//! Explicit batch choices bind MCP payloads to their settings publication group.
use super::*;
use crate::{
    batch::{BatchActionKind, BatchPlanPolicy, BatchSource, BatchState, settings::SettingsStep},
    mcp_credentials::prepare_material,
};

impl MigrationStore {
    pub(super) fn prepare_batch_mcp_credentials(
        &self,
        job: &mut MigrationJob,
        batch: &mut BatchState,
        policy: &BatchPlanPolicy,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        ensure!(
            job.credential_plans.len()
                + job.mcp_credential_plans.len()
                + policy.mcp_credentials.len()
                <= 128,
            "migration_credential_budget_exceeded"
        );
        let mut selected = BTreeSet::new();
        for choice in &policy.mcp_credentials {
            ensure!(
                choice.consent_private_values,
                "migration_mcp_private_consent_required"
            );
            ensure!(
                selected.insert(&choice.item_id),
                "migration_duplicate_selection"
            );
            let keys = targets
                .credentials
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_credential_target_required"))?;
            ensure!(
                keys.target.directory_identity()? == targets.provider.directory_identity()?,
                "migration_wrong_target"
            );
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
                .ok_or_else(|| anyhow::anyhow!("migration_mcp_private_server_not_selected"))?;
            let BatchActionKind::Settings { plan } = &action.action else {
                anyhow::bail!("migration_mcp_private_reuse_not_supported")
            };
            let config = plan
                .steps
                .iter()
                .find_map(|step| match step {
                    SettingsStep::Mcp(plan) if plan.item().preview.id == choice.item_id => {
                        Some(plan.config())
                    }
                    _ => None,
                })
                .ok_or_else(|| anyhow::anyhow!("migration_not_an_mcp_server"))?;
            let BatchSource::Configuration(source) = batch.source_for(&choice.item_id)? else {
                anyhow::bail!("migration_mcp_private_source_required")
            };
            let material = prepare_material(
                keys.target.native(),
                item,
                source,
                config,
                &choice.fields,
                choice.consent_private_values,
                keys.policy,
                keys.backend,
            )?;
            batch.credential_plan_ids.push(material.plan_id.clone());
            job.mcp_credential_plans.push(material);
        }
        for action in &mut batch.actions {
            let BatchActionKind::Settings { plan } = &mut action.action else {
                continue;
            };
            let has_private = job
                .mcp_credential_plans
                .iter()
                .any(|key| action.item_ids.contains(&key.item_id));
            if !has_private {
                continue;
            }
            let mut current = targets.provider.read_settings()?;
            let before = crate::providers::revision(&current);
            for step in &mut plan.steps {
                if let SettingsStep::Mcp(mcp) = step
                    && let Some(key) = job
                        .mcp_credential_plans
                        .iter()
                        .find(|key| key.item_id == mcp.item().preview.id)
                {
                    mcp.item.mcp.as_mut().unwrap().config = key.config.clone();
                    if mcp.enabled() {
                        key.validate_activation()?;
                        mcp.item.preview.issues.retain(|issue| {
                            !(issue.code
                                == kcoder_types::migration::MigrationIssueCode::RequiresReview
                                && issue.field.as_deref() == Some("activation"))
                        });
                    }
                    if let Some(item) = job
                        .inventory
                        .items
                        .iter_mut()
                        .find(|item| item.preview.id == mcp.item().preview.id)
                    {
                        item.preview.issues = mcp.item.preview.issues.clone();
                    }
                }
                step.rebase(&mut current)?;
            }
            let after = crate::providers::revision(&current);
            for key in &mut job.mcp_credential_plans {
                if action.item_ids.contains(&key.item_id) {
                    key.bind_group(&action.action_id, &before, &after)
                }
            }
        }
        Ok(())
    }
}
