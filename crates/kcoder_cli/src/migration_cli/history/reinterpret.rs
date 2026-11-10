use super::*;
use crate::cli_args::HistoryReinterpretAction;

pub(super) fn execute(action: &HistoryReinterpretAction, context: &Context) -> Result<Value> {
    let store = jobs(context)?;
    match action {
        HistoryReinterpretAction::Preview { source_job_id } => Ok(serde_json::to_value(
            store.reinterpretation_preview(source_job_id)?,
        )?),
        HistoryReinterpretAction::Create {
            source_job_id,
            expected_source_sequence,
            request_id,
            confirm,
        } => {
            ensure!(*confirm, "history_reinterpret_confirmation_required");
            Ok(serde_json::to_value(store.reinterpret(
                request_id,
                source_job_id,
                *expected_source_sequence,
            )?)?)
        }
    }
}
