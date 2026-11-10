use kcoder_types::historical_undo::{HistoricalUndoJob, HistoricalUndoPreview};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryUndoPreviewParams {
    pub continuation_job_id: String,
}
pub type MigrationHistoryUndoPreviewResult = HistoricalUndoPreview;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryUndoCreateParams {
    pub request_id: String,
    pub continuation_job_id: String,
    pub expected_continuation_sequence: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryUndoReadParams {
    pub job_id: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryUndoRunParams {
    pub job_id: String,
    pub expected_sequence: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryUndoStateResult {
    pub job: HistoricalUndoJob,
    pub worker_running: bool,
    pub worker_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_selectors_never_accept_paths_or_hashes() {
        for extra in ["path", "owner", "sealSha256", "historyOffset"] {
            let mut value = serde_json::json!({"requestId":"operation","continuationJobId":"source","expectedContinuationSequence":2});
            value[extra] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<MigrationHistoryUndoCreateParams>(value).is_err());
        }
    }
}

/// Lightweight source-owned operation lookup. It never snapshots the native session.
pub type MigrationHistoryUndoLookupParams = MigrationHistoryUndoPreviewParams;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryUndoLookupResult {
    pub existing_job: Option<HistoricalUndoJob>,
}
