//! Signed checkpoint of the verified journal state and in-place compaction.
//!
//! `checkpoint.json` holds the complete folded state at `baseSequence` (every
//! grant proof, revision and revoked flag, every operation identity, and every
//! revocation record verbatim), signed by the issuer key under its own domain
//! separation context. The journal file keeps its pinned identity: compaction
//! publishes the checkpoint atomically, verifies it, then truncates the journal
//! in place. Each interrupted step leaves files that load to the same state.
use super::*;
use kcoder_types::diagnostic_cause::coded;
use std::collections::BTreeSet;

const CHECKPOINT_CONTEXT: &[u8] = b"kcoder-native-delegation-checkpoint-v1\0";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    body: CheckpointBody,
    signature: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointBody {
    version: u32,
    issuer_id: String,
    binding_digest: String,
    base_sequence: u64,
    base_digest: String,
    epoch: String,
    identity_enabled: bool,
    grants: Vec<CheckpointGrant>,
    code_services: Vec<CheckpointCodeGrant>,
    operations: Vec<CheckpointOperation>,
    /// Original revocation journal records, verbatim, in sequence order.
    revocations: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointGrant {
    proof: SignedDelegation,
    revision: u64,
    revoked: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointCodeGrant {
    proof: native_code_services::SignedNativeCodeService,
    revision: u64,
    revoked: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointOperation {
    operation_id: String,
    intent: String,
    id: String,
}

impl NativeDelegationAuthority {
    /// Fold the current verified journal into a signed checkpoint. Takes the
    /// exclusive authority lock; writers call `compact_locked` instead.
    #[cfg(test)]
    pub(super) fn compact(&self) -> Result<()> {
        let _lock = self.lock(PrivateLeaseMode::Exclusive)?;
        self.compact_locked()
    }

    /// Steps, each crash-safe:
    /// 1. make head.json name the verified chain end (repairs a lost head update);
    /// 2. build, sign and verify the checkpoint in memory through the load path;
    /// 3. atomically replace checkpoint.json and confirm the published bytes;
    /// 4. truncate the pinned journal in place and fsync it.
    ///
    /// A crash before 3 leaves the old files (and possibly an ignored temporary
    /// file). A crash between 3 and 4 leaves a journal whose prefix ends at the
    /// checkpoint base digest; the loader skips that verified prefix.
    pub(super) fn compact_locked(&self) -> Result<()> {
        let journal = self.read_journal()?;
        if journal.records == 0 {
            return Ok(());
        }
        let head = serde_json::to_vec(&Head {
            version: 1,
            sequence: journal.sequence,
            digest: journal.digest.clone(),
        })?;
        if read_file(&self.directory, HEAD_FILE, MAX_RECORD_BYTES)? != head {
            self.directory
                .atomic_replace(OsStr::new(HEAD_FILE), &head)?;
        }
        let body = self.checkpoint_body(&journal)?;
        let body_bytes = serde_json::to_vec(&body)?;
        let signature = self
            .key
            .sign(&checkpoint_signing_bytes(&body_bytes))
            .as_ref()
            .to_vec();
        let bytes = serde_json::to_vec(&Checkpoint { body, signature })?;
        ensure!(
            bytes.len() <= MAX_JOURNAL_BYTES,
            "DELEGATION_CHECKPOINT_FULL"
        );
        // Verify before use: the exact bytes must restore to the same state.
        let restored = self.restore_checkpoint(&bytes)?;
        ensure!(
            serde_json::to_vec(&self.checkpoint_body(&restored)?)? == body_bytes,
            "DELEGATION_CHECKPOINT_INVALID"
        );
        #[cfg(test)]
        self.test_compaction_crash(1)?;
        self.directory
            .atomic_replace(OsStr::new(CHECKPOINT_FILE), &bytes)?;
        ensure!(
            read_file(&self.directory, CHECKPOINT_FILE, MAX_JOURNAL_BYTES)? == bytes,
            "DELEGATION_CHECKPOINT_CHANGED"
        );
        #[cfg(test)]
        self.test_compaction_crash(2)?;
        self.verify_storage()?;
        let file = self
            .directory
            .open_read_write_file(OsStr::new(JOURNAL_FILE), false)?;
        ensure!(
            self.directory.portable_regular_handle_identity(&file)? == self.journal_identity,
            "DELEGATION_STORAGE_CHANGED"
        );
        file.set_len(0)?;
        file.sync_all()?;
        self.invalidate_journal_cache()?;
        #[cfg(test)]
        self.counters
            .compactions
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    #[cfg(test)]
    fn test_compaction_crash(&self, step: u8) -> Result<()> {
        let wanted = self
            .counters
            .compaction_crash
            .load(std::sync::atomic::Ordering::SeqCst);
        ensure!(wanted != step, "TEST_COMPACTION_CRASH");
        Ok(())
    }

    fn checkpoint_body(&self, journal: &Journal) -> Result<CheckpointBody> {
        Ok(CheckpointBody {
            version: 1,
            issuer_id: self.binding.issuer_id.clone(),
            binding_digest: binding_digest(&self.binding)?,
            base_sequence: journal.sequence,
            base_digest: journal.digest.clone(),
            epoch: journal.epoch.clone(),
            identity_enabled: journal.identity_enabled,
            grants: journal
                .grants
                .values()
                .map(|grant| CheckpointGrant {
                    proof: grant.proof.clone(),
                    revision: grant.revision,
                    revoked: grant.revoked,
                })
                .collect(),
            code_services: journal
                .code_services
                .values()
                .map(|grant| CheckpointCodeGrant {
                    proof: grant.proof.clone(),
                    revision: grant.revision,
                    revoked: grant.revoked,
                })
                .collect(),
            operations: journal
                .operations
                .iter()
                .map(|(operation_id, (intent, id))| CheckpointOperation {
                    operation_id: operation_id.clone(),
                    intent: intent.clone(),
                    id: id.clone(),
                })
                .collect(),
            revocations: journal.revocations.clone(),
        })
    }

    /// Verify the issuer signature and every structural invariant, re-verify
    /// every grant proof signature, and rebuild the state at the base sequence.
    pub(super) fn restore_checkpoint(&self, bytes: &[u8]) -> Result<Journal> {
        let checkpoint: Checkpoint =
            serde_json::from_slice(bytes).map_err(coded("DELEGATION_CHECKPOINT_INVALID"))?;
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ED25519,
            self.binding.public_key.as_slice(),
        )
        .verify(
            &checkpoint_signing_bytes(&serde_json::to_vec(&checkpoint.body)?),
            &checkpoint.signature,
        )
        // ring reports no detail by design; the key and signature outcome stays opaque.
        .map_err(|_| anyhow::anyhow!("DELEGATION_CHECKPOINT_SIGNATURE_INVALID"))?;
        let body = checkpoint.body;
        ensure!(
            body.version == 1
                && body.issuer_id == self.binding.issuer_id
                && body.binding_digest == binding_digest(&self.binding)?
                && body.base_sequence > 0
                && is_digest(&body.base_digest),
            "DELEGATION_CHECKPOINT_INVALID"
        );
        label(&body.epoch)?;

        // Revocation history: ordered, inside the base, epoch chain intact.
        let mut epochs = BTreeSet::from([self.binding.initial_epoch.clone()]);
        let mut epoch = self.binding.initial_epoch.clone();
        let mut identity_enabled = true;
        let mut revoked_grants = BTreeSet::new();
        let mut revoked_code = BTreeSet::new();
        let mut revocation_operations = BTreeMap::new();
        let mut last_sequence = 0;
        for raw in &body.revocations {
            ensure!(
                raw.len() <= MAX_RECORD_BYTES,
                "DELEGATION_CHECKPOINT_INVALID"
            );
            let entry: Entry =
                serde_json::from_str(raw).map_err(coded("DELEGATION_CHECKPOINT_INVALID"))?;
            ensure!(
                entry.sequence > last_sequence && entry.sequence <= body.base_sequence,
                "DELEGATION_CHECKPOINT_INVALID"
            );
            last_sequence = entry.sequence;
            let (operation_id, intent, id) = match entry.event {
                Event::Revoked {
                    operation_id,
                    intent,
                    delegation_id,
                    expected_revision,
                    ..
                } => {
                    ensure!(
                        expected_revision == 1 && revoked_grants.insert(delegation_id.clone()),
                        "DELEGATION_CHECKPOINT_INVALID"
                    );
                    (operation_id, intent, delegation_id)
                }
                Event::NativeCodeRevoked {
                    operation_id,
                    intent,
                    grant_id,
                    expected_revision,
                    ..
                } => {
                    ensure!(
                        expected_revision == 1 && revoked_code.insert(grant_id.clone()),
                        "DELEGATION_CHECKPOINT_INVALID"
                    );
                    (operation_id, intent, grant_id)
                }
                Event::IdentityRevoked {
                    operation_id,
                    intent,
                    previous_epoch,
                    next_epoch,
                    ..
                } => {
                    label(&next_epoch)?;
                    ensure!(
                        previous_epoch == epoch && epochs.insert(next_epoch.clone()),
                        "DELEGATION_CHECKPOINT_INVALID"
                    );
                    epoch = next_epoch;
                    identity_enabled = false;
                    (operation_id, intent, String::new())
                }
                Event::Issued { .. } | Event::NativeCodeIssued { .. } => {
                    anyhow::bail!("DELEGATION_CHECKPOINT_INVALID")
                }
            };
            ensure!(
                revocation_operations
                    .insert(operation_id, (intent, id))
                    .is_none(),
                "DELEGATION_CHECKPOINT_INVALID"
            );
        }
        ensure!(
            epoch == body.epoch && identity_enabled == body.identity_enabled,
            "DELEGATION_CHECKPOINT_INVALID"
        );

        // Operations: every revocation operation is present exactly; every
        // other operation is the unique issuing operation of one grant.
        let mut operations = BTreeMap::new();
        let mut issuing = BTreeMap::new();
        for operation in body.operations {
            label(&operation.operation_id)?;
            ensure!(
                is_digest(&operation.intent),
                "DELEGATION_CHECKPOINT_INVALID"
            );
            let value = (operation.intent, operation.id);
            if let Some(revocation) = revocation_operations.get(&operation.operation_id) {
                ensure!(revocation == &value, "DELEGATION_CHECKPOINT_INVALID");
            } else {
                ensure!(
                    !value.1.is_empty()
                        && issuing
                            .insert(value.1.clone(), operation.operation_id.clone())
                            .is_none(),
                    "DELEGATION_CHECKPOINT_INVALID"
                );
            }
            ensure!(
                operations.insert(operation.operation_id, value).is_none(),
                "DELEGATION_CHECKPOINT_INVALID"
            );
        }
        ensure!(
            revocation_operations
                .keys()
                .all(|operation| operations.contains_key(operation)),
            "DELEGATION_CHECKPOINT_INVALID"
        );

        let mut grants = BTreeMap::new();
        for grant in body.grants {
            grant.proof.verify(&self.key)?;
            let claims = &grant.proof.claims;
            let id = claims.delegation_id.clone();
            let operation = issuing.get(&id).context("DELEGATION_CHECKPOINT_INVALID")?;
            ensure!(
                claims.version == 1
                    && claims.issuer_id == self.binding.issuer_id
                    && claims.owner == self.binding.owner
                    && epochs.contains(&claims.identity_epoch)
                    && claims.audience == self.binding.owner.target_id
                    && claims.expires_at_ms.valid_issuance(claims.issued_at_ms)
                    && !claims.actions.is_empty()
                    && !claims.resource_refs.is_empty()
                    && claims.resource_refs.len() <= 32
                    && claims
                        .service_lease
                        .as_ref()
                        .is_none_or(|service| &service.operation_id == operation)
                    && grant.revoked == revoked_grants.contains(&id)
                    && grant.revision == 1 + u64::from(grant.revoked),
                "DELEGATION_CHECKPOINT_INVALID"
            );
            ensure!(
                grants
                    .insert(
                        id,
                        Grant {
                            proof: grant.proof,
                            revision: grant.revision,
                            revoked: grant.revoked,
                        },
                    )
                    .is_none(),
                "DELEGATION_CHECKPOINT_INVALID"
            );
        }
        let mut code_services = BTreeMap::new();
        for grant in body.code_services {
            let id = grant.proof.grant_id().to_owned();
            let operation = issuing.get(&id).context("DELEGATION_CHECKPOINT_INVALID")?;
            let restored = native_code_services::NativeCodeGrant {
                proof: grant.proof,
                revision: grant.revision,
                revoked: grant.revoked,
            };
            self.verify_restored_code_grant(operation, &restored, &epochs)?;
            ensure!(
                grant.revoked == revoked_code.contains(&id)
                    && grant.revision == 1 + u64::from(grant.revoked)
                    && !grants.contains_key(&id)
                    && code_services.insert(id, restored).is_none(),
                "DELEGATION_CHECKPOINT_INVALID"
            );
        }
        // Every revocation names a restored grant and every issuing operation
        // names exactly one grant: no grant or revocation can go missing.
        ensure!(
            revoked_grants.iter().all(|id| grants.contains_key(id))
                && revoked_code.iter().all(|id| code_services.contains_key(id))
                && issuing.len() == grants.len() + code_services.len(),
            "DELEGATION_CHECKPOINT_INVALID"
        );
        Ok(Journal {
            epoch: body.epoch,
            identity_enabled: body.identity_enabled,
            grants,
            code_services,
            operations,
            sequence: body.base_sequence,
            digest: body.base_digest,
            bytes: 0,
            records: 0,
            revocations: body.revocations,
        })
    }
}

fn checkpoint_signing_bytes(body: &[u8]) -> Vec<u8> {
    let mut bytes = CHECKPOINT_CONTEXT.to_vec();
    bytes.extend_from_slice(body);
    bytes
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|value| value.is_ascii_hexdigit())
}
