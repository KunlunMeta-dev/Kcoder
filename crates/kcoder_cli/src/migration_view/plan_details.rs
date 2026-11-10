//! Native sidecars and receipts remain authoritative for prepared and reused item inspection.
use super::*;
use kcoder_migration::store::MigrationStore;

pub fn batch_item_plan(
    store: &MigrationStore,
    job: &MigrationJob,
    item_id: &str,
    include_template: bool,
) -> Result<MigrationBatchItemPlanResult> {
    let summary =
        item_summary(job, item_id).ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
    let mut result = MigrationBatchItemPlanResult {
        template: if include_template {
            store
                .template_settings(&job.job_id, item_id)?
                .map(|value| MigrationTemplateSettings {
                    id: value.id,
                    provider_name: value.provider_name,
                    model: value.model,
                    reasoning_effort: value.reasoning_effort,
                })
        } else {
            None
        },
        item: summary,
        provider: None,
        mcp: None,
    };
    let (reused_provider, reused_mcp) = store.reused_settings(&job.job_id, item_id)?;
    result.mcp = reused_mcp;
    if let Some(provider) = reused_provider {
        result.provider = Some(MigrationProviderCandidate {
            item_id: item_id.into(),
            api_format: provider.api_format.as_str().into(),
            endpoint: Some(provider.endpoint),
            model: Some(provider.default_model),
            context_window_tokens: Some(provider.context_window_tokens as u64),
            output_headroom_tokens: Some(provider.output_headroom_tokens as u64),
            max_output_tokens: Some(provider.max_output_tokens as u64),
        });
    }
    for action in &job
        .batch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?
        .actions
    {
        if let BatchActionKind::Settings { plan } = &action.action {
            for step in &plan.steps {
                if step.item().preview.id != item_id {
                    continue;
                }
                match step {
                    SettingsStep::Mcp(plan) => result.mcp = Some(plan.config().clone()),
                    SettingsStep::Provider(plan) => {
                        result.provider = Some(MigrationProviderCandidate {
                            item_id: item_id.into(),
                            api_format: plan.provider().api_format.as_str().into(),
                            endpoint: Some(plan.provider().endpoint.clone()),
                            model: Some(plan.provider().default_model.clone()),
                            context_window_tokens: Some(
                                plan.provider().context_window_tokens as u64,
                            ),
                            output_headroom_tokens: Some(
                                plan.provider().output_headroom_tokens as u64,
                            ),
                            max_output_tokens: Some(plan.provider().max_output_tokens as u64),
                        })
                    }
                }
            }
        }
    }
    Ok(result)
}
