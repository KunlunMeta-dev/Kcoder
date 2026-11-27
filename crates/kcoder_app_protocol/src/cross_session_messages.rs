//! Draft cross-session RPC contracts. No host advertises support from these types alone.
//! Source identity and every access check belong to the original authenticated host.
use kcoder_types::cross_session_messages::valid_agent_message_id;
pub use kcoder_types::cross_session_messages::{
    AgentMessageIntent as AgentMessageSendParams, AgentMessageMode, AgentMessageReceipt,
    AgentMessageStatus, AgentMessageTargetPresence, SessionDiscoveryQuery,
};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_CROSS_SESSION_DISCOVERY_V1: &str = "crossSessionDiscoveryV1";
pub const CAPABILITY_CROSS_SESSION_MESSAGES_V1: &str = "crossSessionMessagesV1";
pub const CAPABILITY_CROSS_SESSION_MESSAGE_REPLIES_V1: &str = "crossSessionMessageRepliesV1";
pub const CAPABILITY_CROSS_SESSION_MESSAGE_RECEIPTS_V1: &str = "crossSessionMessageReceiptsV1";
pub const CAPABILITY_PEER_AGENT_MESSAGES_V1: &str = "peerAgentMessagesV1";
pub const CAPABILITY_CROSS_SESSION_DISCOVERY_SEARCH_V1: &str = "crossSessionDiscoverySearchV1";
/// Routed ReadSession. A Gateway router announces it in `initialize`; a Native
/// target echoes it (and lists it in `agentMessage/router/capabilities`) only when it
/// serves `agentMessage/router/read`. It is a feature fact, never a read grant.
pub const CAPABILITY_SESSION_READ_V1: &str = "sessionReadV1";
/// Shared local/routed ReadSession shapes. A read result never grants other access.
pub use kcoder_types::cross_session_messages::session_read::{
    SessionReadErrorCode, SessionReadItem, SessionReadItemKind, SessionReadOutcome,
    SessionReadParams, SessionReadResult, SessionReadTurn, SessionReadTurnStatus,
};

/// Router-to-target ReadSession request. The source identity comes from the private
/// route proof; `sourceThreadId` only selects a session inside that proven identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionReadRpcParams {
    pub source_thread_id: String,
    pub read: SessionReadParams,
}
impl SessionReadRpcParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_agent_message_id(&self.source_thread_id) {
            return Err("invalid source session selector");
        }
        self.read.validate()?;
        if self.read.target_address.is_none() {
            return Err("a routed read requires targetAddress");
        }
        Ok(())
    }
}
pub const AGENT_MESSAGE_TARGET_PAGE_SIZE: usize =
    kcoder_types::cross_session_messages::DEFAULT_DISCOVERY_PAGE_SIZE;
pub mod method {
    pub const TARGETS: &str = "thread/agentMessage/targets";
    pub const SEND: &str = "thread/agentMessage/send";
    pub const LIST_RECEIPTS: &str = "thread/agentMessage/receipts/list";
    pub const GET: &str = "thread/agentMessage/get";
    pub const RESOLVE: &str = "thread/agentMessage/resolve";
    pub const POLICY_READ: &str = "thread/agentMessage/policy/read";
    pub const POLICY_SAVE: &str = "thread/agentMessage/policy/save";
}

pub use kcoder_types::cross_session_messages::{
    AgentMessageTargetsParams, CrossSessionMessageReceiptListEntry,
    CrossSessionMessageReceiptListParams, CrossSessionMessageReceiptListResult,
    ReceiptConfirmation,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrossSessionMessageReceiptListRpcParams {
    pub source_thread_id: String,
    #[serde(flatten)]
    pub query: CrossSessionMessageReceiptListParams,
}
impl CrossSessionMessageReceiptListRpcParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_agent_message_id(&self.source_thread_id) {
            return Err("invalid source session selector");
        }
        self.query.validate()
    }
}

/// Safe run facts copied from the canonical thread summary; unknown counts stay null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageTargetRunSummary {
    pub main_turn: crate::ThreadMainTurn,
    pub pending_approvals: Option<u32>,
    pub pending_questions: Option<u32>,
    pub active_jobs: Option<u32>,
    pub tasks_pending: Option<u32>,
    pub tasks_running: Option<u32>,
    pub pending_followups: Option<u32>,
    pub pending_goals: Option<u32>,
}
impl From<&crate::ThreadRunSummary> for AgentMessageTargetRunSummary {
    fn from(value: &crate::ThreadRunSummary) -> Self {
        Self {
            main_turn: value.main_turn,
            pending_approvals: value.pending_approvals,
            pending_questions: value.pending_questions,
            active_jobs: value.active_jobs,
            tasks_pending: value.tasks_pending,
            tasks_running: value.tasks_running,
            pending_followups: value.pending_followups,
            pending_goals: value.pending_goals,
        }
    }
}

