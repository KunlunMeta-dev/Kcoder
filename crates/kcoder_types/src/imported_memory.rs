//! Static imported notes retain provenance without asserting that their claims are verified.
use crate::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ImportedMemoryLayout {
    ClaudeAutoMemoryV1,
    CodexMemoryFilesV1,
    UnclassifiedStaticNotes,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemoryProvenance {
    pub source: MigrationSourceKind,
    pub layout: ImportedMemoryLayout,
    pub source_group: String,
    pub source_file: String,
    pub source_revision: String,
    pub source_modified_at_ms: Option<u64>,
    /// Integrity checks concern bytes, not the truth of model-authored statements.
    #[serde(deserialize_with = "unverified")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "unverified_schema"))]
    pub facts_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_job_id: Option<String>,
}

fn unverified<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    if bool::deserialize(deserializer)? {
        return Err(serde::de::Error::custom("imported memory is unverified"));
    }
    Ok(false)
}

#[cfg(feature = "json-schema")]
fn unverified_schema(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    serde_json::from_value(serde_json::json!({"type":"boolean","enum":[false]}))
        .expect("static unverified memory schema")
}

impl std::fmt::Debug for ImportedMemoryProvenance {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportedMemoryProvenance")
            .field("source", &self.source)
            .field("layout", &self.layout)
            .field("facts_verified", &self.facts_verified)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ImportedMemoryMapping {
    Global,
    CurrentWorkspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemorySourceSummary {
    pub source_id: String,
    pub source: MigrationSourceKind,
    pub layout: ImportedMemoryLayout,
    /// An original directory label, never a decoded or inferred project path.
    pub source_group: String,
    pub files: u32,
    pub bytes: u64,
    pub blocked_items: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemoryDiscoveryProblem {
    pub code: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemorySourcePage {
    pub catalog_id: String,
    pub items: Vec<ImportedMemorySourceSummary>,
    pub next_cursor: Option<String>,
    pub problems: Vec<ImportedMemoryDiscoveryProblem>,
    pub unobserved: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemoryControl {
    pub request_id: String,
    pub id: String,
    pub owner_operation_id: String,
    pub expected_revision: String,
    pub enabled: bool,
    pub confirm_unverified_notes: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemoryControlReceipt {
    pub request: ImportedMemoryControl,
    pub applied_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImportedMemoryScope {
    Global,
    Project { root: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemoryRecordSummary {
    pub id: String,
    pub owner_operation_id: String,
    pub name: String,
    pub scope: ImportedMemoryScope,
    pub enabled: bool,
    pub revision: String,
    pub bytes: u64,
    pub provenance: Option<ImportedMemoryProvenance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemoryRecordPage {
    pub items: Vec<ImportedMemoryRecordSummary>,
    pub total_records: u32,
    pub next_page: Option<u32>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemoryRecordText {
    pub record: ImportedMemoryRecordSummary,
    pub text: String,
    pub total_bytes: u64,
    pub next_offset: Option<u64>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMemoryControlResult {
    /// An applied receipt and the current observed record are deliberately separate.
    pub receipt: Option<ImportedMemoryControlReceipt>,
    pub current: Option<ImportedMemoryRecordSummary>,
}
