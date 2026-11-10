//! Exact-scope administrative cleanup. The producer must first durably delete
//! or revoke the named authority; a parsed request or a transient 401 is no proof.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CleanupSource {
    reference: RetentionStageRefV1,
    owner_binding_sha256: String,
    storage_layout: UploadStorageLayout,
    directory_identity: Option<kcoder_types::PrivateFileIdentityV1>,
    payload_identity: kcoder_types::PrivateFileIdentityV1,
    size: u64,
    sha256: String,
    transfer: Option<TransferBinding>,
}

/// Full immutable query, prepared under a short namespace snapshot. A trusted
/// producer verifies its durable lifecycle record outside that lock, then passes
/// a pure, immutable comparison capability. No service reentry/IO in the trait.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CleanupQuery {
    pub scope: Scope,
    pub root_namespace: String,
    pub epoch: u64,
    pub thread_id: String,
    pub request: PrivateRetentionCleanupV1,
    sources: Vec<CleanupSource>,
}
pub trait AdministrativeCleanupProof {
    fn is_exactly_durable(&self, query: &CleanupQuery) -> Result<bool>;
}

pub struct ThreadCleanupCandidate {
    pub scope: Scope,
    pub receipt: RetentionReceiptV1,
    pub request: PrivateRetentionCleanupV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CleanupIntent {
    pub query: CleanupQuery,
    pub query_sha256: String,
}

impl RetentionService {
    pub fn has_registered_thread_receipts(&self, thread: &str) -> Result<bool> {
        atom(thread)?;
        Ok(self
            .store
            .transaction()?
            .registered_receipts()?
            .iter()
            .any(|receipt| receipt.wire.thread_id == thread))
    }

    /// Resolve full authority through registered owners, never from a caller's
    /// device/scope fields. The captured account root owns this entire catalog.
    /// Work is bounded by the existing 65,536 catalog/4,096 receipt hard limits.
    pub fn thread_cleanup_candidates(
        &self,
        thread: &str,
        workspace: &str,
        principal: &RetentionPrincipalV1,
        deleted_proof_sha256: &str,
    ) -> Result<Vec<ThreadCleanupCandidate>> {
        atom(thread)?;
        sha(deleted_proof_sha256)?;
        self.administrative_cleanup_candidates(
            Some(thread),
            workspace,
            principal,
            |scope, receipt| {
                Some((
                    format!(
                        "thread-delete-{}",
                        digest(
                            &serde_json::to_vec(&(
                                "kcoder.retention.thread-delete.v1",
                                deleted_proof_sha256,
                                scope,
                                receipt
                            ))
                            .ok()?
                        )
                    ),
                    RetentionAdministrativeReasonV1::ThreadDeleted {
                        thread_id: thread.into(),
                        proof_sha256: deleted_proof_sha256.into(),
                    },
                ))
            },
        )
    }

