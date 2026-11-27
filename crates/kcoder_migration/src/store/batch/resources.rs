//! Freeze one target-owned accounting group before any history child allocates archive payloads.
use super::*;
mod attachment;
mod attachment_read;
mod observation;

impl MigrationStore {
    pub(super) fn prepare_history_resources(
        &self,
        job: &MigrationJob,
        history: &crate::history_jobs::HistoryJobStore,
    ) -> Result<()> {
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        // Explicit execution upgrades an old parent's single common group before child IO.
        let limits = batch.resource_limits.clone().unwrap_or_default();
        let members = batch
            .actions
            .iter()
            .filter_map(|action| match &action.action {
                BatchActionKind::History { plan } => Some(plan.history_job_id.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        history.prepare_batch_resource_budget(
            &job.job_id,
            members,
            limits,
            batch.resource_limits.is_none(),
        )?;
        Ok(())
    }
}
