//! Passive observations. Missing observations do not establish connectivity.
use super::web_search::{WebSearchErrorKind, WebSearchProvider, WebSearchStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct WebSearchProviderObservationV1 {
    pub provider: WebSearchProvider,
    pub status: Option<WebSearchStatus>,
    pub observed_at: Option<String>,
    pub error: Option<WebSearchErrorKind>,
}
