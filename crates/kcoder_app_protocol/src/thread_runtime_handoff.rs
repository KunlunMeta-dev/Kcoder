//! Finite release of an original resident runtime, not an execution permission.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_THREAD_RUNTIME_HANDOFF_V1: &str = "threadRuntimeHandoffV1";
pub const METHOD_THREAD_RUNTIME_HANDOFF_READ: &str = "thread/runtime/handoff/read";
pub const METHOD_THREAD_RUNTIME_HANDOFF_RELEASE: &str = "thread/runtime/handoff/release";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRuntimeHandoffReadParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRuntimeHandoffReleaseParams {
    pub thread_id: String,
    pub operation_id: String,
    pub expected_server_id: String,
    pub expected_owner_ref: String,
    pub expected_client_turn_count: u64,
}

/// This observes this app-server only. A missing resident owner is not proof
/// that another app-server or the Native Core does not hold the original lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRuntimeHandoffSnapshot {
    pub server_id: String,
    pub thread_id: String,
    pub owner_ref: Option<String>,
    pub client_turn_count: Option<u64>,
    pub releasable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ThreadRuntimeHandoffStatus {
    Released,
    Rejected,
    Unknown,
}

/// Receipts are scoped to the actual server incarnation. After it ends, callers
/// must observe the current owner instead of replaying a release on a new one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRuntimeHandoffReceipt {
    pub server_id: String,
    pub thread_id: String,
    pub operation_id: String,
    pub owner_ref: String,
    pub status: ThreadRuntimeHandoffStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRuntimeHandoffReadResult {
    pub snapshot: ThreadRuntimeHandoffSnapshot,
    pub operation: Option<ThreadRuntimeHandoffReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRuntimeHandoffReleaseResult {
    pub snapshot: ThreadRuntimeHandoffSnapshot,
    pub receipt: ThreadRuntimeHandoffReceipt,
}

pub fn valid_thread_handoff_reference(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

impl ThreadRuntimeHandoffReleaseParams {
    pub fn is_valid(&self) -> bool {
        [
            &self.thread_id,
            &self.operation_id,
            &self.expected_server_id,
            &self.expected_owner_ref,
        ]
        .into_iter()
        .all(|value| valid_thread_handoff_reference(value))
            && self.expected_client_turn_count <= 9_007_199_254_740_991
    }
}
