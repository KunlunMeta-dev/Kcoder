//! Cross-session message facts. These values never grant access to another session.
use serde::{Deserialize, Serialize};

#[path = "cross_session_messages/receipt_list.rs"]
mod receipt_list;
pub use receipt_list::*;
#[path = "cross_session_messages/session_read.rs"]
pub mod session_read;

pub const MAX_AGENT_MESSAGE_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_AGENT_MESSAGE_ID_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum ThreadStatus {
    Idle,
    Running,
    WaitingForApproval,
    WaitingForAnswer,
    Failed,
    /// The main turn is finished but a background run is still working.
    Background,
    /// Only delivery/aggregation of finished background work is outstanding.
    Aggregating,
    /// Authoritative run facts could not be read; never report this as idle.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageTargetPresence {
    Resident,
    NotResident,
    Unknown,
}

pub const DEFAULT_DISCOVERY_PAGE_SIZE: usize = 10;
pub const MAX_DISCOVERY_PAGE_SIZE: usize = 256;

/// Optional, intersecting selectors over visible metadata, independent of the caller's authority.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDiscoveryQuery {
    /// Optional literal substring of the visible session title. Case-insensitive; Chinese text works directly.
    /// Example: "安装包" matches "Windows 安装包更新". Untitled sessions do not match. No wildcards or regular expressions.
    /// Supply 1–256 UTF-8 bytes of nonblank text. Combine with other fields using AND.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optional literal substring (1–256 UTF-8 bytes) of either the title OR the thread ID.
    /// Use this when you only remember a few characters of an ID or are unsure whether your text is a title.
    /// Case-insensitive. If title is also provided, both fields must match. Message bodies are never searched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Optional exact, case-sensitive runtime target ID, up to 256 UTF-8 bytes. Copy address.targetId from a returned session.
    /// Omit to search all visible targets. A target alias, machine name, workspace path or thread ID is not a targetId.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    /// Optional current activity. Use running, idle, waiting_for_approval, waiting_for_answer, background, aggregating, failed or unknown.
    /// Use running to find an executing turn; idle means no active main turn. For a previous outcome, inspect lastTurn.status on the returned row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ThreadStatus>,
    /// Optional runtime presence: resident (currently loaded), not_resident (saved but not loaded) or unknown.
    /// A resident session can be idle or running. Omit this filter when looking for saved sessions by title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presence: Option<AgentMessageTargetPresence>,
    /// Optional advertised delivery mode. enqueue_only finds sessions that currently accept a queued message;
    /// wake_if_idle finds sessions that currently allow a wake. This filter never sends or wakes a session.
    /// Copy the selected address into SendSessionMessage; authority and current state are checked again at send time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_mode: Option<AgentMessageMode>,
    /// Optional integer from 1 to 256. Maximum matching rows for this call. Omit for 10 on the first call.
    /// A continuation inherits the previous limit unless you supply a new one. A page may be shorter; follow nextCursor when present.
    #[serde(
        default,
        deserialize_with = "deserialize_discovery_limit",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 256)))]
    pub limit: Option<usize>,
}
fn deserialize_discovery_limit<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<usize>, D::Error> {
    let limit = Option::<usize>::deserialize(deserializer)?;
    if limit.is_some_and(|value| !(1..=MAX_DISCOVERY_PAGE_SIZE).contains(&value)) {
        return Err(serde::de::Error::custom(
            "ListSessions limit must be an integer from 1 to 256",
        ));
    }
    Ok(limit)
}

