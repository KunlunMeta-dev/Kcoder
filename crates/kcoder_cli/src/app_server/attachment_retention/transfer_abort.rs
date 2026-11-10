//! Abort only a conclusively unaccepted batch under the original lifecycle,
//! session and owner leases. Existing receipt intent is the sole redo journal.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceAbortQuery {
    pub scope: Scope,
    pub identity: kcoder_types::TurnAttemptIdentity,
    pub client_message_id: String,
    pub request_fingerprint: String,
    pub query_sha256: String,
    pub owners: Vec<String>,
}

fn query(scope: &Scope, receipts: &[Receipt]) -> Result<DeviceAbortQuery> {
    let first = receipts
        .first()
        .context("device abort batch empty")?
        .transfer_intent
        .as_ref()
        .context("device abort intent missing")?;
    let mut owners = BTreeSet::new();
    let mut entries = BTreeSet::new();
    let mut plans = Vec::new();
    let mut planned = Vec::new();
    for receipt in receipts {
        let intent = receipt
            .transfer_intent
            .as_ref()
            .context("device abort intent missing")?;
        ensure!(
            receipt.scope_hash == scope.hash
                && receipt.wire.thread_id == intent.identity.thread_id
                && intent.identity == first.identity
                && intent.client_message_id == first.client_message_id
                && intent.request_fingerprint == first.request_fingerprint
                && intent.request_digest == first.request_digest
                && intent.artifacts.len() == receipt.wire.entries.len(),
            RetentionFailure::Conflict
        );
        let mut plan = intent.clone();
        plan.device_abort = None;
        for artifact in &plan.artifacts {
            ensure!(
                entries.insert(artifact.source.entry_id.clone())
                    && receipt
                        .wire
                        .entries
                        .iter()
                        .any(|r| r.stage_ref == artifact.source),
                RetentionFailure::Conflict
            );
            owners.insert(artifact.source.owner_id.clone());
            planned.push(kcoder_types::TurnRetainedArtifactV1 {
                retention_id: receipt.wire.retention_id.clone(),
                expected_receipt_revision: intent.expected_receipt_revision,
                root_namespace: artifact.source.root_namespace.clone(),
                epoch: artifact.source.epoch,
                owner_id: artifact.source.owner_id.clone(),
                entry_id: artifact.source.entry_id.clone(),
                entry_revision: artifact.source.revision,
                artifact_name: artifact.name.clone(),
                artifact_parent_identity: intent.artifact_parent.clone(),
                artifact_identity: artifact.source_identity.clone(),
                artifact_sha256: artifact.sha256.clone(),
                artifact_size: artifact.size,
            });
        }
        plans.push((&receipt.wire.retention_id, &receipt.wire.thread_id, plan));
    }
    ensure!(
        entries.len() <= MAX_RETENTION_BATCH,
        RetentionFailure::Conflict
    );
    let input = transfer::canonical_input(scope, &first.client_message_id, planned)?;
    ensure!(
        transfer::request_digest(scope, &first.identity, &first.request_fingerprint, &input)?
            == first.request_digest,
        RetentionFailure::Conflict
    );
    Ok(DeviceAbortQuery {
        scope: scope.clone(),
        identity: first.identity.clone(),
        client_message_id: first.client_message_id.clone(),
        request_fingerprint: first.request_fingerprint.clone(),
        query_sha256: digest(&serde_json::to_vec(&(
            "retention-device-abort-v1",
            scope,
            plans,
        ))?),
        owners: owners.into_iter().collect(),
    })
}

