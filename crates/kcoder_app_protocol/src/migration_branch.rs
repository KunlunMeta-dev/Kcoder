//! Persistent historical branch views, separate from active sessions and continuation.
use kcoder_types::historical_branch::{
    HistoricalBranchChoice, HistoricalBranchDisplayPage, HistoricalBranchProgress,
};
use serde::{Deserialize, Serialize};

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchPrepareParams {
    pub job_id: String,
    #[serde(default)]
    pub related_job_ids: Vec<String>,
    /// Request a separately identified readable-history reconstruction.
    #[serde(default, skip_serializing_if = "is_false")]
    pub reconstruct_readable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchOperationParams {
    pub job_id: String,
    pub view_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchReadParams {
    pub job_id: String,
    pub view_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchResumeParams {
    pub job_id: String,
    pub view_id: String,
    pub expected_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchStateResult {
    pub choice: Option<HistoricalBranchChoice>,
    pub progress: Option<HistoricalBranchProgress>,
    pub worker_running: bool,
    pub worker_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchCancelResult {
    pub view_id: String,
    pub cancel_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchPageParams {
    pub job_id: String,
    pub view_id: String,
    pub cursor: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchBlocksParams {
    pub job_id: String,
    pub view_id: String,
    pub position: u64,
    pub cursor: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchTextParams {
    pub job_id: String,
    pub view_id: String,
    pub position: u64,
    pub block_index: u32,
    pub cursor: Option<String>,
}

pub type MigrationBranchPageResult = HistoricalBranchDisplayPage;

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    #[test]
    fn reconstruction_is_optional_and_preserves_legacy_wire_shape() {
        let old = r#"{"jobId":"job","relatedJobIds":[]}"#;
        let parsed: MigrationBranchPrepareParams = serde_json::from_str(old).unwrap();
        assert!(!parsed.reconstruct_readable);
        assert_eq!(serde_json::to_string(&parsed).unwrap(), old);
        let mut reconstructed = parsed;
        reconstructed.reconstruct_readable = true;
        assert_eq!(
            serde_json::to_value(reconstructed).unwrap()["reconstructReadable"],
            true
        );
    }
}
