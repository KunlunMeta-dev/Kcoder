//! Durable public Wiki stage summaries. Payloads and provider credentials never
//! cross this contract; artifact hashes are opaque recovery identities.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WikiPipelineStageKind {
    Extract,
    Analyze,
    Retrieve,
    Generate,
    Verify,
    Coverage,
    Commit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WikiPipelineStageStatus {
    Waiting,
    Running,
    Received,
    Validated,
    Completed,
    Failed,
    Paused,
    NeedsReview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WikiPipelineStageAddress {
    /// Source-chunk cursor at the start of this batch, not a display ordinal.
    pub batch: usize,
    pub source_revision: String,
    pub stage_key: String,
    pub stage: WikiPipelineStageKind,
    pub unit_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WikiPipelineStageRecord {
    #[serde(flatten)]
    pub address: WikiPipelineStageAddress,
    pub status: WikiPipelineStageStatus,
    pub attempt: u32,
    pub reused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_label: Option<String>,
    /// Zero-based ordinal, present only for genuinely planned units.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_units: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_units: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at_ms: Option<u64>,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WikiPipelineProgress {
    pub version: u8,
    pub batch: usize,
    pub source_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_stage: Option<WikiPipelineStageKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_stage: Option<WikiPipelineStageAddress>,
    pub records: Vec<WikiPipelineStageRecord>,
}
