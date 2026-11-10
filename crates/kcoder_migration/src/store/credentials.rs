//! Credential steps publish only after their owning connection has been confirmed saved.
use super::batch::safe_code;
use super::*;
use crate::{
    batch::{BatchActionKind, BatchSource, settings::SettingsStep},
    credentials::{ApiKeySelector, CredentialPhase, CredentialTarget},
};
use kcoder_config::{CredentialBackend, CredentialStoreMode, imported_credentials::ImportState};

#[derive(Debug, Clone)]
pub struct CredentialResolution {
    pub item_id: String,
    pub selector: ApiKeySelector,
    pub consent_api_key: bool,
}
pub struct CredentialTargets<'a> {
    pub target: &'a CredentialTarget,
    pub backend: &'a dyn CredentialBackend,
    pub policy: CredentialStoreMode,
}

impl MigrationStore {
    pub fn prepare_credential(
        &self,
        job_id: &str,
        expected_sequence: u64,
        resolution: &CredentialResolution,
        targets: &CredentialTargets<'_>,
    ) -> Result<MigrationJob> {
        ensure!(
            resolution.consent_api_key,
            "migration_credential_consent_required"
        );
        self.update(job_id, expected_sequence, |job| {
            ensure!(
                job.sequence == expected_sequence,
                "migration_revision_conflict"
            );
            ensure!(
                job.credential_plans.len() + job.mcp_credential_plans.len() < 128,
                "migration_credential_budget_exceeded"
            );
            ensure!(
                !matches!(job.status, JobStatus::RollingBack | JobStatus::RolledBack),
                "migration_invalid_transition"
            );
            let item = job
                .inventory
                .items
                .iter()
                .find(|item| {
                    item.preview.id == resolution.item_id
                        && matches!(
                            item.preview.status,
                            ItemStatus::Committed | ItemStatus::Skipped | ItemStatus::Ready
                        )
                })
                .ok_or_else(|| anyhow::anyhow!("migration_credential_saved_provider_required"))?;
            let source = match &job.batch {
                Some(batch) => match batch.source_for(&item.preview.id)? {
                    BatchSource::Configuration(binding) => binding.clone(),
                    _ => anyhow::bail!("migration_credential_source_selection_required"),
                },
                None => job.source_binding.clone().ok_or_else(|| {
                    anyhow::anyhow!("migration_credential_source_selection_required")
                })?,
            };
            let target_name = if let Some(batch) = &job.batch {
                let action = batch
                    .actions
                    .iter()
                    .find(|action| action.item_ids.contains(&item.preview.id))
                    .ok_or_else(|| {
                        anyhow::anyhow!("migration_credential_saved_provider_required")
                    })?;
                match &action.action {
                    BatchActionKind::Settings { plan } => {
                        ensure!(
                            job.receipts
                                .iter()
                                .any(|receipt| receipt.operation_id == action.action_id
                                    && receipt.ownership_confirmed),
                            "migration_credential_provider_ownership_unknown"
                        );
                        plan.steps
                            .iter()
                            .find_map(|step| match step {
                                SettingsStep::Provider(plan)
                                    if plan.item().preview.id == item.preview.id =>
                                {
                                    Some(plan.target_name().to_owned())
                                }
                                _ => None,
                            })
                            .ok_or_else(|| anyhow::anyhow!("migration_not_a_provider"))?
                    }
                    BatchActionKind::Reuse { proof } => {
                        let previous = self.load(&proof.job_id)?;
                        ensure!(
                            matches!(
                                self.origin(&previous, &proof.action_id, &proof.item_id)?,
                                Some(super::reuse::Origin::Provider(_))
                            ),
                            "migration_credential_provider_ownership_unknown"
                        );
                        proof.target_name.clone()
                    }
                    _ => anyhow::bail!("migration_not_a_provider"),
                }
            } else {
                let plan = job
                    .provider_plans
                    .iter()
                    .find(|plan| plan.item().preview.id == item.preview.id)
                    .ok_or_else(|| anyhow::anyhow!("migration_not_a_provider"))?;
                ensure!(
                    job.receipts
                        .iter()
                        .any(|receipt| receipt.operation_id == plan.id()
                            && receipt.ownership_confirmed),
                    "migration_credential_provider_ownership_unknown"
                );
                plan.target_name().to_owned()
            };
            let source = if source.has_configuration_layers() {
                source.read()?;
                source.clone()
            } else {
                source.refreshed()?
            };
            let plan = targets.target.prepare(
                item,
                &source,
                &target_name,
                resolution.selector.clone(),
                targets.policy,
                targets.backend,
            )?;
            job.credential_plans.push(plan);
            Ok(true)
        })
    }

