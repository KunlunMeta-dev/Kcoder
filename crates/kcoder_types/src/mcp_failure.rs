//! Safe MCP activation categories. No endpoint, server payload, or credential data.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpFailureReason {
    ConnectionFailed,
    ProtocolFailed,
    AuthorizationRequired,
    TimedOut,
    Unavailable,
}

impl McpFailureReason {
    /// Fixed public activation code; never derived from transport error prose.
    pub const fn error_code(self) -> &'static str {
        match self {
            Self::ConnectionFailed => "mcp_connection_failed",
            Self::ProtocolFailed => "mcp_protocol_failed",
            Self::AuthorizationRequired => "mcp_authorization_required",
            Self::TimedOut => "mcp_timeout",
            Self::Unavailable => "mcp_unavailable",
        }
    }
}

/// Delivery evidence for an interrupted MCP tool call. Unknown effects must not be replayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpCallStatus {
    NotSent,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpCallInterruptionReason {
    Cancelled,
    TimedOut,
    ConnectionFailed,
    ProtocolFailed,
    AuthorizationRequired,
    Unavailable,
}

impl From<McpFailureReason> for McpCallInterruptionReason {
    fn from(reason: McpFailureReason) -> Self {
        match reason {
            McpFailureReason::ConnectionFailed => Self::ConnectionFailed,
            McpFailureReason::ProtocolFailed => Self::ProtocolFailed,
            McpFailureReason::AuthorizationRequired => Self::AuthorizationRequired,
            McpFailureReason::TimedOut => Self::TimedOut,
            McpFailureReason::Unavailable => Self::Unavailable,
        }
    }
}

/// A cancellation notification is best effort; it is never proof that effects were undone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct McpCallReceipt {
    pub status: McpCallStatus,
    pub reason: McpCallInterruptionReason,
    pub request_id: Option<u64>,
    pub cancellation_notification_sent: bool,
}