impl RetentionService {
    pub(super) fn verified_device_abort_in(
        &self,
        tx: &Transaction<'_>,
        scope: &Scope,
        receipt: &Receipt,
        statement: &str,
    ) -> Result<bool> {
        let Some(abort) = receipt
            .transfer_intent
            .as_ref()
            .and_then(|intent| intent.device_abort.as_ref())
        else {
            return Ok(false);
        };
        if !abort.complete {
            return Ok(false);
        }
        ensure!(
            tx.state
                .device_revocations
                .get(&device_cleanup::device_key(&scope.context)?)
                == Some(&statement.to_string()),
            RetentionFailure::ProofUnavailable
        );
        let receipts = self.abort_receipts(tx, scope, &receipt.wire.retention_id)?;
        let batch = query(scope, &receipts)?;
        for receipt in receipts {
            let intent = receipt.transfer_intent.as_ref().unwrap();
            let abort = intent
                .device_abort
                .as_ref()
                .context("device abort batch incomplete")?;
            ensure!(
                abort.complete
                    && abort.statement_sha256 == statement
                    && abort.query_sha256 == batch.query_sha256
                    && abort.artifacts.len() == intent.artifacts.len()
                    && intent
                        .artifacts
                        .iter()
                        .all(|artifact| abort.artifacts.get(&artifact.source.entry_id)
                            == Some(&RemovalPhase::Gone)),
                RetentionFailure::CompletionUnknown
            );
        }
        Ok(true)
    }
    fn abort_receipts(
        &self,
        tx: &Transaction<'_>,
        scope: &Scope,
        id: &str,
    ) -> Result<Vec<Receipt>> {
        let receipt: Receipt = tx
            .read(Area::Receipts, id)?
            .context("device abort receipt missing")?;
        ensure!(receipt.scope_hash == scope.hash, RetentionFailure::Conflict);
        let first = receipt
            .transfer_intent
            .as_ref()
            .context("device abort transfer missing")?;
        let mut receipts = Vec::new();
        for candidate in tx.registered_receipts()? {
            if candidate.scope_hash != scope.hash {
                continue;
            }
            if let Some(intent) = &candidate.transfer_intent
                && intent.identity == first.identity
            {
                ensure!(
                    intent.client_message_id == first.client_message_id
                        && intent.request_digest == first.request_digest
                        && intent.request_fingerprint == first.request_fingerprint,
                    RetentionFailure::Conflict
                );
                receipts.push(candidate);
            }
        }
        ensure!(
            !receipts.is_empty() && receipts.len() <= MAX_RETENTION_BATCH,
            RetentionFailure::Conflict
        );
        Ok(receipts)
    }

    pub fn device_abort_query(&self, scope: &Scope, id: &str) -> Result<Option<DeviceAbortQuery>> {
        let tx = self.store.transaction()?;
        let receipt: Receipt = tx
            .read(Area::Receipts, id)?
            .context("device receipt missing")?;
        ensure!(receipt.scope_hash == scope.hash, RetentionFailure::Conflict);
        let Some(intent) = &receipt.transfer_intent else {
            return Ok(None);
        };
        if intent.device_abort.as_ref().is_some_and(|a| a.complete) {
            return Ok(None);
        }
        query(scope, &self.abort_receipts(&tx, scope, id)?).map(Some)
    }

    pub fn device_transfer_aborted(&self, scope: &Scope, id: &str) -> Result<bool> {
        let tx = self.store.transaction()?;
        let receipt: Receipt = tx
            .read(Area::Receipts, id)?
            .context("device receipt missing")?;
        ensure!(receipt.scope_hash == scope.hash, RetentionFailure::Conflict);
        let Some(abort) = receipt
            .transfer_intent
            .as_ref()
            .and_then(|i| i.device_abort.as_ref())
        else {
            return Ok(false);
        };
        self.verified_device_abort_in(&tx, scope, &receipt, &abort.statement_sha256)
    }

