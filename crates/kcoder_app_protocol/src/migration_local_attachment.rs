//! Uploaded bytes supplement an inert historical reference; no server path grants are accepted.
use kcoder_types::{
    historical_attachment::{HistoricalAttachmentReceipt, HistoricalAttachmentSelection},
    local_attachment_upload::HistoricalLocalAttachmentUpload,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationLocalAttachmentPrepareParams {
    pub request_id: String,
    pub selection: HistoricalAttachmentSelection,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationLocalAttachmentReadParams {
    pub operation_id: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationLocalAttachmentBeginParams {
    pub operation_id: String,
    pub expected_sequence: u64,
    pub filename: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationLocalAttachmentPartParams {
    pub operation_id: String,
    pub expected_sequence: u64,
    pub index: u32,
    pub content_base64: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationLocalAttachmentRunParams {
    pub operation_id: String,
    /// Upload sequence for finish/resume, local copy sequence for run.
    pub expected_sequence: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationLocalAttachmentListParams {
    pub selection: HistoricalAttachmentSelection,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationLocalAttachmentStateResult {
    pub upload: HistoricalLocalAttachmentUpload,
    pub worker_running: bool,
    pub worker_error: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationLocalAttachmentListResult {
    pub items: Vec<HistoricalLocalAttachmentUpload>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationLocalAttachmentChunkParams {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
    pub expected_receipt: HistoricalAttachmentReceipt,
    pub offset: u64,
    pub limit: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_contract_never_accepts_a_historical_or_server_source_path() {
        let original = serde_json::json!({
            "operationId":"5dbd1f42-a3aa-4330-971a-5cd3f056ed40",
            "expectedSequence":0,"filename":"notes.txt","bytes":3,
            "sha256":"a".repeat(64)
        });
        assert!(
            serde_json::from_value::<MigrationLocalAttachmentBeginParams>(original.clone()).is_ok()
        );
        for key in ["path", "root", "sourcePath", "explicitConsent", "owner"] {
            let mut extra = original.clone();
            extra[key] = serde_json::json!("unauthorized");
            assert!(serde_json::from_value::<MigrationLocalAttachmentBeginParams>(extra).is_err());
        }
    }
}
