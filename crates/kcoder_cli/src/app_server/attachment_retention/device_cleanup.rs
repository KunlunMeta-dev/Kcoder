//! Device cleanup over existing registered owners/receipts and prepaid slots.
use super::cleanup::ThreadCleanupCandidate;
use super::*;

pub(super) fn device_key(context: &TrustedRetentionContextV1) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&(
        "retention-revoked-device-v1",
        &context.gateway_namespace_id,
        &context.device_id,
        &context.authorization_generation,
    ))?))
}
fn statement_key(statement: &DeviceRevocationStatementV1) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&(
        "retention-revoked-device-v1",
        &statement.gateway_namespace_id,
        &statement.device_id,
        &statement.authorization_generation,
    ))?))
}
fn selected(scope: &Scope, request: &PrivateDeviceRevocationV1, workspace: &str) -> Result<bool> {
    ensure!(
        canonical_scope(scope)? == *scope,
        RetentionFailure::Conflict
    );
    Ok(scope.version == 2
        && scope.workspace_identity == workspace
        && scope.context.principal == RetentionPrincipalV1::LocalOs
        && scope.workspace_account.is_none()
        && scope.workspace_target_id.as_deref() == Some(request.route.target_id.as_str())
        && scope.context.target_fingerprint == request.route.target_fingerprint
        && scope.context.gateway_namespace_id == request.statement.gateway_namespace_id
        && scope.context.device_id == request.statement.device_id
        && scope.context.authorization_generation == request.statement.authorization_generation)
}

impl RetentionService {
    /// Advance the existing namespace's cursor before IO, including blocked
    /// entries. A pending/hostile first item cannot starve a later exact scope.
    pub fn device_cleanup_window<T>(
        &self,
        request: &PrivateDeviceRevocationV1,
        mut items: Vec<T>,
        owner: bool,
        id: impl Fn(&T) -> &str,
    ) -> Result<(Vec<T>, bool)> {
        items.sort_by(|a, b| id(a).cmp(id(b)));
        let more = items.len() > 32;
        let mut tx = self.store.transaction()?;
        let key = statement_key(&request.statement)?;
        ensure!(
            tx.state.device_revocations.get(&key) == Some(&request.statement_sha256),
            RetentionFailure::Conflict
        );
        let cursors = tx.state.device_cleanup_cursors.entry(key).or_default();
        let cursor = if owner {
            &mut cursors.1
        } else {
            &mut cursors.0
        };
        let start = items
            .iter()
            .position(|item| cursor.as_ref().is_none_or(|last| id(item) > last.as_str()))
            .unwrap_or(0);
        items.rotate_left(start);
        items.truncate(32);
        if let Some(last) = items.last() {
            *cursor = Some(id(last).into());
        }
        tx.commit()?;
        Ok((items, more))
    }
    pub fn resume_revoked_owner_retirement(
        &self,
        scope: &Scope,
        id: &str,
        statement: &str,
    ) -> Result<bool> {
        let phase = {
            let tx = self.store.transaction()?;
            let owner = self.owner(&tx, scope, id)?;
            if owner.phase == OwnerPhase::Active {
                return Ok(false);
            }
            ensure!(
                owner.device_cleanup.as_deref() == Some(statement),
                RetentionFailure::CompletionUnknown
            );
            owner.phase
        };
        ensure!(
            matches!(
                phase,
                OwnerPhase::Retiring
                    | OwnerPhase::Quarantined
                    | OwnerPhase::PayloadGone
                    | OwnerPhase::Retired
                    | OwnerPhase::Cancelled
            ),
            RetentionFailure::CompletionUnknown
        );
        ensure!(
            self.resume_owner_retirement(scope, id)?,
            RetentionFailure::CompletionUnknown
        );
        Ok(true)
    }
    pub(super) fn require_live_scope(&self, tx: &Transaction<'_>, scope: &Scope) -> Result<()> {
        ensure!(
            !tx.state
                .device_revocations
                .contains_key(&device_key(&scope.context)?),
            RetentionFailure::ProofUnavailable
        );
        Ok(())
    }

    /// Caller already authenticated the installation statement. The fence shares
    /// the allocation namespace transaction, so a concurrent new allocation
    /// cannot appear behind a completed scan. It never blocks read/release/consume.
    pub fn fence_revoked_device(&self, request: &PrivateDeviceRevocationV1) -> Result<()> {
        let key = statement_key(&request.statement)?;
        let mut tx = self.store.transaction()?;
        if let Some(previous) = tx.state.device_revocations.get(&key) {
            ensure!(
                previous == &request.statement_sha256,
                RetentionFailure::Conflict
            );
            return Ok(());
        }
        ensure!(
            tx.state.device_revocations.len() < 256,
            RetentionFailure::Capacity
        );
        tx.state
            .device_revocations
            .insert(key, request.statement_sha256.clone());
        tx.commit()
    }

    pub fn device_cleanup_candidates(
        &self,
        request: &PrivateDeviceRevocationV1,
        workspace: &str,
    ) -> Result<Vec<ThreadCleanupCandidate>> {
        self.administrative_cleanup_candidates(
            None,
            workspace,
            &RetentionPrincipalV1::LocalOs,
            |scope, receipt| {
                if !selected(scope, request, workspace).ok()? {
                    return None;
                }
                Some((
                    format!(
                        "device-revoke-{}",
                        digest(
                            &serde_json::to_vec(&(&request.statement_sha256, &scope.hash, receipt))
                                .ok()?
                        )
                    ),
                    RetentionAdministrativeReasonV1::DeviceRevoked {
                        gateway_namespace_id: request.statement.gateway_namespace_id.clone(),
                        device_id: request.statement.device_id.clone(),
                        authorization_generation: request
                            .statement
                            .authorization_generation
                            .clone(),
                        proof_sha256: request.statement_sha256.clone(),
                    },
                ))
            },
        )
    }

