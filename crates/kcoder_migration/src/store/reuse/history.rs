//! History reuse observes the original normalized archive receipt without gaining deletion authority.
use super::*;
use crate::batch::history::{HistoryBatchAction, HistoryBatchSource};
use anyhow::Context;
use kcoder_types::external_history::HistoryImportStage;

pub(in crate::store) struct HistoryOrigin {
    source: HistoryBatchSource,
    plan: HistoryBatchAction,
    receipt: ItemCommitReceipt,
}

pub(super) fn requested_fingerprint(source: &HistoryBatchSource) -> Result<String> {
    source.validate()?;
    digest(&("history-reuse/1", source.identity(), source.revision()))
}

impl HistoryOrigin {
    pub(super) fn new(
        batch: &crate::batch::BatchState,
        item_id: &str,
        plan: &HistoryBatchAction,
        receipt: &ItemCommitReceipt,
    ) -> Result<Self> {
        let BatchSource::History(source) = batch.source_for(item_id)? else {
            anyhow::bail!("migration_invalid_journal")
        };
        source.validate()?;
        ensure!(
            plan.source_fingerprint == source.identity()
                && plan.normalization_revision == source.revision()
                && receipt.target_id == plan.history_job_id,
            "migration_history_batch_binding_changed"
        );
        Ok(Self {
            source: (**source).clone(),
            plan: plan.clone(),
            receipt: receipt.clone(),
        })
    }

    pub(super) fn fingerprint(&self) -> Result<String> {
        requested_fingerprint(&self.source)
    }
    pub(super) fn name(&self) -> &str {
        self.source.identity()
    }
    pub(super) fn job_id(&self) -> &str {
        &self.plan.history_job_id
    }
    pub(super) fn observe(
        &self,
        targets: &BatchTargets<'_>,
        directory: &PrivateDirectory,
    ) -> Result<Option<bool>> {
        let history = targets
            .history
            .context("migration_history_target_required")?;
        // Settings and history must resolve to the same authenticated profile.
        history.verify_batch_parent(directory)?;
        history.verify_selected_snapshot(self.job_id(), self.source.selection())?;
        let child = history.read(self.job_id())?;
        if child.stage != HistoryImportStage::Normalized
            || history.normalization_revision(self.job_id())? != self.plan.normalization_revision
        {
            return Ok(None);
        }
        let receipt = history.archive_reader(self.job_id())?.receipt()?;
        let Some(receipt) = receipt else {
            return Ok(None);
        };
        let revision = digest(&(
            "batch-history-receipt/1",
            &receipt,
            &self.plan.normalization_revision,
            &child.normalization,
        ))?;
        ensure!(
            revision == self.receipt.target_revision,
            "migration_reuse_target_changed"
        );
        Ok(Some(false))
    }
}

fn reference_binding(parent: &str, action: &str, proof: &ReuseProof) -> Result<(String, String)> {
    let operation = format!("batch-ref-{}", digest(&(parent, action))?);
    let binding = digest(&(
        "history-batch-reference/1",
        parent,
        action,
        &proof.job_id,
        &proof.action_id,
        &proof.item_id,
        &proof.history_job_id,
        &proof.source_key,
        &proof.fingerprint,
    ))?;
    Ok((operation, binding))
}

impl MigrationStore {
    pub(in crate::store) fn pin_history_reuse(
        &self,
        parent: &str,
        action: &str,
        proof: &mut ReuseProof,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        let Some(child) = &proof.history_job_id else {
            return Ok(());
        };
        let history = targets
            .history
            .context("migration_history_target_required")?;
        history.verify_batch_parent(&self.directory)?;
        let (operation, binding) = reference_binding(parent, action, proof)?;
        proof.history_reference = history
            .retain_batch_reference(child, &operation, &binding)?
            .map(Box::new);
        Ok(())
    }

    pub(in crate::store) fn verify_history_reuse(
        &self,
        parent: &str,
        action: &str,
        proof: &ReuseProof,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        let Some(child) = &proof.history_job_id else {
            ensure!(
                proof.history_reference.is_none(),
                "migration_reuse_target_changed"
            );
            return Ok(());
        };
        let history = targets
            .history
            .context("migration_history_target_required")?;
        history.verify_batch_parent(&self.directory)?;
        let (operation, binding) = reference_binding(parent, action, proof)?;
        ensure!(
            proof
                .history_reference
                .as_ref()
                .is_none_or(|receipt| receipt.matches_owner(
                    kcoder_state::external_history::lifecycle::ArchiveReferenceKind::BatchReference,
                    &operation,
                    &binding,
                )),
            "migration_reuse_target_changed"
        );
        history.verify_batch_reference(
            child,
            &operation,
            &binding,
            proof.history_reference.as_deref(),
        )
    }

    pub(in crate::store) fn release_history_reuse(
        &self,
        parent: &str,
        action: &str,
        proof: &ReuseProof,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        let Some(receipt) = &proof.history_reference else {
            return Ok(());
        };
        ensure!(
            proof.history_job_id.is_some(),
            "migration_reuse_target_changed"
        );
        let history = targets
            .history
            .context("migration_history_target_required")?;
        history.verify_batch_parent(&self.directory)?;
        let (operation, binding) = reference_binding(parent, action, proof)?;
        history.release_batch_reference(&operation, &binding, receipt)
    }

    pub(in crate::store) fn cleanup_history_reuse_staging(
        &self,
        parent: &str,
        staged: &[(String, ReuseProof)],
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        if staged.is_empty() {
            return Ok(());
        }
        // This is the same parent journal lease used by plan publication. Never release
        // a receipt while another prepare can concurrently make it visible.
        let _journal = self.write_lock()?;
        let current = self.load(parent)?;
        for (action_id, proof) in staged {
            let visible = current.batch.as_ref().is_some_and(|batch| {
                batch.actions.iter().any(|action| {
                    action.action_id == *action_id
                        && matches!(&action.action, BatchActionKind::Reuse { proof: saved }
                            if saved.history_reference == proof.history_reference)
                })
            });
            if !visible {
                self.release_history_reuse(parent, action_id, proof, targets)?;
            }
        }
        Ok(())
    }
}
