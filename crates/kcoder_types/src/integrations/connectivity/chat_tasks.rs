//! Shared locators and binding receipts, never task or platform authority.
use super::ConnectivityExternalChatRange;
use crate::integrations::core::IntegrationScope;
use serde::{Deserialize, Serialize};

/// The original connection namespace remains the owner of credentials and Inbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityConnectionLocator {
    pub scope: IntegrationScope,
    pub namespace_id: String,
    pub connection_id: String,
}

/// This refers to an original recoverable task, without copying its history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityTaskLocator {
    pub scope: IntegrationScope,
    pub thread_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityChatTaskBindingState {
    Active,
    Unbound,
}

/// A target-side relationship projection. Execution and delivery reauthorize it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityChatTaskBinding {
    pub id: String,
    pub revision: String,
    pub connection: ConnectivityConnectionLocator,
    pub range: ConnectivityExternalChatRange,
    pub task: Option<ConnectivityTaskLocator>,
    pub state: ConnectivityChatTaskBindingState,
    pub generation: u64,
    pub bound_after_sequence: u64,
    pub source_revision: String,
    pub changed_by: String,
    pub changed_at_ms: u64,
    pub operation_id: String,
}

/// Stable original mutation receipt; archiving a previous task is a separate fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityChatTaskBindingReceipt {
    pub operation_id: String,
    pub binding: ConnectivityChatTaskBinding,
    pub previous_task: Option<ConnectivityTaskLocator>,
}

/// Current original runtime ownership, independent of execution authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityTaskRuntimePhase {
    Unowned,
    Prepared,
    Resident,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityTaskRuntimeOwner {
    pub task: ConnectivityTaskLocator,
    pub phase: ConnectivityTaskRuntimePhase,
    pub source_operation_id: Option<String>,
}
