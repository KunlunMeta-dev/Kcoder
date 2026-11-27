//! Passive definition previews resolve the original item/plan, never the newest matching record.
use super::*;
use crate::{
    assets::AssetPlan,
    batch::{BatchActionKind, BatchSource},
};
use kcoder_types::{migration::MigrationCategory as Category, migration_definitions::*};

/// Private bytes must only be exposed through explicit, bounded content reads by the caller.
pub struct DefinitionSnapshot {
    pub report: MigrationDefinitionReport,
    pub bytes: zeroize::Zeroizing<Vec<u8>>,
}
impl DefinitionSnapshot {
    fn from_plan(plan: &AssetPlan) -> Result<Self> {
        Ok(Self {
            report: plan
                .definition_report()
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("migration_not_a_definition"))?,
            bytes: zeroize::Zeroizing::new(
                plan.definition_bytes()?
                    .ok_or_else(|| anyhow::anyhow!("migration_not_a_definition"))?,
            ),
        })
    }
}
impl MigrationStore {
    /// Inspect the original selected bytes; this never enables or publishes an Agent.
    pub fn agent_compatibility(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> Result<kcoder_types::migration_agent::MigrationAgentCompatibility> {
        let snapshot = self.definition_snapshot(job_id, item_id)?;
        ensure!(
            snapshot.report.kind == MigrationDefinitionKind::Agent,
            "migration_not_an_agent"
        );
        Ok(crate::agent_adapter::preview(
            snapshot.report.format,
            &snapshot.bytes,
        ))
    }
    /// Prepared data remains readable after the source moves or the owned result is undone.
    pub fn definition_snapshot(&self, job_id: &str, item_id: &str) -> Result<DefinitionSnapshot> {
        let job = self.read(job_id)?;
        let item = job
            .inventory
            .items
            .iter()
            .find(|item| item.preview.id == item_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        ensure!(
            matches!(item.preview.category, Category::Agent | Category::Hook),
            "migration_not_a_definition"
        );
        if let Some(plan) = job
            .asset_plans
            .iter()
            .find(|plan| plan.item().preview.id == item_id)
        {
            return DefinitionSnapshot::from_plan(plan);
        }
        if let Some(batch) = &job.batch
            && let Some(action) = batch
                .actions
                .iter()
                .find(|action| action.item_ids.iter().any(|id| id == item_id))
        {
            match &action.action {
                BatchActionKind::Asset { plan_id, .. } => {
                    return DefinitionSnapshot::from_plan(&self.load_batch_asset(job_id, plan_id)?);
                }
                BatchActionKind::Reuse { proof } => {
                    let previous = self.load(&proof.job_id)?;
                    if let Some(plan) = previous.asset_plans.iter().find(|plan| {
                        plan.id() == proof.action_id && plan.item().preview.id == proof.item_id
                    }) {
                        return DefinitionSnapshot::from_plan(plan);
                    }
                    let previous_action = previous
                        .batch
                        .as_ref()
                        .and_then(|batch| {
                            batch.actions.iter().find(|action| {
                                action.action_id == proof.action_id
                                    && action.item_ids.contains(&proof.item_id)
                            })
                        })
                        .ok_or_else(|| anyhow::anyhow!("migration_invalid_journal"))?;
                    let BatchActionKind::Asset { plan_id, .. } = &previous_action.action else {
                        anyhow::bail!("migration_invalid_journal");
                    };
                    return DefinitionSnapshot::from_plan(
                        &self.load_batch_asset(&previous.job_id, plan_id)?,
                    );
                }
                _ => anyhow::bail!("migration_invalid_journal"),
            }
        }
        let binding = if let Some(binding) = &job.asset_binding {
            binding
        } else {
            let source = job
                .batch
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_invalid_journal"))?
                .source_for(item_id)?;
            let BatchSource::Assets(binding) = source else {
                anyhow::bail!("migration_not_a_definition");
            };
            binding
        };
        let source = binding.read(
            &item
                .asset
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_not_a_definition"))?
                .entry,
        )?;
        ensure!(
            source.files.len() == 1,
            "migration_definition_single_file_required"
        );
        let bytes = zeroize::Zeroizing::new(source.files.into_iter().next().unwrap().content);
        Ok(DefinitionSnapshot {
            report: crate::definition_adapter::report(
                crate::definition_adapter::format(binding.kind, binding.category)?,
                &bytes,
            ),
            bytes,
        })
    }
}
