//! A new interpretation preserves the original archive and all previously bound views.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryReinterpretationPreview {
    pub source_job_id: String,
    pub source_sequence: u64,
    pub source_revision: String,
    pub parser_revision: String,
    pub can_create: bool,
    pub reason_code: Option<String>,
}
