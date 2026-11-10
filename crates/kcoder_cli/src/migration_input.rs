//! Pure request mapping shared by terminal and authenticated RPC migration entry points.
use anyhow::{Result, ensure};
use kcoder_app_protocol::{MigrationApiKeySource, MigrationBatchChoice, MigrationBatchPlanParams};
use kcoder_migration::{
    assets::AssetResolution,
    batch::BatchResolution,
    credentials::ApiKeySelector,
    mcp::McpResolution,
    providers::{ModelLimits, ProviderResolution},
    store::MigrationJob,
};
pub fn batch_choices(
    params: &MigrationBatchPlanParams,
    scanned: &MigrationJob,
) -> Result<Vec<BatchResolution>> {
    batch_choices_in_scope(params, scanned, None)
}
pub fn batch_choices_in_scope(
    params: &MigrationBatchPlanParams,
    scanned: &MigrationJob,
    workspace: Option<kcoder_config::imported_context::ImportedContextScope>,
) -> Result<Vec<BatchResolution>> {
    batch_choices_with_projects(params, scanned, workspace, &mut |_, _| {
        Err(anyhow::anyhow!("migration_project_mapping_required"))
    })
}
pub fn batch_choices_with_projects(
    params: &MigrationBatchPlanParams,
    scanned: &MigrationJob,
    workspace: Option<kcoder_config::imported_context::ImportedContextScope>,
    resolve_project: &mut impl FnMut(
        &str,
        &kcoder_types::migration_projects::MigrationProjectMappingChoice,
    ) -> Result<
        kcoder_migration::project_migration::ProjectTargetSelection,
    >,
) -> Result<Vec<BatchResolution>> {
    let mut choices = params
        .choices
        .clone()
        .into_iter()
        .map(|choice| {
            Ok(match choice {
                MigrationBatchChoice::Project { item_id, mapping } => {
                    let selection = resolve_project(&item_id, &mapping)?;
                    BatchResolution::Project(Box::new(
                        kcoder_migration::batch::projects::ProjectBatchResolution {
                            item_id,
                            selection,
                            mapping,
                        },
                    ))
                }
                MigrationBatchChoice::Plugin {
                    item_id,
                    target_name,
                } => BatchResolution::Plugin(
                    kcoder_migration::batch::plugins::PluginBatchResolution {
                        item_id,
                        target_name,
                    },
                ),
                MigrationBatchChoice::History { item_id } => BatchResolution::History(
                    kcoder_migration::batch::history::HistoryBatchResolution { item_id },
                ),
                MigrationBatchChoice::Template {
                    item_id,
                    target_name,
                    provider_item_id,
                } => BatchResolution::Template(kcoder_migration::templates::TemplateResolution {
                    item_id,
                    target_name,
                    provider_item_id,
                }),
                MigrationBatchChoice::Provider {
                    item_id,
                    target_name,
                    endpoint,
                    model,
                    context_window_tokens,
                    output_headroom_tokens,
                    max_output_tokens,
                } => BatchResolution::Provider(ProviderResolution {
                    item_id,
                    target_name,
                    endpoint,
                    model,
                    limits: Some(ModelLimits {
                        context_window_tokens,
                        output_headroom_tokens,
                        max_output_tokens,
                    }),
                }),
                MigrationBatchChoice::Mcp {
                    item_id,
                    target_name,
                    cwd,
                    enable_after_import,
                } => BatchResolution::Mcp(McpResolution {
                    item_id,
                    target_name,
                    cwd,
                    enable_after_import,
                }),
                MigrationBatchChoice::Asset {
                    item_id,
                    target_name,
                    agent_adaptation,
                    enable_after_import,
                    memory_mapping,
                } => BatchResolution::Asset(AssetResolution {
                    agent_adaptation,
                    item_id,
                    target_name,
                    enable_after_import,
                    memory_scope: match memory_mapping {
                        None => None,
                        Some(kcoder_types::imported_memory::ImportedMemoryMapping::Global) => {
                            Some(kcoder_config::imported_context::ImportedContextScope::Global)
                        }
                        Some(
                            kcoder_types::imported_memory::ImportedMemoryMapping::CurrentWorkspace,
                        ) => {
                            Some(workspace.clone().ok_or_else(|| {
                                anyhow::anyhow!("migration_memory_scope_required")
                            })?)
                        }
                    },
                }),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        params.excluded_item_ids.len() <= 1024
            && params.excluded_item_ids.iter().all(|id| scanned
                .inventory
                .items
                .iter()
                .any(|item| &item.preview.id == id)),
        "migration_invalid_parameters"
    );
    ensure!(
        !choices.iter().any(|choice| params
            .excluded_item_ids
            .iter()
            .any(|id| id == choice.item_id())),
        "migration_invalid_parameters"
    );
    if params.include_default_items {
        let overrides = choices
            .iter()
            .map(|choice| choice.item_id().to_owned())
            .collect::<std::collections::BTreeSet<_>>();
        for item in &scanned.inventory.items {
            if item.preview.selected_by_default
                && !overrides.contains(&item.preview.id)
                && !params.excluded_item_ids.contains(&item.preview.id)
                && let Some(choice) = kcoder_migration::batch::default_resolution(scanned, item)
            {
                choices.push(choice);
            }
        }
    }
    ensure!(
        !choices.is_empty() && choices.len() <= 1024,
        "migration_batch_budget_exceeded"
    );

    Ok(choices)
}

pub fn selector(
    job: &MigrationJob,
    item_id: &str,
    source: MigrationApiKeySource,
) -> Result<ApiKeySelector> {
    Ok(match source {
        MigrationApiKeySource::Configuration => ApiKeySelector::ClaudeConfiguration,
        MigrationApiKeySource::Environment => {
            let variable = job
                .inventory
                .items
                .iter()
                .find(|item| item.preview.id == item_id)
                .and_then(|item| item.provider.as_ref())
                .and_then(|provider| provider.credential_environment.clone())
                .or_else(|| {
                    (job.inventory.source
                        == kcoder_types::migration::MigrationSourceKind::ClaudeCode)
                        .then(|| "ANTHROPIC_API_KEY".into())
                })
                .ok_or_else(|| anyhow::anyhow!("migration_credential_source_not_declared"))?;
            ApiKeySelector::Environment(variable)
        }
    })
}
