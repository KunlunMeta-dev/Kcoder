pub use kcoder_types::tool_ui::{ToolCatalogEntry, ToolUiGroup, ToolUiIcon, ToolUiMetadata};
use serde::{Deserialize, Serialize};

pub use kcoder_types::tool_ui::{TOOL_CATALOG_BYTE_LIMIT, TOOL_CATALOG_LIMIT};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolsCatalogParams {
    /// Omit for the current target's workspace baseline, not a union of threads.
    #[serde(default)]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolCatalogScope {
    Workspace,
    Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolCatalogCachePolicy {
    #[serde(rename = "no-store")]
    NoStore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsCatalogResult {
    pub scope: ToolCatalogScope,
    pub thread_id: Option<String>,
    /// Snapshots must not be reused across targets, threads, modes or refreshes.
    pub cache_policy: ToolCatalogCachePolicy,
    pub tools: Vec<ToolCatalogEntry>,
    pub total: usize,
    pub truncated: bool,
}
