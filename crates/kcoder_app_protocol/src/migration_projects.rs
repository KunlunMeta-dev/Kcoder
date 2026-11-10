//! Project inventory and explicit Native workspace mapping. No request authorizes source paths.
use serde::{Deserialize, Serialize};
pub const CAPABILITY_MIGRATION_PROJECTS_V1: &str = "migrationProjectsV1";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectsDiscoverParams {
    pub source: kcoder_types::migration::MigrationSourceKind,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectsSourcesParams {
    pub catalog_id: String,
    #[serde(default)]
    pub page_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectSourceRootsParams {
    pub catalog_id: String,
    pub source_handle: String,
    #[serde(default)]
    pub page_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectTargetsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_catalog_id: Option<String>,
    #[serde(default)]
    pub page_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectTargetRootsParams {
    pub target_catalog_id: String,
    pub target_handle: String,
    #[serde(default)]
    pub page_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectReportParams {
    pub job_id: String,
    pub item_id: String,
    #[serde(default)]
    pub page_index: u32,
}
pub use kcoder_types::migration_projects::{
    MigrationProjectReceivedMetadata, MigrationProjectReportResult,
    MigrationProjectSourceRootsResult, MigrationProjectSourcesResult,
    MigrationProjectTargetRootsResult, MigrationProjectTargetsResult,
};
