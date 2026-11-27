//! Portable, restrictive execution metadata for adapted plugin prompt entries.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPromptProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_agent: Option<crate::migration_agent::ImportedAgentExecution>,
    pub instructions: String,
    #[serde(default)]
    pub argument_names: Vec<String>,
    pub plugin_root: String,
    pub source: String,
    pub kind: String,
    pub allowed_tools: Option<Vec<String>>,
    pub max_turns: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPromptPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_model_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_agent: Option<crate::migration_agent::ImportedAgentExecution>,
    pub allowed_tools: Option<Vec<String>>,
    pub max_turns: Option<usize>,
}