impl SessionDiscoveryQuery {
    pub fn page_size(&self) -> usize {
        self.limit.unwrap_or(DEFAULT_DISCOVERY_PAGE_SIZE)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=MAX_DISCOVERY_PAGE_SIZE).contains(&self.page_size()) {
            return Err("ListSessions limit must be an integer from 1 to 256");
        }
        for value in [&self.title, &self.query, &self.target_id]
            .into_iter()
            .flatten()
        {
            if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err(
                    "ListSessions title, query and targetId must be nonblank text of at most 256 UTF-8 bytes",
                );
            }
        }
        Ok(())
    }

    pub fn for_continuation(&self, requested: &Self) -> Result<Self, &'static str> {
        requested.validate()?;
        if requested
            .allowed_mode
            .as_ref()
            .is_some_and(|v| self.allowed_mode.as_ref() != Some(v))
            || requested
                .title
                .as_ref()
                .is_some_and(|v| self.title.as_ref() != Some(v))
            || requested
                .query
                .as_ref()
                .is_some_and(|v| self.query.as_ref() != Some(v))
            || requested
                .target_id
                .as_ref()
                .is_some_and(|v| self.target_id.as_ref() != Some(v))
            || requested
                .status
                .as_ref()
                .is_some_and(|v| self.status.as_ref() != Some(v))
            || requested
                .presence
                .as_ref()
                .is_some_and(|v| self.presence.as_ref() != Some(v))
        {
            return Err("ListSessions cursor belongs to different filters; start a new search");
        }
        Ok(Self {
            limit: requested.limit.or(self.limit),
            ..self.clone()
        })
    }

    pub fn matches_metadata(
        &self,
        title: Option<&str>,
        id: &str,
        target: Option<&str>,
        status: &ThreadStatus,
        presence: &AgentMessageTargetPresence,
    ) -> bool {
        if self.target_id.as_deref().is_some_and(|v| target != Some(v))
            || self.status.as_ref().is_some_and(|v| v != status)
            || self.presence.as_ref().is_some_and(|v| v != presence)
        {
            return false;
        }
        if self.title.is_none() && self.query.is_none() {
            return true;
        }
        let title = title.unwrap_or_default().to_lowercase();
        self.title
            .as_ref()
            .is_none_or(|v| title.contains(&v.trim().to_lowercase()))
            && self.query.as_ref().is_none_or(|v| {
                let key = v.trim().to_lowercase();
                title.contains(&key) || id.to_lowercase().contains(&key)
            })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageTargetsParams {
    /// Omit on the first call. For the next page, pass the exact nextCursor string returned to this caller as cursor.
    /// Continuations inherit the original filters. You may change limit only. To change filters or recover an expired/consumed cursor,
    /// start a fresh search without cursor. Do not fabricate a token or issue parallel reads of the same cursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(flatten)]
    pub search: SessionDiscoveryQuery,
}
impl AgentMessageTargetsParams {
    pub fn validate_cursor(cursor: Option<&str>) -> Result<(), &'static str> {
        if cursor.is_some_and(|v| v.is_empty() || v.len() > 2048 || v.chars().any(char::is_control))
        {
            return Err("ListSessions cursor must be an opaque nextCursor of at most 2048 bytes");
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        Self::validate_cursor(self.cursor.as_deref())?;
        self.search.validate()
    }
}

#[cfg(test)]
mod discovery_query_tests {
    use super::*;

    #[test]
    fn title_and_id_matches_intersect_with_observed_state() {
        let query: SessionDiscoveryQuery = serde_json::from_value(serde_json::json!({
            "title":"发布","query":"WIN","targetId":"Work-PC","status":"running","presence":"resident"
        })).unwrap();
        let matches = |title, id, target| {
            query.matches_metadata(
                title,
                id,
                target,
                &ThreadStatus::Running,
                &AgentMessageTargetPresence::Resident,
            )
        };
        assert!(matches(Some("Windows 发布"), "ref", Some("Work-PC")));
        assert!(matches(Some("发布任务"), "win-a", Some("Work-PC")));
        assert!(!matches(Some("发布任务"), "id-b", Some("Work-PC")));
        assert!(!matches(Some("Windows 发布"), "ref", Some("work-pc")));
        assert!(!matches(None, "win-a", Some("Work-PC")));
        assert_eq!(query.page_size(), 10);
        let next = query
            .for_continuation(&SessionDiscoveryQuery {
                limit: Some(64),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.page_size(), 64);
        assert!(
            next.for_continuation(&SessionDiscoveryQuery {
                title: Some("新".into()),
                ..Default::default()
            })
            .is_err()
        );
    }
}

pub fn valid_agent_message_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_AGENT_MESSAGE_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrossSessionMessageScope {
    pub account_id: String,
    pub target_id: String,
    pub workspace_id: String,
}
impl CrossSessionMessageScope {
    pub fn validate(&self) -> Result<(), &'static str> {
        if [&self.account_id, &self.target_id, &self.workspace_id]
            .into_iter()
            .all(|value| valid_agent_message_id(value))
        {
            Ok(())
        } else {
            Err("invalid cross-session message scope")
        }
    }
}

/// The host binds this identity from its original authenticated tool invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrossSessionMessageSource {
    pub thread_id: String,
    pub principal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<crate::session_address::SessionAddressV1>,
}
impl CrossSessionMessageSource {
    pub fn validate(&self) -> Result<(), &'static str> {
        if valid_agent_message_id(&self.thread_id)
            && valid_agent_message_id(&self.principal_id)
            && self.address.as_ref().is_none_or(|address| {
                address.validate().is_ok() && address.thread_id == self.thread_id
            })
        {
            Ok(())
        } else {
            Err("invalid cross-session message source")
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageMode {
    EnqueueOnly,
    WakeIfIdle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageStatus {
    Queued,
    Delivering,
    Applied,
    Rejected,
    Expired,
    Unknown,
}

/// The exact immutable request. Debug output deliberately omits its private text.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageIntent {
    pub target_thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_address: Option<crate::session_address::SessionAddressV1>,
    pub client_message_id: String,
    pub mode: AgentMessageMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 256)))]
    pub expected_turn_id: Option<String>,
    pub text: String,
    /// Reference to a message actually received by this source from this recipient.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 128)))]
    pub reply_to_message_id: Option<String>,
}
impl std::fmt::Debug for AgentMessageIntent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentMessageIntent")
            .field("target_thread_id", &self.target_thread_id)
            .field("target_address", &self.target_address)
            .field("client_message_id", &self.client_message_id)
            .field("mode", &self.mode)
            .field("expected_turn_id", &self.expected_turn_id)
            .field("reply_to_message_id", &self.reply_to_message_id)
            .field("text_bytes", &self.text.len())
            .finish()
    }
}
impl AgentMessageIntent {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_agent_message_id(&self.target_thread_id)
            || self.target_address.as_ref().is_some_and(|address| {
                address.validate().is_err() || address.thread_id != self.target_thread_id
            })
            || !valid_agent_message_id(&self.client_message_id)
            || self
                .reply_to_message_id
                .as_deref()
                .is_some_and(|id| !valid_agent_message_id(id))
            || self
                .expected_turn_id
                .as_deref()
                .is_some_and(|value| !crate::valid_turn_attempt_component(value))
            || self.text.trim().is_empty()
            || self.text.len() > MAX_AGENT_MESSAGE_TEXT_BYTES
        {
            return Err("invalid cross-session message intent");
        }
        if self.expected_turn_id.is_some() && self.mode == AgentMessageMode::WakeIfIdle {
            return Err("a turn-bound message cannot wake an idle session");
        }
        Ok(())
    }
}

