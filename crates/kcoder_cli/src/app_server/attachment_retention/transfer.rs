//! Receipt-owned materialization. Byte IO never holds the namespace lock.
//! No wire route or capability is enabled by these internal APIs.
use super::*;
use kcoder_types::{TurnAttemptIdentity, TurnRetainedArtifactV1, TurnRetainedInputV1};
use sha2::{Digest, Sha256};
use std::io::Write;

/// Only a trusted turn adapter may construct this from canonical turn params.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TransferRequest {
    pub identity: TurnAttemptIdentity,
    pub client_message_id: String,
    pub request_fingerprint: String,
    pub references: Vec<TurnRetentionReferenceV1>,
}

/// One complete receipt subset of a single immutable Accepted batch. The proof
/// implementation must also validate the entire Accepted batch, not just hashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedTurnQuery {
    pub scope: Scope,
    pub identity: TurnAttemptIdentity,
    pub request_fingerprint: String,
    pub request_digest: String,
    pub materialization_digest: String,
    pub input: TurnRetainedInputV1,
}

pub fn materialization_digest(
    scope: &Scope,
    identity: &TurnAttemptIdentity,
    fingerprint: &str,
    input: &TurnRetainedInputV1,
) -> Result<String> {
    input.validate().map_err(anyhow::Error::msg)?;
    ensure!(input.scope_id == scope.hash, RetentionFailure::Conflict);
    Ok(digest(&serde_json::to_vec(&(
        "retention-materialized-v1",
        scope,
        identity,
        fingerprint,
        input,
    ))?))
}

pub fn request_digest(
    scope: &Scope,
    identity: &TurnAttemptIdentity,
    fingerprint: &str,
    input: &TurnRetainedInputV1,
) -> Result<String> {
    // Identities of unpublished destination inodes are intentionally excluded.
    // Every other accepted tuple field, including parent/name/hash/size, is bound.
    let planned: Vec<_> = input
        .artifacts
        .iter()
        .map(|a| {
            (
                &a.retention_id,
                a.expected_receipt_revision,
                &a.root_namespace,
                a.epoch,
                &a.owner_id,
                &a.entry_id,
                a.entry_revision,
                &a.artifact_name,
                &a.artifact_parent_identity,
                &a.artifact_sha256,
                a.artifact_size,
            )
        })
        .collect();
    Ok(digest(&serde_json::to_vec(&(
        "retention-plan-v1",
        scope,
        identity,
        fingerprint,
        input.version,
        &input.client_message_id,
        planned,
    ))?))
}

pub fn verify_artifact(parent: &PrivateDirectory, artifact: &TurnRetainedArtifactV1) -> Result<()> {
    parent.verify_retention_identity(&artifact.artifact_parent_identity)?;
    let file = parent.open_verified_regular(
        OsStr::new(&artifact.artifact_name),
        &artifact.artifact_identity,
    )?;
    ensure!(
        hash_file(file.file(), artifact.artifact_size)? == artifact.artifact_sha256,
        RetentionFailure::CompletionUnknown
    );
    parent.open_verified_regular(
        OsStr::new(&artifact.artifact_name),
        &artifact.artifact_identity,
    )?;
    Ok(())
}

fn hash_file(mut file: &std::fs::File, size: u64) -> Result<String> {
    ensure!(
        file.metadata()?.len() == size,
        RetentionFailure::CompletionUnknown
    );
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .context("transfer size overflow")?;
        ensure!(total <= size, RetentionFailure::CompletionUnknown);
        hash.update(&chunk[..count]);
    }
    ensure!(
        total == size && file.metadata()?.len() == size,
        RetentionFailure::CompletionUnknown
    );
    Ok(format!("{:x}", hash.finalize()))
}

fn absent(parent: &PrivateDirectory, name: &str) -> Result<()> {
    match parent.open_regular_file(OsStr::new(name)) {
        Err(error) if missing(&error) => Ok(()),
        _ => Err(RetentionFailure::CompletionUnknown.into()),
    }
}

fn accepted_artifact(
    id: &str,
    intent: &TransferIntent,
    a: &TransferArtifact,
) -> Result<TurnRetainedArtifactV1> {
    Ok(TurnRetainedArtifactV1 {
        retention_id: id.into(),
        expected_receipt_revision: intent.expected_receipt_revision,
        root_namespace: a.source.root_namespace.clone(),
        epoch: a.source.epoch,
        owner_id: a.source.owner_id.clone(),
        entry_id: a.source.entry_id.clone(),
        entry_revision: a.source.revision,
        artifact_name: a.name.clone(),
        artifact_parent_identity: intent.artifact_parent.clone(),
        artifact_identity: a.identity.clone().context("materialized inode absent")?,
        artifact_sha256: a.sha256.clone(),
        artifact_size: a.size,
    })
}

pub(super) fn canonical_input(
    scope: &Scope,
    client: &str,
    mut artifacts: Vec<TurnRetainedArtifactV1>,
) -> Result<TurnRetainedInputV1> {
    artifacts.sort_by(|a, b| {
        (
            &a.retention_id,
            &a.root_namespace,
            a.epoch,
            &a.owner_id,
            &a.entry_id,
        )
            .cmp(&(
                &b.retention_id,
                &b.root_namespace,
                b.epoch,
                &b.owner_id,
                &b.entry_id,
            ))
    });
    let input = TurnRetainedInputV1 {
        version: 1,
        scope_id: scope.hash.clone(),
        client_message_id: client.into(),
        artifacts,
    };
    input.validate().map_err(anyhow::Error::msg)?;
    Ok(input)
}

