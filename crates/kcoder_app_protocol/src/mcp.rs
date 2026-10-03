use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpAuthorizationStatus {
    NotApplicable,
    ConfiguredHeader,
    NotAuthorized,
    Authorized,
    Expired,
    ReauthorizationRequired,
    Unavailable,
}

/// Outcome of the most recent runtime connection attempt, not a live health probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpConnectionAttemptStatus {
    Ready,
    Unavailable,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub name: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    pub authorization: McpAuthorizationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connection_attempt: Option<McpConnectionAttemptStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListResult {
    pub servers: Vec<McpServerSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerParams {
    pub name: String,
    #[serde(default)]
    pub plugin_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLogoutResult {
    pub logged_out: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpLoginParams {
    pub server: McpServerParams,
    pub redirect_uri: String,
    #[serde(default)]
    pub authorization_server_index: usize,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub client_authentication: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLoginResult {
    pub flow_id: String,
    pub authorization_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpCallbackParams {
    pub flow_id: String,
    pub callback_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpCancelParams {
    pub flow_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpInstallParams {
    pub config: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigurationResult {
    pub name: String,
    pub applies_to_new_conversations: bool,
}

#[cfg(test)]
mod connection_status_tests {
    use super::*;

    #[test]
    fn historical_status_is_optional_for_older_peers() {
        let legacy = serde_json::json!({"name":"fixture","transport":"stdio","authorization":"notApplicable"});
        let mut summary: McpServerSummary = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(summary.last_connection_attempt, None);
        assert_eq!(serde_json::to_value(&summary).unwrap(), legacy);
        summary.last_connection_attempt = Some(McpConnectionAttemptStatus::Unavailable);
        assert_eq!(
            serde_json::to_value(summary).unwrap()["lastConnectionAttempt"],
            "unavailable"
        );
    }
}