    pub(super) fn administrative_cleanup_candidates(
        &self,
        thread: Option<&str>,
        workspace: &str,
        principal: &RetentionPrincipalV1,
        select: impl Fn(&Scope, &str) -> Option<(String, RetentionAdministrativeReasonV1)>,
    ) -> Result<Vec<ThreadCleanupCandidate>> {
        sha(workspace)?;
        let tx = self.store.transaction()?;
        let mut candidates = Vec::new();
        for receipt in tx.registered_receipts()? {
            if thread.is_some_and(|thread| receipt.wire.thread_id != thread) {
                continue;
            }
            ensure!(
                !receipt.wire.entries.is_empty()
                    && receipt.wire.entries.len() <= MAX_RETENTION_BATCH,
                RetentionFailure::Conflict
            );
            let mut registered_scope = None;
            let mut seen = BTreeSet::new();
            for reference in &receipt.wire.entries {
                let reference_stage = &reference.stage_ref;
                let entry: Entry = tx
                    .read(Area::Entries, &reference_stage.entry_id)?
                    .context("registered cleanup entry missing")?;
                let owner: Owner = tx
                    .read(Area::Owners, &reference_stage.owner_id)?
                    .context("registered cleanup owner missing")?;
                ensure!(
                    canonical_scope(&owner.scope)? == owner.scope
                        && owner.id == reference_stage.owner_id
                        && owner.entries.contains(&entry.id)
                        && entry.scope_hash == owner.scope.hash
                        && receipt.scope_hash == owner.scope.hash
                        && entry.id == reference_stage.entry_id
                        && entry.owner_id == owner.id
                        && stage(self.namespace(), &entry) == reference.stage_ref
                        && entry.retention_id.as_deref()
                            == Some(receipt.wire.retention_id.as_str())
                        && seen.insert(entry.id.clone()),
                    RetentionFailure::Conflict
                );
                if let Some(prior) = &registered_scope {
                    ensure!(prior == &owner.scope, RetentionFailure::Conflict);
                } else {
                    registered_scope = Some(owner.scope);
                }
            }
            let scope = registered_scope.context("cleanup scope absent")?;
            if scope.workspace_identity != workspace || scope.context.principal != *principal {
                continue;
            }
            // Legacy scope lacks the account/target binding needed by this producer.
            ensure!(scope.version == 2, RetentionFailure::ProofUnavailable);
            let Some((operation_id, reason)) = select(&scope, &receipt.wire.retention_id) else {
                continue;
            };
            let request = PrivateRetentionCleanupV1 {
                version: 1,
                operation_id,
                retention_id: receipt.wire.retention_id.clone(),
                expected_revision: receipt.wire.revision,
                reason,
            };
            if receipt.wire.state == RetentionReceiptStateV1::Consumed {
                // A prior terminal consumes no new operation/budget. Preserve
                // its client ACK or exact administrative proof without rewriting.
                self.cleanup_query_in(&tx, &scope, &receipt, &request)?;
                let terminal: Tombstone = tx
                    .read(Area::Consumed, &request.retention_id)?
                    .context("consumed cleanup tombstone missing")?;
                ensure!(
                    terminal.scope_hash == scope.hash
                        && terminal.retention_id == request.retention_id
                        && terminal.epoch == receipt.epoch
                        && terminal.revision == receipt.wire.revision,
                    RetentionFailure::Conflict
                );
                if let Some(proof) = terminal.administrative {
                    let intent = receipt
                        .cleanup_intent
                        .as_ref()
                        .context("administrative cleanup intent missing")?;
                    ensure!(
                        terminal.client_ack_id.is_empty()
                            && proof.root_namespace == self.namespace()
                            && proof.scope_id == scope.hash
                            && proof.epoch == receipt.epoch
                            && proof.retention_id == request.retention_id
                            && proof.terminal_revision == receipt.wire.revision
                            && proof.operation_id == intent.query.request.operation_id
                            && proof.reason == intent.query.request.reason,
                        RetentionFailure::Conflict
                    );
                } else {
                    ensure!(
                        !terminal.client_ack_id.is_empty() && receipt.cleanup_intent.is_none(),
                        RetentionFailure::Conflict
                    );
                }
                continue;
            }
            let request = if let Some(intent) = &receipt.cleanup_intent {
                ensure!(
                    intent.query.request.operation_id == request.operation_id
                        && intent.query.request.reason == request.reason
                        && intent.query.scope == scope
                        && intent.query_sha256 == digest(&serde_json::to_vec(&intent.query)?),
                    RetentionFailure::Conflict
                );
                intent.query.request.clone()
            } else {
                request
            };
            candidates.push(ThreadCleanupCandidate {
                scope,
                receipt: receipt.wire,
                request,
            });
        }
        Ok(candidates)
    }