impl RetentionService {
    /// The delete producer uses this immutable snapshot before minting Accepted
    /// proof outside the namespace lock. Incomplete/unknown materialization is
    /// an error, never evidence that an Accepted record does not exist.
    pub fn thread_cleanup_transfer_query(
        &self,
        scope: &Scope,
        id: &str,
    ) -> Result<Option<AcceptedTurnQuery>> {
        checked_id(id, self.namespace())?;
        let tx = self.store.transaction()?;
        let receipt: Receipt = tx
            .read(Area::Receipts, id)?
            .context("cleanup transfer receipt missing")?;
        ensure!(
            receipt.scope_hash == scope.hash && receipt.wire.retention_id == id,
            RetentionFailure::Conflict
        );
        if receipt.transfer_intent.is_none() {
            ensure!(
                !matches!(
                    receipt.wire.state,
                    RetentionReceiptStateV1::Materializing | RetentionReceiptStateV1::Transferred
                ),
                RetentionFailure::CompletionUnknown
            );
            return Ok(None);
        }
        self.transfer_query(&tx, scope, &receipt).map(Some)
    }

    /// Resolve only existing receipt facts. Ready receipts have no attempt;
    /// pending/terminal receipts must agree on one original immutable request.
    pub fn retained_transfer_owner_ids(
        &self,
        scope: &Scope,
        thread: &str,
        client: &str,
        fingerprint: &str,
        references: &[TurnRetentionReferenceV1],
    ) -> Result<(Option<TurnAttemptIdentity>, Vec<String>)> {
        ensure!(
            !references.is_empty() && references.len() <= MAX_RETENTION_BATCH,
            RetentionFailure::Conflict
        );
        let tx = self.store.transaction()?;
        let mut receipts = BTreeSet::new();
        let mut entries = BTreeSet::new();
        let mut owners = BTreeSet::new();
        let mut identity = None;
        let mut pending = 0;
        for reference in references {
            checked_id(&reference.retention_id, self.namespace())?;
            ensure!(
                receipts.insert(&reference.retention_id),
                RetentionFailure::Conflict
            );
            let receipt: Receipt = tx
                .read(Area::Receipts, &reference.retention_id)?
                .context("transfer receipt absent")?;
            let own: BTreeSet<_> = reference.entry_ids.iter().collect();
            ensure!(
                receipt.scope_hash == scope.hash
                    && receipt.wire.thread_id == thread
                    && receipt.wire.retention_id == reference.retention_id
                    && !own.is_empty()
                    && own.len() == reference.entry_ids.len()
                    && own.len() == receipt.wire.entries.len()
                    && receipt.release_intent.is_none(),
                RetentionFailure::Conflict
            );
            for item in &receipt.wire.entries {
                ensure!(
                    own.contains(&item.stage_ref.entry_id)
                        && entries.insert(item.stage_ref.entry_id.clone()),
                    RetentionFailure::Conflict
                );
                let entry: Entry = tx
                    .read(Area::Entries, &item.stage_ref.entry_id)?
                    .context("transfer entry absent")?;
                ensure!(
                    entry.scope_hash == scope.hash
                        && entry.retention_id.as_deref() == Some(&reference.retention_id)
                        && stage(self.namespace(), &entry) == item.stage_ref,
                    RetentionFailure::Conflict
                );
                owners.insert(entry.owner_id);
            }
            if let Some(intent) = &receipt.transfer_intent {
                pending += 1;
                ensure!(
                    intent.version == 1
                        && intent.identity.thread_id == thread
                        && intent.client_message_id == client
                        && intent.request_fingerprint == fingerprint
                        && intent.expected_receipt_revision == reference.expected_revision,
                    RetentionFailure::Conflict
                );
                if let Some(prior) = &identity {
                    ensure!(prior == &intent.identity, RetentionFailure::Conflict);
                }
                identity = Some(intent.identity.clone());
            } else {
                ensure!(
                    receipt.wire.state == RetentionReceiptStateV1::Ready
                        && receipt.wire.revision == reference.expected_revision,
                    RetentionFailure::Conflict
                );
            }
        }
        ensure!(
            entries.len() <= MAX_RETENTION_BATCH && (pending == 0 || pending == references.len()),
            RetentionFailure::Conflict
        );
        Ok((identity, owners.into_iter().collect()))
    }

    pub fn retained_owner_leases(
        &self,
        scope: &Scope,
        owners: &[String],
    ) -> Result<Vec<OwnerLease>> {
        owners
            .iter()
            .map(|id| {
                self.recover_owner(scope, id)?
                    .context("retained owner is busy or unavailable")
            })
            .collect()
    }

    /// The wire adapter snapshots the complete query before preparing a proof.
    /// No attempt/artifact IO runs while this namespace transaction is held.
    pub fn retained_consume_query(
        &self,
        scope: &Scope,
        id: &str,
    ) -> Result<Option<AcceptedTurnQuery>> {
        checked_id(id, self.namespace())?;
        let tx = self.store.transaction()?;
        let Some(receipt) = tx.read::<Receipt>(Area::Receipts, id)? else {
            return Ok(None);
        };
        ensure!(
            receipt.scope_hash == scope.hash && receipt.wire.retention_id == id,
            RetentionFailure::Conflict
        );
        if tx.read::<Tombstone>(Area::Consumed, id)?.is_some()
            || receipt.wire.state == RetentionReceiptStateV1::Released
        {
            return Ok(None);
        }
        if receipt.wire.state != RetentionReceiptStateV1::Transferred {
            return Ok(None);
        }
        self.transfer_query(&tx, scope, &receipt).map(Some)
    }