    /// The adapter proves absence using the complete bounded attempt and client
    /// map while holding SessionLease; this service repeats every ledger tuple.
    pub fn abort_unaccepted_device_transfer(
        &self,
        wanted: &DeviceAbortQuery,
        id: &str,
        statement: &str,
        leases: &[&OwnerLease],
        parent: &PrivateDirectory,
    ) -> Result<()> {
        let _operations = self.transfer_operations(&wanted.scope, leases)?;
        let mut receipts = {
            let mut tx = self.store.transaction()?;
            ensure!(
                tx.state
                    .device_revocations
                    .get(&device_cleanup::device_key(&wanted.scope.context)?)
                    == Some(&statement.to_string()),
                RetentionFailure::ProofUnavailable
            );
            let mut receipts = self.abort_receipts(&tx, &wanted.scope, id)?;
            ensure!(
                query(&wanted.scope, &receipts)? == *wanted,
                RetentionFailure::Conflict
            );
            for receipt in &mut receipts {
                let intent = receipt.transfer_intent.as_mut().unwrap();
                parent.verify_retention_identity(&intent.artifact_parent)?;
                ensure!(
                    matches!(
                        receipt.wire.state,
                        RetentionReceiptStateV1::Materializing | RetentionReceiptStateV1::Ready
                    ),
                    RetentionFailure::Conflict
                );
                for artifact in &intent.artifacts {
                    let lease = leases
                        .iter()
                        .find(|l| l.id == artifact.source.owner_id)
                        .context("device abort owner lease absent")?;
                    self.leased_owner(&tx, &wanted.scope, lease)?;
                    ensure!(
                        matches!(
                            artifact.phase,
                            TransferPhase::Planned
                                | TransferPhase::Publishing
                                | TransferPhase::Copied
                        ),
                        RetentionFailure::CompletionUnknown
                    );
                }
                if let Some(abort) = &intent.device_abort {
                    ensure!(
                        abort.statement_sha256 == statement
                            && abort.query_sha256 == wanted.query_sha256,
                        RetentionFailure::Conflict
                    );
                } else {
                    intent.device_abort = Some(DeviceTransferAbort {
                        statement_sha256: statement.into(),
                        query_sha256: wanted.query_sha256.clone(),
                        artifacts: intent
                            .artifacts
                            .iter()
                            .map(|a| (a.source.entry_id.clone(), RemovalPhase::RenamePending))
                            .collect(),
                        complete: false,
                    });
                }
                tx.put(
                    Area::Receipts,
                    &receipt.wire.retention_id,
                    receipt.epoch,
                    receipt,
                )?;
            }
            tx.commit()?;
            receipts
        };
        for receipt in &mut receipts {
            let count = receipt.transfer_intent.as_ref().unwrap().artifacts.len();
            for index in 0..count {
                let artifact = receipt.transfer_intent.as_ref().unwrap().artifacts[index].clone();
                let quarantine = format!(
                    "abort-{}",
                    digest(&serde_json::to_vec(&(
                        statement,
                        &wanted.query_sha256,
                        &artifact.name
                    ))?)
                );
                let phase = receipt
                    .transfer_intent
                    .as_ref()
                    .unwrap()
                    .device_abort
                    .as_ref()
                    .unwrap()
                    .artifacts[&artifact.source.entry_id];
                if phase == RemovalPhase::RenamePending {
                    match parent.open_regular_file(OsStr::new(&artifact.name)) {
                        Ok(_) => {
                            let identity = artifact
                                .identity
                                .as_ref()
                                .context("unpublished foreign abort target present")?;
                            verify_abort_target(
                                parent,
                                &artifact.name,
                                identity,
                                artifact.size,
                                &artifact.sha256,
                            )?;
                            parent.quarantine_verified_entry_unflushed(
                                OsStr::new(&artifact.name),
                                identity,
                                OsStr::new(&quarantine),
                            )?;
                        }
                        Err(error) if missing(&error) => {
                            if let Some(identity) = &artifact.identity {
                                match parent.open_regular_file(OsStr::new(&quarantine)) {
                                    Ok(_) => verify_abort_target(
                                        parent,
                                        &quarantine,
                                        identity,
                                        artifact.size,
                                        &artifact.sha256,
                                    )?,
                                    Err(error) if missing(&error) => (),
                                    Err(error) => return Err(error),
                                }
                            } else {
                                absent_abort_target(parent, &quarantine)?;
                            }
                        }
                        Err(error) => return Err(error),
                    }
                    parent.sync()?;
                    self.abort_phase(
                        receipt,
                        &artifact.source.entry_id,
                        RemovalPhase::Quarantined,
                    )?;
                }
                if receipt
                    .transfer_intent
                    .as_ref()
                    .unwrap()
                    .device_abort
                    .as_ref()
                    .unwrap()
                    .artifacts[&artifact.source.entry_id]
                    == RemovalPhase::Quarantined
                {
                    absent_abort_target(parent, &artifact.name)?;
                    match parent.open_regular_file(OsStr::new(&quarantine)) {
                        Ok(_) => {
                            let identity = artifact
                                .identity
                                .as_ref()
                                .context("foreign abort quarantine present")?;
                            verify_abort_target(
                                parent,
                                &quarantine,
                                identity,
                                artifact.size,
                                &artifact.sha256,
                            )?;
                            parent.unlink_verified_regular_leaf_unflushed(
                                OsStr::new(&quarantine),
                                identity,
                            )?;
                        }
                        Err(error) if missing(&error) => (),
                        Err(error) => return Err(error),
                    }
                    parent.sync()?;
                    self.abort_phase(receipt, &artifact.source.entry_id, RemovalPhase::Gone)?;
                }
            }
        }
        let mut tx = self.store.transaction()?;
        for receipt in &mut receipts {
            let fresh: Receipt = tx
                .read(Area::Receipts, &receipt.wire.retention_id)?
                .context("abort receipt disappeared")?;
            ensure!(
                serde_json::to_value(&fresh)? == serde_json::to_value(&*receipt)?,
                RetentionFailure::Conflict
            );
            let intent = receipt.transfer_intent.as_mut().unwrap();
            let abort = intent.device_abort.as_mut().unwrap();
            ensure!(
                abort.artifacts.values().all(|p| *p == RemovalPhase::Gone),
                RetentionFailure::CompletionUnknown
            );
            if abort.complete {
                continue;
            }
            for artifact in &intent.artifacts {
                absent_abort_target(parent, &artifact.name)?;
                let mut entry: Entry = tx
                    .read(Area::Entries, &artifact.source.entry_id)?
                    .context("abort source missing")?;
                ensure!(
                    entry.scope_hash == wanted.scope.hash
                        && stage(self.namespace(), &entry) == artifact.source
                        && entry.retention_id.as_deref()
                            == Some(receipt.wire.retention_id.as_str())
                        && matches!(entry.phase, EntryPhase::Materializing | EntryPhase::Copied),
                    RetentionFailure::Conflict
                );
                entry.phase = EntryPhase::Ready;
                entry.transfer = None;
                decrement(&mut tx.state.charges.transfer_bytes, artifact.size)?;
                tx.put(Area::Entries, &entry.id, entry.epoch, &entry)?;
            }
            abort.complete = true;
            receipt.wire.state = RetentionReceiptStateV1::Ready;
            receipt.wire.revision = receipt
                .wire
                .revision
                .checked_add(1)
                .context("abort revision overflow")?;
            for reference in &mut receipt.wire.entries {
                reference.state = RetentionEntryStateV1::Ready;
            }
            tx.put(
                Area::Receipts,
                &receipt.wire.retention_id,
                receipt.epoch,
                receipt,
            )?;
        }
        parent.sync()?;
        tx.commit()
    }

