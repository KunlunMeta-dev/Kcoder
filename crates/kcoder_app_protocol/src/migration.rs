//! Reviewed migration envelopes. Implementations negotiate capabilities separately.
use kcoder_types::migration::{MigrationItemPreview, MigrationJobStatus, MigrationSourceKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDiscoverParams {
    #[serde(default)]
    pub sources: Vec<MigrationSourceKind>,
    #[serde(default)]
    pub include_project: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceSummary {
    pub source_id: String,
    pub kind: MigrationSourceKind,
    pub display_name: String,
    pub format_revision: String,
    pub available_categories: Vec<kcoder_types::migration::MigrationCategory>,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDiscoveryProblem {
    pub kind: MigrationSourceKind,
    pub scope: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDiscoverResult {
    pub sources: Vec<MigrationSourceSummary>,
    #[serde(default)]
    pub problems: Vec<MigrationDiscoveryProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationScanParams {
    pub source_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationOperationParams {
    pub job_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationItemsParams {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_index: Option<usize>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub include_templates: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationItemsResult {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub templates: Vec<MigrationTemplateCandidate>,
    pub items: Vec<MigrationItemPreview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub providers: Vec<MigrationProviderCandidate>,
    #[serde(default)]
    pub mcps: Vec<MigrationMcpCandidate>,
    #[serde(default)]
    pub assets: Vec<MigrationAssetCandidate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub planned: Vec<crate::MigrationBatchItemSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drafts: Vec<crate::MigrationBatchDraft>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationTemplateCandidate {
    pub item_id: String,
    pub name: String,
    pub provider_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_page_index: Option<usize>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationAssetCandidate {
    pub item_id: String,
    pub name: String,
    pub bytes: usize,
    pub files: usize,
    pub native_reference: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationAssetPlanParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub item_id: String,
    pub target_name: String,
    #[serde(default)]
    pub enable_after_import: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_mapping: Option<kcoder_types::imported_memory::ImportedMemoryMapping>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationAssetPlanSummary {
    pub plan_id: String,
    pub item_id: String,
    pub target_name: String,
    pub enable_after_import: bool,
    pub native_reference: bool,
    pub project_scoped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationAssetPreviewParams {
    pub job_id: String,
    pub item_id: String,
    #[serde(default)]
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationAssetPreviewResult {
    pub item_id: String,
    pub text: String,
    pub total_bytes: usize,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMcpCandidate {
    pub item_id: String,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub url: String,
    pub cwd: Option<String>,
    pub source_cwd: Option<String>,
    pub required_env: Vec<String>,
    pub required_headers: Vec<String>,
    pub enabled_in_source: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMcpPlanParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub item_id: String,
    pub target_name: String,
    pub cwd: Option<String>,
    #[serde(default)]
    pub enable_after_import: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMcpPlanSummary {
    pub plan_id: String,
    pub item_id: String,
    pub config: kcoder_types::McpServerConfig,
    pub enable_after_import: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProviderCandidate {
    pub item_id: String,
    pub api_format: String,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub context_window_tokens: Option<u64>,
    pub output_headroom_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProviderPlanParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub item_id: String,
    pub target_name: String,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub context_window_tokens: u64,
    pub output_headroom_tokens: u64,
    pub max_output_tokens: u64,
}

/// The durable plan ID is also the operation identity for safe retries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProviderOperationParams {
    pub job_id: String,
    pub plan_id: String,
    pub expected_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationCancelParams {
    pub job_id: String,
    pub expected_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProviderPlanSummary {
    pub plan_id: String,
    pub item_id: String,
    pub target_name: String,
    pub provider: MigrationProviderCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationJobReadResult {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credential_plans: Vec<crate::MigrationCredentialPlanSummary>,
    pub job: MigrationJobSummary,
    pub source: MigrationSourceKind,
    pub plans: Vec<MigrationProviderPlanSummary>,
    #[serde(default)]
    pub mcp_plans: Vec<MigrationMcpPlanSummary>,
    #[serde(default)]
    pub asset_plans: Vec<MigrationAssetPlanSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<crate::MigrationBatchSummary>,
    pub issues: Vec<kcoder_types::migration::MigrationIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationJobSummary {
    pub job_id: String,
    pub source_id: String,
    pub status: MigrationJobStatus,
    pub sequence: u64,
    pub total_items: usize,
    pub committed_items: usize,
    pub requires_action_items: usize,
    #[serde(default)]
    pub has_unconfirmed_outcomes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPlanParams {
    pub job_id: String,
    pub selected_item_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationApplyParams {
    pub plan_id: String,
    pub request_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_and_job_references_cannot_supply_paths_accounts_or_credentials() {
        for input in [
            r#"{"sourceId":"source","path":"/other-user"}"#,
            r#"{"sourceId":"source","owner":"administrator"}"#,
            r#"{"sourceId":"source","credentials":{"key":"not-allowed"}}"#,
        ] {
            assert!(serde_json::from_str::<MigrationScanParams>(input).is_err());
        }
        assert!(
            serde_json::from_str::<MigrationApplyParams>(
                r#"{"planId":"plan","requestId":"request","secret":"forbidden"}"#
            )
            .is_err()
        );
    }
}