    pub(super) fn cleanup_query_in(
        &self,
        tx: &Transaction<'_>,
        scope: &Scope,
        receipt: &Receipt,
        request: &PrivateRetentionCleanupV1,
    ) -> Result<CleanupQuery> {
        atom(&request.operation_id)?;
        ensure!(
            request.version == 1 && request.expected_revision > 0,
            RetentionFailure::Conflict
        );
        let epoch = checked_id(&request.retention_id, self.namespace())?;
        ensure!(
            receipt.scope_hash == scope.hash
                && receipt.epoch == epoch
                && receipt.wire.retention_id == request.retention_id,
            RetentionFailure::Conflict
        );
        match &request.reason {
            RetentionAdministrativeReasonV1::ThreadDeleted {
                thread_id,
                proof_sha256,
            } => {
                atom(thread_id)?;
                sha(proof_sha256)?;
                ensure!(
                    *thread_id == receipt.wire.thread_id,
                    RetentionFailure::Conflict
                );
            }
            RetentionAdministrativeReasonV1::DeviceRevoked {
                gateway_namespace_id,
                device_id,
                authorization_generation,
                proof_sha256,
            } => {
                sha(proof_sha256)?;
                ensure!(
                    *gateway_namespace_id == scope.context.gateway_namespace_id
                        && *device_id == scope.context.device_id
                        && *authorization_generation == scope.context.authorization_generation,
                    RetentionFailure::Conflict
                );
            }
        }
        ensure!(
            !receipt.wire.entries.is_empty() && receipt.wire.entries.len() <= MAX_RETENTION_BATCH,
            RetentionFailure::Conflict
        );
        let mut seen = BTreeSet::new();
        let mut sources = Vec::new();
        for reference in &receipt.wire.entries {
            let stage = &reference.stage_ref;
            ensure!(
                seen.insert(stage.entry_id.clone()),
                RetentionFailure::Conflict
            );
            let entry: Entry = tx
                .read(Area::Entries, &stage.entry_id)?
                .context("cleanup entry missing")?;
            let owner = self.owner(tx, scope, &entry.owner_id)?;
            ensure!(
                entry.id == stage.entry_id
                    && owner.entries.contains(&entry.id)
                    && stage.root_namespace == self.namespace()
                    && stage.epoch == entry.epoch
                    && stage.owner_id == entry.owner_id
                    && stage.revision == entry.revision
                    && entry.scope_hash == scope.hash
                    && entry.retention_id.as_deref() == Some(request.retention_id.as_str()),
                RetentionFailure::Conflict
            );
            let valid_phase = match receipt.wire.state {
                RetentionReceiptStateV1::Ready => {
                    entry.phase == EntryPhase::Ready
                        && reference.state == RetentionEntryStateV1::Ready
                        && entry.transfer.is_none()
                }
                RetentionReceiptStateV1::ReleasePending => {
                    matches!(
                        entry.phase,
                        EntryPhase::Ready
                            | EntryPhase::ReleasePending
                            | EntryPhase::RenamePending
                            | EntryPhase::Quarantined
                            | EntryPhase::PayloadGone
                            | EntryPhase::Released
                    ) && entry.transfer.is_none()
                        && (reference.state == RetentionEntryStateV1::ReleasePending
                            || (entry.phase == EntryPhase::Released
                                && reference.state == RetentionEntryStateV1::Released))
                }
                RetentionReceiptStateV1::Released => {
                    entry.phase == EntryPhase::Released
                        && reference.state == RetentionEntryStateV1::Released
                        && entry.transfer.is_none()
                }
                RetentionReceiptStateV1::Transferred => {
                    entry.phase == EntryPhase::Transferred
                        && reference.state == RetentionEntryStateV1::Transferred
                        && entry.transfer.is_some()
                }
                RetentionReceiptStateV1::Consumed => match entry.phase {
                    EntryPhase::Released => {
                        reference.state == RetentionEntryStateV1::Released
                            && entry.transfer.is_none()
                    }
                    EntryPhase::Transferred => {
                        reference.state == RetentionEntryStateV1::Transferred
                            && entry.transfer.is_some()
                    }
                    _ => false,
                },
                _ => false,
            };
            ensure!(valid_phase, RetentionFailure::CompletionUnknown);
            if let Some(upload) = &entry.upload {
                ensure!(
                    upload.confirmed_bytes == entry.size
                        && upload.pending.is_none()
                        && !upload.payload_publishing,
                    RetentionFailure::CompletionUnknown
                );
            }
            let owner_binding_sha256 = digest(&serde_json::to_vec(&(
                &owner.id,
                owner.epoch,
                &owner.scope,
                &owner.data_identity,
                &owner.marker_identity,
                &owner.lease_directory_identity,
                &owner.lease_identity,
                owner.layout_version,
                &owner.manifest,
            ))?);
            sources.push(CleanupSource {
                reference: stage.clone(),
                owner_binding_sha256,
                storage_layout: entry.storage_layout(),
                directory_identity: entry.directory_identity.clone(),
                payload_identity: entry
                    .payload_identity
                    .clone()
                    .context("cleanup payload identity missing")?,
                size: entry.size,
                sha256: entry.content_sha256.clone(),
                transfer: entry.transfer,
            });
        }
        sources.sort_by(|a, b| a.reference.entry_id.cmp(&b.reference.entry_id));
        Ok(CleanupQuery {
            scope: scope.clone(),
            root_namespace: self.namespace().into(),
            epoch,
            thread_id: receipt.wire.thread_id.clone(),
            request: request.clone(),
            sources,
        })
    }

