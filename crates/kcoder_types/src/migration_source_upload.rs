//! User-supplied migration files. A manifest does not authenticate an original machine or account.
use crate::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceUploadFile {
    pub relative_path: String,
    pub bytes: u64,
    pub sha256: String,
}

/// Version 1 describes regular files relative to one selected product directory.
/// File order is immutable and defines the backup container's payload order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceUploadManifest {
    pub version: u32,
    pub source: MigrationSourceKind,
    pub files: Vec<SourceUploadFile>,
}

/// User-supplied bytes, never an assertion about the browser's OS or source account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceUploadProvenance {
    pub operation_id: String,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SourceUploadStage {
    Prepared,
    Receiving,
    Verifying,
    Ready,
    CancelRequested,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SourceUploadWorkerState {
    Running,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceUploadState {
    pub operation_id: String,
    pub manifest_sha256: String,
    pub source: MigrationSourceKind,
    pub stage: SourceUploadStage,
    pub sequence: u64,
    pub cancel_watermark: u64,
    pub cancel_requested: bool,
    pub worker_state: SourceUploadWorkerState,
    pub total_files: u32,
    pub completed_files: u32,
    pub total_bytes: u64,
    pub received_bytes: u64,
    pub verified_bytes: u64,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceUploadFileProgress {
    pub file_index: u32,
    pub accepted_bytes: u64,
    pub next_part: u32,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceUploadFilePage {
    pub operation_id: String,
    pub manifest_sha256: String,
    pub files: Vec<SourceUploadFileProgress>,
    pub next_cursor: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn uploaded_manifest_cannot_claim_original_os_authority_or_link_entries() {
        let original = json!({"version":1,"source":"codex","files":[{"relativePath":"config.toml","bytes":0,"sha256":"a".repeat(64)}]});
        let parsed: SourceUploadManifest = serde_json::from_value(original.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), original);
        for field in [
            "sourceAuthority",
            "account",
            "instanceId",
            "destination",
            "executable",
        ] {
            let mut value = original.clone();
            value[field] = json!("forged");
            assert!(serde_json::from_value::<SourceUploadManifest>(value).is_err());
        }
        for field in ["symlink", "hardlink", "target", "executable"] {
            let mut value = original.clone();
            value["files"][0][field] = json!("forged");
            assert!(serde_json::from_value::<SourceUploadManifest>(value).is_err());
        }
    }
}
