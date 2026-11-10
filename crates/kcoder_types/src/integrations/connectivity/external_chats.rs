//! Observed chat locators never grant membership, task access or delivery authority.
use super::MessagingPlatform;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityChatKind {
    Private,
    Group,
    Channel,
}

/// Operator identity belongs to each message and is not a conversation boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityExternalChatRange {
    pub version: u8,
    pub platform: MessagingPlatform,
    pub connection_id: String,
    pub tenant_id: String,
    pub chat_kind: ConnectivityChatKind,
    pub chat_id: String,
    pub topic_id: Option<String>,
}
impl ConnectivityExternalChatRange {
    pub fn is_valid(&self) -> bool {
        self.version == 1
            && [&self.connection_id, &self.tenant_id, &self.chat_id]
                .into_iter()
                .all(|value| {
                    !value.is_empty()
                        && value.chars().count() <= 256
                        && !value.chars().any(char::is_control)
                })
            && self.topic_id.as_ref().is_none_or(|value| {
                !value.is_empty()
                    && value.chars().count() <= 256
                    && !value.chars().any(char::is_control)
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityChatObservationState {
    Observed,
    Stale,
}

/// Target-side metadata projection without message bodies or credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityExternalChatObservation {
    pub id: String,
    pub revision: String,
    pub range: ConnectivityExternalChatRange,
    pub bot_id: String,
    pub last_operator_id: String,
    pub first_observed_at: u64,
    pub last_observed_at: u64,
    pub observation_state: ConnectivityChatObservationState,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_scope_requires_connection_and_keeps_operator_separate() {
        let value = serde_json::json!({"version":1,"platform":"feishu","connectionId":"connection",
            "tenantId":"tenant","chatKind":"group","chatId":"chat","topicId":"topic"});
        let range: ConnectivityExternalChatRange = serde_json::from_value(value.clone()).unwrap();
        assert!(range.is_valid());
        let mut other = range.clone();
        other.connection_id = "other-connection".into();
        assert_ne!(range, other);
        other = range.clone();
        other.topic_id = None;
        assert_ne!(range, other);
        let mut with_sender = value;
        with_sender["senderId"] = "member".into();
        assert!(serde_json::from_value::<ConnectivityExternalChatRange>(with_sender).is_err());
        other.connection_id.clear();
        assert!(!other.is_valid());
        other = range;
        other.version = 2;
        assert!(!other.is_valid());
        other.version = 1;
        other.chat_id = "chat\nother".into();
        assert!(!other.is_valid());
    }
}
