//! Target-side namespace locators. Discovery does not grant source or task access.
use super::super::core::IntegrationOwner;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityConnectionSourceState {
    Available,
    Unregistered,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityConnectionSource {
    pub namespace_id: String,
    pub owner: IntegrationOwner,
    pub workspace_path: Option<String>,
    pub state: ConnectivityConnectionSourceState,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityConnectionDirectory {
    pub supported: bool,
    pub complete: bool,
    pub sources: Vec<ConnectivityConnectionSource>,
}
