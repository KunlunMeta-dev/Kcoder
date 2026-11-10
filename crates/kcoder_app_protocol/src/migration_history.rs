//! Account-local archive jobs, distinct from native sessions and safe continuation.
use kcoder_types::{
    external_history::{HistoryImportJobView, HistorySourcePage},
    migration::MigrationSourceKind,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryDiscoverParams {
    pub source: MigrationSourceKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistorySourcesParams {
    pub catalog_id: String,
    pub cursor: Option<String>,
}

pub type MigrationHistorySourcesResult = HistorySourcePage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryCreateParams {
    pub catalog_id: String,
    pub source_handle: String,
    /// Canonical UUID chosen before submission; also the durable job identity.
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_limits: Option<kcoder_types::migration_resource::MigrationResourceLimits>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryRunParams {
    pub job_id: String,
    pub expected_sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationHistoryPhase {
    Capturing,
    CopyingOriginal,
    ReadingOriginal,
    Decoding,
    Copying,
    Indexing,
    Verifying,
    Normalizing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryProgress {
    pub phase: MigrationHistoryPhase,
    pub processed: u64,
    pub total: u64,
    pub unit: MigrationHistoryProgressUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationHistoryProgressUnit {
    Bytes,
    Records,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryJobResult {
    pub job: HistoryImportJobView,
    pub worker_running: bool,
    pub progress: Option<MigrationHistoryProgress>,
    pub worker_error: Option<String>,
    /// Only serialized for clients that opted into migrationHistoryWorkerStateV1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_state: Option<MigrationHistoryWorkerState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationHistoryWorkerState {
    Running,
    Stopped,
    Unknown,
}

pub const MIGRATION_HISTORY_WORKER_STATE_CAPABILITY: &str = "migrationHistoryWorkerStateV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryJobsResult {
    pub jobs: Vec<MigrationHistoryJobResult>,
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selections_and_operations_never_accept_paths_or_accounts() {
        assert!(serde_json::from_value::<MigrationHistoryCreateParams>(serde_json::json!({
            "catalogId":"catalog", "sourceHandle":"selection", "requestId":"id", "path":"/other/account"
        })).is_err());
        assert!(
            serde_json::from_value::<MigrationHistoryRunParams>(serde_json::json!({
                "jobId":"job", "expectedSequence":1, "owner":"other"
            }))
            .is_err()
        );
    }
}
