//! Plugin migration uses account-owned Native grants and private installation receipts.
use super::*;
use anyhow::Context;
use kcoder_migration::plugin_migration::{
    PluginMigrationStage as Stage, PluginMigrationStore, PluginMigrationView,
};
use kcoder_plugins::PluginCancellationToken;
use kcoder_types::migration_plugins::{
    MigrationPluginCandidate, MigrationPluginJob, MigrationPluginStage,
};
use std::path::Path;
mod worker;
pub(super) use worker::PluginWorkers;
fn dto(job: PluginMigrationView) -> MigrationPluginJob {
    let stage = match job.stage {
        Stage::Prepared => MigrationPluginStage::Prepared,
        Stage::Capturing => MigrationPluginStage::Capturing,
        Stage::Pending => MigrationPluginStage::Pending,
        Stage::Ready => MigrationPluginStage::Ready,
        Stage::Applying => MigrationPluginStage::Applying,
        Stage::Imported => MigrationPluginStage::Imported,
        Stage::Undoing => MigrationPluginStage::Undoing,
        Stage::Undone => MigrationPluginStage::Undone,
        Stage::Cancelled => MigrationPluginStage::Cancelled,
        Stage::OutcomeUnknown => MigrationPluginStage::OutcomeUnknown,
    };
    MigrationPluginJob {
        operation_id: job.operation_id,
        sequence: job.sequence,
        stage,
        source: job.source,
        name: job.name,
        installed_version: job.installed_version,
        scope: job.scope,
        source_enabled: job.source_enabled,
        target_id: job.target_id,
        package_files: job.package_files,
        package_bytes: job.package_bytes,
        capabilities: job.capabilities,
        readiness: job.readiness,
        pending: job.pending,
        imported: job.imported,
        cancel_requested: job.cancel_requested,
        cancel_revision: job.cancel_revision,
        batch_job_id: job.batch_job_id,
        failure_code: job.failure_code,
    }
}
pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_PLUGIN_DISCOVER
            | method::MIGRATION_PLUGIN_PLAN
            | method::MIGRATION_PLUGIN_CAPTURE
            | method::MIGRATION_PLUGIN_READ
            | method::MIGRATION_PLUGIN_APPLY
            | method::MIGRATION_PLUGIN_UNDO
            | method::MIGRATION_PLUGIN_CANCEL
            | method::MIGRATION_PLUGIN_RESUME
            | method::MIGRATION_PLUGIN_LIST
    )
}
pub(super) fn control(operation: &str) -> bool {
    handles(operation)
        && !matches!(
            operation,
            method::MIGRATION_PLUGIN_DISCOVER
                | method::MIGRATION_PLUGIN_READ
                | method::MIGRATION_PLUGIN_LIST
        )
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if operation == method::MIGRATION_PLUGIN_DISCOVER {
        let params: MigrationPluginDiscoverParams = decode(params)?;
        let mut registry = processor
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?;
        processor.initialize_registry(&mut registry, factory)?;
        let token = processor.cancellation();
        let cancel = PluginCancellationToken::default().with_probe(move || token.is_cancelled());
        let registry = registry.as_mut().unwrap();
        let page = if params.include_uploaded {
            ensure!(
                !params.include_project,
                "plugin_migration_invalid_parameters"
            );
            registry.discover_uploaded_plugins(
                &params.sources,
                params.cursor.as_deref(),
                &cancel,
            )?
        } else if params.include_project {
            let roots = factory.migration_source_roots()?;
            registry.authorize_selected_project(profile, roots.project.as_deref())?;
            registry.discover_plugins_in_project(
                &params.sources,
                params.cursor.as_deref(),
                profile,
                roots
                    .project
                    .as_deref()
                    .context("migration_project_source_not_trusted")?,
                &cancel,
            )?
        } else {
            registry.discover_plugins(&params.sources, params.cursor.as_deref(), &cancel)?
        };
        return Ok(serde_json::to_value(MigrationPluginDiscoverResult {
            candidates: page
                .candidates
                .into_iter()
                .map(|entry| MigrationPluginCandidate {
                    candidate_id: entry.candidate_id,
                    source: entry.candidate.source,
                    name: entry.candidate.name,
                    installed_version: entry.candidate.installed_version,
                    scope: entry.candidate.scope,
                    source_enabled: entry.candidate.source_enabled,
                    pending: entry.candidate.pending,
                })
                .collect(),
            next_cursor: page.next_cursor,
            problems: page
                .problems
                .into_iter()
                .map(|problem| MigrationDiscoveryProblem {
                    kind: problem.kind,
                    scope: problem.scope.into(),
                    code: problem.code.into(),
                })
                .collect(),
        })?);
    }
    if operation == method::MIGRATION_PLUGIN_LIST {
        let params: MigrationPluginListParams = decode(params)?;
        let Some(store) = PluginMigrationStore::open_existing(profile)? else {
            return Ok(serde_json::to_value(MigrationPluginListResult {
                items: vec![],
                next_cursor: None,
            })?);
        };
        let (items, next_cursor) = store.list(params.cursor.as_deref())?;
        return Ok(serde_json::to_value(MigrationPluginListResult {
            items: items.into_iter().map(dto).collect(),
            next_cursor,
        })?);
    }
    if operation == method::MIGRATION_PLUGIN_PLAN {
        let params: MigrationPluginPlanParams = decode(params)?;
        let candidate = processor
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?
            .selected_plugin(&params.candidate_id)?;
        let store = PluginMigrationStore::open(profile)?;
        let mapping = if params.project_mapping.is_some() {
            ensure!(
                matches!(candidate.scope.as_str(), "project" | "local"),
                "plugin_migration_invalid_project_mapping"
            );
            let roots = factory.migration_source_roots()?;
            Some(kcoder_plugins::PluginProjectBinding::capture(
                profile,
                roots
                    .project
                    .as_deref()
                    .context("plugin_project_mapping_required")?,
            )?)
        } else {
            None
        };
        let job = store.prepare_mapped(
            &params.request_id,
            &candidate,
            params.target_name.as_deref(),
            mapping.as_ref(),
        )?;
        return Ok(serde_json::to_value(processor.plugins.start(
            profile.into(),
            store,
            job.operation_id,
            job.sequence,
            worker::Action::Capture,
        )?)?);
    }
    let store = PluginMigrationStore::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("plugin_migration_store_missing"))?;
    if operation == method::MIGRATION_PLUGIN_READ {
        let params: MigrationPluginReadParams = decode(params)?;
        return Ok(serde_json::to_value(
            processor.plugins.observe(&store, &params.operation_id)?,
        )?);
    }
    let params: MigrationPluginOperationParams = decode(params)?;
    if operation != method::MIGRATION_PLUGIN_CANCEL {
        store.verify_workspace(
            &params.operation_id,
            factory.migration_source_roots()?.project.as_deref(),
        )?;
    }
    match operation {
        method::MIGRATION_PLUGIN_CANCEL => {
            store.cancel(&params.operation_id, params.expected_sequence)?;
        }
        method::MIGRATION_PLUGIN_RESUME => {
            store.resume(&params.operation_id, params.expected_sequence)?;
            processor.plugins.clear_finished_error(&params.operation_id);
        }
        method::MIGRATION_PLUGIN_CAPTURE
        | method::MIGRATION_PLUGIN_APPLY
        | method::MIGRATION_PLUGIN_UNDO => {
            let action = if operation == method::MIGRATION_PLUGIN_CAPTURE {
                worker::Action::Capture
            } else if operation == method::MIGRATION_PLUGIN_APPLY {
                worker::Action::Apply
            } else {
                worker::Action::Undo
            };
            return Ok(serde_json::to_value(processor.plugins.start(
                profile.into(),
                store,
                params.operation_id,
                params.expected_sequence,
                action,
            )?)?);
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    }
    Ok(serde_json::to_value(
        processor.plugins.observe(&store, &params.operation_id)?,
    )?)
}
pub(super) fn safe_error(error: &anyhow::Error) -> String {
    for cause in error.chain() {
        let value = cause.to_string();
        if matches!(
            value.as_str(),
            "plugin_migration_busy"
                | "plugin_migration_stale_sequence"
                | "plugin_migration_cancelled"
                | "plugin_migration_request_changed"
                | "plugin_migration_profile_changed"
                | "plugin_migration_source_changed"
                | "plugin_migration_invalid_candidate"
                | "plugin_migration_invalid_operation"
                | "plugin_migration_invalid_cursor"
                | "plugin_migration_list_changed"
                | "plugin_migration_plan_not_ready"
                | "plugin_migration_pending_resolution_required"
                | "plugin_migration_claimed_by_another_owner"
                | "plugin_migration_control_unavailable"
                | "plugin_migration_control_changed"
                | "plugin_migration_legacy_control_unavailable"
                | "plugin_migration_target_changed"
                | "plugin_migration_in_use"
                | "plugin_migration_output_missing"
                | "plugin_migration_staging_budget_exceeded"
                | "plugin_migration_capture_retry_budget_exceeded"
                | "plugin_migration_private_state_not_copied"
                | "plugin_migration_invalid_package"
                | "plugin_migration_manifest_missing"
                | "plugin_migration_unsafe_tree"
                | "plugin_migration_manifest_identity_changed"
                | "plugin_migration_invalid_target_policy"
                | "plugin_migration_user_policy_changed"
                | "plugin_migration_local_install_disabled"
                | "plugin_migration_format_disabled"
                | "plugin_migration_already_retired"
                | "plugin_migration_worker_capacity_reached"
                | "plugin_migration_worker_stopping"
                | "plugin_migration_worker_unavailable"
                | "migration_source_selection_expired"
                | "migration_invalid_parameters"
        ) {
            return value;
        }
    }
    "plugin_migration_outcome_unknown".into()
}
