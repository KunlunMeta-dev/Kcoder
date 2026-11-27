//! In-process prepared execution and durable native identity; none grants authority.
use anyhow::{Result, ensure};
use kcoder_app_protocol::UserInput;
use kcoder_types::{ClientPresentationV1, StudioWorkMode, integrations::core::*};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeExternalSend {
    Ask,
    Deny,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeWorkflowSpec {
    pub definition_id: String,
    pub version: u64,
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_sha256: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeExecutionConfiguration {
    pub model: IntegrationModelResolutionResult,
    pub allowed_tools: Option<Vec<String>>,
    pub external_send: RuntimeExternalSend,
    #[serde(default)]
    pub workflow: Option<RuntimeWorkflowSpec>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedRuntimeTask {
    /// Set by the native authorization/material adapter, never decoded as authority.
    pub input: Vec<UserInput>,
    pub studio_work_mode: StudioWorkMode,
    pub configuration: RuntimeExecutionConfiguration,
    #[serde(default)]
    pub existing_thread_id: Option<String>,
    /// Captured from current native client negotiation, never restored as authority.
    #[serde(default)]
    pub client_presentation: Option<ClientPresentationV1>,
}
impl PreparedRuntimeTask {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.input.is_empty()
                && self.input.len() <= 64
                && serde_json::to_vec(self)?.len() <= 512 * 1024,
            "RUNTIME_INVALID_INPUT"
        );
        ensure!(
            !self.configuration.model.model.model_id.is_empty()
                && !self.configuration.model.model.revision.is_empty()
                && self.configuration.model.budget.reservation_state
                    != IntegrationBudgetReservationState::Denied,
            "RUNTIME_MODEL_UNCONFIRMED"
        );
        if let Some(tools) = &self.configuration.allowed_tools {
            ensure!(
                tools.len() <= 512
                    && tools
                        .iter()
                        .all(|tool| !tool.is_empty() && tool.chars().count() <= 256),
                "RUNTIME_TOOL_RESTRICTION_INVALID"
            );
        }
        if let Some(workflow) = &self.configuration.workflow {
            ensure!(
                !workflow.definition_id.is_empty()
                    && workflow.definition_id.chars().count() <= 256
                    && workflow.version > 0
                    && serde_json::to_vec(&workflow.args)?.len() <= 128 * 1024
                    && workflow.definition_sha256.as_ref().is_none_or(|sha| {
                        sha.len() == 64
                            && sha
                                .bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    }),
                "RUNTIME_WORKFLOW_INVALID"
            );
        }
        if let Some(presentation) = &self.client_presentation {
            ensure!(
                presentation.version == 1
                    && presentation
                        .studio_work_mode
                        .is_none_or(|mode| mode == self.studio_work_mode),
                "RUNTIME_PRESENTATION_MISMATCH"
            );
        }
        if let Some(thread) = &self.existing_thread_id {
            ensure!(
                !thread.is_empty() && thread.chars().count() <= 256,
                "RUNTIME_THREAD_INVALID"
            );
        }
        Ok(())
    }
}

/// Only Root's queue integration holds a ticket. A public JSON-RPC ID is not
/// sufficient to complete a generated native command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRuntimeTicket {
    pub(super) id: String,
    pub(super) operation: String,
    pub(super) phase: RuntimePhase,
}
impl NativeRuntimeTicket {
    pub fn id(&self) -> &str {
        &self.id
    }
    #[cfg(feature = "test-oracle")]
    pub fn test_append_id(&mut self, suffix: &str) {
        self.id.push_str(suffix);
    }

    pub fn phase(&self) -> RuntimePhase {
        self.phase
    }
    pub fn operation_id(&self) -> &str {
        &self.operation
    }
}
#[derive(Debug, Clone)]
pub enum NativeRuntimeCommand {
    Rpc {
        ticket: NativeRuntimeTicket,
        method: &'static str,
        params: Value,
    },
    Configure {
        ticket: NativeRuntimeTicket,
        thread_id: String,
        configuration: Box<RuntimeExecutionConfiguration>,
    },
    StartWorkflow {
        ticket: NativeRuntimeTicket,
        thread_id: String,
        workflow: RuntimeWorkflowSpec,
    },
    StopWorkflow {
        ticket: NativeRuntimeTicket,
        thread_id: String,
        run_id: String,
    },
}
impl NativeRuntimeCommand {
    #[cfg(any(test, feature = "test-oracle"))]
    pub fn ticket(&self) -> &NativeRuntimeTicket {
        match self {
            Self::Rpc { ticket, .. }
            | Self::Configure { ticket, .. }
            | Self::StartWorkflow { ticket, .. }
            | Self::StopWorkflow { ticket, .. } => ticket,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePhase {
    ThreadQueued,
    ThreadDispatched,
    ConfigureQueued,
    ConfigureDispatched,
    TurnQueued,
    TurnDispatched,
    WorkflowQueued,
    WorkflowDispatched,
    RecoverThreadQueued,
    RecoverThreadDispatched,
    RecoverTurnQueued,
    RecoverTurnDispatched,
    CancelQueued,
    CancelDispatched,
    Accepted,
    Rejected,
    Unknown,
    Terminal,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeBinding {
    pub version: u32,
    pub revision: u64,
    pub owner: IntegrationOwner,
    pub operation_id: String,
    pub intent_sha256: String,
    pub source_scope: IntegrationScope,
    pub original_request: IntegrationRequest,
    pub cancel_operation: Option<String>,
    pub cancel_request: Option<IntegrationRequest>,
    pub recovery_from: Option<RuntimePhase>,
    pub spec: PreparedRuntimeTask,
    pub phase: RuntimePhase,
    pub thread_request_id: String,
    pub client_message_id: String,
    pub thread_id: Option<String>,
    pub acceptance: Option<IntegrationRuntimeAcceptance>,
    pub task_state: IntegrationTaskState,
    pub output: Option<String>,
    /// Original producer observation only; it grants no execution or send authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_observation: Option<RuntimeOutputObservation>,
    #[serde(default)]
    pub artifact_refs: Vec<IntegrationEntityRef>,
    #[serde(default)]
    pub pending_interactions: Vec<IntegrationPendingInteraction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub child_intents: Vec<super::child_records::ChildIntentRecord>,
    pub error: Option<IntegrationError>,
}
#[derive(Debug, Clone)]
pub enum RuntimeSubmission {
    Queued,
    Known(IntegrationRuntimeAcceptance),
    Unconfirmed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOutputObservationState {
    Pending,
    Unconfirmed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeOutputObservation {
    pub state: RuntimeOutputObservationState,
    pub started_at_ms: u64,
    pub budget_ms: u64,
    pub reason_code: Option<String>,
}
