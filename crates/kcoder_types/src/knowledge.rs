//! Versioned personal Wiki records shared by the domain service and protocol.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeLibrary {
    pub revision: u64,
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgePageKind {
    Overview,
    Source,
    Concept,
    Entity,
    Synthesis,
    Query,
}

/// References resolve against an immutable source revision, never a filename.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeCitation {
    pub source_id: String,
    pub revision_id: String,
    pub chunk_id: String,
    pub quote: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePageDraft {
    pub page_id: String,
    /// None means create-only; updates must name the exact base revision.
    pub expected_revision: Option<String>,
    pub kind: KnowledgePageKind,
    pub title: String,
    pub markdown: String,
    #[serde(default)]
    pub citations: Vec<KnowledgeCitation>,
    #[serde(default)]
    pub related_page_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePageSummary {
    pub page_id: String,
    pub revision_id: String,
    pub title: String,
    pub kind: KnowledgePageKind,
    pub human_edited: bool,
}

/// Public durable image extraction progress. Private response/original bytes never cross RPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiImageImport {
    pub id: String,
    pub idempotency_key: String,
    pub title: String,
    pub status: String,
    pub phase: String,
    pub model: Option<String>,
    pub source_id: Option<String>,
    pub revision_id: Option<String>,
    pub error_code: Option<String>,
    pub reserved_calls: u32,
    pub call_limit: u32,
    pub usage_reported_calls: u32,
    pub unknown_usage_calls: u32,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub text_bytes: usize,
    pub reasoning_bytes: usize,
    pub updated_at_ms: u64,
}