    pub fn cleanup_query(
        &self,
        scope: &Scope,
        request: &PrivateRetentionCleanupV1,
    ) -> Result<CleanupQuery> {
        let tx = self.store.transaction()?;
        let receipt: Receipt = tx
            .read(Area::Receipts, &request.retention_id)?
            .context("cleanup receipt missing")?;
        let query = self.cleanup_query_in(&tx, scope, &receipt, request)?;
        if let Some(intent) = &receipt.cleanup_intent {
            ensure!(
                intent.query == query
                    && intent.query_sha256 == digest(&serde_json::to_vec(&query)?),
                RetentionFailure::Conflict
            );
        } else {
            ensure!(
                receipt.wire.revision == request.expected_revision,
                RetentionFailure::Conflict
            );
        }
        Ok(query)
    }

    /// Commit the exact intent and the Ready dispatch barrier in one redo.
    /// Materializing/Unknown cannot be discarded: the caller must first recover
    /// that existing accepted handoff under its actual exclusive runtime owner.
    pub fn begin_administrative_cleanup(
        &self,
        scope: &Scope,
        request: &PrivateRetentionCleanupV1,
        proof: &dyn AdministrativeCleanupProof,
    ) -> Result<RetentionReceiptV1> {
        let mut tx = self.store.transaction()?;
        let mut receipt: Receipt = tx
            .read(Area::Receipts, &request.retention_id)?
            .context("cleanup receipt missing")?;
        let query = self.cleanup_query_in(&tx, scope, &receipt, request)?;
        let wanted = CleanupIntent {
            query,
            query_sha256: String::new(),
        };
        let wanted = CleanupIntent {
            query_sha256: digest(&serde_json::to_vec(&wanted.query)?),
            ..wanted
        };
        ensure!(
            proof.is_exactly_durable(&wanted.query)?,
            RetentionFailure::ProofUnavailable
        );
        if receipt.wire.state == RetentionReceiptStateV1::Consumed
            && receipt.cleanup_intent.is_none()
        {
            let prior: Tombstone = tx
                .read(Area::Consumed, &request.retention_id)?
                .context("existing client terminal missing")?;
            ensure!(
                prior.scope_hash == scope.hash
                    && prior.retention_id == request.retention_id
                    && prior.epoch == receipt.epoch
                    && prior.revision == receipt.wire.revision
                    && !prior.client_ack_id.is_empty()
                    && prior.administrative.is_none(),
                RetentionFailure::Conflict
            );
            ensure!(
                receipt.wire.revision == request.expected_revision,
                RetentionFailure::Conflict
            );
            return Ok(receipt.wire);
        }
        if let Some(existing) = &receipt.cleanup_intent {
            ensure!(*existing == wanted, RetentionFailure::Conflict);
            return Ok(receipt.wire);
        }
        ensure!(
            receipt.wire.revision == request.expected_revision
                && matches!(
                    receipt.wire.state,
                    RetentionReceiptStateV1::Ready
                        | RetentionReceiptStateV1::Released
                        | RetentionReceiptStateV1::Transferred
                ),
            RetentionFailure::Conflict
        );
        ensure!(
            receipt.cleanup_capacity == RECORD_BYTES && receipt.terminal_budget == 2 * RECORD_BYTES,
            RetentionFailure::Capacity
        );
        if receipt.wire.state == RetentionReceiptStateV1::Ready {
            let aborted = match &request.reason {
                RetentionAdministrativeReasonV1::DeviceRevoked { proof_sha256, .. } => {
                    self.verified_device_abort_in(&tx, scope, &receipt, proof_sha256)?
                }
                _ => false,
            };
            ensure!(
                (receipt.transfer_intent.is_none() || aborted) && receipt.release_intent.is_none(),
                RetentionFailure::Conflict
            );
            receipt.release_intent = Some(ReleaseIntent {
                expected_revision: request.expected_revision,
                // This is the physical discard action, not a client authority or ACK.
                reason: RetentionReleaseReasonV1::Discard,
            });
            receipt.wire.state = RetentionReceiptStateV1::ReleasePending;
            receipt.wire.revision = receipt
                .wire
                .revision
                .checked_add(1)
                .context("cleanup revision overflow")?;
            for entry in &mut receipt.wire.entries {
                entry.state = RetentionEntryStateV1::ReleasePending;
            }
        }
        receipt.cleanup_intent = Some(wanted);
        tx.put_cleanup_receipt(&receipt)?;
        tx.commit()?;
        Ok(receipt.wire)
    }

