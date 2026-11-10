//! A local historical reference is inert until the host obtains an explicit file selection.
use crate::historical_attachment::{
    HistoricalAttachmentInfo, HistoricalAttachmentReceipt, HistoricalAttachmentSelection,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalLocalAttachmentStage {
    Authorized,
    Copying,
    Ready,
    Cancelled,
    SelectionRequired,
    SourceChanged,
    Failed,
    OutcomeUnknown,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalLocalAttachmentState {
    pub operation_id: String,
    pub sequence: u64,
    pub stage: HistoricalLocalAttachmentStage,
    pub processed_bytes: u64,
    pub receipt: Option<HistoricalAttachmentReceipt>,
    pub failure_code: Option<String>,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalLocalAttachmentJob {
    pub selection: HistoricalAttachmentSelection,
    pub state: HistoricalLocalAttachmentState,
    pub info: HistoricalAttachmentInfo,
    /// The selection proves the supplied bytes, not equivalence to an unavailable historical file.
    pub historical_content_verified: bool,
}
