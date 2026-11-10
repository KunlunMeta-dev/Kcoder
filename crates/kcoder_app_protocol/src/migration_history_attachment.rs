//! Durable attachment extraction uses native history coordinates, never source paths or blobs.
use kcoder_types::historical_attachment::{
    HistoricalAttachmentJobView, HistoricalAttachmentReceipt, HistoricalAttachmentSelection,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryAttachmentParams {
    pub selection: HistoricalAttachmentSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryAttachmentResumeParams {
    pub selection: HistoricalAttachmentSelection,
    pub expected_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryAttachmentStateResult {
    pub job: Option<HistoricalAttachmentJobView>,
    pub worker_running: bool,
    pub worker_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryAttachmentChunkParams {
    pub selection: HistoricalAttachmentSelection,
    pub offset: u64,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryAttachmentChunkResult {
    pub receipt: HistoricalAttachmentReceipt,
    pub offset: u64,
    pub next_offset: Option<u64>,
    pub data_base64: String,
    pub data_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryToolAttachmentItemsParams {
    pub selection: HistoricalAttachmentSelection,
    pub cursor: Option<u32>,
}

pub type MigrationHistoryToolAttachmentItemsResult =
    kcoder_types::historical_tool_attachments::HistoricalToolAttachmentPage;