    /// Replays only the same committed operation. Busy owners remain pending;
    /// no byte refund or terminal tombstone occurs until the source is terminal.
    pub fn resume_administrative_cleanup(
        &self,
        scope: &Scope,
        request: &PrivateRetentionCleanupV1,
        administrative_proof: &dyn AdministrativeCleanupProof,
        accepted_proof: &dyn AcceptedTurnProof,
    ) -> Result<RetentionCleanupStatusV1> {
        let receipt = self.begin_administrative_cleanup(scope, request, administrative_proof)?;
        if receipt.state == RetentionReceiptStateV1::Consumed {
            let tx = self.store.transaction()?;
            let terminal: Tombstone = tx
                .read(Area::Consumed, &request.retention_id)?
                .context("administrative terminal missing")?;
            ensure!(
                terminal.scope_hash == scope.hash
                    && terminal.retention_id == request.retention_id
                    && terminal.epoch == checked_id(&request.retention_id, self.namespace())?
                    && terminal.revision == receipt.revision,
                RetentionFailure::Conflict
            );
            return Ok(match terminal.administrative {
                Some(proof) => {
                    ensure!(
                        terminal.client_ack_id.is_empty()
                            && proof.operation_id == request.operation_id
                            && proof.root_namespace == self.namespace()
                            && proof.scope_id == scope.hash
                            && proof.retention_id == request.retention_id
                            && proof.epoch == terminal.epoch
                            && proof.terminal_revision == terminal.revision
                            && proof.reason == request.reason,
                        RetentionFailure::Conflict
                    );
                    RetentionCleanupStatusV1::Administrative { proof }
                }
                None => {
                    ensure!(
                        !terminal.client_ack_id.is_empty(),
                        RetentionFailure::Conflict
                    );
                    RetentionCleanupStatusV1::ClientConsumed {
                        ack: RetentionConsumeAckV1 {
                            retention_id: terminal.retention_id,
                            terminal_revision: terminal.revision,
                            client_ack_id: terminal.client_ack_id,
                        },
                    }
                }
            });
        }
        let receipt = if receipt.state == RetentionReceiptStateV1::ReleasePending {
            self.release_receipt_authorized(
                scope,
                &request.retention_id,
                request.expected_revision,
                RetentionReleaseReasonV1::Discard,
                Some(&request.operation_id),
            )?
        } else {
            receipt
        };
        if !matches!(
            receipt.state,
            RetentionReceiptStateV1::Released | RetentionReceiptStateV1::Transferred
        ) {
            return Ok(RetentionCleanupStatusV1::Pending);
        }
        let terminal = RetentionAdministrativeTerminalV1 {
            operation_id: request.operation_id.clone(),
            root_namespace: self.namespace().into(),
            epoch: checked_id(&request.retention_id, self.namespace())?,
            scope_id: scope.hash.clone(),
            retention_id: request.retention_id.clone(),
            terminal_revision: receipt.revision,
            reason: request.reason.clone(),
        };
        self.consume_terminal(
            scope,
            &RetentionConsumeAckV1 {
                retention_id: request.retention_id.clone(),
                terminal_revision: receipt.revision,
                client_ack_id: String::new(),
            },
            accepted_proof,
            Some(&terminal),
        )?;
        Ok(RetentionCleanupStatusV1::Administrative { proof: terminal })
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct ExactProof(Option<CleanupQuery>);
    impl AdministrativeCleanupProof for ExactProof {
        fn is_exactly_durable(&self, query: &CleanupQuery) -> Result<bool> {
            Ok(self.0.as_ref() == Some(query))
        }
    }
    struct Fixture {
        temp: TempDir,
        service: RetentionService,
        scope: Scope,
        lease: OwnerLease,
        request: PrivateRetentionCleanupV1,
        reference: RetentionStageRefV1,
    }
    fn fixture() -> Fixture {
        let base = kcoder_test_harness::workspace_root()
            .expect("resolve current workspace")
            .join("crates/kcoder_cli")
            .join("../..")
            .canonicalize()
            .unwrap()
            .join("target/test/crates/kcoder_cli/retention-cleanup");
        PrivateDirectory::open_or_create(&base).unwrap();
        let temp = tempfile::Builder::new()
            .prefix("cleanup-")
            .tempdir_in(base)
            .unwrap();
        let account = temp.path().join("account");
        PrivateDirectory::open_or_create(&account).unwrap();
        let service = RetentionService::open(&account, true, Limits::default()).unwrap();
        let scope = service
            .full_scope(
                &TrustedRetentionContextV1 {
                    gateway_namespace_id: "gateway-a".into(),
                    device_id: "device-a".into(),
                    authorization_generation: "epoch-a".into(),
                    target_fingerprint: "target-a".into(),
                    principal: RetentionPrincipalV1::LocalOs,
                },
                &digest(b"workspace-a"),
                None,
                "target-id-a",
            )
            .unwrap();
        let lease = service.create_owner(&scope).unwrap();
        let bytes = b"owned original attachment";
        let entry = service
            .allocate_upload(
                &scope,
                &lease,
                "upload-a",
                bytes.len() as u64,
                &digest(bytes),
            )
            .unwrap();
        let reference = service
            .seal_bytes(&scope, &lease, &entry.id, bytes)
            .unwrap();
        let receipt = service
            .reserve(
                &scope,
                &wire_id(service.namespace(), reference.epoch),
                "thread-a",
                std::slice::from_ref(&reference),
            )
            .unwrap();
        let request = PrivateRetentionCleanupV1 {
            version: 1,
            operation_id: "delete-operation-a".into(),
            retention_id: receipt.retention_id,
            expected_revision: receipt.revision,
            reason: RetentionAdministrativeReasonV1::ThreadDeleted {
                thread_id: "thread-a".into(),
                proof_sha256: digest(b"durable lifecycle proof fixture"),
            },
        };
        Fixture {
            temp,
            service,
            scope,
            lease,
            request,
            reference,
        }
    }
    fn snapshot(service: &RetentionService, request: &PrivateRetentionCleanupV1) -> Vec<u8> {
        let tx = service.store.transaction().unwrap();
        let receipt: Receipt = tx
            .read(Area::Receipts, &request.retention_id)
            .unwrap()
            .unwrap();
        let terminal: Option<Tombstone> = tx.read(Area::Consumed, &request.retention_id).unwrap();
        serde_json::to_vec(&(receipt, terminal, &tx.state)).unwrap()
    }
    fn proof(f: &Fixture) -> ExactProof {
        ExactProof(Some(f.service.cleanup_query(&f.scope, &f.request).unwrap()))
    }
    fn source_directory(f: &Fixture) -> PrivateDirectory {
        let tx = f.service.store.transaction().unwrap();
        let entry: Entry = tx
            .read(Area::Entries, &f.reference.entry_id)
            .unwrap()
            .unwrap();
        let owner = f.service.owner(&tx, &f.scope, &entry.owner_id).unwrap();
        drop(tx);
        f.service
            .owner_data(&owner)
            .unwrap()
            .open_verified_child(
                OsStr::new(&entry.id),
                entry.directory_identity.as_ref().unwrap(),
            )
            .unwrap()
    }

    #[test]
    fn administrative_cleanup_rejects_claim_missing_scope_and_extra_tuple_without_mutation() {
        let f = fixture();
        let before = snapshot(&f.service, &f.request);
        assert!(
            f.service
                .begin_administrative_cleanup(&f.scope, &f.request, &ExactProof(None))
                .is_err()
        );
        let mut wrong = proof(&f).0.unwrap();
        wrong.sources.push(wrong.sources[0].clone());
        assert!(
            f.service
                .begin_administrative_cleanup(&f.scope, &f.request, &ExactProof(Some(wrong)))
                .is_err()
        );
        let mut wrong_scope = f.scope.clone();
        wrong_scope.context.authorization_generation = "new-epoch".into();
        wrong_scope.hash = digest(b"other scope");
        assert!(
            f.service
                .begin_administrative_cleanup(&wrong_scope, &f.request, &proof(&f))
                .is_err()
        );
        let mut transient = f.request.clone();
        transient.reason = RetentionAdministrativeReasonV1::DeviceRevoked {
            gateway_namespace_id: "gateway-a".into(),
            device_id: "device-a".into(),
            authorization_generation: "epoch-a".into(),
            proof_sha256: digest(b"transient 401"),
        };
        // Parsed declarations, including plausible device tuples, are not proof.
        assert!(
            f.service
                .begin_administrative_cleanup(&f.scope, &transient, &ExactProof(None))
                .is_err()
        );
        assert_eq!(snapshot(&f.service, &f.request), before);
        let mut file = source_directory(&f)
            .open_regular_file(OsStr::new("payload"))
            .unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"owned original attachment");
    }