/// Applied means present in native history, never model comprehension or task success.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageReceipt {
    pub message_id: String,
    pub client_message_id: String,
    pub target_thread_id: String,
    pub status: AgentMessageStatus,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_address: Option<crate::session_address::SessionAddressV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_address: Option<crate::session_address::SessionAddressV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
}

/// Full selectors determine sameness; they still do not authorize either endpoint.
pub fn same_peer_session(
    source: &CrossSessionMessageSource,
    intent: &AgentMessageIntent,
) -> Result<bool, &'static str> {
    match (&source.address, &intent.target_address) {
        (Some(source), Some(target)) => Ok(source == target),
        (None, None) => Ok(source.thread_id == intent.target_thread_id),
        _ => Err("incomplete peer session address pair"),
    }
}

#[cfg(test)]
mod expected_turn_domain_tests {
    use super::*;
    #[test]
    fn expected_turn_uses_the_exact_actual_attempt_domain_without_normalizing_identity() {
        let mut intent = AgentMessageIntent {
            reply_to_message_id: None,
            target_thread_id: "actual-target".into(),
            target_address: None,
            client_message_id: "original-client".into(),
            mode: AgentMessageMode::EnqueueOnly,
            expected_turn_id: Some("运行/turn:1".into()),
            text: "reference".into(),
        };
        assert!(intent.validate().is_ok());
        assert_eq!(
            serde_json::from_value::<AgentMessageIntent>(serde_json::to_value(&intent).unwrap())
                .unwrap(),
            intent
        );
        intent.expected_turn_id = Some("界".repeat(85) + "x");
        assert!(intent.validate().is_ok());
        for invalid in ["x".repeat(257), "界".repeat(86), " \t\n\u{85}".into()] {
            intent.expected_turn_id = Some(invalid);
            assert!(intent.validate().is_err());
        }
        intent.expected_turn_id = Some("运行/turn:1".into());
        intent.mode = AgentMessageMode::WakeIfIdle;
        assert!(
            intent.validate().is_err(),
            "turn selection never grants a wake"
        );
    }
}
