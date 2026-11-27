//! Source grants and durable archive jobs never create an Engine or execute imported tools.
use super::*;
use kcoder_migration::history_jobs::HistoryJobStore;
use std::path::Path;
mod branches;
mod reinterpretation;
mod resources;
pub(super) use resources::attachment_projection;
mod search;
mod transcript;
mod view;
mod worker;
pub(super) use branches::BranchWorkers;
pub(super) use search::SearchCursor;
pub(super) use transcript::TranscriptCursor;
pub(super) use view::ViewWorkers;
pub(super) use worker::HistoryWorkers;
pub(super) use worker::progress;

pub(super) fn handles(operation: &str) -> bool {
    resources::handles(operation)
        || view::handles(operation)
        || operation == method::MIGRATION_HISTORY_SEARCH
        || reinterpretation::handles(operation)
        || branches::handles(operation)
        || transcript::handles(operation)
        || matches!(
            operation,
            method::MIGRATION_HISTORY_DISCOVER
                | method::MIGRATION_HISTORY_FAMILIES_DISCOVER
                | method::MIGRATION_HISTORY_SOURCES
                | method::MIGRATION_HISTORY_CREATE
                | method::MIGRATION_HISTORY_READ
                | method::MIGRATION_HISTORY_RUN
                | method::MIGRATION_HISTORY_CANCEL
                | method::MIGRATION_HISTORY_RESUME
                | method::MIGRATION_HISTORY_JOBS
        )
}

pub(super) fn control(operation: &str) -> bool {
    resources::handles(operation)
        || view::handles(operation)
        || operation == method::MIGRATION_HISTORY_SEARCH
        || operation == method::MIGRATION_HISTORY_REINTERPRET_PREVIEW
        || super::undo::handles(operation)
        || super::continuation::handles(operation)
        || branches::handles(operation)
        || transcript::handles(operation)
        || matches!(
            operation,
            method::MIGRATION_HISTORY_READ
                | method::MIGRATION_HISTORY_RUN
                | method::MIGRATION_HISTORY_CANCEL
                | method::MIGRATION_HISTORY_RESUME
                | method::MIGRATION_HISTORY_JOBS
        )
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if resources::handles(operation) {
        return resources::execute(profile, operation, params);
    }
    if view::handles(operation) {
        return view::execute(processor, profile, operation, params);
    }
    if reinterpretation::handles(operation) {
        return reinterpretation::execute(processor, profile, operation, params);
    }
    if operation == method::MIGRATION_HISTORY_SEARCH {
        return search::execute(processor, profile, params);
    }
    if branches::handles(operation) {
        return branches::execute(processor, profile, operation, params);
    }
    if transcript::handles(operation) {
        return transcript::execute(processor, profile, operation, params);
    }
    if matches!(
        operation,
        method::MIGRATION_HISTORY_DISCOVER | method::MIGRATION_HISTORY_FAMILIES_DISCOVER
    ) {
        let params: MigrationHistoryDiscoverParams = decode(params)?;
        if operation == method::MIGRATION_HISTORY_FAMILIES_DISCOVER {
            ensure!(
                params.source == kcoder_types::migration::MigrationSourceKind::Codex,
                "history_discovery_family_source_unsupported"
            );
        }
        let mut registry = processor
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?;
        processor.initialize_registry(&mut registry, factory)?;
        return Ok(serde_json::to_value(
            if operation == method::MIGRATION_HISTORY_FAMILIES_DISCOVER {
                registry
                    .as_mut()
                    .unwrap()
                    .discover_history_families(params.source, |_| !processor.history.cancelled())?
            } else {
                registry
                    .as_mut()
                    .unwrap()
                    .discover_history(params.source, |_| !processor.history.cancelled())?
            },
        )?);
    }
    if operation == method::MIGRATION_HISTORY_SOURCES {
        let params: MigrationHistorySourcesParams = decode(params)?;
        let registry = processor
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?;
        return Ok(serde_json::to_value(
            registry
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("history_discovery_catalog_unavailable"))?
                .history_page(&params.catalog_id, params.cursor.as_deref(), |_| {
                    !processor.history.cancelled()
                })?,
        )?);
    }
    if operation == method::MIGRATION_HISTORY_CREATE {
        let params: MigrationHistoryCreateParams = decode(params)?;
        let selected = {
            let registry = processor
                .registry
                .lock()
                .map_err(|_| anyhow::anyhow!("migration_busy"))?;
            registry
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("history_discovery_catalog_unavailable"))?
                .history_selection(&params.catalog_id, &params.source_handle)?
        };
        let store = HistoryJobStore::open(profile)?;
        let job = store.create_selected_with_resource_limits(
            &params.request_id,
            selected.pin()?,
            params.resource_limits,
        )?;
        return Ok(serde_json::to_value(
            processor.history.observe(&store, &job.job_id)?,
        )?);
    }
    if operation == method::MIGRATION_HISTORY_JOBS {
        let params: MigrationJobsListParams = decode(params)?;
        let Some(store) = HistoryJobStore::open_existing(profile)? else {
            return Ok(serde_json::to_value(MigrationHistoryJobsResult {
                jobs: Vec::new(),
                next_cursor: None,
            })?);
        };
        let (jobs, next_cursor) = store.records(params.cursor.as_deref())?;
        return Ok(serde_json::to_value(MigrationHistoryJobsResult {
            jobs: jobs
                .into_iter()
                .map(|job| processor.history.observe(&store, &job.job_id))
                .collect::<Result<_>>()?,
            next_cursor,
        })?);
    }
    let store = HistoryJobStore::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("history_job_not_found"))?;
    let job = match operation {
        method::MIGRATION_HISTORY_RUN => {
            let params: MigrationHistoryRunParams = decode(params)?;
            return Ok(serde_json::to_value(processor.history.start(
                store,
                &params.job_id,
                params.expected_sequence,
            )?)?);
        }
        method::MIGRATION_HISTORY_RESUME => {
            let params: MigrationHistoryRunParams = decode(params)?;
            store.resume(&params.job_id, params.expected_sequence)?
        }
        method::MIGRATION_HISTORY_CANCEL => {
            let params: MigrationOperationParams = decode(params)?;
            let job = store.request_cancel(&params.job_id)?;
            // An idle accepted job still needs to settle its cancellation without source IO.
            if job.cancel_requested
                && store.execution_state(&job.job_id)?
                    == kcoder_migration::history_jobs::HistoryExecutionState::Stopped
            {
                store
                    .step(&params.job_id, job.sequence, 10, |_| false)
                    .or_else(|_| store.read(&params.job_id))?
            } else {
                job
            }
        }
        method::MIGRATION_HISTORY_READ => {
            let params: MigrationOperationParams = decode(params)?;
            return Ok(serde_json::to_value(
                processor.history.observe(&store, &params.job_id)?,
            )?);
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    Ok(serde_json::to_value(
        processor.history.observe(&store, &job.job_id)?,
    )?)
}