    fn abort_phase(&self, receipt: &mut Receipt, entry: &str, phase: RemovalPhase) -> Result<()> {
        let mut tx = self.store.transaction()?;
        let fresh: Receipt = tx
            .read(Area::Receipts, &receipt.wire.retention_id)?
            .context("abort receipt missing")?;
        ensure!(
            serde_json::to_value(&fresh)? == serde_json::to_value(&*receipt)?,
            RetentionFailure::Conflict
        );
        receipt
            .transfer_intent
            .as_mut()
            .unwrap()
            .device_abort
            .as_mut()
            .unwrap()
            .artifacts
            .insert(entry.into(), phase);
        tx.put(
            Area::Receipts,
            &receipt.wire.retention_id,
            receipt.epoch,
            receipt,
        )?;
        tx.commit()
    }
}

fn absent_abort_target(parent: &PrivateDirectory, name: &str) -> Result<()> {
    match parent.open_regular_file(OsStr::new(name)) {
        Err(e) if missing(&e) => Ok(()),
        Err(e) => Err(e),
        Ok(_) => Err(RetentionFailure::CompletionUnknown.into()),
    }
}
fn verify_abort_target(
    parent: &PrivateDirectory,
    name: &str,
    identity: &kcoder_types::PrivateFileIdentityV1,
    size: u64,
    hash: &str,
) -> Result<()> {
    let handle = parent.open_verified_regular(OsStr::new(name), identity)?;
    ensure!(
        handle.file().metadata()?.len() == size,
        RetentionFailure::CompletionUnknown
    );
    let mut file = handle.file();
    let mut digest = Sha256::new();
    let mut bytes = [0; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = file.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        ensure!(total <= size, RetentionFailure::CompletionUnknown);
        digest.update(&bytes[..count]);
    }
    ensure!(
        total == size && format!("{:x}", digest.finalize()) == hash,
        RetentionFailure::CompletionUnknown
    );
    parent.open_verified_regular(OsStr::new(name), identity)?;
    Ok(())
}
