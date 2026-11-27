//! Batch RPC adapts authenticated factories to the migration domain without executing sources.
use super::*;
use kcoder_migration::{
    batch::{BatchActionKind, BatchResolution, BatchSource, settings::SettingsStep},
    store::BatchTargets,
};
use std::path::Path;
mod control;
mod project_mcp;
mod resources;
mod settings_target;
mod worker;
pub(super) use worker::BatchWorkers;

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_BATCH_CONTROL_READ
            | method::MIGRATION_BATCH_CONTROL_CANCEL
            | method::MIGRATION_BATCH_RESOURCES_ATTACHMENT_READ
            | method::MIGRATION_BATCH_RESOURCES_ATTACH
            | method::MIGRATION_BATCH_RESOURCES_READ
            | method::MIGRATION_BATCH_RESOURCES_INCREASE
            | method::MIGRATION_BATCH_SCAN
            | method::MIGRATION_BATCH_PLAN
            | method::MIGRATION_BATCH_APPLY
            | method::MIGRATION_BATCH_RUN
            | method::MIGRATION_BATCH_READ
            | method::MIGRATION_BATCH_CREDENTIAL_SOURCES
            | method::MIGRATION_BATCH_ROLLBACK
            | method::MIGRATION_BATCH_ITEM_PLAN
            | method::MIGRATION_PROJECT_MCP_CATALOG
            | method::MIGRATION_JOBS_LIST
    )
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if matches!(
        operation,
        method::MIGRATION_BATCH_CONTROL_READ | method::MIGRATION_BATCH_CONTROL_CANCEL
    ) {
        return control::execute(profile, operation, params);
    }
    if operation == method::MIGRATION_PROJECT_MCP_CATALOG {
        return project_mcp::catalog(factory, profile, decode(params)?);
    }
    if operation == method::MIGRATION_BATCH_CREDENTIAL_SOURCES {
        let params: MigrationSourceCredentialSourcesParams = decode(params)?;
        return Ok(serde_json::to_value(
            MigrationStore::open_existing(profile)?
                .credential_sources(&params.job_id, params.page_index)?,
        )?);
    }
    if matches!(
        operation,
        method::MIGRATION_BATCH_RESOURCES_ATTACHMENT_READ
            | method::MIGRATION_BATCH_RESOURCES_ATTACH
            | method::MIGRATION_BATCH_RESOURCES_READ
            | method::MIGRATION_BATCH_RESOURCES_INCREASE
    ) {
        return resources::execute(factory, profile, operation, params);
    }
    if operation == method::MIGRATION_BATCH_READ {
        let params: MigrationOperationParams = decode(params)?;
        return Ok(serde_json::to_value(
            processor.batch_workers.observe(profile, &params.job_id)?,
        )?);
    }
    if operation == method::MIGRATION_BATCH_RUN {
        let params: MigrationBatchRunParams = decode(params)?;
        let saved = MigrationStore::open_existing(profile)?.read(&params.job_id)?;
        verify_target_layout(factory, profile, &saved)?;
        return Ok(serde_json::to_value(processor.batch_workers.start(
            profile,
            params,
            factory.current_settings()?.credential_store,
        )?)?);
    }
    if operation == method::MIGRATION_JOBS_LIST {
        let params: MigrationJobsListParams = decode(params)?;
        let store = match MigrationStore::open_existing(profile) {
            Ok(store) => store,
            Err(error)
                if error.chain().any(|error| {
                    error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                return Ok(serde_json::to_value(MigrationJobsListResult {
                    jobs: Vec::new(),
                    next_cursor: None,
                })?);
            }
            Err(error) => return Err(error),
        };
        let (records, next_cursor) = store.records(params.cursor.as_deref())?;
        return Ok(serde_json::to_value(
            kcoder_migration_client::migration_view::records_result(records, next_cursor),
        )?);
    }
    if operation == method::MIGRATION_BATCH_SCAN {
        let params: MigrationBatchScanParams = decode(params)?;
        ensure!(
            !params.source_ids.is_empty()
                || !params.history_sources.is_empty()
                || !params.plugin_sources.is_empty()
                || !params.project_sources.is_empty(),
            "migration_batch_budget_exceeded"
        );
        ensure!(
            params
                .source_ids
                .len()
                .saturating_add(params.history_sources.len())
                .saturating_add(params.plugin_sources.len())
                .saturating_add(params.project_sources.len())
                <= 64,
            "migration_batch_budget_exceeded"
        );
        ensure!(
            params
                .source_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == params.source_ids.len(),
            "migration_duplicate_selection"
        );
        ensure!(
            params
                .history_sources
                .iter()
                .map(|source| (&source.catalog_id, &source.source_handle))
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == params.history_sources.len(),
            "migration_duplicate_selection"
        );
        ensure!(
            params
                .plugin_sources
                .iter()
                .map(|source| &source.operation_id)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == params.plugin_sources.len(),
            "migration_duplicate_selection"
        );
        ensure!(
            params
                .project_sources
                .iter()
                .map(|s| (&s.catalog_id, &s.source_handle))
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == params.project_sources.len(),
            "migration_duplicate_selection"
        );
        let mut inputs = Vec::new();
        if !params.source_ids.is_empty() || !params.history_sources.is_empty() {
            let guard = processor
                .registry
                .lock()
                .map_err(|_| anyhow::anyhow!("migration_busy"))?;
            let registry = guard
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?;
            inputs = params
                .source_ids
                .iter()
                .map(|id| match registry.selected_asset(id) {
                    Ok(binding) => Ok(BatchSource::Assets(binding)),
                    Err(_) => {
                        let binding = registry.selected(id)?;
                        binding.verify_codex_layer_authority(profile)?;
                        Ok(BatchSource::Configuration(binding))
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            let history_grants = params
                .history_sources
                .iter()
                .map(|source| registry.history_selection(&source.catalog_id, &source.source_handle))
                .collect::<Result<Vec<_>>>()?;
            drop(guard);
            for grant in history_grants {
                inputs.push(BatchSource::History(Box::new(
                    kcoder_migration::batch::history::HistoryBatchSource::new(grant.pin()?)?,
                )));
            }
        }
        if !params.project_sources.is_empty() {
            let guard = processor
                .registry
                .lock()
                .map_err(|_| anyhow::anyhow!("migration_busy"))?;
            let registry = guard
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_project_catalog_unavailable"))?;
            for source in &params.project_sources {
                inputs.push(BatchSource::Project(Box::new(registry.selected_project(
                    &source.catalog_id,
                    &source.source_handle,
                    &Default::default(),
                )?)));
            }
        }
        if !params.plugin_sources.is_empty() {
            let plugins = kcoder_migration::plugin_migration::PluginMigrationStore::open(profile)?;
            for source in &params.plugin_sources {
                inputs.push(BatchSource::Plugin(Box::new(
                    plugins.batch_source(&source.operation_id, source.expected_sequence)?,
                )));
            }
        }
        if !params.history_sources.is_empty() {
            // Initialize the same target service without accepting or running any child job.
            kcoder_migration::history_jobs::HistoryJobStore::open(profile)?;
        }
        let job = MigrationStore::open_or_create(profile)?.create_batch_scan_with_resource_limits(
            inputs,
            params.resource_limits.unwrap_or_default(),
        )?;
        return Ok(serde_json::to_value(read_result(&job))?);
    }
    let store = MigrationStore::open_existing(profile)?;
    if operation == method::MIGRATION_BATCH_ITEM_PLAN {
        let params: MigrationBatchItemPlanParams = decode(params)?;
        let job = store.read(&params.job_id)?;
        return Ok(serde_json::to_value(
            kcoder_migration_client::migration_view::batch_item_plan(
                &store,
                &job,
                &params.item_id,
                params.include_template,
            )?,
        )?);
    }
    let target_job = store.read(
        params
            .get("jobId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_job"))?,
    )?;
    settings_target::verify(factory, profile, &target_job)?;
    let create = operation == method::MIGRATION_BATCH_PLAN
        && target_job
            .batch
            .as_ref()
            .is_some_and(|batch| batch.plan_id.is_none());
    let (provider, mut mcp) = settings_target::open(profile, &target_job, create)?;
    if operation == method::MIGRATION_BATCH_PLAN {
        let request: MigrationBatchPlanParams = decode(params.clone())?;
        if let Some(selection) = request.project_mcp_inheritance {
            settings_target::writable(factory, profile, &target_job, true)?;
            mcp = mcp.with_project_mcp_catalog(kcoder_config::ProjectMcpCatalogSelection {
                names: selection.names,
                expected_revision: selection.expected_revision,
            })?;
        }
    }
    let assets = AssetTarget::open(profile)?;
    let credential_target = kcoder_migration::credentials::CredentialTarget::open(profile)?;
    let backend = kcoder_config::OsCredentialBackend::new();
    let credential_policy = factory.current_settings()?.credential_store;
    let history = kcoder_migration::history_jobs::HistoryJobStore::open_existing(profile)?;
    let targets = BatchTargets {
        history: history.as_ref(),
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: Some(kcoder_migration::store::CredentialTargets {
            target: &credential_target,
            backend: &backend,
            policy: credential_policy,
        }),
    };
    let job = if operation == method::MIGRATION_BATCH_PLAN {
        let params: MigrationBatchPlanParams = decode(params)?;
        let scanned = store.read(&params.job_id)?;
        settings_target::private_choices_allowed(
            &scanned,
            !params.credentials.is_empty() || !params.mcp_credentials.is_empty(),
        )?;
        let workspace = if params.choices.iter().any(|choice| {
            matches!(
                choice,
                MigrationBatchChoice::Asset {
                    memory_mapping: Some(
                        kcoder_types::imported_memory::ImportedMemoryMapping::CurrentWorkspace
                    ),
                    ..
                }
            )
        }) {
            super::memory::mapping(
                factory,
                profile,
                Some(kcoder_types::imported_memory::ImportedMemoryMapping::CurrentWorkspace),
            )?
        } else {
            None
        };
        let choices = if params
            .choices
            .iter()
            .any(|choice| matches!(choice, MigrationBatchChoice::Project { .. }))
        {
            kcoder_migration_client::migration_input::batch_choices_with_projects(
                &params,
                &scanned,
                workspace,
                &mut |item, mapping| {
                    super::projects::resolve(processor, profile, &scanned, item, mapping)
                },
            )?
        } else if workspace.is_some() {
            kcoder_migration_client::migration_input::batch_choices_in_scope(
                &params, &scanned, workspace,
            )?
        } else {
            kcoder_migration_client::migration_input::batch_choices(&params, &scanned)?
        };
        if choices
            .iter()
            .any(|choice| matches!(choice, BatchResolution::Provider(_)))
        {
            settings_target::writable(factory, profile, &scanned, false)?;
        }
        if choices
            .iter()
            .any(|choice| matches!(choice, BatchResolution::Mcp(_)))
        {
            settings_target::writable(factory, profile, &scanned, true)?;
        }
        let has_skills = choices.iter().any(|choice| match choice {
            BatchResolution::Asset(value) => scanned.inventory.items.iter().any(|item| {
                item.preview.id == value.item_id
                    && matches!(
                        item.preview.category,
                        kcoder_types::migration::MigrationCategory::Skill
                            | kcoder_types::migration::MigrationCategory::Command
                    )
            }),
            _ => false,
        });
        let skills = if has_skills {
            Some(factory.current_skills()?)
        } else {
            None
        };
        let mcps = if choices
            .iter()
            .any(|choice| matches!(choice, BatchResolution::Mcp(_)))
        {
            factory.current_mcp_names()?
        } else {
            Vec::new()
        };
        let policy = kcoder_migration::batch::BatchPlanPolicy {
            mcp_credentials: params
                .mcp_credentials
                .iter()
                .map(|choice| kcoder_migration::batch::McpCredentialChoice {
                    item_id: choice.item_id.clone(),
                    fields: choice.fields.clone(),
                    consent_private_values: choice.consent_private_values,
                })
                .collect(),
            credentials: params
                .credentials
                .iter()
                .map(|choice| {
                    Ok(kcoder_migration::store::CredentialResolution {
                        item_id: choice.item_id.clone(),
                        consent_api_key: choice.consent_api_key,
                        selector: super::credentials::selector(
                            &scanned,
                            &choice.item_id,
                            choice.source,
                        )?,
                    })
                })
                .collect::<Result<Vec<_>>>()?,
            reuse_existing: params.reuse_existing,
            reserved_skills: skills
                .as_ref()
                .map(|registry| {
                    registry
                        .list_catalog()
                        .into_iter()
                        .map(|skill| skill.name.clone())
                        .collect()
                })
                .unwrap_or_default(),
            reserved_mcp: mcps
                .iter()
                .map(|server| kcoder_mcp_policy::mcp_tool_name(server, "migration_namespace_probe"))
                .collect(),
        };
        if !params.reuse_existing {
            for choice in &choices {
                match choice {
                    BatchResolution::Asset(value)
                        if scanned.inventory.items.iter().any(|item| {
                            item.preview.id == value.item_id
                                && matches!(
                                    item.preview.category,
                                    kcoder_types::migration::MigrationCategory::Skill
                                        | kcoder_types::migration::MigrationCategory::Command
                                )
                        }) =>
                    {
                        ensure!(
                            !skills
                                .as_ref()
                                .unwrap()
                                .list_catalog()
                                .iter()
                                .any(|skill| skill.name == value.target_name),
                            "migration_target_conflict"
                        );
                    }
                    BatchResolution::Mcp(value) => ensure!(
                        !mcps.iter().any(|server| kcoder_mcp_policy::mcp_tool_name(
                            server,
                            "migration_namespace_probe"
                        ) == kcoder_mcp_policy::mcp_tool_name(
                            &value.target_name,
                            "migration_namespace_probe"
                        )),
                        "migration_target_conflict"
                    ),
                    _ => {}
                }
            }
        }
        store.prepare_batch_with_policy(
            &params.job_id,
            params.expected_sequence,
            &choices,
            &targets,
            &policy,
        )?
    } else {
        let params: MigrationBatchOperationParams = decode(params)?;
        let saved = store.read(&params.job_id)?;
        verify_target_layout(factory, profile, &saved)?;
        store.run_batch(
            &params.job_id,
            &params.plan_id,
            &params.request_id,
            params.expected_sequence,
            operation == method::MIGRATION_BATCH_ROLLBACK,
            &targets,
        )?
    };
    Ok(serde_json::to_value(read_result(&job))?)
}

fn verify_target_layout(
    factory: &dyn MigrationHost,
    profile: &Path,
    saved: &kcoder_migration::store::MigrationJob,
) -> Result<()> {
    settings_target::verify(factory, profile, saved)?;
    let (workspace, registry) = factory.migration_project_target_context();
    MigrationStore::open_existing(profile)?.verify_project_host_context(
        saved,
        &workspace,
        registry.as_deref(),
    )?;
    for action in &saved
        .batch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?
        .actions
    {
        if let BatchActionKind::Settings { plan } = &action.action {
            for step in &plan.steps {
                match step {
                    SettingsStep::Provider(_) => {
                        settings_target::writable(factory, profile, saved, false)?;
                    }
                    SettingsStep::Mcp(_) => {
                        settings_target::writable(factory, profile, saved, true)?;
                    }
                }
            }
        }
    }
    Ok(())
}
