//! Legacy completed batches acquire their original common group without rerunning an action.
use super::*;
use crate::history_jobs::HistoryJobStore;
use kcoder_config::PrivateLeaseMode;
use kcoder_types::{
    external_history::HistoryImportStage,
    migration_resource::{MigrationResourceBudgetView, MigrationResourceLimits},
};

impl MigrationStore {
    pub fn attach_batch_resource_budget(
        &self,
        job_id: &str,
        plan_id: &str,
        expected_sequence: u64,
        limits: MigrationResourceLimits,
        confirm: bool,
        history: &HistoryJobStore,
    ) -> Result<MigrationResourceBudgetView> {
        ensure!(confirm, "migration_resource_consent_required");
        ensure!(limits.is_supported(), "history_resource_invalid_limits");
        job_file(job_id)?;
        history.verify_batch_parent(&self.directory)?;
        let name = format!(".{job_id}.runner.lock");
        let identity = self
            .directory
            .portable_regular_identity(OsStr::new(&name))
            .map_err(|_| anyhow::anyhow!("history_resource_parent_unknown"))?;
        let _runner = self
            .directory
            .try_existing_portable_lock(OsStr::new(&name), &identity, PrivateLeaseMode::Exclusive)?
            .ok_or_else(|| anyhow::anyhow!("history_resource_parent_busy"))?;
        let snapshot = {
            let _journal = self.journal_lock(false)?;
            let job = self.load(job_id)?;
            self.validate_legacy_resource_attachment(&job, plan_id)?;
            job
        };
        let batch = snapshot.batch.as_ref().unwrap();
        let mut sources = batch
            .actions
            .iter()
            .filter_map(|action| match &action.action {
                BatchActionKind::History { plan } => Some((
                    plan.history_job_id.clone(),
                    plan.source_fingerprint.clone(),
                    plan.normalization_revision.clone(),
                )),
                _ => None,
            })
            .collect::<Vec<_>>();
        sources.sort();
        ensure!(!sources.is_empty(), "migration_resource_not_started");
        let members = sources
            .iter()
            .map(|source| source.0.clone())
            .collect::<Vec<_>>();
        if let Some(original) = history.recorded_batch_resource_budget(job_id, members.clone())? {
            ensure!(
                original.initial_limits == limits,
                "history_resource_initial_limits_changed"
            );
            if !history.has_parent_resource_intent(job_id)? {
                // A legacy journal can omit limits while the original State group is intact.
                // This is a read of that existing group, not a fresh attachment receipt.
                ensure!(
                    snapshot.sequence == expected_sequence,
                    "migration_revision_conflict"
                );
                return self.batch_resource_budget(job_id, None);
            }
        }
        // Validate the complete set before any legacy execution identity can be upgraded.
        let mut views = Vec::new();
        for (child, fingerprint, revision) in &sources {
            let view = history.read(child)?;
            ensure!(
                view.stage == HistoryImportStage::Normalized
                    && !view.cancel_requested
                    && history.normalization_revision(child)? == *revision,
                "history_resource_parent_unknown"
            );
            let action = batch
                .actions
                .iter()
                .find(|action| {
                    matches!(&action.action,
                BatchActionKind::History { plan } if plan.history_job_id == *child)
                })
                .unwrap();
            ensure!(
                action.item_ids.len() == 1,
                "history_resource_parent_unknown"
            );
            let BatchSource::History(source) = batch.source_for(&action.item_ids[0])? else {
                anyhow::bail!("history_resource_parent_unknown")
            };
            ensure!(
                source.identity() == fingerprint && source.revision() == revision,
                "history_resource_parent_unknown"
            );
            history.verify_selected_snapshot(child, source.selection())?;
            // A born child's missing ledger is unknown, never an untracked legacy member.
            history.resource_budget(child, None)?;
            views.push(view);
        }
        let guards = views
            .iter()
            .map(|view| history.claim_execution(&view.job_id, view.sequence))
            .collect::<Result<Vec<_>>>()?;
        {
            let _journal = self.write_lock()?;
            let mut job = self.load(job_id)?;
            self.validate_legacy_resource_attachment(&job, plan_id)?;
            let current = job.batch.as_ref().unwrap();
            ensure!(current.actions == batch.actions, "migration_plan_changed");
            let fresh = current.resource_limits.is_none();
            if fresh {
                ensure!(
                    job.sequence == expected_sequence,
                    "migration_revision_conflict"
                );
            } else {
                ensure!(
                    current.resource_limits.as_ref() == Some(&limits),
                    "history_resource_initial_limits_changed"
                );
            }
            history.prepare_parent_resource_budget(
                job_id,
                plan_id,
                expected_sequence,
                sources,
                limits.clone(),
                fresh,
            )?;
            job.batch.as_mut().unwrap().resource_limits = Some(limits);
            // Policy attachment is separate from the job's execution/cancellation sequence.
            self.save(&job)?;
        }
        // No parent journal lease is held while a child verifies its reverse parent binding.
        for guard in &guards {
            history.bind_existing_resource_budget_owned(guard)?;
        }
        self.batch_resource_budget(job_id, None)
    }

    fn validate_legacy_resource_attachment(&self, job: &MigrationJob, plan_id: &str) -> Result<()> {
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        ensure!(
            batch.plan_id.as_deref() == Some(plan_id),
            "migration_plan_changed"
        );
        ensure!(
            matches!(
                job.status,
                JobStatus::Completed | JobStatus::CompletedWithIssues
            ) && batch
                .actions
                .iter()
                .all(|action| matches!(action.status, ItemStatus::Committed | ItemStatus::Skipped)),
            "migration_resource_job_not_mutable"
        );
        Ok(())
    }
}
