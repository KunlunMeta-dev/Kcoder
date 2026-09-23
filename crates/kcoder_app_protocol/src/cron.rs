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

fn false_flag(value: &bool) -> bool { !*value }

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
