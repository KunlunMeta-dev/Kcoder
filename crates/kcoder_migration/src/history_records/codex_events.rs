//! Only pinned, direct execution receipts contribute supplementary historical facts.
use super::*;

pub(super) fn patch_outcome(
    fields: &Fields,
    payload: &[Segment],
    record: &mut HistoricalRecord,
) -> Option<HistoricalToolOutcome> {
    if fields
        .text(payload, "call_id")
        .is_none_or(|id| id.is_empty())
        || (fields.nodes.contains_key(&child(payload, "turn_id"))
            && fields.text(payload, "turn_id").is_none())
    {
        diagnostic(record, "invalid_patch_execution_identity", true);
        return None;
    }
    let success = fields.boolean(payload, "success");
    let status = fields.text(payload, "status");
    match (success, status.as_deref()) {
        (Some(true), Some("completed")) => Some(HistoricalToolOutcome::RecordedSuccess),
        (Some(false), Some("failed")) => Some(HistoricalToolOutcome::RecordedError),
        // Rejection is distinct from an execution failure or cancellation. Preserve the
        // source status without manufacturing an outcome the shared contract cannot express.
        (Some(false), Some("declined")) => {
            diagnostic(record, "patch_execution_declined", true);
            None
        }
        (Some(_), Some("completed" | "failed" | "declined")) => {
            diagnostic(record, "conflicting_patch_execution_status", true);
            None
        }
        _ => {
            diagnostic(record, "invalid_patch_execution_status", true);
            None
        }
    }
}
