//! Read-only search observations and explicitly requested, owner-bound diagnostics.
use kcoder_types::{
    StudioWorkMode,
    web_search::{WebSearchErrorKind, WebSearchProvider, WebSearchResponseV1, WebSearchStatus},
};
use serde::{Deserialize, Serialize};
pub const CAPABILITY_WEB_SEARCH_STATUS_V1: &str = "webSearchStatusV1";
pub const CAPABILITY_WEB_SEARCH_PROBE_V1: &str = "webSearchProbeV1";
pub const WEB_SEARCH_STATUS_READ: &str = "webSearch/status/read";
pub const WEB_SEARCH_PROBE_START: &str = "webSearch/probe/start";
pub const WEB_SEARCH_PROBE_READ: &str = "webSearch/probe/read";
pub const WEB_SEARCH_PROBE_CANCEL: &str = "webSearch/probe/cancel";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchStatusReadParams {
    pub mode: StudioWorkMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WebSearchComponentState {
    Unknown,
    Available,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchSourceObservation {
    pub provider: WebSearchProvider,
    pub component: WebSearchComponentState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<WebSearchStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<WebSearchErrorKind>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchStatusReadResult {
    pub target_id: String,
    pub revision: String,
    pub mode: StudioWorkMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub web_search_visible: bool,
    pub web_fetch_visible: bool,
    pub automatic: bool,
    pub candidates: Vec<WebSearchProvider>,
    pub observations: Vec<WebSearchSourceObservation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchProbeStartParams {
    pub request_id: String,
    pub expected_revision: String,
    pub mode: StudioWorkMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchProbeReadParams {
    pub request_id: String,
    pub expected_revision: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WebSearchProbeState {
    Running,
    Completed,
    Cancelled,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchProbeResult {
    pub target_id: String,
    pub request_id: String,
    pub revision: String,
    pub state: WebSearchProbeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<WebSearchResponseV1>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn diagnostic_start_never_accepts_query_endpoint_or_owner_authority() {
        let start = json!({"mode":"kcoder", "requestId":"probe-1", "expectedRevision":"r1"});
        assert!(serde_json::from_value::<WebSearchProbeStartParams>(start.clone()).is_ok());
        for key in ["query", "endpoint", "owner", "targetId", "apiKey"] {
            let mut bad = start.clone();
            bad[key] = json!("untrusted");
            assert!(serde_json::from_value::<WebSearchProbeStartParams>(bad).is_err());
        }
        assert!(
            serde_json::from_value::<WebSearchStatusReadParams>(json!({"mode":"kcoder"})).is_ok()
        );
    }
    #[test]
    fn unknown_probe_is_distinct_from_cancelled_empty_or_success() {
        for state in ["unknown", "running", "completed", "cancelled"] {
            let value =
                json!({"targetId":"target", "requestId":"probe", "revision":"r1", "state":state});
            let result = serde_json::from_value::<WebSearchProbeResult>(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(result).unwrap(), value);
        }
        assert!(serde_json::from_value::<WebSearchProbeResult>(json!({"targetId":"target", "requestId":"probe", "revision":"r1", "state":"success"})).is_err());
    }
}
