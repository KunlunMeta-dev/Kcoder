//! Browser bytes are staged only for one previously selected historical local reference.
use crate::{
    historical_attachment::HistoricalAttachmentSelection,
    local_attachment::HistoricalLocalAttachmentJob,
};
use serde::{Deserialize, Serialize};

pub const HISTORICAL_LOCAL_UPLOAD_PART_BYTES: u32 = 192 * 1024;
pub const HISTORICAL_LOCAL_UPLOAD_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const HISTORICAL_LOCAL_UPLOAD_MAX_STAGING_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const HISTORICAL_LOCAL_UPLOAD_MAX_JOBS: usize = 4096;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalLocalAttachmentUploadStage {
    Prepared,
    Receiving,
    Assembling,
    Authorized,
    Cancelled,
    Failed,
    OutcomeUnknown,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalLocalAttachmentUpload {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
    pub sequence: u64,
    pub stage: HistoricalLocalAttachmentUploadStage,
    pub filename: Option<String>,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
    pub received_bytes: u64,
    pub received_parts: u32,
    pub part_bytes: u32,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
    pub failure_code: Option<String>,
    pub local_job: Option<HistoricalLocalAttachmentJob>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalLocalAttachmentUploadPage {
    pub items: Vec<HistoricalLocalAttachmentUpload>,
    pub next_cursor: Option<String>,
}