    #[test]
    fn administrative_cleanup_durable_intent_reopens_busy_then_consumes_without_client_ack() {
        let f = fixture();
        let exact = proof(&f);
        let before = snapshot(&f.service, &f.request);
        storage::FAIL_AFTER_JOURNAL.with(|fail| fail.set(true));
        let error = f
            .service
            .begin_administrative_cleanup(&f.scope, &f.request, &exact)
            .unwrap_err();
        assert!(format!("{error:#}").contains("after durable retention journal"));
        assert_ne!(snapshot(&f.service, &f.request), before);
        let pending = f
            .service
            .read(
                &f.scope,
                &RetentionReceiptSelectorV1::RetentionId {
                    retention_id: f.request.retention_id.clone(),
                },
            )
            .unwrap()
            .receipt
            .unwrap();
        assert_eq!(pending.state, RetentionReceiptStateV1::ReleasePending);
        assert!(pending.revision > f.request.expected_revision);
        assert!(
            f.service
                .release_receipt(
                    &f.scope,
                    &f.request.retention_id,
                    f.request.expected_revision,
                    RetentionReleaseReasonV1::Discard
                )
                .is_err()
        );
        assert_eq!(
            f.service
                .resume_administrative_cleanup(&f.scope, &f.request, &exact, &NoAcceptedTurnProof)
                .unwrap(),
            RetentionCleanupStatusV1::Pending
        );
        let owner_id = f.lease.id.clone();
        drop(f.lease);
        drop(f.service);
        let service =
            RetentionService::open(&f.temp.path().join("account"), true, Limits::default())
                .unwrap();
        let terminal = service
            .resume_administrative_cleanup(&f.scope, &f.request, &exact, &NoAcceptedTurnProof)
            .unwrap();
        let RetentionCleanupStatusV1::Administrative { proof: terminal } = terminal else {
            panic!("expected administrative terminal")
        };
        let after = snapshot(&service, &f.request);
        let repeated = service
            .resume_administrative_cleanup(&f.scope, &f.request, &exact, &NoAcceptedTurnProof)
            .unwrap();
        assert_eq!(
            repeated,
            RetentionCleanupStatusV1::Administrative { proof: terminal }
        );
        assert_eq!(snapshot(&service, &f.request), after);
        let lease = service.recover_owner(&f.scope, &owner_id).unwrap().unwrap();
        service.retire_owner(&f.scope, &lease).unwrap();
        let tx = service.store.transaction().unwrap();
        let tombstone: Tombstone = tx
            .read(Area::Consumed, &f.request.retention_id)
            .unwrap()
            .unwrap();
        assert!(tombstone.client_ack_id.is_empty());
        assert!(tombstone.administrative.is_some());
        assert_eq!(tx.state.charges.staged_bytes, 0);
        assert_eq!(tx.state.charges.entries, 0);
        assert_eq!(tx.state.charges.receipt_slots, 0);
        assert_eq!(tx.state.epochs[&f.reference.epoch].unconsumed_references, 0);
    }

