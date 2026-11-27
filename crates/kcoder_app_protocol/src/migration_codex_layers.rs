//! Explicit project selection and independent Codex origins preserve legacy result schemas.
use serde::{Deserialize, Serialize};
pub const CAPABILITY_MIGRATION_CODEX_LAYERS_V1: &str = "migrationCodexLayersV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationCodexLayersSelectParams {
    pub source_id: String,
    pub include_project: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationCodexLayersSelectResult {
    pub source: crate::MigrationSourceSummary,
    /// Only opaque references from this account's existing discovery; never source paths.
    pub replaces_source_ids: Vec<String>,
}

pub type MigrationCodexLayersReadParams = crate::MigrationConfigurationLayersParams;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum CodexConfigurationLayerKind {
    User,
    Profile,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexConfigurationLayerState {
    pub index: u32,
    pub kind: CodexConfigurationLayerKind,
    pub present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationCodexLayersReadResult {
    pub target: crate::MigrationConfigurationLayersTarget,
    pub status: crate::MigrationConfigurationLayersStatus,
    pub page_index: u32,
    pub adapter_revision: Option<String>,
    pub layers: Vec<CodexConfigurationLayerState>,
    pub fields: Vec<kcoder_types::codex_configuration_layers::CodexFieldOrigin>,
    pub total_fields: u32,
    pub next_page: Option<u32>,
    pub unobserved: Vec<String>,
}