    pub fn apply_credential(
        &self,
        job_id: &str,
        plan_id: &str,
        expected_sequence: u64,
        undo: bool,
        targets: &CredentialTargets<'_>,
    ) -> Result<MigrationJob> {
        job_file(job_id)?;
        let _runner = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!(".{job_id}.credential.lock")))?
            .ok_or_else(|| {
                crate::contention::busy(crate::contention::LeaseKind::CredentialOperation)
            })?;
        let (plan, source_name, already_published) = {
            let _lock = self.write_lock()?;
            let mut job = self.load(job_id)?;
            let index = job
                .credential_plans
                .iter()
                .position(|plan| plan.plan_id == plan_id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?;
            let phase = job.credential_plans[index].phase;
            if undo && phase == CredentialPhase::Undone {
                return Ok(job);
            }
            let already_published = !undo && phase == CredentialPhase::Published;
            if !undo && !already_published {
                self.require_batch_credential_dependency(&job, plan_id)?;
            }
            ensure!(
                job.credential_plans[index].atomic_group_id.is_none() || already_published,
                "migration_credential_group_operation_required"
            );
            ensure!(
                job.sequence == expected_sequence
                    || already_published
                    || matches!(
                        phase,
                        CredentialPhase::Applying
                            | CredentialPhase::Unknown
                            | CredentialPhase::Undoing
                    ),
                "migration_revision_conflict"
            );
            ensure!(
                targets.policy == job.credential_plans[index].policy,
                "migration_credential_storage_policy_changed"
            );
            ensure!(
                !undo || phase != CredentialPhase::Ready,
                "migration_credential_receipt_required"
            );
            ensure!(
                undo || !matches!(phase, CredentialPhase::Undoing | CredentialPhase::Undone),
                "migration_credential_import_undone"
            );
            ensure!(
                undo || !job.credential_plans[index].undo_requested,
                "migration_credential_undo_pending"
            );
            let source_name = job
                .inventory
                .items
                .iter()
                .find(|item| item.preview.id == job.credential_plans[index].item_id)
                .map(|item| item.preview.source_name.clone())
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            if !already_published {
                job.credential_plans[index].phase = if undo {
                    CredentialPhase::Undoing
                } else {
                    CredentialPhase::Applying
                };
                job.credential_plans[index].undo_requested = undo;
                job.credential_plans[index].error_code = None;
                bump(&mut job)?;
                self.save(&job)?;
            }
            (
                job.credential_plans[index].clone(),
                source_name,
                already_published,
            )
        };
        let result = if already_published {
            // A terminal retry only observes the original binding, even if its source is gone.
            targets
                .target
                .state(&plan, targets.backend)
                .and_then(|state| {
                    ensure!(
                        state == Some(ImportState::Published),
                        "migration_credential_import_target_changed"
                    );
                    Ok(ImportState::Published)
                })
        } else if undo {
            targets.target.undo(&plan, targets.backend)
        } else {
            targets.target.publish(&plan, targets.backend, &source_name)
        };
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        let index = job
            .credential_plans
            .iter()
            .position(|candidate| candidate.plan_id == plan_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?;
        match result {
            Ok(state) => {
                if already_published {
                    return Ok(job);
                }
                job.credential_plans[index].phase = match state {
                    ImportState::Published => CredentialPhase::Published,
                    ImportState::Undone => CredentialPhase::Undone,
                    ImportState::Undoing => CredentialPhase::Undoing,
                    ImportState::Staged => CredentialPhase::Unknown,
                };
                job.credential_plans[index].error_code = None;
                sync_credential_issue(&mut job, index);
                bump(&mut job)?;
                self.save(&job)?;
                Ok(job)
            }
            Err(error) => {
                job.credential_plans[index].error_code = Some(safe_code(&error));
                job.credential_plans[index].phase = if matches!(
                    error.to_string().as_str(),
                    "migration_credential_import_target_changed"
                        | "migration_credential_import_target_exists"
                        | "migration_credential_import_referenced"
                        | "migration_credential_source_changed"
                        | "migration_source_changed"
                        | "migration_credential_destination_changed"
                ) {
                    CredentialPhase::Conflict
                } else if undo {
                    CredentialPhase::Undoing
                } else {
                    CredentialPhase::Unknown
                };
                bump(&mut job)?;
                self.save(&job)?;
                Err(error)
            }
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

pub(super) fn sync_credential_issue(job: &mut MigrationJob, index: usize) {
    use kcoder_types::migration::{
        MigrationIssue, MigrationIssueCode, MigrationIssuePhase, MigrationIssueSeverity,
    };
    let plan = &job.credential_plans[index];
    if let Some(item) = job
        .inventory
        .items
        .iter_mut()
        .find(|item| item.preview.id == plan.item_id)
    {
        if plan.phase == CredentialPhase::Published {
            item.preview
                .issues
                .retain(|issue| issue.code != MigrationIssueCode::CredentialResolutionRequired);
        } else if plan.phase == CredentialPhase::Undone
            && !item
                .preview
                .issues
                .iter()
                .any(|issue| issue.code == MigrationIssueCode::CredentialResolutionRequired)
        {
            item.preview.issues.push(MigrationIssue {
                code: MigrationIssueCode::CredentialResolutionRequired,
                severity: MigrationIssueSeverity::Blocking,
                phase: MigrationIssuePhase::Activation,
                field: Some("credentials".into()),
            });
        }
    }
}