    #[test]
    fn administrative_cleanup_preserves_existing_client_consumption_and_old_record_shape() {
        let f = fixture();
        let request = f.request.clone();
        drop(f.lease);
        let released = f
            .service
            .release_receipt(
                &f.scope,
                &request.retention_id,
                request.expected_revision,
                RetentionReleaseReasonV1::Discard,
            )
            .unwrap();
        let ack = RetentionConsumeAckV1 {
            retention_id: request.retention_id.clone(),
            terminal_revision: released.revision,
            client_ack_id: "original-client-ack".into(),
        };
        f.service
            .consume(&f.scope, &ack, &NoAcceptedTurnProof)
            .unwrap();
        let request = PrivateRetentionCleanupV1 {
            expected_revision: released.revision,
            ..request
        };
        let query = f.service.cleanup_query(&f.scope, &request).unwrap();
        let before = snapshot(&f.service, &request);
        assert_eq!(
            f.service
                .resume_administrative_cleanup(
                    &f.scope,
                    &request,
                    &ExactProof(Some(query)),
                    &NoAcceptedTurnProof
                )
                .unwrap(),
            RetentionCleanupStatusV1::ClientConsumed { ack: ack.clone() }
        );
        assert_eq!(snapshot(&f.service, &request), before);
        let tx = f.service.store.transaction().unwrap();
        let tombstone: Tombstone = tx
            .read(Area::Consumed, &request.retention_id)
            .unwrap()
            .unwrap();
        let old_shape = serde_json::to_value(&tombstone).unwrap();
        assert!(old_shape.get("administrative").is_none());
        let restored: Tombstone = serde_json::from_value(old_shape).unwrap();
        assert_eq!(restored.client_ack_id, ack.client_ack_id);
        assert!(restored.administrative.is_none());
    }

