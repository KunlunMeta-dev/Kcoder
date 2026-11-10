use super::*;
use crate::{
    batch::{BatchAction, BatchActionKind, BatchState, settings::SettingsStep},
    templates::{ProviderDependency, TemplateResolution},
};
#[cfg(test)]
mod tests;

pub fn provider_item_id(job: &MigrationJob, template_id: &str) -> Option<String> {
    let item = job
        .inventory
        .items
        .iter()
        .find(|item| item.preview.id == template_id)?;
    let candidate = item.template.as_ref()?;
    let batch = job.batch.as_ref()?;
    let source = batch
        .item_sources
        .iter()
        .find(|source| source.item_id == template_id)?
        .source_index;
    job.inventory
        .items
        .iter()
        .find(|provider| {
            provider.provider.is_some()
                && provider.preview.source_name == candidate.source_provider
                && batch.item_sources.iter().any(|binding| {
                    binding.item_id == provider.preview.id && binding.source_index == source
                })
        })
        .map(|item| item.preview.id.clone())
}

impl MigrationStore {
    pub(super) fn prepare_batch_templates(
        &self,
        job: &mut MigrationJob,
        batch: &mut BatchState,
        resolutions: &[TemplateResolution],
        targets: &BatchTargets<'_>,
        reuse_existing: bool,
        candidates: &[crate::batch::ReuseProof],
    ) -> Result<()> {
        if resolutions.is_empty() {
            return Ok(());
        }
        ensure!(
            targets.provider.templates()?.identity() == targets.provider.directory_identity()?,
            "migration_wrong_target"
        );
        let mut names = BTreeSet::new();
        for resolution in resolutions {
            ensure!(
                provider_item_id(job, &resolution.item_id).as_deref()
                    == Some(&resolution.provider_item_id),
                "migration_template_dependency_mismatch"
            );
            ensure!(
                names.insert(&resolution.target_name),
                "migration_target_conflict"
            );
            let dependency = batch
                .actions
                .iter()
                .find_map(|action| {
                    if !action.item_ids.contains(&resolution.provider_item_id) {
                        return None;
                    }
                    match &action.action {
                        BatchActionKind::Settings { plan } => {
                            plan.steps.iter().find_map(|step| match step {
                                SettingsStep::Provider(plan)
                                    if plan.item().preview.id == resolution.provider_item_id =>
                                {
                                    Some(Ok(ProviderDependency {
                                        item_id: resolution.provider_item_id.clone(),
                                        action_id: action.action_id.clone(),
                                        name: plan.target_name().into(),
                                        definition: plan.provider().clone(),
                                    }))
                                }
                                _ => None,
                            })
                        }
                        BatchActionKind::Reuse { proof } => Some((|| {
                            self.observe_reuse(proof, targets)?;
                            let previous = self.load(&proof.job_id)?;
                            match self.origin(&previous, &proof.action_id, &proof.item_id)? {
                                Some(super::reuse::Origin::Provider(plan)) => {
                                    Ok(ProviderDependency {
                                        item_id: resolution.provider_item_id.clone(),
                                        action_id: action.action_id.clone(),
                                        name: plan.target_name().into(),
                                        definition: plan.provider().clone(),
                                    })
                                }
                                _ => anyhow::bail!("migration_template_dependency_mismatch"),
                            }
                        })()),
                        _ => None,
                    }
                })
                .ok_or_else(|| {
                    anyhow::anyhow!("migration_template_provider_selection_required")
                })??;
            let position = job
                .inventory
                .items
                .iter()
                .position(|item| item.preview.id == resolution.item_id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            let item = &job.inventory.items[position];
            if reuse_existing
                && let Some(mut proof) = self.find_template_reuse(
                    &job.job_id,
                    batch.source_for(&item.preview.id)?,
                    item,
                    (resolution, &dependency),
                    targets,
                    candidates,
                )?
            {
                proof.dependency_action_id = Some(dependency.action_id.clone());
                job.inventory.items[position] = crate::templates::resolved_item(item);
                batch.actions.push(BatchAction {
                    action_id: format!("reuse-{}", uuid::Uuid::new_v4().simple()),
                    item_ids: vec![resolution.item_id.clone()],
                    action: BatchActionKind::Reuse { proof },
                    status: ItemStatus::Staged,
                    error: None,
                });
                continue;
            }
            let plan = targets
                .provider
                .templates()?
                .prepare(item, resolution, dependency)?;
            job.inventory.items[position] = plan.item.clone();
            batch.actions.push(BatchAction {
                action_id: plan.operation_id().into(),
                item_ids: vec![resolution.item_id.clone()],
                action: BatchActionKind::Template {
                    plan: Box::new(plan),
                },
                status: ItemStatus::Staged,
                error: None,
            });
        }
        Ok(())
    }

    pub(super) fn undo_templates_first(
        &self,
        job_id: &str,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        let original = self.read(job_id)?;
        for (index, action) in original
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .enumerate()
            .rev()
        {
            if !matches!(action.action, BatchActionKind::Template { .. })
                || action.status == ItemStatus::RolledBack
                || !matches!(
                    action.status,
                    ItemStatus::Committing | ItemStatus::CommitUnknown
                ) && !original
                    .receipts
                    .iter()
                    .any(|receipt| receipt.operation_id == action.action_id)
            {
                continue;
            }
            let result = self.undo_batch_action(&original, action, targets);
            let _lock = self.write_lock()?;
            let mut current = self.load(job_id)?;
            let (status, error) = match result {
                Ok(()) => (ItemStatus::RolledBack, None),
                Err(error) => (
                    ItemStatus::RollbackConflict,
                    Some(super::batch::safe_code(&error)),
                ),
            };
            super::batch::set_action(&mut current, index, status, error);
            super::batch::bump(&mut current)?;
            self.save(&current)?;
        }
        Ok(())
    }
}