    fn transfer_entry(
        &self,
        tx: &Transaction<'_>,
        scope: &Scope,
        receipt: &Receipt,
        a: &TransferArtifact,
    ) -> Result<Entry> {
        let entry: Entry = tx
            .read(Area::Entries, &a.source.entry_id)?
            .context("transfer entry missing")?;
        let owner = self.owner(tx, scope, &a.source.owner_id)?;
        ensure!(
            owner.phase == OwnerPhase::Active || entry.phase == EntryPhase::Transferred,
            RetentionFailure::Conflict
        );
        ensure!(
            entry.id == a.source.entry_id
                && entry.scope_hash == scope.hash
                && entry.owner_id == a.source.owner_id
                && entry.epoch == a.source.epoch
                && entry.revision == a.source.revision
                && entry.retention_id.as_deref() == Some(&receipt.wire.retention_id)
                && entry.directory_identity.as_ref() == Some(&a.source_parent)
                && entry.payload_identity.as_ref() == Some(&a.source_identity)
                && entry.content_sha256 == a.sha256
                && entry.size == a.size,
            RetentionFailure::Conflict
        );
        ensure!(
            a.source.root_namespace == self.namespace(),
            RetentionFailure::Conflict
        );
        let phase_matches = match a.phase {
            TransferPhase::Planned => {
                entry.phase == EntryPhase::Materializing && entry.transfer.is_none()
            }
            TransferPhase::Publishing => {
                entry.phase == EntryPhase::Materializing && entry.transfer.is_some()
            }
            TransferPhase::Copied
            | TransferPhase::RenamePending
            | TransferPhase::Quarantined
            | TransferPhase::Gone => entry.phase == EntryPhase::Copied && entry.transfer.is_some(),
            TransferPhase::Transferred => {
                entry.phase == EntryPhase::Transferred && entry.transfer.is_some()
            }
        };
        ensure!(phase_matches, RetentionFailure::Conflict);
        Ok(entry)
    }

    pub(super) fn transfer_query(
        &self,
        tx: &Transaction<'_>,
        scope: &Scope,
        receipt: &Receipt,
    ) -> Result<AcceptedTurnQuery> {
        let intent = receipt
            .transfer_intent
            .as_ref()
            .context("receipt has no transfer intent")?;
        ensure!(
            intent.version == 1
                && receipt.scope_hash == scope.hash
                && receipt.wire.thread_id == intent.identity.thread_id
                && receipt.wire.entries.len() == intent.artifacts.len(),
            RetentionFailure::Conflict
        );
        let terminal = matches!(
            receipt.wire.state,
            RetentionReceiptStateV1::Transferred | RetentionReceiptStateV1::Consumed
        );
        ensure!(
            terminal || receipt.wire.state == RetentionReceiptStateV1::Materializing,
            RetentionFailure::Conflict
        );
        ensure!(
            receipt.wire.revision
                == intent
                    .expected_receipt_revision
                    .checked_add(if terminal { 2 } else { 1 })
                    .context("transfer revision overflow")?,
            RetentionFailure::Conflict
        );
        let mut artifacts = Vec::new();
        for a in &intent.artifacts {
            ensure!(
                receipt
                    .wire
                    .entries
                    .iter()
                    .filter(|r| r.stage_ref == a.source)
                    .count()
                    == 1,
                RetentionFailure::Conflict
            );
            let entry = self.transfer_entry(tx, scope, receipt, a)?;
            let binding = entry
                .transfer
                .as_ref()
                .context("transfer entry binding absent")?;
            let artifact = accepted_artifact(&receipt.wire.retention_id, intent, a)?;
            ensure!(
                binding.thread_id == intent.identity.thread_id
                    && binding.attempt_id == intent.identity.attempt_id
                    && binding.client_message_id == intent.client_message_id
                    && binding.input_sha256 == intent.request_fingerprint
                    && binding.artifact_identity == artifact.artifact_identity
                    && binding.artifact_sha256 == artifact.artifact_sha256
                    && binding.artifact_size == artifact.artifact_size,
                RetentionFailure::Conflict
            );
            artifacts.push(artifact);
        }
        Ok(AcceptedTurnQuery {
            scope: scope.clone(),
            identity: intent.identity.clone(),
            request_fingerprint: intent.request_fingerprint.clone(),
            request_digest: intent.request_digest.clone(),
            materialization_digest: intent
                .materialization_digest
                .clone()
                .context("batch materialization is not committed")?,
            input: canonical_input(scope, &intent.client_message_id, artifacts)?,
        })
    }

