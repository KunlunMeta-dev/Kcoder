use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
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

/// Latest runtime connection observation, including failure after initialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpConnectionAttemptStatus {
    Ready,
    Unavailable,
    TimedOut,
}

/// Safe connection observation details; legacy peers may omit the failure category.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionAttempt {
    pub status: McpConnectionAttemptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<kcoder_types::mcp_failure::McpFailureReason>,
}
impl From<McpConnectionAttemptStatus> for McpConnectionAttempt {
    fn from(status: McpConnectionAttemptStatus) -> Self {
        Self {
            status,
            failure_reason: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub name: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    pub authorization: McpAuthorizationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connection_attempt: Option<McpConnectionAttemptStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connection_failure: Option<kcoder_types::mcp_failure::McpFailureReason>,
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
    fn failure_details_are_optional_and_payload_free() {
        let legacy: McpConnectionAttempt =
            serde_json::from_value(serde_json::json!({"status":"unavailable"})).unwrap();
        assert_eq!(legacy.failure_reason, None);
        let typed = McpConnectionAttempt {
            status: McpConnectionAttemptStatus::Unavailable,
            failure_reason: Some(kcoder_types::mcp_failure::McpFailureReason::ProtocolFailed),
        };
        assert_eq!(
            serde_json::to_value(typed).unwrap(),
            serde_json::json!({"status":"unavailable","failureReason":"protocolFailed"})
        );
    }

    #[test]
    fn historical_status_is_optional_for_older_peers() {
        let legacy = serde_json::json!({"name":"fixture","transport":"stdio","authorization":"notApplicable"});
        let mut summary: McpServerSummary = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(summary.last_connection_attempt, None);
        assert_eq!(summary.last_connection_failure, None);
        assert_eq!(serde_json::to_value(&summary).unwrap(), legacy);
        summary.last_connection_attempt = Some(McpConnectionAttemptStatus::Unavailable);
        assert_eq!(
            serde_json::to_value(summary).unwrap()["lastConnectionAttempt"],
            "unavailable"
        );
    }
}
