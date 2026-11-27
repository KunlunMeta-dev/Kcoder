//! Correlation of selected historical tools does not execute or approve them.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchToolsStateResult {
    pub state: kcoder_types::historical_tool_links::HistoricalBranchToolState,
    pub worker_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBranchToolsPageParams {
    pub job_id: String,
    pub view_id: String,
    pub cursor: Option<String>,
}

pub type MigrationBranchToolsPageResult =
    kcoder_types::historical_tool_links::HistoricalToolLinkPage;