    fn transfer_receipts(&self, scope: &Scope, request: &TransferRequest) -> Result<Vec<Receipt>> {
        request.identity.validate().map_err(anyhow::Error::msg)?;
        atom(&request.client_message_id)?;
        sha(&request.request_fingerprint)?;
        ensure!(
            !request.references.is_empty() && request.references.len() <= MAX_RETENTION_BATCH,
            RetentionFailure::Conflict
        );
        let tx = self.store.transaction()?;
        let mut receipts = Vec::new();
        let mut ids = BTreeSet::new();
        let mut entries = BTreeSet::new();
        for r in &request.references {
            checked_id(&r.retention_id, self.namespace())?;
            ensure!(
                ids.insert(&r.retention_id) && !r.entry_ids.is_empty(),
                RetentionFailure::Conflict
            );
            let receipt: Receipt = tx
                .read(Area::Receipts, &r.retention_id)?
                .context("transfer receipt missing")?;
            ensure!(
                receipt.scope_hash == scope.hash
                    && receipt.wire.retention_id == r.retention_id
                    && receipt.wire.thread_id == request.identity.thread_id
                    && receipt.release_intent.is_none()
                    && receipt.wire.entries.len() == r.entry_ids.len(),
                RetentionFailure::Conflict
            );
            let own: BTreeSet<_> = r.entry_ids.iter().collect();
            ensure!(
                own.len() == r.entry_ids.len()
                    && receipt
                        .wire
                        .entries
                        .iter()
                        .all(|e| own.contains(&e.stage_ref.entry_id)
                            && entries.insert(e.stage_ref.entry_id.clone())),
                RetentionFailure::Conflict
            );
            if let Some(intent) = &receipt.transfer_intent {
                ensure!(
                    intent.version == 1
                        && intent.identity == request.identity
                        && intent.client_message_id == request.client_message_id
                        && intent.request_fingerprint == request.request_fingerprint
                        && intent.expected_receipt_revision == r.expected_revision,
                    RetentionFailure::Conflict
                );
            } else {
                ensure!(
                    receipt.wire.revision == r.expected_revision
                        && receipt.wire.state == RetentionReceiptStateV1::Ready,
                    RetentionFailure::Conflict
                );
            }
            receipts.push(receipt);
        }
        ensure!(
            entries.len() <= MAX_RETENTION_BATCH,
            RetentionFailure::Conflict
        );
        receipts.sort_by(|a, b| a.wire.retention_id.cmp(&b.wire.retention_id));
        Ok(receipts)
    }

    /// All supplied leases are pinned in stable owner order. No lease wait or IO
    /// occurs while a namespace transaction is held.
    pub fn prepare_retained_transfer(
        &self,
        scope: &Scope,
        leases: &[&OwnerLease],
        request: &TransferRequest,
        parent: &PrivateDirectory,
    ) -> Result<TurnRetainedInputV1> {
        let _operations = self.transfer_operations(scope, leases)?;
        let mut receipts = self.transfer_receipts(scope, request)?;
        let parent_identity = parent.retention_identity()?;
        let mut tx = self.store.transaction()?;
        self.require_live_scope(&tx, scope)?;
        let mut planned = Vec::new();
        let mut additional = 0u64;
        for receipt in &mut receipts {
            let fresh: Receipt = tx
                .read(Area::Receipts, &receipt.wire.retention_id)?
                .context("receipt disappeared")?;
            ensure!(
                serde_json::to_value(&fresh)? == serde_json::to_value(&*receipt)?,
                RetentionFailure::Conflict
            );
            if let Some(intent) = &receipt.transfer_intent {
                ensure!(
                    intent.device_abort.is_none(),
                    RetentionFailure::CompletionUnknown
                );
                sha(&intent.request_digest)?;
                ensure!(
                    receipt.wire.state == RetentionReceiptStateV1::Materializing
                        && receipt.wire.revision
                            == intent
                                .expected_receipt_revision
                                .checked_add(1)
                                .context("transfer revision overflow")?,
                    RetentionFailure::Conflict
                );
                ensure!(
                    intent.artifact_parent == parent_identity,
                    RetentionFailure::Conflict
                );
                for a in &intent.artifacts {
                    self.transfer_entry(&tx, scope, receipt, a)?;
                    let mut a = a.clone();
                    // Before publication a placeholder is used only to validate
                    // the plan; request_digest deliberately excludes this inode.
                    if a.identity.is_none() {
                        a.identity = Some(a.source_identity.clone());
                    }
                    planned.push(accepted_artifact(&receipt.wire.retention_id, intent, &a)?);
                }
                continue;
            }
            let mut artifacts = Vec::new();
            for r in &receipt.wire.entries {
                let entry: Entry = tx
                    .read(Area::Entries, &r.stage_ref.entry_id)?
                    .context("transfer source missing")?;
                let lease = leases
                    .iter()
                    .find(|l| l.id == entry.owner_id)
                    .context("transfer owner lease missing")?;
                self.leased_owner(&tx, scope, lease)?;
                ensure!(
                    stage(self.namespace(), &entry) == r.stage_ref
                        && entry.scope_hash == scope.hash
                        && entry.retention_id.as_deref() == Some(&receipt.wire.retention_id)
                        && entry.phase == EntryPhase::Ready
                        && entry.transfer.is_none(),
                    RetentionFailure::Conflict
                );
                let name = format!(
                    "retained-{}",
                    digest(&serde_json::to_vec(&(
                        &scope.hash,
                        &request.identity,
                        &receipt.wire.retention_id,
                        &entry.id,
                        &request.client_message_id
                    ))?)
                );
                let a = TransferArtifact {
                    source: r.stage_ref.clone(),
                    source_parent: entry
                        .directory_identity
                        .clone()
                        .context("source parent absent")?,
                    source_identity: entry
                        .payload_identity
                        .clone()
                        .context("source inode absent")?,
                    name,
                    sha256: entry.content_sha256.clone(),
                    size: entry.size,
                    identity: None,
                    phase: TransferPhase::Planned,
                };
                additional = additional
                    .checked_add(entry.size)
                    .context("transfer size overflow")?;
                artifacts.push(a);
            }
            let intent = TransferIntent {
                version: 1,
                identity: request.identity.clone(),
                client_message_id: request.client_message_id.clone(),
                request_fingerprint: request.request_fingerprint.clone(),
                request_digest: String::new(),
                materialization_digest: None,
                artifact_parent: parent_identity.clone(),
                expected_receipt_revision: receipt.wire.revision,
                artifacts,
                device_abort: None,
            };
            for a in &intent.artifacts {
                let mut a = a.clone();
                a.identity = Some(a.source_identity.clone());
                planned.push(accepted_artifact(&receipt.wire.retention_id, &intent, &a)?);
            }
            receipt.transfer_intent = Some(intent);
        }
        let plan = canonical_input(scope, &request.client_message_id, planned)?;
        let plan_digest = request_digest(
            scope,
            &request.identity,
            &request.request_fingerprint,
            &plan,
        )?;
        tx.state.charges.transfer_bytes = tx
            .state
            .charges
            .transfer_bytes
            .checked_add(additional)
            .context("transfer charge overflow")?;
        for receipt in &mut receipts {
            let intent = receipt.transfer_intent.as_mut().unwrap();
            ensure!(
                intent.request_digest.is_empty() || intent.request_digest == plan_digest,
                RetentionFailure::Conflict
            );
            let new = intent.request_digest.is_empty();
            intent.request_digest = plan_digest.clone();
            if new {
                for a in &intent.artifacts {
                    let mut entry: Entry = tx
                        .read(Area::Entries, &a.source.entry_id)?
                        .context("source missing")?;
                    entry.phase = EntryPhase::Materializing;
                    tx.put(Area::Entries, &entry.id, entry.epoch, &entry)?;
                }
                receipt.wire.state = RetentionReceiptStateV1::Materializing;
                receipt.wire.revision = receipt
                    .wire
                    .revision
                    .checked_add(1)
                    .context("transfer revision overflow")?;
                for r in &mut receipt.wire.entries {
                    r.state = RetentionEntryStateV1::Materializing;
                }
                tx.put(
                    Area::Receipts,
                    &receipt.wire.retention_id,
                    receipt.epoch,
                    receipt,
                )?;
            }
        }
        // Reject every capacity/metadata failure before any destination byte IO.
        tx.validate_pending()?;
        tx.commit()?;
        for receipt in &mut receipts {
            for index in 0..receipt.transfer_intent.as_ref().unwrap().artifacts.len() {
                self.copy_transfer_artifact(scope, leases, receipt, index, parent)?;
            }
        }
        let input = canonical_input(
            scope,
            &request.client_message_id,
            receipts
                .iter()
                .flat_map(|r| {
                    let intent = r.transfer_intent.as_ref().unwrap();
                    intent
                        .artifacts
                        .iter()
                        .map(move |a| accepted_artifact(&r.wire.retention_id, intent, a))
                })
                .collect::<Result<Vec<_>>>()?,
        )?;
        let final_digest = materialization_digest(
            scope,
            &request.identity,
            &request.request_fingerprint,
            &input,
        )?;
        let mut tx = self.store.transaction()?;
        for receipt in &mut receipts {
            self.match_transfer_receipt(&tx, receipt)?;
            let intent = receipt.transfer_intent.as_mut().unwrap();
            ensure!(
                intent
                    .materialization_digest
                    .as_ref()
                    .is_none_or(|d| d == &final_digest),
                RetentionFailure::Conflict
            );
            intent.materialization_digest = Some(final_digest.clone());
            tx.put(
                Area::Receipts,
                &receipt.wire.retention_id,
                receipt.epoch,
                receipt,
            )?;
        }
        tx.commit()?;
        Ok(input)
    }

