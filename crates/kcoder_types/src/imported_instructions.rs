//! Explicit imported guide scopes are user constraints, never product policy or new permissions.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportedInstructionTrigger {
    Launch,
    OnCwd,
    OnRead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedInstructionProvenance {
    pub version: u32,
    pub source: crate::migration::MigrationSourceKind,
    pub source_relative_path: String,
    pub source_sha256: String,
    /// Physical evidence permits deduplication only when this same file was read natively.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_file_identity: Option<String>,
    pub cohort_id: String,
    pub rank: u32,
    pub trigger: ImportedInstructionTrigger,
    pub target_root: PathBuf,
    pub target_root_identity: String,
    pub target_workspace_identity: String,
}

/// Only Native composition can construct the actual same-read file evidence used for deduplication.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeInstructionFact {
    pub file_identity: String,
    pub sha256: String,
}
impl std::fmt::Debug for NativeInstructionFact {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeInstructionFact")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeferredImportedInstruction {
    pub activation_id: String,
    pub id: String,
    pub operation_id: String,
    pub scope_root: PathBuf,
    pub provenance: ImportedInstructionProvenance,
    pub content: String,
}
impl std::fmt::Debug for DeferredImportedInstruction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeferredImportedInstruction")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// A captured native boundary distinguishes observed-empty from old sessions without this envelope.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedInstructionSession {
    pub version: u32,
    pub before_native: Option<String>,
    pub native_context: Option<String>,
    pub deferred: Vec<DeferredImportedInstruction>,
}
impl std::fmt::Debug for ImportedInstructionSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportedInstructionSession")
            .field("version", &self.version)
            .field("deferred", &self.deferred.len())
            .finish_non_exhaustive()
    }
}
