//! Explicitly create a new interpretation; all execution uses the normal history worker.
use super::*;

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_HISTORY_REINTERPRET_PREVIEW
            | method::MIGRATION_HISTORY_REINTERPRET_CREATE
    )
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let store = HistoryJobStore::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("history_job_not_found"))?;
    match operation {
        method::MIGRATION_HISTORY_REINTERPRET_PREVIEW => {
            let params: MigrationHistoryReinterpretPreviewParams = decode(params)?;
            Ok(serde_json::to_value(
                store.reinterpretation_preview(&params.source_job_id)?,
            )?)
        }
        method::MIGRATION_HISTORY_REINTERPRET_CREATE => {
            let params: MigrationHistoryReinterpretCreateParams = decode(params)?;
            let job = store.reinterpret(
                &params.request_id,
                &params.source_job_id,
                params.expected_source_sequence,
            )?;
            Ok(serde_json::to_value(
                processor.history.observe(&store, &job.job_id)?,
            )?)
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    }
}
