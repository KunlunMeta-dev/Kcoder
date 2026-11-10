//! Explicit collection of owned upload staging; final attachments and history pins remain.
use kcoder_types::historical_attachment::HistoricalAttachmentSelection;
use kcoder_types::local_attachment::HistoricalLocalAttachmentJob;
use serde::{Deserialize, Serialize};

pub const CAPABILITY_MIGRATION_UPLOAD_COLLECTION_V1: &str = "migrationUploadCollectionV1";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollectionPrepareParams {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
    pub expected_upload_sequence: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollectionReadParams {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollectionListParams {
    pub selection: HistoricalAttachmentSelection,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollectionRunParams {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
    pub collection_id: String,
    pub expected_sequence: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollectionCancelParams {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
    pub collection_id: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollectionResumeParams {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
    pub collection_id: String,
    pub expected_sequence: u64,
    /// Rebase only through this explicit action and only before Native side effects.
    pub expected_upload_sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationUploadCollectionStage {
    Prepared,
    Blocked,
    Collecting,
    Collected,
    Cancelled,
    OutcomeUnknown,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollection {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
    pub collection_id: String,
    pub sequence: u64,
    pub upload_sequence: u64,
    pub stage: MigrationUploadCollectionStage,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
    pub storage_retired: bool,
    /// Verified logical lengths, not a promise about filesystem free blocks.
    pub deleted_bytes: u64,
    /// Freed staging reservation only after the original completed deletion receipt.
    pub released_reservation_bytes: u64,
    pub failure_code: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollectionStateResult {
    pub collection: Option<MigrationUploadCollection>,
    /// Observed from the Native independent collection writer, including peer processes.
    pub worker_running: bool,
    /// Connection-owned accepted work; this alone does not prove Native execution.
    pub worker_scheduled: bool,
    pub worker_error: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollectionListResult {
    pub items: Vec<MigrationUploadCollectionStateResult>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationUploadCollectionAttachmentResult {
    pub job: HistoricalLocalAttachmentJob,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_authority_is_a_fixed_upload_and_selection_not_a_path_or_cleanup_flag() {
        let input = serde_json::json!({"operationId":"owned-upload","selection":{"jobId":"job","viewId":null,"position":0,"blockIndex":0,"toolItemIndex":null},"expectedUploadSequence":1});
        assert!(
            serde_json::from_value::<MigrationUploadCollectionPrepareParams>(input.clone()).is_ok()
        );
        for key in [
            "path",
            "root",
            "sourcePath",
            "recursive",
            "force",
            "owner",
            "profile",
            "autoRun",
        ] {
            let mut extra = input.clone();
            extra[key] = serde_json::json!("untrusted");
            assert!(
                serde_json::from_value::<MigrationUploadCollectionPrepareParams>(extra).is_err()
            );
        }
        assert!(serde_json::from_value::<MigrationUploadCollectionRunParams>(serde_json::json!({"operationId":"owned-upload","selection":input["selection"],"expectedSequence":1})).is_err());
    }
}
