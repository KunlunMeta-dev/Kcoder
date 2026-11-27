//! Persistent MCP consent and recovery use the original saved-definition ownership proof.
use super::*;
use crate::{
    batch::{BatchActionKind, BatchSource, settings::SettingsStep},
    credentials::CredentialPhase as Phase,
    mcp_credentials::{McpCredentialTarget, MigrationMcpPrivateField, safe_error},
};
use kcoder_config::{CredentialBackend, CredentialStoreMode};

#[cfg(test)]
thread_local! { static LOSE_ACTION_RECEIPT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
#[cfg(test)]
mod tests;

impl MigrationStore {
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_mcp_credentials(
        &self,
        job_id: &str,
        expected_sequence: u64,
        item_id: &str,
        fields: &[MigrationMcpPrivateField],
        consent: bool,
        target: &McpCredentialTarget,
        policy: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<MigrationJob> {
        ensure!(consent, "migration_mcp_private_consent_required");
        job_file(job_id)?;
        let _runner = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!(".{job_id}.runner.lock")))?
            .ok_or_else(|| crate::contention::busy(crate::contention::LeaseKind::BatchRunner))?;
        self.update(job_id, expected_sequence, |job| {
            ensure!(
                !matches!(
                    job.status,
                    JobStatus::RollingBack
                        | JobStatus::RolledBack
                        | JobStatus::Cancelled
                        | JobStatus::CancelRequested
                ),
                "migration_invalid_transition"
            );
            ensure!(
                job.credential_plans.len() + job.mcp_credential_plans.len() < 128,
                "migration_credential_budget_exceeded"
            );
            ensure!(
                !job.mcp_credential_plans
                    .iter()
                    .any(|plan| plan.item_id == item_id && plan.phase != Phase::Undone),
                "migration_mcp_private_plan_exists"
            );
            let item = job
                .inventory
                .items
                .iter()
                .find(|item| {
                    item.preview.id == item_id && item.preview.status == ItemStatus::Committed
                })
                .ok_or_else(|| anyhow::anyhow!("migration_mcp_private_saved_server_required"))?;
            let (source, config, operation_id) = if let Some(batch) = &job.batch {
                let source = match batch.source_for(item_id)? {
                    BatchSource::Configuration(binding) => binding,
                    _ => anyhow::bail!("migration_mcp_private_source_required"),
                };
                let action = batch
                    .actions
                    .iter()
                    .find(|action| {
                        action.item_ids.iter().any(|id| id == item_id)
                            && action.status == ItemStatus::Committed
                    })
                    .ok_or_else(|| {
                        anyhow::anyhow!("migration_mcp_private_saved_server_required")
                    })?;
                let plan = match &action.action {
                    BatchActionKind::Settings { plan } => {
                        plan.steps.iter().find_map(|step| match step {
                            SettingsStep::Mcp(plan) if plan.item().preview.id == item_id => {
                                Some(plan)
                            }
                            _ => None,
                        })
                    }
                    _ => None,
                }
                .ok_or_else(|| anyhow::anyhow!("migration_mcp_private_origin_required"))?;
                target.check_import(plan)?;
                (
                    source.clone(),
                    plan.config().clone(),
                    action.action_id.clone(),
                )
            } else {
                let plan = job
                    .mcp_plans
                    .iter()
                    .find(|plan| plan.item().preview.id == item_id)
                    .ok_or_else(|| anyhow::anyhow!("migration_not_an_mcp_server"))?;
                target.check_import(plan)?;
                (
                    job.source_binding
                        .clone()
                        .ok_or_else(|| anyhow::anyhow!("migration_mcp_private_source_required"))?,
                    plan.config().clone(),
                    plan.id().to_owned(),
                )
            };
            ensure!(
                job.receipts
                    .iter()
                    .any(|receipt| receipt.operation_id == operation_id
                        && receipt.ownership_confirmed),
                "migration_mcp_private_ownership_unknown"
            );
            self.require_unreferenced(job_id, &operation_id)?;
            let source = source.refreshed()?;
            let plan = target.prepare(item, &source, &config, fields, consent, policy, backend)?;
            job.mcp_credential_plans.push(plan);
            Ok(true)
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply_mcp_credentials(
        &self,
        job_id: &str,
        plan_id: &str,
        expected_sequence: u64,
        undo: bool,
        target: &McpCredentialTarget,
        policy: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<MigrationJob> {
        job_file(job_id)?;
        let _runner = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!(".{job_id}.runner.lock")))?
            .ok_or_else(|| crate::contention::busy(crate::contention::LeaseKind::BatchRunner))?;
        let plan = {
            let _lock = self.write_lock()?;
            let mut job = self.load(job_id)?;
            let index = job
                .mcp_credential_plans
                .iter()
                .position(|plan| plan.plan_id == plan_id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?;
            let plan = &job.mcp_credential_plans[index];
            ensure!(
                plan.atomic_group_id.is_none(),
                "migration_credential_group_operation_required"
            );
            ensure!(
                policy == plan.policy,
                "migration_mcp_private_storage_policy_changed"
            );
            if undo && plan.phase == Phase::Undone {
                return Ok(job);
            }
            let operation = job
                .mcp_plans
                .iter()
                .find(|candidate| candidate.item().preview.id == plan.item_id)
                .map(|candidate| candidate.id())
                .or_else(|| {
                    job.batch.as_ref().and_then(|batch| {
                        batch
                            .actions
                            .iter()
                            .find(|action| action.item_ids.contains(&plan.item_id))
                            .map(|action| action.action_id.as_str())
                    })
                })
                .ok_or_else(|| anyhow::anyhow!("migration_mcp_private_ownership_unknown"))?;
            self.require_unreferenced(job_id, operation)?;
            let terminal = !undo && plan.phase == Phase::Published;
            ensure!(
                job.sequence == expected_sequence
                    || terminal
                    || matches!(
                        plan.phase,
                        Phase::Applying | Phase::Unknown | Phase::Undoing
                    ),
                "migration_revision_conflict"
            );
            ensure!(
                undo || !plan.undo_requested && plan.phase != Phase::Undone,
                "migration_mcp_private_undo_pending"
            );
            ensure!(
                undo || terminal
                    || !matches!(
                        job.status,
                        JobStatus::Cancelled
                            | JobStatus::CancelRequested
                            | JobStatus::RollingBack
                            | JobStatus::RolledBack
                    ),
                "migration_invalid_transition"
            );
            if !terminal {
                job.mcp_credential_plans[index].phase = if undo {
                    Phase::Undoing
                } else {
                    Phase::Applying
                };
                job.mcp_credential_plans[index].undo_requested = undo;
                job.mcp_credential_plans[index].error_code = None;
                bump(&mut job)?;
                self.save(&job)?;
            }
            job.mcp_credential_plans[index].clone()
        };
        let result = if undo {
            target.undo(&plan, policy, backend)
        } else {
            target.publish(&plan, policy, backend)
        };
        #[cfg(test)]
        if result.is_ok() && LOSE_ACTION_RECEIPT.with(|fail| fail.replace(false)) {
            anyhow::bail!("migration_injected_lost_mcp_private_receipt");
        }
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        let index = job
            .mcp_credential_plans
            .iter()
            .position(|candidate| candidate.plan_id == plan_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?;
        match result {
            Ok(()) => {
                if !undo && plan.phase == Phase::Published {
                    return Ok(job);
                }
                job.mcp_credential_plans[index].phase = if undo {
                    Phase::Undone
                } else {
                    Phase::Published
                };
                job.mcp_credential_plans[index].error_code = None;
                sync_mcp_credential_issue(&mut job, index);
                bump(&mut job)?;
                self.save(&job)?;
                Ok(job)
            }
            Err(error) => {
                let error = safe_error(error);
                job.mcp_credential_plans[index].error_code = Some(error.to_string());
                job.mcp_credential_plans[index].phase = if undo {
                    Phase::Undoing
                } else if error.to_string().ends_with("_changed")
                    || error.to_string().ends_with("_exists")
                {
                    Phase::Conflict
                } else {
                    Phase::Unknown
                };
                bump(&mut job)?;
                self.save(&job)?;
                Err(error)
            }
        }
    }
}
pub(super) fn sync_mcp_credential_issue(job: &mut MigrationJob, index: usize) {
    use kcoder_types::migration::{
        MigrationIssue, MigrationIssueCode as Code, MigrationIssuePhase, MigrationIssueSeverity,
    };
    let plan = &job.mcp_credential_plans[index];
    let complete = plan.remaining_fields() == 0;
    if let Some(item) = job
        .inventory
        .items
        .iter_mut()
        .find(|item| item.preview.id == plan.item_id)
    {
        if plan.phase == Phase::Published && complete {
            item.preview
                .issues
                .retain(|issue| issue.code != Code::CredentialResolutionRequired);
        } else if plan.phase == Phase::Undone
            && !item
                .preview
                .issues
                .iter()
                .any(|issue| issue.code == Code::CredentialResolutionRequired)
        {
            item.preview.issues.push(MigrationIssue {
                code: Code::CredentialResolutionRequired,
                severity: MigrationIssueSeverity::Blocking,
                phase: MigrationIssuePhase::Activation,
                field: Some("credentials".into()),
            });
        }
    }
}
fn bump(job: &mut MigrationJob) -> Result<()> {
    job.sequence = job
        .sequence
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
    Ok(())
}
