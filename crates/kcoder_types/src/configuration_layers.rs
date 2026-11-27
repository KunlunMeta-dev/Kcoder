//! Safe provenance of selected static settings files, without source values or paths.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationLayerScope {
    User,
    Project,
    Local,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationLayerState {
    pub scope: ConfigurationLayerScope,
    pub present: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationFieldOrigin {
    /// Unknown names may contain credentials; only predefined schema paths are public.
    pub field: Option<String>,
    pub ordinal: u32,
    pub scopes: Vec<ConfigurationLayerScope>,
    pub private: bool,
    pub supported: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationLayerReport {
    pub adapter_revision: String,
    pub layers: Vec<ConfigurationLayerState>,
    pub fields: Vec<ConfigurationFieldOrigin>,
    /// Explicitly unobserved authorities; this is not a running application's effective state.
    pub unobserved: Vec<String>,
}
