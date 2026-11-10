//! Read-only historical display with server-bound content positions.
use kcoder_types::{historical_display::*, imported_transcript::HistoricalValueEncoding};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationTranscriptPageParams {
    pub job_id: String,
    pub cursor: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationTranscriptBlocksParams {
    pub job_id: String,
    pub record: u64,
    pub cursor: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationTranscriptTextParams {
    pub job_id: String,
    pub record: u64,
    pub block_index: u32,
    pub cursor: Option<String>,
}

pub type MigrationTranscriptPageResult = HistoricalDisplayPage;
pub type MigrationTranscriptBlocksResult = HistoricalDisplayBlocksPage;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationTranscriptTextResult {
    pub text: String,
    pub next_cursor: Option<String>,
    pub source_bytes: u64,
    pub decoded_bytes: Option<u64>,
    pub encoding: HistoricalValueEncoding,
}
