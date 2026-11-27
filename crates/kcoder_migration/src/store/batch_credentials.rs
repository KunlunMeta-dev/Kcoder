//! Optional API keys participate in one confirmed batch, with independent durable receipts.
use super::batch::{bump, safe_code};
use super::*;
use crate::{
    batch::{BatchActionKind, BatchPlanPolicy, BatchSource, BatchState, settings::SettingsStep},
    credentials::CredentialPhase as Phase,
};

impl MigrationStore {
    pub(super) fn prepare_batch_credentials(
        &self,
        job: &mut MigrationJob,
        batch: &mut BatchState,
        policy: &BatchPlanPolicy,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        ensure!(
            job.credential_plans.len() + job.mcp_credential_plans.len() + policy.credentials.len()
                <= 128,
            "migration_credential_budget_exceeded"
        );
        let mut selected = BTreeSet::new();
        let mut names = BTreeSet::new();
        if !policy.credentials.is_empty() {
            let keys = targets
                .credentials
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_credential_target_required"))?;
            ensure!(
                keys.target.directory_identity()? == targets.provider.directory_identity()?,
                "migration_wrong_target"
            );
        }
        for choice in &policy.credentials {
            ensure!(
                choice.consent_api_key,
                "migration_credential_consent_required"
            );
            ensure!(
                selected.insert(&choice.item_id),
                "migration_duplicate_selection"
            );
            let targets = targets
                .credentials
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_credential_target_required"))?;
            let item = job
                .inventory
                .items
                .iter()
                .find(|item| item.preview.id == choice.item_id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            let action = batch
                .actions
                .iter()
                .find(|action| action.item_ids.contains(&choice.item_id))
                .ok_or_else(|| anyhow::anyhow!("migration_credential_provider_not_selected"))?;
            let BatchSource::Configuration(binding) = batch.source_for(&choice.item_id)? else {
                anyhow::bail!("migration_not_a_provider")
            };
            let (name, provider) = match &action.action {
                BatchActionKind::Settings { plan } => plan
                    .steps
                    .iter()
                    .find_map(|step| match step {
                        SettingsStep::Provider(plan)
                            if plan.item().preview.id == choice.item_id =>
                        {
                            Some((plan.target_name().to_owned(), plan.provider().clone()))
                        }
                        _ => None,
                    })
                    .ok_or_else(|| anyhow::anyhow!("migration_not_a_provider"))?,
                BatchActionKind::Reuse { proof } => {
                    let previous = self.load(&proof.job_id)?;
                    let Some(super::reuse::Origin::Provider(provider)) =
                        self.origin(&previous, &proof.action_id, &proof.item_id)?
                    else {
                        anyhow::bail!("migration_not_a_provider")
                    };
                    (proof.target_name.clone(), provider.provider().clone())
                }
                _ => anyhow::bail!("migration_not_a_provider"),
            };
            ensure!(names.insert(name.clone()), "migration_duplicate_selection");
            let (normalized, _) = crate::providers::resolve(
                item,
                &crate::providers::ProviderResolution {
                    item_id: item.preview.id.clone(),
                    target_name: name.clone(),
                    endpoint: Some(provider.endpoint.clone()),
                    model: Some(provider.default_model.clone()),
                    limits: Some(crate::providers::ModelLimits {
                        context_window_tokens: provider.context_window_tokens as u64,
                        output_headroom_tokens: provider.output_headroom_tokens as u64,
                        max_output_tokens: provider.max_output_tokens as u64,
                    }),
                },
            )?;
            let plan = targets.target.prepare_prospective(
                &normalized,
                binding,
                (&name, provider),
                choice.selector.clone(),
                targets.policy,
                targets.backend,
            )?;
            batch.credential_plan_ids.push(plan.plan_id.clone());
            job.credential_plans.push(plan);
        }
        Ok(())
    }

    pub(super) fn require_batch_credential_dependency(
        &self,
        job: &MigrationJob,
        plan_id: &str,
    ) -> Result<()> {
        let Some(batch) = &job.batch else {
            return Ok(());
        };
        if !batch.credential_plan_ids.iter().any(|id| id == plan_id) {
            return Ok(());
        }
        ensure!(
            !matches!(
                job.status,
                JobStatus::CancelRequested
                    | JobStatus::Cancelled
                    | JobStatus::RollingBack
                    | JobStatus::RolledBack
                    | JobStatus::RollbackConflict
            ),
            "migration_cancel_pending"
        );
        let plan = job
            .credential_plans
            .iter()
            .find(|plan| plan.plan_id == plan_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?;
        let action = batch
            .actions
            .iter()
            .find(|action| action.item_ids.contains(&plan.item_id))
            .ok_or_else(|| anyhow::anyhow!("migration_credential_saved_provider_required"))?;
        ensure!(
            matches!(action.status, ItemStatus::Committed | ItemStatus::Skipped)
                && job
                    .receipts
                    .iter()
                    .any(|receipt| receipt.operation_id == action.action_id
                        && (receipt.ownership_confirmed
                            || matches!(action.action, BatchActionKind::Reuse { .. }))),
            "migration_credential_saved_provider_required"
        );
        Ok(())
    }

    pub(super) fn batch_credentials_pending(job: &MigrationJob, undo: bool) -> bool {
        let Some(batch) = &job.batch else {
            return false;
        };
        batch.credential_plan_ids.iter().any(|id| {
            let phase = job
                .credential_plans
                .iter()
                .find(|plan| &plan.plan_id == id)
                .map(|plan| plan.phase)
                .or_else(|| {
                    job.mcp_credential_plans
                        .iter()
                        .find(|plan| &plan.plan_id == id)
                        .map(|plan| plan.phase)
                });
            phase.is_none_or(|phase| {
                if undo {
                    phase != Phase::Undone
                } else {
                    !matches!(phase, Phase::Published | Phase::Undone)
                }
            })
        })
    }

    pub(super) fn batch_credentials_unknown(job: &MigrationJob) -> bool {
        let Some(batch) = &job.batch else {
            return false;
        };
        batch.credential_plan_ids.iter().any(|id| {
            let phase = job
                .credential_plans
                .iter()
                .find(|plan| &plan.plan_id == id)
                .map(|plan| plan.phase)
                .or_else(|| {
                    job.mcp_credential_plans
                        .iter()
                        .find(|plan| &plan.plan_id == id)
                        .map(|plan| plan.phase)
                });
            phase.is_some_and(|phase| {
                matches!(phase, Phase::Applying | Phase::Unknown | Phase::Undoing)
            })
        })
    }

    pub(super) fn run_batch_credentials(
        &self,
        job_id: &str,
        undo: bool,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        let job = self.read(job_id)?;
        let ids = &job.batch.as_ref().unwrap().credential_plan_ids;
        if ids.is_empty() {
            return Ok(());
        }
        let targets = targets
            .credentials
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_credential_target_required"))?;
        for id in ids {
            let current = self.read(job_id)?;
            let Some(plan) = current
                .credential_plans
                .iter()
                .find(|plan| &plan.plan_id == id)
            else {
                ensure!(
                    current
                        .mcp_credential_plans
                        .iter()
                        .any(|plan| &plan.plan_id == id && plan.atomic_group_id.is_some()),
                    "migration_invalid_journal"
                );
                continue;
            };
            if plan.atomic_group_id.is_some() {
                continue;
            }
            if plan.phase == Phase::Undone || !undo && plan.phase == Phase::Published {
                continue;
            }
            if !undo
                && matches!(
                    current.status,
                    JobStatus::Cancelled | JobStatus::CancelRequested
                )
                && matches!(plan.phase, Phase::Ready | Phase::Conflict)
            {
                continue;
            }
            let result = if undo && plan.phase == Phase::Ready {
                self.discard_batch_credential(job_id, id, targets)
            } else {
                self.apply_credential(
                    job_id,
                    id,
                    current.sequence,
                    undo || plan.undo_requested,
                    targets,
                )
                .map(|_| ())
            };
            if let Err(error) = result {
                let _lock = self.write_lock()?;
                let mut current = self.load(job_id)?;
                let plan = current
                    .credential_plans
                    .iter_mut()
                    .find(|plan| &plan.plan_id == id)
                    .unwrap();
                if plan.phase == Phase::Ready {
                    plan.error_code = Some(safe_code(&error));
                    bump(&mut current)?;
                    self.save(&current)?;
                }
            }
        }
        Ok(())
    }

    fn discard_batch_credential(
        &self,
        job_id: &str,
        id: &str,
        targets: &CredentialTargets<'_>,
    ) -> Result<()> {
        let _runner = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!(".{job_id}.credential.lock")))?
            .ok_or_else(|| {
                crate::contention::busy(crate::contention::LeaseKind::CredentialOperation)
            })?;
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        let plan = job
            .credential_plans
            .iter_mut()
            .find(|plan| plan.plan_id == id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?;
        ensure!(
            plan.phase == Phase::Ready && targets.target.state(plan, targets.backend)?.is_none(),
            "migration_credential_receipt_required"
        );
        plan.phase = Phase::Undone;
        plan.undo_requested = true;
        plan.error_code = None;
        bump(&mut job)?;
        self.save(&job)
    }
}