    pub(super) fn transfer_operations<'a>(
        &self,
        scope: &Scope,
        leases: &'a [&OwnerLease],
    ) -> Result<Vec<std::sync::MutexGuard<'a, ()>>> {
        ensure!(
            leases.windows(2).all(|w| w[0].id < w[1].id),
            RetentionFailure::Conflict
        );
        leases
            .iter()
            .map(|lease| {
                ensure!(lease.scope_hash == scope.hash, RetentionFailure::Conflict);
                lease
                    .operation
                    .lock()
                    .map_err(|_| anyhow::anyhow!("transfer owner lock poisoned"))
            })
            .collect()
    }

    fn match_transfer_receipt(&self, tx: &Transaction<'_>, receipt: &Receipt) -> Result<()> {
        let fresh: Receipt = tx
            .read(Area::Receipts, &receipt.wire.retention_id)?
            .context("transfer receipt missing")?;
        ensure!(
            serde_json::to_value(fresh)? == serde_json::to_value(receipt)?,
            RetentionFailure::Conflict
        );
        Ok(())
    }

    fn commit_transfer_artifact(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        receipt: &mut Receipt,
        next: Receipt,
        entry_phase: EntryPhase,
    ) -> Result<()> {
        let mut tx = self.store.transaction()?;
        self.leased_owner(&tx, scope, lease)?;
        self.match_transfer_receipt(&tx, receipt)?;
        for a in &next.transfer_intent.as_ref().unwrap().artifacts {
            let old = receipt
                .transfer_intent
                .as_ref()
                .unwrap()
                .artifacts
                .iter()
                .find(|old| old.source.entry_id == a.source.entry_id)
                .context("old transfer artifact missing")?;
            let mut entry = self.transfer_entry(&tx, scope, receipt, old)?;
            if next
                .transfer_intent
                .as_ref()
                .unwrap()
                .artifacts
                .iter()
                .find(|n| n.source.entry_id == entry.id)
                != receipt
                    .transfer_intent
                    .as_ref()
                    .unwrap()
                    .artifacts
                    .iter()
                    .find(|n| n.source.entry_id == entry.id)
            {
                entry.phase = entry_phase;
                if let Some(identity) = &a.identity {
                    entry.transfer = Some(TransferBinding {
                        thread_id: next.wire.thread_id.clone(),
                        client_message_id: next
                            .transfer_intent
                            .as_ref()
                            .unwrap()
                            .client_message_id
                            .clone(),
                        attempt_id: next
                            .transfer_intent
                            .as_ref()
                            .unwrap()
                            .identity
                            .attempt_id
                            .clone(),
                        input_sha256: next
                            .transfer_intent
                            .as_ref()
                            .unwrap()
                            .request_fingerprint
                            .clone(),
                        artifact_identity: identity.clone(),
                        artifact_sha256: a.sha256.clone(),
                        artifact_size: a.size,
                    });
                }
                tx.put(Area::Entries, &entry.id, entry.epoch, &entry)?;
            }
        }
        tx.put(Area::Receipts, &next.wire.retention_id, next.epoch, &next)?;
        tx.commit()?;
        *receipt = next;
        Ok(())
    }

    fn copy_transfer_artifact(
        &self,
        scope: &Scope,
        leases: &[&OwnerLease],
        receipt: &mut Receipt,
        index: usize,
        parent: &PrivateDirectory,
    ) -> Result<()> {
        let a = receipt.transfer_intent.as_ref().unwrap().artifacts[index].clone();
        parent.verify_retention_identity(
            &receipt.transfer_intent.as_ref().unwrap().artifact_parent,
        )?;
        let lease = *leases
            .iter()
            .find(|l| l.id == a.source.owner_id)
            .context("owner lease absent")?;
        let entry = {
            let tx = self.store.transaction()?;
            self.leased_owner(&tx, scope, lease)?;
            self.transfer_entry(&tx, scope, receipt, &a)?
        };
        if matches!(
            a.phase,
            TransferPhase::Copied
                | TransferPhase::RenamePending
                | TransferPhase::Quarantined
                | TransferPhase::Gone
                | TransferPhase::Transferred
        ) {
            return verify_artifact(
                parent,
                &accepted_artifact(
                    &receipt.wire.retention_id,
                    receipt.transfer_intent.as_ref().unwrap(),
                    &a,
                )?,
            );
        }
        ensure!(
            entry.phase == EntryPhase::Materializing,
            RetentionFailure::Conflict
        );
        if a.phase == TransferPhase::Publishing {
            let identity = a.identity.as_ref().context("publishing inode absent")?;
            match parent.open_verified_regular(OsStr::new(&a.name), identity) {
                Ok(_) => {
                    verify_artifact(
                        parent,
                        &accepted_artifact(
                            &receipt.wire.retention_id,
                            receipt.transfer_intent.as_ref().unwrap(),
                            &a,
                        )?,
                    )?;
                    parent.sync()?;
                    let mut next = receipt.clone();
                    next.transfer_intent.as_mut().unwrap().artifacts[index].phase =
                        TransferPhase::Copied;
                    return self.commit_transfer_artifact(
                        scope,
                        lease,
                        receipt,
                        next,
                        EntryPhase::Copied,
                    );
                }
                Err(error) if missing(&error) => {
                    absent(parent, &a.name)?;
                    parent.sync()?;
                }
                Err(error) => return Err(error),
            }
        } else {
            ensure!(
                a.phase == TransferPhase::Planned && a.identity.is_none(),
                RetentionFailure::Conflict
            );
            absent(parent, &a.name)?;
        }
        let owner = {
            let tx = self.store.transaction()?;
            self.leased_owner(&tx, scope, lease)?
        };
        let (source, name) = if entry.upload.is_some() {
            self.upload_location(&entry)?
        } else {
            (
                self.owner_data(&owner)?
                    .open_verified_child(OsStr::new(&entry.id), &a.source_parent)?,
                "payload".into(),
            )
        };
        source.verify_retention_identity(&a.source_parent)?;
        let verified = source.open_verified_regular(OsStr::new(&name), &a.source_identity)?;
        ensure!(
            verified.file().metadata()?.len() == a.size,
            RetentionFailure::CompletionUnknown
        );
        let anonymous = parent.create_anonymous_private_entry()?;
        let mut input = verified.file();
        let mut output = anonymous.file();
        let mut hash = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = input.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            ensure!(total <= a.size, RetentionFailure::CompletionUnknown);
            hash.update(&buffer[..n]);
            output.write_all(&buffer[..n])?;
        }
        ensure!(
            total == a.size && format!("{:x}", hash.finalize()) == a.sha256,
            RetentionFailure::CompletionUnknown
        );
        output.sync_all()?;
        source.open_verified_regular(OsStr::new(&name), &a.source_identity)?;
        let mut next = receipt.clone();
        let progress = &mut next.transfer_intent.as_mut().unwrap().artifacts[index];
        progress.identity = Some(anonymous.identity().clone());
        progress.phase = TransferPhase::Publishing;
        self.commit_transfer_artifact(scope, lease, receipt, next, EntryPhase::Materializing)?;
        transfer_pause("publishing", &receipt.wire.retention_id);
        parent.publish_anonymous_private_entry(&anonymous, OsStr::new(&a.name))?;
        parent.sync()?;
        transfer_pause("published", &receipt.wire.retention_id);
        let mut next = receipt.clone();
        next.transfer_intent.as_mut().unwrap().artifacts[index].phase = TransferPhase::Copied;
        self.commit_transfer_artifact(scope, lease, receipt, next, EntryPhase::Copied)
    }
}

