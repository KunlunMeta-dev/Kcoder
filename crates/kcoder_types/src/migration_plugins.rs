//! Public plugin migration facts never contain source paths or private package ownership proofs.
use crate::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationPluginStage {
    Prepared,
    Capturing,
    Pending,
    Ready,
    Applying,
    Imported,
    Undoing,
    Undone,
    Cancelled,
    OutcomeUnknown,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginCandidate {
    pub candidate_id: String,
    pub source: MigrationSourceKind,
    pub name: String,
    pub installed_version: Option<String>,
    pub scope: String,
    pub source_enabled: Option<bool>,
    pub pending: Vec<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginJob {
    pub operation_id: String,
    pub sequence: u64,
    pub stage: MigrationPluginStage,
    pub source: MigrationSourceKind,
    pub name: String,
    pub installed_version: Option<String>,
    pub scope: String,
    pub source_enabled: Option<bool>,
    pub target_id: Option<String>,
    pub package_files: Option<u32>,
    pub package_bytes: Option<u64>,
    pub capabilities: Vec<String>,
    pub readiness: Vec<String>,
    pub pending: Vec<String>,
    pub imported: bool,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
}
