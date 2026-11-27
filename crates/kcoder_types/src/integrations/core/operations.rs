//! Durable integration outcomes. These records are evidence, never authorization.
use super::{IntegrationError, IntegrationNullable, IntegrationScope};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationOperationPhase {
    Pending,
    Executing,
    Accepted,
    Completed,
    Rejected,
    Unknown,
    CancelRequested,
    Cancelled,
}

impl IntegrationOperationPhase {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Rejected | Self::Cancelled)
    }

    pub const fn may_transition_to(self, next: Self) -> bool {
        use IntegrationOperationPhase::*;
        matches!(
            (self, next),
            (
                Pending,
                Executing | Rejected | CancelRequested | Cancelled | Unknown
            ) | (
                Executing,
                Accepted | Completed | Rejected | Unknown | CancelRequested | Cancelled
            ) | (
                Accepted,
                Completed | Rejected | Unknown | CancelRequested | Cancelled
            ) | (
                Unknown,
                Accepted | Completed | Rejected | CancelRequested | Cancelled
            ) | (CancelRequested, Completed | Unknown | Cancelled)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationEntityRef {
    pub kind: IntegrationEntityKind,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationEntityKind {
    ModelPolicyConfiguration,
    Input,
    Workspace,
    Workflow,
    Assistant,
    Delegation,
    Destination,
    Thread,
    Turn,
    Task,
    Artifact,
    Dataset,
    Subscription,
    Publication,
    Connection,
    Delivery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationOperationReceipt {
    pub operation_id: String,
    pub scope: IntegrationScope,
    pub port: String,
    pub method: String,
    pub revision: u64,
    pub phase: IntegrationOperationPhase,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub entity_ref: Option<IntegrationEntityRef>,
    pub error: Option<IntegrationError>,
    /// Immutable observation at native acceptance, not the task's current state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_acceptance: Option<IntegrationRuntimeAcceptance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationOperationReadResult {
    pub receipt: IntegrationNullable<IntegrationOperationReceipt>,
    /// Negative admission evidence only; the original outcome remains unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsubmitted_input: Option<IntegrationRuntimeUnsubmittedInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationRuntimeUnsubmittedInput {
    pub operation_id: String,
    pub operation_revision: u64,
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationRuntimeReadTaskParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

impl IntegrationRuntimeReadTaskParams {
    pub fn validate(&self) -> Result<(), super::IntegrationValidationError> {
        for (value, field) in [
            (&self.thread_id, "threadId"),
            (&self.turn_id, "turnId"),
            (&self.task_id, "taskId"),
        ] {
            if let Some(value) = value {
                super::id(value, field)?;
            }
        }
        if self.task_id.is_none() && (self.thread_id.is_none() || self.turn_id.is_none()) {
            return Err(super::invalid(
                "taskReference",
                "an exact native task or thread/turn reference is required",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationPolicyDecision {
    Allow,
    Deny,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationPolicyEvaluation {
    pub decision: IntegrationPolicyDecision,
    pub policy_revision: String,
    pub reason_code: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationTaskState {
    Queued,
    Running,
    WaitingForUser,
    Completed,
    Failed,
    Cancelled,
    OutcomeUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationRuntimeAcceptance {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub state: IntegrationTaskState,
}

impl IntegrationRuntimeAcceptance {
    pub fn validate(&self) -> Result<(), super::IntegrationValidationError> {
        super::id(&self.thread_id, "threadId")?;
        IntegrationRuntimeReadTaskParams {
            thread_id: Some(self.thread_id.clone()),
            turn_id: self.turn_id.clone(),
            task_id: self.task_id.clone(),
        }
        .validate()?;
        if !matches!(
            self.state,
            IntegrationTaskState::Queued | IntegrationTaskState::Running
        ) {
            return Err(super::invalid(
                "state",
                "native acceptance must carry its initial queued/running observation",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationRuntimeTask {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub state: IntegrationTaskState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default)]
    pub artifact_refs: Vec<IntegrationEntityRef>,
    #[serde(default)]
    pub pending_interactions: Vec<IntegrationPendingInteraction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationPendingInteraction {
    pub interaction_id: String,
    pub revision: String,
    pub kind: IntegrationInteractionKind,
    pub prompt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationInteractionKind {
    Question,
    Approval,
}

/// Stable owner identity excludes refreshable authorization/configuration generations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationOwner {
    pub account_id: String,
    pub target_id: String,
    pub workspace_id: IntegrationNullable<String>,
    pub organization_id: Option<IntegrationNullable<String>>,
}

impl From<&IntegrationScope> for IntegrationOwner {
    fn from(scope: &IntegrationScope) -> Self {
        Self {
            account_id: scope.account_id.clone(),
            target_id: scope.target_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            organization_id: scope
                .organization_id
                .as_ref()
                .and_then(|value| match value {
                    IntegrationNullable::Value(id) => Some(IntegrationNullable::Value(id.clone())),
                    IntegrationNullable::Null => None,
                }),
        }
    }
}
