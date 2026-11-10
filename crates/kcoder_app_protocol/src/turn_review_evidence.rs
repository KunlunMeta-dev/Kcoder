//! Native execution observations, independent of model text and overall task success.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_TURN_REVIEW_EVIDENCE_V1: &str = "turnReviewEvidenceV1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ReviewEvidenceState {
    Collecting,
    Settled,
    Partial,
    Interrupted,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ReviewToolOutcome {
    Pending,
    Recorded,
    Denied,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewProcess {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewArtifact {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ReviewArtifactStatus {
    Unchanged,
    Passed,
    SkippedMissing,
    Missing,
    Denied,
    InvalidPath,
    NotRegular,
    TooSmall,
    ForbiddenContent,
    TooLarge,
    ReadLimit,
    Duplicate,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewArtifactCheck {
    pub index: u32,
    pub path: String,
    pub status: ReviewArtifactStatus,
    pub size_bytes: Option<u64>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewValidation {
    pub run_id: String,
    pub declarations_sha256: String,
    pub observed_at_ms: u64,
    pub entries: Vec<ReviewArtifactCheck>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewToolExecution {
    pub ordinal: u32,
    pub tool_call_id: String,
    pub tool_name: String,
    pub command: Option<String>,
    pub execution_observed_at_ms: Option<u64>,
    pub result_observed_at_ms: Option<u64>,
    pub outcome: ReviewToolOutcome,
    pub tool_failed: Option<bool>,
    pub process: Option<ReviewProcess>,
    pub artifacts: Vec<ReviewArtifact>,
    pub validation: Option<ReviewValidation>,
    pub output_preview: Option<String>,
    pub details_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnReviewEvidence {
    pub version: u8,
    pub evidence_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub attempt_id: String,
    pub state: ReviewEvidenceState,
    pub observations: Vec<ReviewToolExecution>,
    /// Omitted observation updates, not a count of distinct tool executions.
    pub omitted_count: u32,
}
