//! Public original-operation metadata. Provider tokens and endpoint URLs stay private.
use crate::integrations::core::IntegrationRevisionRef;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpProviderRevocationPhase {
    Prepared,
    Accepted,
    Unknown,
    Unsupported,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpProviderRevocationReason {
    AwaitingConfirmation,
    ProviderAccepted,
    OutcomeUnconfirmed,
    EndpointNotAdvertised,
    AuthenticationUnsupported,
    TokenTypeUnsupported,
    AuthorizationUnavailable,
    SourceChanged,
    CredentialsChanged,
    ProviderRejected,
    IntentExpired,
    PreparationCancelled,
    OriginalReceiptUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpProviderRevocationSourceState {
    Matches,
    Changed,
    Unavailable,
}

/// An accepted provider response concerns the original token only. It does not
/// claim that local credentials were removed or all provider sessions revoked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpProviderRevocationReceipt {
    pub request_id: String,
    pub intent_ref: Option<IntegrationRevisionRef>,
    pub phase: McpProviderRevocationPhase,
    pub reason: McpProviderRevocationReason,
    pub local_credentials_removed: bool,
    pub current_source_matches: bool,
    pub source_state: McpProviderRevocationSourceState,
}
