//! Read-only view of another session's visible turns. The same shapes serve a local
//! host and a routed runtime target; neither the request nor a result grants access.
use crate::session_address::SessionAddressV1;
use serde::{Deserialize, Serialize};

pub const DEFAULT_SESSION_READ_TURNS: u8 = 3;
pub const MAX_SESSION_READ_TURNS: u8 = 10;

/// Model/RPC request. The source session, account and workspace are bound by the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionReadParams {
    /// Required. Copy threadId exactly from a ListSessions result. Never use a title,
    /// a turn ID or your own conversation's ID.
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 128)))]
    pub thread_id: String,
    /// Copy the entire address object from that same ListSessions row when present.
    /// Its threadId must equal threadId. Omit for a conversation listed without an address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_address: Option<SessionAddressV1>,
    /// Optional. Read this visible turn and up to turns-1 turns before it. Copy a turnId
    /// from an earlier ReadSession result. Do not combine with beforeTurnId.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 256)))]
    pub turn_id: Option<String>,
    /// Optional. Read turns strictly older than this turn when paging backwards. Copy
    /// nextBeforeTurnId from the previous ReadSession result. Do not combine with turnId.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 256)))]
    pub before_turn_id: Option<String>,
    /// Optional number of turns, 1–10. Defaults to 3 (the newest turns).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 10)))]
    pub turns: Option<u8>,
    /// Optional, default false. Set true only when you need what the other conversation
    /// did with tools: adds each tool call's name with truncated arguments and its truncated
    /// result. Costs more output; reasoning is never included.
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_outputs: bool,
    /// Optional, default false. Set true to list attachments and images as name/type/size
    /// placeholders. File and image contents are never returned.
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_attachments: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl SessionReadParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !super::valid_agent_message_id(&self.thread_id) {
            return Err("threadId must be a threadId copied from ListSessions");
        }
        if let Some(address) = &self.target_address {
            address.validate()?;
            if address.thread_id != self.thread_id {
                return Err("targetAddress.threadId must equal threadId");
            }
        }
        for value in [&self.turn_id, &self.before_turn_id].into_iter().flatten() {
            if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err(
                    "turnId and beforeTurnId must be nonblank turn IDs of at most 256 bytes",
                );
            }
        }
        if self.turn_id.is_some() && self.before_turn_id.is_some() {
            return Err("use either turnId or beforeTurnId, not both");
        }
        if self
            .turns
            .is_some_and(|turns| !(1..=MAX_SESSION_READ_TURNS).contains(&turns))
        {
            return Err("turns must be an integer from 1 to 10");
        }
        Ok(())
    }
    pub fn turn_count(&self) -> usize {
        usize::from(self.turns.unwrap_or(DEFAULT_SESSION_READ_TURNS))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SessionReadItemKind {
    UserMessage,
    AssistantMessage,
    /// A message another session sent into the target conversation.
    PeerMessage,
    ToolCall,
    ToolResult,
    /// Name/type/size placeholder only; contents are never transferred.
    Attachment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionReadItem {
    pub kind: SessionReadItemKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_error: bool,
    /// Assistant text still being streamed by the target's current turn.
    #[serde(default, skip_serializing_if = "is_false")]
    pub partial: bool,
    /// The beginning of this text was dropped; the newest part is kept.
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated_front: bool,
}

impl SessionReadItem {
    pub fn text(kind: SessionReadItemKind, text: impl Into<String>) -> Self {
        Self {
            kind,
            text: text.into(),
            tool_name: None,
            is_error: false,
            partial: false,
            truncated_front: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SessionReadTurnStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
    /// No durable outcome was recorded; this is not a failure.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionReadTurn {
    pub turn_id: String,
    pub status: SessionReadTurnStatus,
    /// The turn is still in progress and its content may be incomplete.
    #[serde(default, skip_serializing_if = "is_false")]
    pub partial: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<u64>,
    pub items: Vec<SessionReadItem>,
    /// Earlier items of this turn dropped by the per-turn item cap.
    #[serde(default)]
    pub omitted_items: u32,
}

/// One window of the target's visible transcript, oldest turn first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionReadResult {
    pub thread_id: String,
    /// Resolved complete address when the host has a peer identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<SessionAddressV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub archived: bool,
    /// Read from the loaded conversation; the newest turn may include live text.
    #[serde(default)]
    pub resident: bool,
    /// The conversation is in another workspace of the same host and account.
    #[serde(default)]
    pub other_workspace: bool,
    /// The conversation lives on another runtime target and was read by its owner
    /// through the authenticated peer router. Set by the reading host, never trusted
    /// from the target's reply.
    #[serde(default, skip_serializing_if = "is_false")]
    pub other_target: bool,
    pub turns: Vec<SessionReadTurn>,
    /// Visible turns older than this window exist.
    #[serde(default)]
    pub has_earlier_turns: bool,
}

/// Stable refusal codes shared by local and routed reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SessionReadErrorCode {
    SessionReadNotFound,
    SessionReadOtherProject,
    SessionReadNotPermitted,
    SessionReadSelf,
    SessionReadTurnNotFound,
    SessionReadUnsupportedTarget,
    SessionReadUnavailable,
    /// The router could not reach the target owner; nothing is known about the target.
    SessionReadTargetUnreachable,
    /// The routed read did not finish in time; nothing is known about the target.
    SessionReadTimeout,
}

impl SessionReadErrorCode {
    pub fn code(self) -> &'static str {
        match self {
            Self::SessionReadNotFound => "session_read_not_found",
            Self::SessionReadOtherProject => "session_read_other_project",
            Self::SessionReadNotPermitted => "session_read_not_permitted",
            Self::SessionReadSelf => "session_read_self",
            Self::SessionReadTurnNotFound => "session_read_turn_not_found",
            Self::SessionReadUnsupportedTarget => "session_read_unsupported_target",
            Self::SessionReadUnavailable => "session_read_unavailable",
            Self::SessionReadTargetUnreachable => "session_read_target_unreachable",
            Self::SessionReadTimeout => "session_read_timeout",
        }
    }
}

/// A routed read's reply from the target owner: one bounded window, or a typed
/// refusal decided by that owner. Transport failures are never encoded here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged, deny_unknown_fields)]
pub enum SessionReadOutcome {
    // Boxed so the refusal variant stays small; serde treats `Box<T>` like `T`.
    Read { result: Box<SessionReadResult> },
    Refused { refused: SessionReadErrorCode },
}
