//! Explicit read-only provenance discovery leaves legacy migration results unchanged.
use kcoder_types::configuration_layers::{ConfigurationFieldOrigin, ConfigurationLayerState};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_MIGRATION_CONFIGURATION_LAYERS_V1: &str = "migrationConfigurationLayersV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MigrationConfigurationLayersTarget {
    Source {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    Job {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "itemId", default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationConfigurationLayersParams {
    pub target: MigrationConfigurationLayersTarget,
    #[serde(default)]
    pub page_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationConfigurationLayersStatus {
    Available,
    NotApplicable,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationConfigurationLayersResult {
    pub target: MigrationConfigurationLayersTarget,
    pub status: MigrationConfigurationLayersStatus,
    pub page_index: u32,
    pub adapter_revision: Option<String>,
    pub layers: Vec<ConfigurationLayerState>,
    pub fields: Vec<ConfigurationFieldOrigin>,
    pub total_fields: u32,
    pub next_page: Option<u32>,
    pub unobserved: Vec<String>,
}
