use serde::{Deserialize, Serialize};

/// Allowlisted terminal facts, independent of the provider's diagnostic text.
///
/// Three different questions are answered here, and a consumer must not collapse
/// them into one "can I retry?" flag:
///
/// - [`Self::retryable`] — repeating the *request* is allowed. It says nothing
///   about whether the failed attempt already produced visible output.
/// - [`Self::resume_safe`] — repeating it cannot duplicate a response that had
///   already started streaming, so the conversation can be resumed as it stands.
/// - [`Self::recovery_action`] — whether a human has to act at all.
///
/// None of them means "this failed turn can be continued from its committed
/// boundary": that is a separate server capability
/// (`kcoder_app_protocol::CAPABILITY_FAILED_TURN_CONTINUATION_V1`, requested with
/// `turn/start.retryFromTurnId`), and a client must gate on the capability rather
/// than infer it from these booleans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderFailureDetails {
    pub category: ProviderFailureCategory,
    pub recovery_action: ProviderFailureRecoveryAction,
    pub http_status: Option<u16>,
    pub retryable: bool,
    pub resume_safe: bool,
    pub retry_after_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFailureCategory {
    AuthenticationError,
    Forbidden,
    ModelOrRoute,
    InvalidParameter,
    ContextLengthExceeded,
    RateLimit,
    QuotaExceeded,
    NetworkError,
    TimeoutError,
    ModelProtocolError,
    ProviderError,
}

impl ProviderFailureCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AuthenticationError => "authentication_error",
            Self::Forbidden => "forbidden",
            Self::ModelOrRoute => "model_or_route",
            Self::InvalidParameter => "invalid_parameter",
            Self::ContextLengthExceeded => "context_length_exceeded",
            Self::RateLimit => "rate_limit",
            Self::QuotaExceeded => "quota_exceeded",
            Self::NetworkError => "network_error",
            Self::TimeoutError => "timeout_error",
            Self::ModelProtocolError => "model_protocol_error",
            Self::ProviderError => "provider_error",
        }
    }
}

/// Terminal instructions never schedule another invocation or approval request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFailureRecoveryAction {
    NeedsHuman,
    DiagnoseOnly,
}
