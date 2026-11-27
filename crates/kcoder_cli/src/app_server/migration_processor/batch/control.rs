//! Control reads and requests use only the original target journal and its born runner identity.
use super::*;
use kcoder_migration::batch::control::BatchCancellationIntent;

pub(super) fn execute(profile: &Path, operation: &str, params: Value) -> Result<Value> {
    let store = MigrationStore::open_existing(profile)?;
    let value = if operation == method::MIGRATION_BATCH_CONTROL_READ {
        let params: MigrationBatchControlReadParams = decode(params)?;
        store.observe_batch_control(&params.job_id, params.command_id.as_deref())?
    } else {
        let params: MigrationBatchControlCancelParams = decode(params)?;
        store.cancel_batch_execution(&BatchCancellationIntent {
            job_id: params.job_id,
            command_id: params.command_id,
            plan_id: params.plan_id,
            run_request_id: params.run_request_id,
            admission_sequence: params.admission_sequence,
        })?
    };
    // Decode through the public DTO so private journal fields can never leak into this lane.
    let result: MigrationBatchControlResult = serde_json::from_value(serde_json::to_value(value)?)?;
    Ok(serde_json::to_value(result)?)
}
