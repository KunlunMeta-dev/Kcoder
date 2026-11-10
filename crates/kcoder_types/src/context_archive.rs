//! Session-scoped references to compressed history. References never grant access.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextBlockSource {
    pub schema_version: u32,
    pub message_ids: Vec<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextBlockInfo {
    pub block_id: String,
    pub summary: String,
    pub summary_truncated: bool,
    pub parent_block_ids: Vec<String>,
    pub source_message_count: usize,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextHistoryPage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    pub snapshot: String,
    pub indexing: bool,
    pub scanned_bytes: u64,
    pub blocks: Vec<ContextBlockInfo>,
    pub hits: Vec<ContextHistoryHit>,
    pub text: String,
    pub next_offset: Option<usize>,
    pub next_text_offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextHistoryHit {
    pub block_id: String,
    pub message_id: String,
    pub excerpt: String,
}

#[derive(Debug, Clone)]
pub struct ContextHistoryQuery {
    pub query: Option<String>,
    pub block_id: Option<String>,
    pub message_id: Option<String>,
    pub snapshot: Option<String>,
    pub offset: usize,
    pub text_offset: usize,
    pub limit: usize,
    pub full: bool,
}

impl Default for ContextHistoryQuery {
    fn default() -> Self {
        Self {
            query: None,
            block_id: None,
            message_id: None,
            snapshot: None,
            offset: 0,
            text_offset: 0,
            limit: 10,
            full: false,
        }
    }
}
