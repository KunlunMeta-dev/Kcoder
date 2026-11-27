//! Historical attachment facts never grant current file, network, or execution authority.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalAttachmentKind {
    EmbeddedBase64,
    EmbeddedText,
    RemoteReference,
    LocalReference,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalAttachmentReceipt {
    pub attachment_id: String,
    pub bytes: u64,
    pub sha256: String,
    pub chunk_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalAttachmentInfo {
    pub kind: HistoricalAttachmentKind,
    pub media_type: Option<String>,
    pub display_name: Option<String>,
    pub receipt: Option<HistoricalAttachmentReceipt>,
    pub issue: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoricalAttachmentStage {
    Inspecting,
    Extracting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalAttachmentSelection {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_id: Option<String>,
    pub position: u64,
    pub block_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_item_index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalAttachmentJobStage {
    Planned,
    Inspecting,
    Extracting,
    Ready,
    Catalogued,
    Unavailable,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalAttachmentJobView {
    pub id: String,
    pub sequence: u64,
    pub stage: HistoricalAttachmentJobStage,
    pub processed_bytes: u64,
    pub info: Option<HistoricalAttachmentInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<crate::historical_tool_attachments::HistoricalToolAttachmentSummary>,
    pub failure_code: Option<String>,
    pub cancel_requested: bool,
    #[serde(default)]
    pub cancel_revision: u64,
}

pub const HISTORICAL_ATTACHMENT_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const HISTORICAL_ATTACHMENT_CHUNK_BYTES: usize = 256 * 1024;

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    #[test]
    fn ordinary_attachment_coordinates_keep_their_old_serialization() {
        let old = serde_json::json!({"jobId":"job","position":0,"blockIndex":1});
        let value: HistoricalAttachmentSelection = serde_json::from_value(old.clone()).unwrap();
        assert!(value.tool_item_index.is_none());
        assert_eq!(serde_json::to_value(value).unwrap(), old);
        let child: HistoricalAttachmentSelection = serde_json::from_value(
            serde_json::json!({"jobId":"job","position":0,"blockIndex":1,"toolItemIndex":0}),
        )
        .unwrap();
        assert_eq!(child.tool_item_index, Some(0));
    }
}
