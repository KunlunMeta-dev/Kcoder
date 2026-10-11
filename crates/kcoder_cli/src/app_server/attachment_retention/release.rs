//! Durable receipt-owned discard. Progress is derived from exact registered
//! entries; a busy lease never authorizes a refund or global Released state.
use super::*;

impl RetentionService {
    pub(in crate::app_server) fn release_receipt(
        &self,
        scope: &Scope,
        retention_id: &str,
        expected_revision: u64,
        reason: RetentionReleaseReasonV1,
    ) -> Result<RetentionReceiptV1> {
        // A wire reason is not the B6 durable deletion proof.
        ensure!(
            reason == RetentionReleaseReasonV1::Discard,
            RetentionFailure::ProofUnavailable
        );
        checked_id(retention_id, self.namespace())?;
        let wanted = ReleaseIntent {
            expected_revision,
            reason,
        };
        let owners = {
            let mut tx = self.store.transaction()?;
            let mut receipt: Receipt = tx
                .read(Area::Receipts, retention_id)?
                .context("retention release receipt missing")?;
            ensure!(
                receipt.scope_hash == scope.hash && receipt.wire.retention_id == retention_id,
                RetentionFailure::Conflict
            );
            if receipt.wire.state == RetentionReceiptStateV1::Consumed {
                ensure!(
                    receipt.release_intent.as_ref() == Some(&wanted),
                    RetentionFailure::Conflict
                );
                return Ok(receipt.wire);
            }
            ensure!(
                matches!(
                    receipt.wire.state,
                    RetentionReceiptStateV1::Ready
                        | RetentionReceiptStateV1::ReleasePending
                        | RetentionReceiptStateV1::Released
                ),
                RetentionFailure::CompletionUnknown
            );
            ensure!(
                receipt.cleanup_capacity == RECORD_BYTES,
                RetentionFailure::Capacity
            );
            if let Some(original) = &receipt.release_intent {
                ensure!(original == &wanted, RetentionFailure::Conflict);
            } else {
                ensure!(
                    receipt.wire.revision == expected_revision
                        && receipt.wire.state == RetentionReceiptStateV1::Ready,
                    RetentionFailure::Conflict
                );
            }
            ensure!(
                !receipt.wire.entries.is_empty()
                    && receipt.wire.entries.len() <= MAX_RETENTION_BATCH,
                RetentionFailure::CompletionUnknown
            );
            let mut owners = BTreeSet::new();
            let mut entries = BTreeSet::new();
            for reference in &receipt.wire.entries {
                ensure!(
                    entries.insert(reference.stage_ref.entry_id.clone()),
                    RetentionFailure::Conflict
                );
                let entry: Entry = tx
                    .read(Area::Entries, &reference.stage_ref.entry_id)?
                    .context("retention release entry missing")?;
                let owner = self.owner(&tx, scope, &entry.owner_id)?;
                ensure!(
                    entry.cleanup_capacity == RECORD_BYTES
                        && receipt.terminal_budget == 2 * RECORD_BYTES,
                    RetentionFailure::Capacity
                );
                ensure!(
                    entry.scope_hash == scope.hash
                        && entry.retention_id.as_deref() == Some(retention_id)
                        && entry.owner_id == reference.stage_ref.owner_id
                        && entry.epoch == reference.stage_ref.epoch
                        && entry.revision == reference.stage_ref.revision
                        && reference.stage_ref.root_namespace == self.namespace()
                        && owner.scope == *scope,
                    RetentionFailure::Conflict
                );
                ensure!(
                    matches!(
                        entry.phase,
                        EntryPhase::Ready
                            | EntryPhase::ReleasePending
                            | EntryPhase::RenamePending
                            | EntryPhase::Quarantined
                            | EntryPhase::PayloadGone
                            | EntryPhase::Released
                    ),
                    RetentionFailure::CompletionUnknown
                );
                if entry.phase != EntryPhase::Released {
                    ensure!(
                        owner.phase == OwnerPhase::Active,
                        RetentionFailure::CompletionUnknown
                    );
                    owners.insert(entry.owner_id);
                }
            }
            if receipt.release_intent.is_none() {
                receipt.release_intent = Some(wanted);
                receipt.wire.state = RetentionReceiptStateV1::ReleasePending;
                receipt.wire.revision = receipt
                    .wire
                    .revision
                    .checked_add(1)
                    .context("release revision overflow")?;
                for entry in &mut receipt.wire.entries {
                    entry.state = RetentionEntryStateV1::ReleasePending;
                }
                tx.put(Area::Receipts, retention_id, receipt.epoch, &receipt)?;
                tx.commit()?;
            }
            owners
        };
        // No namespace transaction is held across lease recovery or physical IO.
        // Sorted recovery is bounded by the receipt, with no unbounded cache.
        for owner_id in owners {
            let Some(lease) = self.recover_owner(scope, &owner_id)? else {
                continue;
            };
            self.release_original_owner(scope, &lease, retention_id, expected_revision)?;
        }
        #[cfg(all(test, target_os = "linux"))]
        pause_release_projection_test_hook("receipt", retention_id);
        let mut tx = self.store.transaction()?;
        let mut receipt: Receipt = tx
            .read(Area::Receipts, retention_id)?
            .context("retention release projection missing")?;
        ensure!(
            receipt.scope_hash == scope.hash
                && receipt.wire.retention_id == retention_id
                && receipt.release_intent.as_ref()
                    == Some(&ReleaseIntent {
                        expected_revision,
                        reason,
                    }),
            RetentionFailure::Conflict
        );
        // Another releaser may finish the receipt and consume it while this
        // operation is outside the namespace transaction. Never reverse it.
        if receipt.wire.state == RetentionReceiptStateV1::Consumed {
            return Ok(receipt.wire);
        }
        ensure!(
            matches!(
                receipt.wire.state,
                RetentionReceiptStateV1::ReleasePending | RetentionReceiptStateV1::Released
            ),
            RetentionFailure::CompletionUnknown
        );
        let mut all_released = true;
        for reference in &mut receipt.wire.entries {
            let entry: Entry = tx
                .read(Area::Entries, &reference.stage_ref.entry_id)?
                .context("release physical proof missing")?;
            ensure!(
                entry.scope_hash == scope.hash
                    && entry.retention_id.as_deref() == Some(retention_id),
                RetentionFailure::Conflict
            );
            if entry.phase == EntryPhase::Released {
                reference.state = RetentionEntryStateV1::Released;
            } else {
                all_released = false;
            }
        }
        ensure!(
            receipt.wire.state != RetentionReceiptStateV1::Released || all_released,
            RetentionFailure::CompletionUnknown
        );
        if all_released && receipt.wire.state == RetentionReceiptStateV1::ReleasePending {
            receipt.wire.state = RetentionReceiptStateV1::Released;
            receipt.wire.revision = receipt
                .wire
                .revision
                .checked_add(1)
                .context("release revision overflow")?;
        }
        tx.put(Area::Receipts, retention_id, receipt.epoch, &receipt)?;
        tx.commit()?;
        Ok(receipt.wire)
    }
}
