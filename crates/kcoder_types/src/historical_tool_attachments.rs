//! Public collection metadata never contains source ranges, payloads, paths or URLs.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalToolAttachmentSummary {
    pub structured: bool,
    pub attachments: u32,
    pub source_items: u32,
    pub unknown_items: u32,
    pub opaque_items: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalToolAttachmentItem {
    pub index: u32,
    pub source_array_index: u32,
    pub source_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalToolAttachmentPage {
    pub items: Vec<HistoricalToolAttachmentItem>,
    pub next_cursor: Option<u32>,
    pub summary: HistoricalToolAttachmentSummary,
}