#[cfg(all(test, target_os = "linux"))]
fn transfer_pause(phase: &str, id: &str) {
    tests::pause(phase, id);
}
#[cfg(not(all(test, target_os = "linux")))]
fn transfer_pause(_: &str, _: &str) {}

#[cfg(all(test, target_os = "linux"))]
#[path = "transfer_tests.rs"]
mod tests;

impl RetentionService {
    /// A whole-batch Accepted proof authorizes only this receipt's exact subset.
    /// Failure leaves its durable progress charged and resumable, never redispatches.
    pub fn finish_retained_transfer(
        &self,
        scope: &Scope,
        leases: &[&OwnerLease],
        id: &str,
        parent: &PrivateDirectory,
        proof: &dyn AcceptedTurnProof,
    ) -> Result<RetentionReceiptV1> {
        checked_id(id, self.namespace())?;
        let _operations = self.transfer_operations(scope, leases)?;
        let (mut receipt, query) = {
            let tx = self.store.transaction()?;
            let receipt: Receipt = tx
                .read(Area::Receipts, id)?
                .context("transfer receipt missing")?;
            ensure!(
                receipt.scope_hash == scope.hash && receipt.wire.retention_id == id,
                RetentionFailure::Conflict
            );
            let query = self.transfer_query(&tx, scope, &receipt)?;
            for a in &receipt.transfer_intent.as_ref().unwrap().artifacts {
                let lease = leases
                    .iter()
                    .find(|l| l.id == a.source.owner_id)
                    .context("transfer owner lease absent")?;
                self.leased_owner(&tx, scope, lease)?;
            }
            (receipt, query)
        };
        // Production proof is already minted outside the lock; this call is a
        // pure full-batch-token comparison, with no ledger/filesystem IO.
        ensure!(
            proof.is_exactly_accepted(&query)?,
            RetentionFailure::ProofUnavailable
        );
        for artifact in &query.input.artifacts {
            verify_artifact(parent, artifact)?;
        }
        if matches!(
            receipt.wire.state,
            RetentionReceiptStateV1::Transferred | RetentionReceiptStateV1::Consumed
        ) {
            ensure!(
                receipt
                    .transfer_intent
                    .as_ref()
                    .unwrap()
                    .artifacts
                    .iter()
                    .all(|a| a.phase == TransferPhase::Transferred),
                RetentionFailure::Conflict
            );
            return Ok(receipt.wire);
        }
        ensure!(
            receipt.wire.state == RetentionReceiptStateV1::Materializing,
            RetentionFailure::Conflict
        );
        for index in 0..receipt.transfer_intent.as_ref().unwrap().artifacts.len() {
            let owner_id = receipt.transfer_intent.as_ref().unwrap().artifacts[index]
                .source
                .owner_id
                .clone();
            let lease = *leases
                .iter()
                .find(|l| l.id == owner_id)
                .context("transfer lease absent")?;
            self.finish_transfer_artifact(scope, lease, &mut receipt, index, parent)?;
        }
        let mut tx = self.store.transaction()?;
        self.match_transfer_receipt(&tx, &receipt)?;
        ensure!(
            self.transfer_query(&tx, scope, &receipt)? == query,
            RetentionFailure::Conflict
        );
        ensure!(
            receipt
                .transfer_intent
                .as_ref()
                .unwrap()
                .artifacts
                .iter()
                .all(|a| a.phase == TransferPhase::Transferred),
            RetentionFailure::CompletionUnknown
        );
        receipt.wire.state = RetentionReceiptStateV1::Transferred;
        receipt.wire.revision = receipt
            .wire
            .revision
            .checked_add(1)
            .context("transfer revision overflow")?;
        for r in &mut receipt.wire.entries {
            r.state = RetentionEntryStateV1::Transferred;
        }
        tx.put(Area::Receipts, id, receipt.epoch, &receipt)?;
        tx.commit()?;
        Ok(receipt.wire)
    }

