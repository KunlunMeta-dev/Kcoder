//! Portable, restrictive execution metadata for adapted plugin prompt entries.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPromptProfile {
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
    pub allowed_tools: Option<Vec<String>>,
    pub max_turns: Option<usize>,
}
