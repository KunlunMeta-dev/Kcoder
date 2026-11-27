//! Persisted imported project associations. Source paths are data, never target permissions.
use crate::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedProjectOwner {
    pub operation_id: String,
    pub action_id: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedProjectSource {
    pub source: MigrationSourceKind,
    pub format_revision: String,
    pub project_id: String,
    pub project_name: String,
    pub snapshot_sha256: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedProjectRoot {
    pub source_root_id: String,
    pub source_path: String,
    pub target_root: PathBuf,
    pub target_identity: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedProjectTarget {
    pub project_key: String,
    pub workspace: PathBuf,
    pub workspace_identity: String,
    pub roots: Vec<ImportedProjectRoot>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedProjectAssociation {
    pub id: String,
    pub owner: ImportedProjectOwner,
    pub source: ImportedProjectSource,
    pub target: ImportedProjectTarget,
    pub revision: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportedProjectReceiptStage {
    Associated,
    Removed,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedProjectReceipt {
    pub association_id: String,
    pub owner: ImportedProjectOwner,
    pub record_sha256: String,
    pub record_revision: u64,
    pub stage: ImportedProjectReceiptStage,
}
