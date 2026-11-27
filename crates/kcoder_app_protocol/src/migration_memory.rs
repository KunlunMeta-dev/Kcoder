//! Imported memory is explicitly selected, inactive by default and never a verified fact.
use serde::{Deserialize, Serialize};
pub const CAPABILITY_MIGRATION_MEMORY_V1: &str = "migrationMemoryV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMemoryDiscoverParams {
    pub source: kcoder_types::migration::MigrationSourceKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMemorySourcesParams {
    pub catalog_id: String,
    #[serde(default)]
    pub cursor: Option<String>,
}
pub type MigrationMemorySourcesResult = kcoder_types::imported_memory::ImportedMemorySourcePage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMemoryListParams {
    #[serde(default)]
    pub page_index: u32,
}
pub type MigrationMemoryListResult = kcoder_types::imported_memory::ImportedMemoryRecordPage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMemoryReadParams {
    pub id: String,
    #[serde(default)]
    pub offset: u64,
}
pub type MigrationMemoryReadResult = kcoder_types::imported_memory::ImportedMemoryRecordText;
pub type MigrationMemoryControlParams = kcoder_types::imported_memory::ImportedMemoryControl;
pub type MigrationMemoryControlResult = kcoder_types::imported_memory::ImportedMemoryControlResult;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMemoryControlReadParams {
    pub request_id: String,
}