    pub fn unreserved_device_owners(
        &self,
        request: &PrivateDeviceRevocationV1,
        workspace: &str,
    ) -> Result<Vec<(Scope, String)>> {
        let tx = self.store.transaction()?;
        let mut result = Vec::new();
        for owner in tx.registered_owners()? {
            if !selected(&owner.scope, request, workspace)? {
                continue;
            }
            if matches!(owner.phase, OwnerPhase::Retired | OwnerPhase::Cancelled) {
                continue;
            }
            for id in &owner.entries {
                let entry: Entry = tx
                    .read(Area::Entries, id)?
                    .context("registered device entry missing")?;
                ensure!(
                    entry.owner_id == owner.id && entry.scope_hash == owner.scope.hash,
                    RetentionFailure::Conflict
                );
            }
            // Every matching unsettled owner remains pending, including mixed
            // consumed references and unreserved sources. Receipt processing
            // settles live references before per-entry owner cleanup can run.
            result.push((owner.scope, owner.id));
        }
        Ok(result)
    }

    /// Original exclusive owner lease -> operation -> namespace. An atomic
    /// owner intent plus all entry phases prevents late upload/reserve admission.
    /// Physical refunds still go through the existing verified release primitive.
    pub fn cancel_revoked_owner(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        statement_sha256: &str,
    ) -> Result<()> {
        let entries = {
            let _operation = lease
                .operation
                .lock()
                .map_err(|_| anyhow::anyhow!("owner operation poisoned"))?;
            let mut tx = self.store.transaction()?;
            let mut owner = self.leased_owner(&tx, scope, lease)?;
            ensure!(
                tx.state
                    .device_revocations
                    .get(&device_key(&scope.context)?)
                    == Some(&statement_sha256.to_string())
                    && owner.cleanup_capacity == RECORD_BYTES
                    && owner
                        .device_cleanup
                        .as_deref()
                        .is_none_or(|s| s == statement_sha256),
                RetentionFailure::Conflict
            );
            if owner.bytes == 0 && self.retirement_ready(&tx, &owner).is_ok() {
                owner.device_cleanup = Some(statement_sha256.into());
                tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
                tx.commit()?;
                drop(_operation);
                return self.retire_owner(scope, lease);
            }
            let mut entries = Vec::new();
            for id in &owner.entries {
                let mut entry: Entry = tx
                    .read(Area::Entries, id)?
                    .context("device owner entry missing")?;
                ensure!(
                    entry.owner_id == owner.id && entry.scope_hash == scope.hash,
                    RetentionFailure::CompletionUnknown
                );
                if entry.retention_id.is_some() {
                    // Keep the reference, tombstone and Accepted target intact.
                    // A live/unknown reference rejects the entire transaction.
                    self.retirement_entry_ready(&tx, &owner, &entry)?;
                    continue;
                }
                ensure!(
                    entry.transfer.is_none()
                        && entry.cleanup_capacity == RECORD_BYTES
                        && entry
                            .upload
                            .as_ref()
                            .is_none_or(|p| p.pending.is_none() && !p.payload_publishing),
                    RetentionFailure::CompletionUnknown
                );
                ensure!(
                    matches!(
                        entry.phase,
                        EntryPhase::Allocating
                            | EntryPhase::Sealing
                            | EntryPhase::Sealed
                            | EntryPhase::ReleasePending
                            | EntryPhase::RenamePending
                            | EntryPhase::Quarantined
                            | EntryPhase::PayloadGone
                            | EntryPhase::Cancelled
                    ),
                    RetentionFailure::CompletionUnknown
                );
                if matches!(
                    entry.phase,
                    EntryPhase::Allocating | EntryPhase::Sealing | EntryPhase::Sealed
                ) {
                    ensure!(
                        entry.payload_identity.is_some(),
                        RetentionFailure::CompletionUnknown
                    );
                    entry.phase = EntryPhase::ReleasePending;
                }
                tx.put(Area::Entries, &entry.id, entry.epoch, &entry)?;
                entries.push(entry.id);
            }
            owner.device_cleanup = Some(statement_sha256.into());
            tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
            tx.commit()?;
            entries
        };
        for id in entries {
            let _operation = lease
                .operation
                .lock()
                .map_err(|_| anyhow::anyhow!("owner operation poisoned"))?;
            let cancelled = {
                let tx = self.store.transaction()?;
                tx.read::<Entry>(Area::Entries, &id)?
                    .context("device entry missing")?
                    .phase
                    == EntryPhase::Cancelled
            };
            if !cancelled {
                self.release_entry(scope, lease, &id)?;
            }
            let mut tx = self.store.transaction()?;
            let mut entry: Entry = tx
                .read(Area::Entries, &id)?
                .context("device entry missing")?;
            if entry.phase == EntryPhase::Released && entry.retention_id.is_none() {
                entry.phase = EntryPhase::Cancelled;
                decrement(&mut tx.state.charges.entries, 1)?;
                decrement(&mut tx.state.charges.receipt_slots, 1)?;
                tx.put(Area::Entries, &id, entry.epoch, &entry)?;
                tx.commit()?;
            }
        }
        self.retire_owner(scope, lease)
    }
}
