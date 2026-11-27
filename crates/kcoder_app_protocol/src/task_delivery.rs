//! Commit-bound delivery preparation and read-only forge reconciliation.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_TASK_DELIVERY_V1: &str = "taskDeliveryV1";
pub mod method {
    pub const PREPARE: &str = "task/delivery/prepare";
    pub const READ: &str = "task/delivery/read";
    pub const REQUEST: &str = "task/delivery/request";
    pub const FAILURE: &str = "task/delivery/failure";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryPrepareParams {
    pub thread_id: String,
    /// Routing labels checked by Gateway; only the owned thread grants Native authority.
    pub owner: TaskDeliveryRecipient,
    pub base_branch: String,
    #[serde(default)]
    pub comparison_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryReadParams {
    pub thread_id: String,
    /// Routing labels checked by Gateway; only the owned thread grants Native authority.
    pub owner: TaskDeliveryRecipient,
    pub delivery_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryRequestParams {
    pub thread_id: String,
    /// Routing labels checked by Gateway; only the owned thread grants Native authority.
    pub owner: TaskDeliveryRecipient,
    pub delivery_id: String,
    pub request_id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryFailureParams {
    pub thread_id: String,
    /// Routing labels checked by Gateway; only the owned thread grants Native authority.
    pub owner: TaskDeliveryRecipient,
    pub delivery_id: String,
    pub check_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryRecipient {
    pub task_id: String,
    pub thread_id: String,
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliverySource {
    pub repository: String,
    pub branch: String,
    pub head_commit: String,
    pub base_branch: String,
    pub base_commit: String,
    pub diff_sha256: String,
    pub working_sha256: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryDraft {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryRequest {
    pub request_id: String,
    pub draft_sha256: String,
    /// Prepared intent only; the normal task send receipt proves acceptance.
    pub prompt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum TaskDeliveryCiState {
    Unknown,
    None,
    Waiting,
    Skipped,
    Neutral,
    Failed,
    Passed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryCheck {
    pub check_id: String,
    pub name: String,
    pub head_commit: String,
    pub state: TaskDeliveryCiState,
    pub details_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryPullRequest {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub head_commit: String,
    pub review_state: String,
    pub matches_request: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryStatus {
    /// notPushed/pushed/unknown are independent from PR and CI state.
    pub push_state: String,
    pub pull_request: Option<TaskDeliveryPullRequest>,
    pub ci_state: TaskDeliveryCiState,
    pub checks: Vec<TaskDeliveryCheck>,
    pub checks_truncated: bool,
    pub source_changed: bool,
    pub limitation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryResult {
    pub delivery_id: String,
    pub thread_id: String,
    pub recipient: TaskDeliveryRecipient,
    pub comparison_id: Option<String>,
    pub source: TaskDeliverySource,
    pub draft: TaskDeliveryDraft,
    pub native_evidence_ids: Vec<String>,
    pub request: Option<TaskDeliveryRequest>,
    pub status: TaskDeliveryStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryFailureResult {
    pub thread_id: String,
    pub recipient: TaskDeliveryRecipient,
    pub head_commit: String,
    pub check_id: String,
    pub raw_evidence: String,
    pub truncated: bool,
    /// Untrusted forge text for the original task's unsent draft only.
    pub prompt: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn delivery_parameters_cannot_carry_client_path_or_commit_authority() {
        let plain = json!({"threadId":"owner-a","owner":{"taskId":"task-a","threadId":"owner-a","deviceId":"target-a"},"baseBranch":"main","comparisonId":"comparison-1"});
        let params: TaskDeliveryPrepareParams = serde_json::from_value(plain.clone()).unwrap();
        assert_eq!(params.comparison_id.as_deref(), Some("comparison-1"));
        for field in ["path", "workspace", "headCommit", "recipient", "deviceId"] {
            let mut payload = plain.clone();
            payload[field] = json!("forged");
            assert!(serde_json::from_value::<TaskDeliveryPrepareParams>(payload).is_err());
        }
    }

    #[test]
    fn view_owner_and_source_recipient_are_distinct_on_the_wire() {
        let value = TaskDeliveryFailureResult {
            thread_id: "owner-a".into(),
            recipient: TaskDeliveryRecipient {
                task_id: "source-task-b".into(),
                thread_id: "source-thread-b".into(),
                device_id: "target-b".into(),
            },
            head_commit: "a".repeat(40),
            check_id: "check:3".into(),
            raw_evidence: "failure".into(),
            truncated: false,
            prompt: "unsent source-task draft".into(),
        };
        let wire = serde_json::to_value(value).unwrap();
        assert_eq!(wire["threadId"], "owner-a");
        assert_eq!(wire["recipient"]["threadId"], "source-thread-b");
        assert_eq!(wire["recipient"]["deviceId"], "target-b");
    }
}