/// A committed last-turn fact only; idle or a missing runtime is never a completion receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageLastTurn {
    pub status: crate::TurnStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<u64>,
}

/// Discovery grants neither history access nor a saved permission verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageTarget {
    pub thread_id: String,
    /// Full location supplied by the authenticated target, never an access grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<kcoder_types::session_address::SessionAddressV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub status: crate::ThreadStatus,
    /// Current actual stream registration only; absent is never a saved turn grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    pub presence: AgentMessageTargetPresence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_summary: Option<AgentMessageTargetRunSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<AgentMessageLastTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    /// Persisted history update only; never evidence of current activity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_history_update_at_ms: Option<u64>,
    pub allowed_modes: Vec<AgentMessageMode>,
}
impl AgentMessageTarget {
    /// Match only metadata already observable by the authenticated caller.
    pub fn matches_query(&self, search: &SessionDiscoveryQuery) -> bool {
        search
            .allowed_mode
            .as_ref()
            .is_none_or(|mode| self.allowed_modes.contains(mode))
            && search.matches_metadata(
                self.title.as_deref(),
                &self.thread_id,
                self.address
                    .as_ref()
                    .map(|address| address.target_id.as_str()),
                &self.status,
                &self.presence,
            )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageTargetsResult {
    pub coverage: AgentMessageDiscoveryCoverage,
    pub observed_at_ms: u64,
    #[serde(default)]
    pub completeness: AgentMessageDiscoveryCompleteness,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_count: Option<u32>,
    pub targets: Vec<AgentMessageTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// A bounded resident observation must not claim to enumerate saved history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageDiscoveryCoverage {
    ResidentOnly,
    WorkspaceHistory,
}

/// Absence on older draft responses stays unknown, never complete.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageDiscoveryCompleteness {
    Complete,
    Partial,
    Indexing,
    #[default]
    Unknown,
}

/// An account-owned policy observation; support negotiation is not an allow verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessagePolicyResult {
    pub enabled: bool,
    pub wake_idle: bool,
    pub revision: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessagePolicyReadParams {
    pub source_thread_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessagePolicySaveParams {
    pub source_thread_id: String,
    pub expected_revision: String,
    pub enabled: bool,
    pub wake_idle: bool,
}

/// Gateway resolves a full Native address through a current authorized broker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageResolveParams {
    pub source_thread_id: String,
    pub address: kcoder_types::session_address::SessionAddressV1,
}
impl AgentMessageResolveParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_agent_message_id(&self.source_thread_id) {
            return Err("invalid source session selector");
        }
        self.address.validate()
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageResolveResult {
    pub server_id: String,
    pub workspace_path: String,
    pub thread_id: String,
    pub address: kcoder_types::session_address::SessionAddressV1,
}

/// RPC selectors locate sessions; the authenticated host still verifies authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageTargetsRpcParams {
    pub source_thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(flatten)]
    pub search: SessionDiscoveryQuery,
}
impl AgentMessageTargetsRpcParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_agent_message_id(&self.source_thread_id) {
            return Err("invalid source session selector");
        }
        self.search.validate()?;
        AgentMessageTargetsParams::validate_cursor(self.cursor.as_deref())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageSendRpcParams {
    pub source_thread_id: String,
    pub message: AgentMessageSendParams,
}
impl AgentMessageSendRpcParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_agent_message_id(&self.source_thread_id) {
            return Err("invalid source session selector");
        }
        self.message.validate()?;
        if self.message.target_address.is_none()
            && self.source_thread_id == self.message.target_thread_id
        {
            return Err("self-targeted peer message is not allowed");
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageGetRpcParams {
    pub source_thread_id: String,
    pub query: AgentMessageGetParams,
}
impl AgentMessageGetRpcParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_agent_message_id(&self.source_thread_id) {
            return Err("invalid source session selector");
        }
        self.query.validate()
    }
}
/// Null is a confirmed missing receipt, never a read failure or an unknown result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged, deny_unknown_fields)]
pub enum AgentMessageGetResult {
    // Boxed so the confirmed-missing variant stays small; serde and the JSON
    // schema treat `Box<T>` exactly like `T`.
    Found { receipt: Box<AgentMessageReceipt> },
    Missing { receipt: () },
}
impl AgentMessageGetResult {
    pub fn from_receipt(receipt: Option<AgentMessageReceipt>) -> Self {
        match receipt {
            Some(receipt) => Self::Found {
                receipt: Box::new(receipt),
            },
            None => Self::Missing { receipt: () },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageGetParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
}
impl AgentMessageGetParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        match (&self.message_id, &self.client_message_id) {
            (Some(id), None) | (None, Some(id)) if valid_agent_message_id(id) => Ok(()),
            _ => Err("provide exactly one valid message identity"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn caller_cannot_select_discovery_scope_or_forge_send_source() {
        for value in [
            json!({"accountId":"another"}),
            json!({"workspaceId":"another"}),
            json!({"sourceThreadId":"another"}),
        ] {
            assert!(serde_json::from_value::<AgentMessageTargetsParams>(value).is_err());
        }
        let mut send = json!({"targetThreadId":"b","clientMessageId":"request-1","mode":"enqueue_only","text":"body"});
        assert!(
            serde_json::from_value::<AgentMessageSendParams>(send.clone())
                .unwrap()
                .validate()
                .is_ok()
        );
        send["sourceThreadId"] = json!("forged-source");
        assert!(serde_json::from_value::<AgentMessageSendParams>(send).is_err());
    }

    #[test]
    fn draft_queries_and_send_are_bounded_and_do_not_promote_unknown_modes() {
        assert!(
            AgentMessageTargetsParams {
                cursor: Some("x".repeat(2049)),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            AgentMessageGetParams {
                message_id: None,
                client_message_id: None
            }
            .validate()
            .is_err()
        );
        assert!(
            AgentMessageGetParams {
                message_id: Some("message".into()),
                client_message_id: Some("request".into())
            }
            .validate()
            .is_err()
        );
        assert!(
            serde_json::from_value::<AgentMessageSendParams>(
                json!({"targetThreadId":"b","clientMessageId":"r","mode":"broadcast","text":"body"})
            )
            .is_err()
        );
        let request: AgentMessageSendParams = serde_json::from_value(json!({"targetThreadId":"b","clientMessageId":"r","mode":"wake_if_idle","expectedTurnId":"old-turn","text":"body"})).unwrap();
        assert!(request.validate().is_err());
        let mut request = request;
        request.expected_turn_id = None;
        request.text = "x".repeat(16 * 1024 + 1);
        assert!(request.validate().is_err());
        assert!(!format!("{request:?}").contains(&request.text));
    }
}

#[cfg(test)]
mod discovery_state_tests {
    use super::*;

    #[test]
    fn discovery_retains_unknowns_and_terminal_facts_without_error_content() {
        let unknown = crate::ThreadRunFacts::default().summary();
        let projected = AgentMessageTargetRunSummary::from(&unknown);
        assert_eq!(projected.main_turn, crate::ThreadMainTurn::Unknown);
        assert_eq!(projected.pending_approvals, None);
        assert_eq!(projected.tasks_pending, None);
        let value = serde_json::to_value(projected).unwrap();
        assert!(value["tasksPending"].is_null());
        assert!(value.get("recentError").is_none());
        assert!(value.get("latestTurnStatus").is_none());
        for status in [
            crate::TurnStatus::Completed,
            crate::TurnStatus::Failed,
            crate::TurnStatus::Interrupted,
        ] {
            let fact = AgentMessageLastTurn {
                status: status.clone(),
                turn_id: None,
                ended_at_ms: None,
            };
            assert_eq!(
                serde_json::from_value::<AgentMessageLastTurn>(serde_json::to_value(fact).unwrap())
                    .unwrap()
                    .status,
                status
            );
        }
    }
}

#[cfg(test)]
mod active_turn_identity_tests {
    use super::*;
    #[test]
    fn current_turn_identity_is_optional_for_older_discovery_clients() {
        let old = serde_json::json!({"threadId":"actual-peer", "status":"running", "presence":"resident", "allowedModes":["enqueue_only"]});
        let mut target: AgentMessageTarget = serde_json::from_value(old).unwrap();
        assert_eq!(target.active_turn_id, None);
        assert!(
            serde_json::to_value(&target)
                .unwrap()
                .get("activeTurnId")
                .is_none()
        );
        target.active_turn_id = Some("original-running-turn".into());
        let encoded = serde_json::to_value(target).unwrap();
        assert_eq!(encoded["activeTurnId"], "original-running-turn");
        assert_eq!(
            serde_json::from_value::<AgentMessageTarget>(encoded)
                .unwrap()
                .active_turn_id
                .as_deref(),
            Some("original-running-turn")
        );
    }
}
