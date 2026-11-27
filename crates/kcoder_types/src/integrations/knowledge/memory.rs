use super::KnowledgeOwner;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MemoryOrigin {
    Manual,
    Observer,
    Imported,
    ExistingObservation,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MemoryReviewStatus {
    Candidate,
    Confirmed,
    Rejected,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryProvenance {
    pub kind: String,
    pub source_id: String,
    pub source_revision: String,
    pub description: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryProposal {
    pub title: String,
    pub content: String,
    pub category: String,
    pub origin: MemoryOrigin,
    pub provenance: Vec<MemoryProvenance>,
    pub valid_until_ms: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedMemory {
    pub id: String,
    pub owner: KnowledgeOwner,
    pub revision: u64,
    pub proposal: MemoryProposal,
    pub review_status: MemoryReviewStatus,
    pub enabled: bool,
    #[serde(default)]
    pub deleted: bool,
    /// User acceptance never certifies an imported source as externally verified.
    pub source_verified: bool,
    pub updated_at_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum MemoryReview {
    Accept {
        #[serde(rename = "editedContent")]
        edited_content: Option<String>,
    },
    Reject,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryTaskSnapshot {
    pub owner: KnowledgeOwner,
    pub task_id: String,
    pub memories: Vec<ReviewedMemory>,
    pub captured_at_ms: u64,
    #[serde(default)]
    pub omitted_count: usize,
}
