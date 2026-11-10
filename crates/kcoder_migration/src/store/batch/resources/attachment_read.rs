//! A read does not claim a runner, create an accounting group or repair an old header.
use super::*;
use crate::history_jobs::{ResourceAttachmentObservation, ResourceAttachmentPhase};

impl MigrationStore {
    pub fn resource_attachment(&self, job_id: &str) -> Result<ResourceAttachmentObservation> {
        let name = OsStr::new(".lock");
        let identity = self
            .directory
            .portable_regular_identity(name)
            .map_err(|_| anyhow::anyhow!("history_resource_parent_unknown"))?;
        let _journal = self
            .directory
            .try_existing_portable_lock(name, &identity, kcoder_config::PrivateLeaseMode::Shared)
            .map_err(|_| anyhow::anyhow!("history_resource_parent_unknown"))?
            .context("history_resource_parent_busy")?;
        let job = self.load(job_id)?;
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        let mut view = ResourceAttachmentObservation {
            job_id: job_id.into(),
            owner_job_id: Some(job_id.into()),
            current_sequence: job.sequence,
            current_plan_id: batch.plan_id.clone(),
            phase: ResourceAttachmentPhase::NotApplicable,
            original_intent: None,
            issue_code: None,
        };
        let Some(plan_id) = batch.plan_id.as_deref() else {
            return Ok(view);
        };
        let sources = batch
            .actions
            .iter()
            .filter_map(|action| match &action.action {
                BatchActionKind::History { plan } => Some((action, plan)),
                _ => None,
            })
            .collect::<Vec<_>>();
        if sources.is_empty() {
            return Ok(view);
        }
        let Some(history) = crate::history_jobs::HistoryJobStore::open_existing(&self.profile)?
        else {
            view.phase = ResourceAttachmentPhase::Unknown;
            view.issue_code = Some("history_resource_parent_unknown");
            return Ok(view);
        };
        history.verify_batch_parent(&self.directory)?;
        let mut selected = Vec::new();
        for (action, plan) in sources {
            if action.item_ids.len() != 1 {
                view.phase = ResourceAttachmentPhase::Unknown;
                view.issue_code = Some("history_resource_parent_unknown");
                return Ok(view);
            }
            let BatchSource::History(source) = batch.source_for(&action.item_ids[0])? else {
                anyhow::bail!("history_resource_parent_unknown")
            };
            ensure!(
                source.identity() == plan.source_fingerprint
                    && source.revision() == plan.normalization_revision,
                "history_resource_parent_unknown"
            );
            history.verify_selected_snapshot(&plan.history_job_id, source.selection())?;
            ensure!(
                history.normalization_revision(&plan.history_job_id)?
                    == plan.normalization_revision,
                "history_resource_parent_unknown"
            );
            selected.push((
                plan.history_job_id.clone(),
                plan.source_fingerprint.clone(),
                plan.normalization_revision.clone(),
            ));
        }
        history.inspect_parent_resource_attachment(
            job_id,
            job.sequence,
            plan_id,
            selected,
            batch.resource_limits.as_ref(),
        )
    }
}
