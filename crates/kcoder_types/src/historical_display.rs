//! Read-only archive presentation. These rows carry no current execution authority.
use crate::{
    imported_transcript::{
        HistoricalDiagnostic, HistoricalRole, HistoricalToolOutcome, HistoricalValueEncoding,
    },
    migration::MigrationSourceKind,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalDisplayKind {
    Message,
    Session,
    Compaction,
    Boundary,
    Metadata,
    Event,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalDisplayBlockKind {
    Text,
    Thinking,
    ToolCall,
    ToolResult,
    Attachment,
    Opaque,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalDisplayBlock {
    pub index: u32,
    pub kind: HistoricalDisplayBlockKind,
    pub preview: Option<String>,
    pub source_bytes: u64,
    pub decoded_bytes: Option<u64>,
    pub body_available: bool,
    pub call_id: Option<String>,
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub source_type: Option<String>,
    pub outcome: Option<HistoricalToolOutcome>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalDisplayRecord {
    pub record: u64,
    pub kind: HistoricalDisplayKind,
    pub role: Option<HistoricalRole>,
    pub timestamp: Option<String>,
    pub source_id: Option<String>,
    pub parent_id: Option<String>,
    pub hidden: bool,
    pub sidechain: bool,
    pub compact_summary: bool,
    pub blocks: Vec<HistoricalDisplayBlock>,
    pub total_blocks: u32,
    pub next_block_cursor: Option<u32>,
    pub diagnostics: Vec<HistoricalDiagnostic>,
    pub total_diagnostics: u32,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalDisplayPage {
    pub source: MigrationSourceKind,
    pub source_session_id: String,
    pub title: Option<String>,
    pub project: Option<String>,
    pub items: Vec<HistoricalDisplayRecord>,
    pub total_records: u64,
    pub next_cursor: Option<u64>,
    pub normalization_complete: bool,
    pub adapter_revision: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalDisplayBlocksPage {
    pub record: u64,
    pub blocks: Vec<HistoricalDisplayBlock>,
    pub total_blocks: u32,
    pub next_cursor: Option<u32>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalTextChunk {
    pub text: String,
    /// Native callers use only a returned offset. Public transports seal this position.
    pub next_offset: Option<u64>,
    pub source_bytes: u64,
    pub decoded_bytes: Option<u64>,
    pub encoding: HistoricalValueEncoding,
}
