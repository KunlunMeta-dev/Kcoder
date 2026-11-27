use kcoder_types::migration::{MigrationIssue, MigrationItemPreview, MigrationSourceKind};
use serde::{Deserialize, Serialize};

/// An uncommitted mapping. Missing values stay unknown instead of inventing limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCandidate {
    pub api_format: String,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub context_window_tokens: Option<u64>,
    pub output_headroom_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub credential_environment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedItem {
    pub preview: MigrationItemPreview,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<McpCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<AssetCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<TemplateCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateCandidate {
    pub source_provider: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetCandidate {
    pub entry: String,
    pub name: String,
    pub bytes: usize,
    pub files: usize,
    pub native_reference: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpCandidate {
    pub config: kcoder_types::McpServerConfig,
    pub enabled_in_source: bool,
    pub source_cwd: Option<String>,
}

/// Only explicitly mapped, credential-free values can enter this intermediate form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationInventory {
    pub source: MigrationSourceKind,
    pub adapter_revision: String,
    pub items: Vec<NormalizedItem>,
    pub issues: Vec<MigrationIssue>,
}
