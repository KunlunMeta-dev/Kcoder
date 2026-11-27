//! Explicit static source data and reviewed target choices never carry Native filesystem proof.
use crate::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
mod codec;

pub const INSTRUCTION_PAGE_ITEMS: usize = 10;
pub const INSTRUCTION_BODY_WINDOW: usize = 16 * 1024;
pub const INSTRUCTION_MAX_FILES: usize = 128;
pub const INSTRUCTION_MAX_FILE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum InstructionSourceRole {
    Shared,
    Local,
    Override,
    Ordinary,
    Fallback,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum InstructionSourceTrigger {
    Launch,
    OnRead,
    OnCwd,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum InstructionSourceDisposition {
    Selected,
    Empty,
    Shadowed,
    RequiresReview,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum InstructionFormatRevision {
    #[serde(rename = "scoped-instructions/v1")]
    ScopedV1,
    #[serde(rename = "scoped-instructions/v2")]
    ScopedV2,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum InstructionCaptureFormat {
    StaticV2,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationInstructionCaptureParams {
    #[serde(deserialize_with = "codec::uuid")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::uuid_schema"))]
    pub capture_id: String,
    pub source: MigrationSourceKind,
    pub format: InstructionCaptureFormat,
    #[serde(deserialize_with = "codec::directory")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "codec::directory_schema")
    )]
    pub source_root: String,
    #[serde(deserialize_with = "codec::directory")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "codec::directory_schema")
    )]
    pub source_cwd: String,
    #[serde(default)]
    pub include_descendants: bool,
    #[serde(deserialize_with = "codec::confirmed")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "codec::confirmed_schema")
    )]
    pub confirm_static_subset: bool,
}
impl std::fmt::Debug for MigrationInstructionCaptureParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MigrationInstructionCaptureParams")
            .field("capture_id", &self.capture_id)
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationInstructionCaptureResult {
    pub capture_id: String,
    pub source: MigrationSourceKind,
    pub format_revision: InstructionFormatRevision,
    pub source_revision: String,
    pub total_items: u32,
    pub complete_authorized_static_chain: bool,
    pub dynamic_scope_present: bool,
    pub remaining_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MigrationInstructionReadTarget {
    Source {
        #[serde(rename = "captureId", deserialize_with = "codec::uuid")]
        #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::uuid_schema"))]
        capture_id: String,
    },
    Job {
        #[serde(rename = "jobId", deserialize_with = "codec::atom")]
        #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::atom_schema"))]
        job_id: String,
    },
    Received {
        #[serde(rename = "requestId", deserialize_with = "codec::uuid")]
        #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::uuid_schema"))]
        request_id: String,
        #[serde(rename = "manifestSha256", deserialize_with = "codec::sha")]
        #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::sha_schema"))]
        manifest_sha256: String,
        #[serde(rename = "entryId", deserialize_with = "codec::entry")]
        #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::entry_schema"))]
        entry_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationInstructionPageParams {
    pub target: MigrationInstructionReadTarget,
    #[serde(default)]
    pub page_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceInstructionPageParams {
    #[serde(deserialize_with = "codec::uuid")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::uuid_schema"))]
    pub capture_id: String,
    #[serde(default)]
    pub page_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationInstructionItem {
    pub item_id: String,
    pub display_name: String,
    pub source: MigrationSourceKind,
    pub scoped: bool,
    pub format_revision: Option<InstructionFormatRevision>,
    pub source_revision: Option<String>,
    pub relative_path: Option<String>,
    pub relative_scope: Option<String>,
    pub role: Option<InstructionSourceRole>,
    pub trigger: Option<InstructionSourceTrigger>,
    pub disposition: InstructionSourceDisposition,
    pub bytes: Option<u64>,
    pub complete_authorized_static_chain: bool,
    pub reason_code: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationInstructionPageResult {
    pub target: MigrationInstructionReadTarget,
    pub page_index: u32,
    pub items: Vec<MigrationInstructionItem>,
    pub total_items: u32,
    pub next_page: Option<u32>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum InstructionRepresentation {
    Original,
    Compiled,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum InstructionBodyEncoding {
    Utf8,
    Binary,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationInstructionBodyParams {
    pub target: MigrationInstructionReadTarget,
    #[serde(deserialize_with = "codec::atom")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::atom_schema"))]
    pub item_id: String,
    pub representation: InstructionRepresentation,
    #[serde(default)]
    pub offset: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceInstructionBodyParams {
    #[serde(deserialize_with = "codec::uuid")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::uuid_schema"))]
    pub capture_id: String,
    #[serde(deserialize_with = "codec::atom")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::atom_schema"))]
    pub item_id: String,
    pub representation: InstructionRepresentation,
    #[serde(default)]
    pub offset: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationInstructionBodyResult {
    pub target: MigrationInstructionReadTarget,
    pub item_id: String,
    pub representation: InstructionRepresentation,
    pub format_revision: Option<InstructionFormatRevision>,
    pub offset: u64,
    pub encoding: InstructionBodyEncoding,
    pub bytes_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub total_bytes: u64,
    pub sha256: String,
    pub next_offset: Option<u64>,
    #[serde(deserialize_with = "codec::disabled")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "codec::disabled_schema")
    )]
    pub enabled_by_preview: bool,
}
impl std::fmt::Debug for MigrationInstructionBodyResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MigrationInstructionBodyResult")
            .field("item_id", &self.item_id)
            .field("offset", &self.offset)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationInstructionScopeChoice {
    #[serde(deserialize_with = "codec::atom")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::atom_schema"))]
    pub item_id: String,
    #[serde(deserialize_with = "codec::relative")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "codec::relative_schema")
    )]
    pub target_relative_scope: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceInstructionMapping {
    #[serde(deserialize_with = "codec::entry")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "codec::entry_schema"))]
    pub entry_id: String,
    #[serde(deserialize_with = "codec::choices")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "codec::choices_schema")
    )]
    pub items: Vec<MigrationInstructionScopeChoice>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub archive_incomplete_chain: bool,
}
