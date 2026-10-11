use kcoder_types::CronSchedule;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStateChangedParams {
    pub job_count: usize,
    pub pending_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CronParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CronCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub prompt: String,
    pub schedule: CronSchedule,
    #[serde(default)]
    pub confirmed: bool,
    pub jitter_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CronDeleteParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub job_id: String,
    #[serde(default, skip_serializing_if = "false_flag")]
    pub receipts_only: bool,
    #[serde(default, skip_serializing_if = "false_flag")]
    pub confirmed: bool,
}

fn false_flag(value: &bool) -> bool {
    !*value
}

/// Diagnostic trigger receipts and explicit receipt-only cleanup, not execution replay.
pub const CAPABILITY_CRON_DELIVERY_DIAGNOSTICS_V1: &str = "cronDeliveryDiagnosticsV1";

/// Opt-in support for schedules whose calendar fields use an explicit timezone.
pub const CAPABILITY_CRON_TIMEZONE_V1: &str = "cronTimezoneV1";
pub const CAPABILITY_CRON_PREVIEW_V1: &str = "cronPreviewV1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CronPreviewParams {
    pub schedule: CronSchedule,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronPreviewResult {
    /// Nominal UTC instant, before the job's deterministic jitter is assigned.
    pub next_run_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn execution_wire_keeps_delivery_without_an_execution_identity_unknown() {
        let row = serde_json::json!({"triggerId":"cron:legacy:due", "jobId":"legacy",
            "scheduledAt":"2026-10-03T09:00:00Z", "recordedAt":"2026-10-03T09:00:00Z",
            "status":"unknown", "deliveryConfirmed":true, "automaticReplay":false});
        let result: CronExecutionDiagnostics = serde_json::from_value(serde_json::json!({
            "runs":[row], "serviceRequired":true, "automaticReplay":false,
            "offlinePolicy":"wait-for-host-and-service; coalesce-missed; expire-after-seven-days"
        }))
        .unwrap();
        assert_eq!(result.runs[0].status, "unknown");
        assert!(result.runs[0].delivery_confirmed);
        assert!(result.runs[0].thread_id.is_none());
        assert!(result.runs[0].turn_id.is_none());
        assert!(!result.runs[0].automatic_replay);
        let wire = serde_json::to_value(result).unwrap();
        assert_eq!(wire["runs"][0]["status"], "unknown");
        assert!(wire["runs"][0]["threadId"].is_null());
    }

    #[test]
    fn schedule_wire_contract_keeps_utc_and_zoned_intents_distinct() {
        for schedule in [
            serde_json::json!({"kind":"cron","expression":"0 9 * * *"}),
            serde_json::json!({"kind":"zoned_cron","expression":"0 9 * * *","timezone":"Asia/Tokyo"}),
        ] {
            let params =
                serde_json::json!({"prompt":"review","confirmed":true,"schedule":schedule});
            let parsed: CronCreateParams = serde_json::from_value(params).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap()["schedule"], schedule);
        }
        assert!(serde_json::from_value::<CronCreateParams>(serde_json::json!({"prompt":"review","schedule":{"kind":"zoned_cron","expression":"0 9 * * *"}})).is_err());
    }
}

/// Correlates the internal turn admission response with its scheduled conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunFailedParams {
    pub job_id: String,
    pub thread_id: String,
    pub request_id: String,
    pub error: crate::RpcError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunStartedParams {
    pub job_id: String,
    pub thread_id: String,
    pub thread: serde_json::Value,
    pub workspace_path: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Execution evidence is separate from dispatch/delivery acknowledgements.
pub const CAPABILITY_CRON_EXECUTION_DIAGNOSTICS_V1: &str = "cronExecutionDiagnosticsV1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecutionDiagnostics {
    pub runs: Vec<CronExecutionRecord>,
    pub automatic_replay: bool,
    pub service_required: bool,
    pub offline_policy: String,
}

/// Nullable identities mean execution has not reached that stage; never synthesize them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecutionRecord {
    pub trigger_id: String,
    pub job_id: String,
    pub scheduled_at: String,
    pub recorded_at: String,
    pub status: String,
    pub automatic_replay: bool,
    pub delivery_confirmed: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub coalesced: Option<usize>,
    #[serde(default)]
    pub schedule: Option<CronSchedule>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub last_recorded_status: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub attempt_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub reply_preview: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub failure_stage: Option<String>,
    #[serde(default)]
    pub merged_into_trigger_id: Option<String>,
}
