use serde::{Deserialize, Serialize};

/// Allowlisted terminal facts, independent of the provider's diagnostic text.
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
