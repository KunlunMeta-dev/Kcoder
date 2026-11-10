//! Undoing an owned continuation never authorizes source replay or archive garbage collection.
use serde::{Deserialize, Serialize};

/// Private publication proof stored in the continuation journal, never a public RPC result.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalUndoSealReceipt {
    pub operation_id: String,
    pub session_id: String,
    pub seal_sha256: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalUndoStage {
    Planned,
    Checking,
    Retiring,
    Undone,
    Cancelled,
    Conflict,
    Failed,
    OutcomeUnknown,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalUndoPreview {
    pub continuation_job_id: String,
    pub session_id: Option<String>,
    pub can_undo: bool,
    pub reason_code: Option<String>,
    pub existing_job: Option<HistoricalUndoJob>,
    pub archives_retained: bool,
    pub attachments_retained: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalUndoJob {
    pub job_id: String,
    pub continuation_job_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub stage: HistoricalUndoStage,
    pub checked_bytes: u64,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
    pub failure_code: Option<String>,
    pub archives_retained: bool,
    pub attachments_retained: bool,
}
