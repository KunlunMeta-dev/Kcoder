//! Typed classification at the transport boundary; never inspect error text.
use kcoder_types::mcp_failure::McpFailureReason;
use kcoder_types::mcp_failure::{McpCallInterruptionReason, McpCallReceipt, McpCallStatus};

#[derive(Debug)]
pub struct McpCallFailure(pub McpCallReceipt);

impl std::fmt::Display for McpCallFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.0.status {
            McpCallStatus::NotSent => "MCP tool call was not sent",
            McpCallStatus::OutcomeUnknown => {
                "MCP tool call outcome is unknown; do not automatically repeat the action"
            }
        })
    }
}
impl std::error::Error for McpCallFailure {}

pub fn call_receipt(error: &anyhow::Error) -> Option<&McpCallReceipt> {
    error
        .downcast_ref::<McpCallFailure>()
        .map(|failure| &failure.0)
}

pub(crate) fn interrupted(
    request_id: Option<u64>,
    reason: McpCallInterruptionReason,
    cancellation_notification_sent: bool,
) -> anyhow::Error {
    McpCallFailure(McpCallReceipt {
        status: if request_id.is_some() {
            McpCallStatus::OutcomeUnknown
        } else {
            McpCallStatus::NotSent
        },
        reason,
        request_id,
        cancellation_notification_sent,
    })
    .into()
}

#[derive(Debug)]
pub struct McpFailure {
    pub reason: McpFailureReason,
    pub(crate) message: &'static str,
}
impl std::fmt::Display for McpFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for McpFailure {}

pub fn failure_reason(error: &anyhow::Error) -> McpFailureReason {
    if let Some(receipt) = call_receipt(error) {
        return match receipt.reason {
            McpCallInterruptionReason::Cancelled | McpCallInterruptionReason::Unavailable => {
                McpFailureReason::Unavailable
            }
            McpCallInterruptionReason::TimedOut => McpFailureReason::TimedOut,
            McpCallInterruptionReason::ConnectionFailed => McpFailureReason::ConnectionFailed,
            McpCallInterruptionReason::ProtocolFailed => McpFailureReason::ProtocolFailed,
            McpCallInterruptionReason::AuthorizationRequired => {
                McpFailureReason::AuthorizationRequired
            }
        };
    }
    if let Some(failure) = error.downcast_ref::<McpFailure>() {
        return failure.reason;
    }
    if error.is::<crate::AuthenticationRequired>()
        || error.is::<crate::authorization_tokens::RefreshRecoveryRequired>()
    {
        return McpFailureReason::AuthorizationRequired;
    }
    if let Some(error) = error.downcast_ref::<crate::authorization_tokens::TokenEndpointError>() {
        return if matches!(error.status(), 400 | 401 | 403)
            && matches!(
                error.code(),
                Some("invalid_grant" | "invalid_client" | "unauthorized_client" | "access_denied")
            ) {
            McpFailureReason::AuthorizationRequired
        } else {
            McpFailureReason::Unavailable
        };
    }
    if let Some(error) = error.downcast_ref::<reqwest::Error>() {
        return if error.is_timeout() {
            McpFailureReason::TimedOut
        } else if error.status() == Some(reqwest::StatusCode::UNAUTHORIZED) {
            McpFailureReason::AuthorizationRequired
        } else if error.is_decode() {
            McpFailureReason::ProtocolFailed
        } else {
            McpFailureReason::ConnectionFailed
        };
    }
    if let Some(error) = error.downcast_ref::<std::io::Error>() {
        return if error.kind() == std::io::ErrorKind::TimedOut {
            McpFailureReason::TimedOut
        } else {
            McpFailureReason::ConnectionFailed
        };
    }
    if error.is::<serde_json::Error>() {
        return McpFailureReason::ProtocolFailed;
    }
    McpFailureReason::Unavailable
}

pub(crate) fn protocol(message: &'static str) -> anyhow::Error {
    McpFailure {
        reason: McpFailureReason::ProtocolFailed,
        message,
    }
    .into()
}
pub(crate) fn timeout(message: &'static str) -> anyhow::Error {
    McpFailure {
        reason: McpFailureReason::TimedOut,
        message,
    }
    .into()
}
pub(crate) fn authorization(message: &'static str) -> anyhow::Error {
    McpFailure {
        reason: McpFailureReason::AuthorizationRequired,
        message,
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arbitrary_text_is_never_authorization_or_protocol_evidence() {
        let error = anyhow::anyhow!("401 OAuth expired unsupported protocol timed out");
        assert_eq!(failure_reason(&error), McpFailureReason::Unavailable);
        let io = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert_eq!(failure_reason(&io), McpFailureReason::ConnectionFailed);
        assert_eq!(
            failure_reason(&protocol("safe")),
            McpFailureReason::ProtocolFailed
        );
        assert_eq!(failure_reason(&timeout("safe")), McpFailureReason::TimedOut);
    }
}
