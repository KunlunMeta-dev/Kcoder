//! Compiled foreign facts are neither executable messages nor current permissions.
use crate::{
    historical_attachment::{HistoricalAttachmentReceipt, HistoricalAttachmentSelection},
    imported_transcript::{HistoricalRole, HistoricalToolOutcome},
    migration::MigrationSourceKind,
};
use serde::{Deserialize, Serialize};

pub const HISTORICAL_CONTEXT_DEFAULT_BYTES: u64 = 4 * 1024 * 1024;
pub const HISTORICAL_CONTEXT_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub const HISTORICAL_CONTEXT_DEFAULT_ENTRIES: u32 = 2048;
pub const HISTORICAL_CONTEXT_MAX_ENTRIES: u32 = 4096;
pub const HISTORICAL_CONTEXT_DEFAULT_ATTACHMENTS: u32 = 256;
pub const HISTORICAL_CONTEXT_DEFAULT_ATTACHMENT_BYTES: u64 = 512 * 1024 * 1024;
pub const LEGACY_HISTORICAL_CONTEXT_COMPILER_REVISION: &str = "inert-history-context/1";
pub const HISTORICAL_CONTEXT_COMPILER_REVISION_V2: &str = "inert-history-context/2";
pub const HISTORICAL_CONTEXT_COMPILER_REVISION_V3: &str = "inert-history-context/3";
pub const HISTORICAL_CONTEXT_COMPILER_REVISION: &str = "inert-history-context/4";
/// A reconstruction is distinct from a faithfully reproduced provider window.
pub const HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION_V1: &str =
    "inert-history-context/reconstructed/1";
pub const HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION: &str = "inert-history-context/reconstructed/2";

pub fn historical_context_revision_reconstructed(revision: &str) -> bool {
    matches!(
        revision,
        HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION_V1 | HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION
    )
}

pub fn historical_context_revision_supported(revision: &str) -> bool {
    matches!(
        revision,
        LEGACY_HISTORICAL_CONTEXT_COMPILER_REVISION
            | HISTORICAL_CONTEXT_COMPILER_REVISION_V2
            | HISTORICAL_CONTEXT_COMPILER_REVISION_V3
            | HISTORICAL_CONTEXT_COMPILER_REVISION
            | HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION_V1
            | HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContextPolicy {
    pub max_context_bytes: u64,
    pub max_entries: u32,
    pub max_attachments: u32,
    pub max_attachment_bytes: u64,
}
impl Default for HistoricalContextPolicy {
    fn default() -> Self {
        Self {
            max_context_bytes: HISTORICAL_CONTEXT_DEFAULT_BYTES,
            max_entries: HISTORICAL_CONTEXT_DEFAULT_ENTRIES,
            max_attachments: HISTORICAL_CONTEXT_DEFAULT_ATTACHMENTS,
            max_attachment_bytes: HISTORICAL_CONTEXT_DEFAULT_ATTACHMENT_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoricalContextFactKind {
    Text,
    HistoricalInstruction,
    ToolCallFact,
    ToolResultFact,
    AttachmentReference,
}

/// Private contents may contain user-pasted secrets. Do not log or export in progress metadata.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContextEntry {
    pub position: u64,
    pub block_index: u32,
    pub source_array_index: Option<u32>,
    pub source_role: HistoricalRole,
    pub kind: HistoricalContextFactKind,
    pub text: String,
    pub call_id: Option<String>,
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub outcome: Option<HistoricalToolOutcome>,
    pub execution_outcome: Option<HistoricalToolOutcome>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContextAttachment {
    pub selection: HistoricalAttachmentSelection,
    pub source_array_index: Option<u32>,
    pub receipt: HistoricalAttachmentReceipt,
    pub media_type: Option<String>,
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<HistoricalContextAttachmentProvenance>,
}

/// Explicit user-supplied bytes, never a claim of equivalence to the historical original.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HistoricalContextAttachmentProvenance {
    UserSuppliedLocal {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
}

/// Caller selection is exact: no implicit latest operation or attachment substitution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalLocalAttachmentBinding {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
    pub receipt: HistoricalAttachmentReceipt,
}

/// Source roles label evidence only. A publisher must use current native identity and policy.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContextDocument {
    pub revision: String,
    pub source: MigrationSourceKind,
    pub source_job_id: String,
    pub view_id: String,
    pub entries: Vec<HistoricalContextEntry>,
    pub attachments: Vec<HistoricalContextAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContextIssue {
    pub code: String,
    pub position: Option<u64>,
    pub block_index: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContextReport {
    /// Source compilation only; not model compatibility, task completion or permission to run.
    pub context_compiled: bool,
    pub selected_items: u64,
    pub entries: u32,
    pub encoded_bytes: u64,
    pub attachments: u32,
    pub attachment_bytes: u64,
    pub excluded_provider_blocks: u64,
    pub issues: Vec<HistoricalContextIssue>,
    pub issues_truncated: bool,
}

/// Native-only proof, rechecked before any future publication or use.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContextBinding {
    pub compiler_revision: String,
    pub policy: HistoricalContextPolicy,
    pub branch_identity: String,
    pub tool_links_sha256: Option<String>,
    pub attachments_sha256: String,
    pub document_sha256: String,
}

pub struct HistoricalContextCompilation {
    pub report: HistoricalContextReport,
    pub document: Option<HistoricalContextDocument>,
    pub binding: Option<HistoricalContextBinding>,
}

/// Native preparation receipt. It does not describe a published or runnable session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedContextReceipt {
    pub preparation_id: String,
    pub document_sha256: String,
    pub binding_sha256: String,
    pub attachments: u32,
    pub attachment_bytes: u64,
}

/// Native publication binding. It carries no source execution authority or credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalSessionSeedBinding {
    pub operation_id: String,
    pub session_id: String,
    pub source_job_id: String,
    pub view_id: String,
    pub preparation: PreparedContextReceipt,
    pub model_snapshot_sha256: String,
    pub projection_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalSessionSeedReceipt {
    pub binding: HistoricalSessionSeedBinding,
    pub history_uuid: String,
    pub history_bytes: u64,
    pub history_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalModelProjectionReport {
    pub projection_ready: bool,
    /// Local estimate only, never measured provider usage or a successful model response.
    pub estimated_input_tokens: Option<u64>,
    pub input_limit_tokens: Option<u64>,
    pub images: u32,
    pub files: u32,
    pub issues: Vec<HistoricalContextIssue>,
}