    fn finish_transfer_artifact(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        receipt: &mut Receipt,
        index: usize,
        parent: &PrivateDirectory,
    ) -> Result<()> {
        let mut a = receipt.transfer_intent.as_ref().unwrap().artifacts[index].clone();
        let (owner, entry) = {
            let tx = self.store.transaction()?;
            self.match_transfer_receipt(&tx, receipt)?;
            (
                self.leased_owner(&tx, scope, lease)?,
                self.transfer_entry(&tx, scope, receipt, &a)?,
            )
        };
        if a.phase == TransferPhase::Transferred {
            ensure!(
                entry.phase == EntryPhase::Transferred,
                RetentionFailure::Conflict
            );
            return Ok(());
        }
        verify_artifact(
            parent,
            &accepted_artifact(
                &receipt.wire.retention_id,
                receipt.transfer_intent.as_ref().unwrap(),
                &a,
            )?,
        )?;
        let root_leaf = entry.storage_layout() == UploadStorageLayout::RootLeafV1;
        let container = if entry.upload.is_some() {
            self.store.data()?
        } else {
            self.owner_data(&owner)?
        };
        let source_parent = if root_leaf {
            container.verify_retention_identity(&a.source_parent)?;
            Some(container)
        } else {
            match container.open_verified_child(OsStr::new(&entry.id), &a.source_parent) {
                Ok(d) => Some(d),
                Err(error) if missing(&error) && a.phase == TransferPhase::Gone => None,
                Err(error) => return Err(error),
            }
        };
        let source_name = if root_leaf {
            entry.upload_leaf()
        } else {
            "payload".into()
        };
        let quarantine = format!("q-transfer-{}", entry.id);
        if a.phase == TransferPhase::Copied {
            let source = source_parent
                .as_ref()
                .context("transfer source parent absent")?;
            source.open_verified_regular(OsStr::new(&source_name), &a.source_identity)?;
            absent(source, &quarantine)?;
            if !root_leaf {
                ensure!(
                    source.count_regular_files_bounded(|_| true, 2)? == 1,
                    RetentionFailure::CompletionUnknown
                );
            }
            let mut next = receipt.clone();
            next.transfer_intent.as_mut().unwrap().artifacts[index].phase =
                TransferPhase::RenamePending;
            self.commit_transfer_artifact(scope, lease, receipt, next, EntryPhase::Copied)?;
            a.phase = TransferPhase::RenamePending;
        }
        if a.phase == TransferPhase::RenamePending {
            let source = source_parent
                .as_ref()
                .context("transfer source parent absent")?;
            match source.open_verified_regular(OsStr::new(&quarantine), &a.source_identity) {
                Ok(_) => {
                    absent(source, &source_name)?;
                    source.sync()?;
                }
                Err(error) if missing(&error) => {
                    source.open_verified_regular(OsStr::new(&source_name), &a.source_identity)?;
                    source.quarantine_verified_entry_unflushed(
                        OsStr::new(&source_name),
                        &a.source_identity,
                        OsStr::new(&quarantine),
                    )?;
                    source.sync()?;
                }
                Err(error) => return Err(error),
            }
            transfer_pause("source-renamed", &receipt.wire.retention_id);
            let mut next = receipt.clone();
            next.transfer_intent.as_mut().unwrap().artifacts[index].phase =
                TransferPhase::Quarantined;
            self.commit_transfer_artifact(scope, lease, receipt, next, EntryPhase::Copied)?;
            a.phase = TransferPhase::Quarantined;
        }
        if a.phase == TransferPhase::Quarantined {
            let source = source_parent
                .as_ref()
                .context("transfer source parent absent")?;
            absent(source, &source_name)?;
            verify_artifact(
                parent,
                &accepted_artifact(
                    &receipt.wire.retention_id,
                    receipt.transfer_intent.as_ref().unwrap(),
                    &a,
                )?,
            )?;
            match source.open_verified_regular(OsStr::new(&quarantine), &a.source_identity) {
                Ok(_) => {
                    source.unlink_verified_regular_leaf_unflushed(
                        OsStr::new(&quarantine),
                        &a.source_identity,
                    )?;
                    source.sync()?;
                }
                Err(error) if missing(&error) => source.sync()?,
                Err(error) => return Err(error),
            }
            let mut next = receipt.clone();
            next.transfer_intent.as_mut().unwrap().artifacts[index].phase = TransferPhase::Gone;
            self.commit_transfer_artifact(scope, lease, receipt, next, EntryPhase::Copied)?;
            a.phase = TransferPhase::Gone;
            transfer_pause("source-gone", &receipt.wire.retention_id);
        }
        ensure!(
            a.phase == TransferPhase::Gone,
            RetentionFailure::CompletionUnknown
        );
        if let Some(source) = source_parent.as_ref() {
            absent(source, &source_name)?;
            absent(source, &quarantine)?;
            source.sync()?;
        }
        if !root_leaf {
            let container = if entry.upload.is_some() {
                self.store.data()?
            } else {
                self.owner_data(&owner)?
            };
            match container.open_verified_child(OsStr::new(&entry.id), &a.source_parent) {
                Ok(d) => {
                    ensure!(
                        d.count_regular_files_bounded(|_| true, 1)? == 0,
                        RetentionFailure::CompletionUnknown
                    );
                    container
                        .remove_verified_empty_directory(OsStr::new(&entry.id), &a.source_parent)?;
                }
                Err(error) if missing(&error) => container.sync()?,
                Err(error) => return Err(error),
            }
        }
        verify_artifact(
            parent,
            &accepted_artifact(
                &receipt.wire.retention_id,
                receipt.transfer_intent.as_ref().unwrap(),
                &a,
            )?,
        )?;
        let mut tx = self.store.transaction()?;
        self.match_transfer_receipt(&tx, receipt)?;
        let mut fresh = self.transfer_entry(&tx, scope, receipt, &a)?;
        ensure!(
            fresh.phase == EntryPhase::Copied,
            RetentionFailure::Conflict
        );
        let mut owner = self.leased_owner(&tx, scope, lease)?;
        fresh.phase = EntryPhase::Transferred;
        decrement(&mut tx.state.charges.staged_bytes, fresh.size)?;
        decrement(&mut tx.state.charges.transfer_bytes, fresh.size)?;
        decrement(&mut owner.bytes, fresh.size)?;
        decrement(
            &mut tx
                .state
                .epochs
                .get_mut(&fresh.epoch)
                .context("transfer epoch absent")?
                .nonterminal_allocations,
            1,
        )?;
        let mut next = receipt.clone();
        next.transfer_intent.as_mut().unwrap().artifacts[index].phase = TransferPhase::Transferred;
        tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
        tx.put(Area::Entries, &fresh.id, fresh.epoch, &fresh)?;
        tx.put(Area::Receipts, &next.wire.retention_id, next.epoch, &next)?;
        tx.commit()?;
        *receipt = next;
        Ok(())
    }
}
