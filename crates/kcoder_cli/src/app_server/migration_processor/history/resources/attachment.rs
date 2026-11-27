//! Only the Native journal determines the original sequence, plan and initial limits.
use super::*;

pub(crate) fn project(
    value: kcoder_migration::history_jobs::ResourceAttachmentObservation,
) -> Result<Value> {
    use kcoder_app_protocol::MigrationHistoryResourceAttachmentPhase as Wire;
    use kcoder_migration::history_jobs::ResourceAttachmentPhase as Native;
    Ok(serde_json::to_value(
        MigrationHistoryResourceAttachmentResult {
            job_id: value.job_id,
            owner_job_id: value.owner_job_id,
            current_sequence: value.current_sequence,
            current_plan_id: value.current_plan_id,
            phase: match value.phase {
                Native::NotApplicable => Wire::NotApplicable,
                Native::Untracked => Wire::Untracked,
                Native::Pending => Wire::Pending,
                Native::Attached => Wire::Attached,
                Native::Tracked => Wire::Tracked,
                Native::ParentOwned => Wire::ParentOwned,
                Native::Unknown => Wire::Unknown,
            },
            original_intent: value.original_intent.map(|intent| {
                MigrationHistoryResourceAttachmentIntent {
                    expected_sequence: intent.expected_sequence,
                    plan_id: intent.plan_id,
                    initial_limits: intent.initial_limits.into(),
                }
            }),
            issue_code: value.issue_code.map(str::to_owned),
        },
    )?)
}
