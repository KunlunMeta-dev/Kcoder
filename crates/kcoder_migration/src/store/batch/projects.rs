//! Project associations use the Config owner receipt and the ordinary parent batch.
use super::*;
use crate::project_migration::{ProjectReadCancellation, plan::ProjectAssociationPlan};
impl MigrationStore {
    pub fn verify_project_host_context(
        &self,
        job: &MigrationJob,
        workspace: &Path,
        registry: Option<&Path>,
    ) -> Result<()> {
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        for action in &batch.actions {
            match &action.action {
                BatchActionKind::Project { plan } => {
                    plan.verify_host_context(&self.profile, workspace, registry)?
                }
                BatchActionKind::Reuse { proof }
                    if matches!(
                        batch.source_for(&action.item_ids[0])?,
                        BatchSource::Project(_)
                    ) =>
                {
                    let previous = self.load(&proof.job_id)?;
                    let action = previous
                        .batch
                        .as_ref()
                        .and_then(|batch| {
                            batch.actions.iter().find(|action| {
                                action.action_id == proof.action_id
                                    && action.item_ids.contains(&proof.item_id)
                            })
                        })
                        .context("migration_invalid_journal")?;
                    let BatchActionKind::Project { plan } = &action.action else {
                        anyhow::bail!("migration_invalid_journal")
                    };
                    plan.verify_host_context(&self.profile, workspace, registry)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub fn project_report(
        &self,
        job_id: &str,
        item_id: &str,
        page: u32,
    ) -> Result<kcoder_types::migration_projects::MigrationProjectReportResult> {
        let job = self.read(job_id)?;
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        let BatchSource::Project(source) = batch.source_for(item_id)? else {
            anyhow::bail!("migration_invalid_batch_resolution")
        };
        let target = batch
            .actions
            .iter()
            .find(|a| a.item_ids.iter().any(|id| id == item_id))
            .map(|action| match &action.action {
                BatchActionKind::Project { plan } => {
                    Ok::<_, anyhow::Error>(Some(plan.record().clone()))
                }
                BatchActionKind::Reuse { proof } => {
                    let previous = self.load(&proof.job_id)?;
                    Ok(previous.batch.as_ref().and_then(|batch| {
                        batch.actions.iter().find_map(|action| {
                            if action.action_id == proof.action_id
                                && action.item_ids.contains(&proof.item_id)
                                && let BatchActionKind::Project { plan } = &action.action
                            {
                                return Some(plan.record().clone());
                            }
                            None
                        })
                    }))
                }
                _ => Ok(None),
            })
            .transpose()?
            .flatten();
        crate::project_migration::report::report(job_id, item_id, source, target.as_ref(), page)
    }

    pub(super) fn publish_project_batch_action(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        plan: &ProjectAssociationPlan,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<crate::providers::ProviderPublication> {
        ensure!(action.item_ids.len() == 1, "migration_invalid_journal");
        let BatchSource::Project(source) = job
            .batch
            .as_ref()
            .context("migration_not_a_batch")?
            .source_for(&action.item_ids[0])?
        else {
            anyhow::bail!("migration_invalid_batch_resolution")
        };
        let cancel = ProjectReadCancellation::default();
        if job.status == JobStatus::CancelRequested || !check(BatchRunEvent::Checkpoint) {
            cancel.cancel();
        }
        let receipt = plan.publish(&self.profile, source, &cancel)?;
        Ok(crate::providers::ProviderPublication {
            target_id: receipt.association_id,
            target_revision: receipt.record_sha256,
            ownership_confirmed: true,
        })
    }
    pub(super) fn undo_project_batch_action(
        &self,
        plan: &ProjectAssociationPlan,
        receipt: &ItemCommitReceipt,
    ) -> Result<()> {
        ensure!(
            receipt.ownership_confirmed
                && receipt.target_id == plan.id()
                && receipt.target_revision == plan.record_fingerprint()?,
            "migration_project_receipt_changed"
        );
        plan.undo(&self.profile)?;
        Ok(())
    }
}
