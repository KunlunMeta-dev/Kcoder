//! Safe static Codex field origins; no configuration values or source paths.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexFieldOrigin {
    pub field: Option<String>,
    pub layer: u32,
    pub provider_index: Option<u32>,
    pub supported: bool,
    pub ignored: bool,
    pub private: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexLayerReport {
    pub profile_selected: bool,
    pub present: Vec<bool>,
    pub fields: Vec<CodexFieldOrigin>,
    pub unobserved: Vec<String>,
}