    #[test]
    fn administrative_cleanup_preserves_foreign_leaf_and_charges() {
        let f = fixture();
        let exact = proof(&f);
        let directory = source_directory(&f);
        directory
            .atomic_replace(OsStr::new("payload"), b"foreign fixture inode")
            .unwrap();
        let request = f.request.clone();
        let scope = f.scope.clone();
        let before_bytes = f
            .service
            .store
            .transaction()
            .unwrap()
            .state
            .charges
            .staged_bytes;
        drop(f.lease);
        assert!(
            f.service
                .resume_administrative_cleanup(&scope, &request, &exact, &NoAcceptedTurnProof)
                .is_err()
        );
        let mut bytes = Vec::new();
        directory
            .open_regular_file(OsStr::new("payload"))
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"foreign fixture inode");
        let tx = f.service.store.transaction().unwrap();
        assert_eq!(tx.state.charges.staged_bytes, before_bytes);
        assert!(
            tx.read::<Tombstone>(Area::Consumed, &request.retention_id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn administrative_cleanup_old_unprepaid_receipt_stays_readable_without_refund() {
        let f = fixture();
        let mut tx = f.service.store.transaction().unwrap();
        let mut receipt: Receipt = tx
            .read(Area::Receipts, &f.request.retention_id)
            .unwrap()
            .unwrap();
        receipt.cleanup_capacity = 0;
        receipt.terminal_budget = 0;
        tx.put(
            Area::Receipts,
            &f.request.retention_id,
            receipt.epoch,
            &receipt,
        )
        .unwrap();
        tx.commit().unwrap();
        let before = snapshot(&f.service, &f.request);
        assert!(
            f.service
                .begin_administrative_cleanup(&f.scope, &f.request, &proof(&f))
                .is_err()
        );
        assert_eq!(snapshot(&f.service, &f.request), before);
        assert_eq!(
            f.service
                .read(
                    &f.scope,
                    &RetentionReceiptSelectorV1::RetentionId {
                        retention_id: f.request.retention_id.clone(),
                    }
                )
                .unwrap()
                .receipt
                .unwrap()
                .state,
            RetentionReceiptStateV1::Ready
        );
    }

    #[test]
    fn administrative_cleanup_rejects_unknown_entry_before_intent_or_refund() {
        let f = fixture();
        let exact = proof(&f);
        let mut tx = f.service.store.transaction().unwrap();
        let mut entry: Entry = tx
            .read(Area::Entries, &f.reference.entry_id)
            .unwrap()
            .unwrap();
        entry.phase = EntryPhase::Unknown;
        tx.put(Area::Entries, &entry.id, entry.epoch, &entry)
            .unwrap();
        tx.commit().unwrap();
        let before = snapshot(&f.service, &f.request);
        assert!(
            f.service
                .begin_administrative_cleanup(&f.scope, &f.request, &exact)
                .is_err()
        );
        assert_eq!(snapshot(&f.service, &f.request), before);
        let tx = f.service.store.transaction().unwrap();
        let receipt: Receipt = tx
            .read(Area::Receipts, &f.request.retention_id)
            .unwrap()
            .unwrap();
        assert!(receipt.cleanup_intent.is_none());
        assert!(
            tx.read::<Tombstone>(Area::Consumed, &f.request.retention_id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn administrative_cleanup_rejects_mismatched_terminal_readback() {
        let f = fixture();
        let exact = proof(&f);
        drop(f.lease);
        f.service
            .resume_administrative_cleanup(&f.scope, &f.request, &exact, &NoAcceptedTurnProof)
            .unwrap();
        let mut tx = f.service.store.transaction().unwrap();
        let mut terminal: Tombstone = tx
            .read(Area::Consumed, &f.request.retention_id)
            .unwrap()
            .unwrap();
        terminal.administrative.as_mut().unwrap().operation_id = "other-operation".into();
        tx.put(
            Area::Consumed,
            &f.request.retention_id,
            terminal.epoch,
            &terminal,
        )
        .unwrap();
        tx.commit().unwrap();
        let before = snapshot(&f.service, &f.request);
        assert!(
            f.service
                .resume_administrative_cleanup(&f.scope, &f.request, &exact, &NoAcceptedTurnProof)
                .is_err()
        );
        assert_eq!(snapshot(&f.service, &f.request), before);
    }
}
