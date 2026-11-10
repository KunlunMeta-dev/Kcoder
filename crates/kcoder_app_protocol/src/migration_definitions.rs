//! Passive definitions are data for review, never native Agent/Hook execution authority.
use serde::{Deserialize, Serialize};
pub const CAPABILITY_MIGRATION_DEFINITIONS_V1: &str = "migrationDefinitionsV1";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDefinitionsDiscoverParams {
    #[serde(default)]
    pub sources: Vec<kcoder_types::migration::MigrationSourceKind>,
    #[serde(default)]
    pub include_project: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    #[serde(default)]
    pub page_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDefinitionsDiscoverResult {
    pub catalog_id: String,
    pub sources: Vec<crate::MigrationSourceSummary>,
    pub problems: Vec<crate::MigrationDiscoveryProblem>,
    pub total_sources: u32,
    pub next_page: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDefinitionReportParams {
    pub job_id: String,
    pub item_id: String,
    #[serde(default)]
    pub page_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDefinitionReportResult {
    pub job_id: String,
    pub item_id: String,
    pub page_index: u32,
    pub report: kcoder_types::migration_definitions::MigrationDefinitionReport,
    pub total_fields: u32,
    pub next_page: Option<u32>,
    pub total_bytes: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDefinitionBodyParams {
    pub job_id: String,
    pub item_id: String,
    #[serde(default)]
    pub offset: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationDefinitionBodyEncoding {
    Utf8,
    Binary,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDefinitionBodyResult {
    pub job_id: String,
    pub item_id: String,
    pub offset: u64,
    pub encoding: MigrationDefinitionBodyEncoding,
    pub bytes_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub total_bytes: u64,
    pub sha256: String,
    pub next_offset: Option<u64>,
}
