//! Batch requests select native inventory identities; source paths and credentials are never inputs.
use crate::{MigrationJobSummary, MigrationProviderCandidate};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchScanParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_limits: Option<crate::MigrationResourceLimits>,
    pub source_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history_sources: Vec<MigrationBatchHistorySource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugin_sources: Vec<MigrationBatchPluginSource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_sources: Vec<MigrationBatchProjectSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchPluginSource {
    pub operation_id: String,
    pub expected_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchProjectSource {
    pub catalog_id: String,
    pub source_handle: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchHistorySource {
    pub catalog_id: String,
    pub source_handle: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MigrationBatchChoice {
    #[serde(rename_all = "camelCase")]
    Project {
        item_id: String,
        mapping: kcoder_types::migration_projects::MigrationProjectMappingChoice,
    },
    #[serde(rename_all = "camelCase")]
    Plugin {
        item_id: String,
        target_name: String,
    },
    #[serde(rename_all = "camelCase")]
    History { item_id: String },
    #[serde(rename_all = "camelCase")]
    Template {
        item_id: String,
        target_name: String,
        provider_item_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Provider {
        item_id: String,
        target_name: String,
        endpoint: Option<String>,
        model: Option<String>,
        context_window_tokens: u64,
        output_headroom_tokens: u64,
        max_output_tokens: u64,
    },
    #[serde(rename_all = "camelCase")]
    Mcp {
        item_id: String,
        target_name: String,
        cwd: Option<String>,
        #[serde(default)]
        enable_after_import: bool,
    },
    #[serde(rename_all = "camelCase")]
    Asset {
        item_id: String,
        target_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_adaptation: Option<crate::MigrationAgentAdaptation>,
        #[serde(default)]
        enable_after_import: bool,
        #[serde(
            rename = "memoryMapping",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        memory_mapping: Option<kcoder_types::imported_memory::ImportedMemoryMapping>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchPlanParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub choices: Vec<MigrationBatchChoice>,
    #[serde(default)]
    pub include_default_items: bool,
    #[serde(default)]
    pub excluded_item_ids: Vec<String>,
    #[serde(default)]
    pub reuse_existing: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credentials: Vec<MigrationBatchCredentialChoice>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_credentials: Vec<MigrationBatchMcpCredentialChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_mcp_inheritance: Option<crate::MigrationProjectMcpInheritanceSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchMcpCredentialChoice {
    pub item_id: String,
    pub fields: Vec<kcoder_types::migration::MigrationMcpPrivateField>,
    pub consent_private_values: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchCredentialChoice {
    pub item_id: String,
    pub source: crate::MigrationApiKeySource,
    pub consent_api_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchOperationParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub plan_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationBatchRunMode {
    Apply,
    Resume,
    Rollback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchRunParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub plan_id: String,
    pub request_id: String,
    pub mode: MigrationBatchRunMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchProgress {
    pub action_id: String,
    pub action_index: usize,
    pub total_actions: usize,
    pub history: Option<crate::MigrationHistoryProgress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchStateResult {
    pub state: crate::MigrationJobReadResult,
    pub worker_running: bool,
    pub worker_error: Option<String>,
    pub progress: Option<MigrationBatchProgress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchSummary {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub atomic_credentials: bool,
    pub plan_id: Option<String>,
    pub selected_items: usize,
    pub total_actions: usize,
    pub committed_actions: usize,
    pub unresolved_actions: usize,
    #[serde(default)]
    pub default_item_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub reused_items: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub credential_actions: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub published_credentials: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchDraft {
    pub item_id: String,
    pub target_name: String,
    pub choice: Option<MigrationBatchChoice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchItemSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_job_id: Option<String>,
    pub item_id: String,
    pub target_name: Option<String>,
    pub enabled: bool,
    pub project_scoped: bool,
    pub native_reference: bool,
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reused_from_job_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchItemPlanParams {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub include_template: bool,
    pub job_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchItemPlanResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<MigrationTemplateSettings>,
    pub item: MigrationBatchItemSummary,
    pub provider: Option<MigrationProviderCandidate>,
    pub mcp: Option<kcoder_types::McpServerConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationTemplateSettings {
    pub id: String,
    pub provider_name: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationJobsListParams {
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationJobRecord {
    pub job: MigrationJobSummary,
    pub source: kcoder_types::migration::MigrationSourceKind,
    pub created_at_ms: u64,
    pub is_batch: bool,
    pub selected_items: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub reused_items: usize,
}
fn is_zero(value: &usize) -> bool {
    *value == 0
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationJobsListResult {
    pub jobs: Vec<MigrationJobRecord>,
    pub next_cursor: Option<String>,
}
