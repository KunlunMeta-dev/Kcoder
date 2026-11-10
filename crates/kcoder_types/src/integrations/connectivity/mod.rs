//! Connection and messaging data. Provider observations do not grant authority.
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod connection_directory;
pub use connection_directory::*;
mod payloads;
pub use payloads::*;
mod external_chats;
pub use external_chats::*;
mod chat_tasks;
pub use chat_tasks::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MessagingPlatform {
    Feishu,
    Dingtalk,
    Qq,
    Weixin,
    Wecom,
    Github,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Configured,
    AuthorizationRequired,
    Starting,
    Connected,
    Degraded,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityConnection {
    pub id: String,
    pub revision: String,
    pub kind: String,
    pub label: String,
    pub enabled: bool,
    pub has_credential: bool,
    pub state: ConnectionState,
    pub configuration: Value,
    #[serde(default)]
    pub resource_grants: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_authorization_cleanup: Option<ConnectivityLocalAuthorizationCleanupReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_authorization_cleanup_observation: Option<ReadinessObservationState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_observation_state: Option<ReadinessObservationState>,
}

/// This is the original Main operation receipt, separate from any provider request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityLocalAuthorizationCleanupReceipt {
    pub operation_id: String,
    pub connection_ref: crate::integrations::core::IntegrationRevisionRef,
    pub local_removal: ConnectivityLocalAuthorizationCleanupState,
    pub availability: ConnectivityLocalAuthorizationCleanupAvailability,
    pub provider_revocation_requested: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ConnectivityLocalAuthorizationCleanupState {
    Unknown,
    Accepted,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ConnectivityLocalAuthorizationCleanupAvailability {
    Unknown,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum ReadinessLevel {
    L0,
    L1,
    L2,
    L3,
    L4,
    L5,
    L6,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ReadinessObservationState {
    Observed,
    Failed,
    Unknown,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadinessObservation {
    pub level: ReadinessLevel,
    pub state: ReadinessObservationState,
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ChannelDeliveryState {
    Pending,
    Sending,
    Accepted,
    Failed,
    Unknown,
    Cancelled,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityDelivery {
    pub delivery_id: String,
    pub delivery_state: ChannelDeliveryState,
    pub cancelled: bool,
    pub receipt: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connectivity_unknown_is_distinct_from_failed_and_accepted() {
        assert_eq!(
            serde_json::to_value(ChannelDeliveryState::Unknown).unwrap(),
            "unknown"
        );
        assert_ne!(ChannelDeliveryState::Unknown, ChannelDeliveryState::Failed);
        assert_ne!(
            ChannelDeliveryState::Accepted,
            ChannelDeliveryState::Sending
        );
    }
    #[test]
    fn connection_public_dto_rejects_secret_field() {
        let input = serde_json::json!({"id":"id","revision":"1","kind":"qq","label":"QQ","enabled":false,
            "hasCredential":true,"state":"configured","configuration":{},"resourceGrants":[],"secret":"synthetic"});
        assert!(serde_json::from_value::<ConnectivityConnection>(input).is_err());
    }
}
