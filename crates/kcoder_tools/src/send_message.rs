use crate::agent::{
    AgentKind, DEFAULT_AGENT_MAX_TURNS, MAX_AGENT_MAX_TURNS, MIN_AGENT_MAX_TURNS,
    apply_configured_default_max_turns, clamp_agent_max_turns, run_continued_subagent_loop,
};
use crate::{AgentRunOptions, Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use kcoder_state::TaskStatus;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Default)]
pub struct SendMessageTool;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SendMessageInput {
    /// Agent id returned by `spawn_agent` or `explore_agent`.
    pub agent_id: String,
    /// New user message to deliver to that sub-agent.
    pub message: String,
    /// Maximum internal turns for this continuation; when omitted use the value from settings.json.
    /// `default_subagent_max_turns`。
    #[serde(default = "default_max_turns")]
    pub max_turns: usize,
    /// Used only by ControlAgent to wake an existing reliable queue after explicit retry; excluded from the model tool schema.
    #[serde(default)]
    #[schemars(skip)]
    internal_existing_message_id: Option<String>,
}

fn default_max_turns() -> usize {
    DEFAULT_AGENT_MAX_TURNS
}

#[derive(Debug, Serialize, Deserialize)]
struct SendMessageResult {
    agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    status: String,
    queued: bool,
    queue_position: Option<usize>,
    output_file: Option<String>,
    next_action: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentSteerStatus {
    QueuedLive,
    QueuedPaused,
    QueuedBehindBlocked,
    Resuming,
    Finishing,
    Cancelled,
    Closed,
    Rejected,
}

impl SubagentSteerStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::QueuedLive => "queued_live",
            Self::QueuedPaused => "queued_paused",
            Self::QueuedBehindBlocked => "queued_behind_blocked",
            Self::Resuming => "resuming",
            Self::Finishing => "finishing",
            Self::Cancelled => "cancelled",
            Self::Closed => "closed",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentSteerReceipt {
    pub agent_id: String,
    pub message_id: Option<String>,
    pub status: SubagentSteerStatus,
    pub queued: bool,
    pub queue_position: Option<usize>,
    pub output_file: Option<String>,
    pub next_action: String,
    pub reason_code: Option<String>,
    pub is_error: bool,
}

impl SendMessageTool {
    /// Provide non-model entry points with the same typed domain receipt as `SendMessage`.
    pub async fn steer_typed(
        &self,
        input: Value,
        ctx: &ToolContext,
    ) -> Result<SubagentSteerReceipt, ToolError> {
        let output = <Self as Tool>::call(self, input, ctx).await?;
        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        let value = serde_json::from_str::<Value>(&text).map_err(|error| {
            ToolError::Execution(format!(
                "failed to decode SendMessage typed receipt: {error}"
            ))
        })?;
        let raw_status =
            value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or(if output.is_error {
                    "rejected"
                } else {
                    "unknown"
                });
        let status = match raw_status {
            "queued_live" => SubagentSteerStatus::QueuedLive,
            "queued_paused" => SubagentSteerStatus::QueuedPaused,
            "queued_behind_blocked" => SubagentSteerStatus::QueuedBehindBlocked,
            "resuming" | "running" => SubagentSteerStatus::Resuming,
            "finishing" => SubagentSteerStatus::Finishing,
            "cancelled" => SubagentSteerStatus::Cancelled,
            "closed" | "halted" | "paused_queue_closed" => SubagentSteerStatus::Closed,
            _ => SubagentSteerStatus::Rejected,
        };
        Ok(SubagentSteerReceipt {
            agent_id: value
                .get("agent_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            message_id: value
                .get("message_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            status,
            queued: value
                .get("queued")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            queue_position: value
                .get("queue_position")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok()),
            output_file: value
                .get("output_file")
                .and_then(Value::as_str)
                .map(str::to_string),
            next_action: value
                .get("next_action")
                .and_then(Value::as_str)
                .unwrap_or("The message was not queued.")
                .to_string(),
            reason_code: (status == SubagentSteerStatus::Rejected).then(|| raw_status.to_string()),
            is_error: output.is_error,
        })
    }
}

#[async_trait]
impl Tool for SendMessageTool {
    fn name(&self) -> String {
        "SendMessage".to_string()
    }

    fn description(&self) -> String {
        "Send a follow-up message to an existing sub-agent. \
         If the sub-agent is currently running, the message is queued durably and applied at \
         that agent's next protocol-safe model/tool boundary, after the current Provider response \
         and complete tool batch. If its queue has already closed during the \
         final completion commit, this tool returns status=finishing without claiming the message \
         was queued; wait for completion and send it again. If the sub-agent has completed or failed \
         but has not been closed, this tool re-opens the same agent_id in the background using \
         its saved transcript and preserves the tracked role and write scope. It does not copy \
         the parent conversation again or re-evaluate the original context_mode: the supplied \
         message is appended exactly once to the child's own transcript. Agent ids are bound to \
         the parent session that created them, so a different session cannot continue them. \
         Legacy tasks that do not contain the parent-session owner, canonical role, or complete \
         capability profile recorded at spawn time are rejected instead of guessing ownership, \
         inferring a role from the description, or inheriting the parent's current mode. \
         Inconsistent Arrangement role/write-scope metadata is also rejected; spawn a fresh \
         sub-agent. \
         The saved transcript is also bound to the provider and model that created it. If the \
         parent switched provider or model, switch back before continuing or spawn a fresh \
         sub-agent; KCoder will not replay old reasoning signatures into a different protocol. \
         Cancelled, closed, \
         or missing sub-agents cannot be resumed; spawn a fresh sub-agent instead. Inspect the \
         sub-agent output_file or wait result before accepting, retrying, or closing a result \
         that matters. Do not use this for background command tasks."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(SendMessageInput));
        if let Value::Object(ref mut map) = schema {
            map.insert("additionalProperties".to_string(), Value::Bool(false));
            if let Some(Value::Object(properties)) = map.get_mut("properties") {
                properties.insert(
                    "agent_id".to_string(),
                    serde_json::json!({
                        "type": "string",
                        "description": "Exact agent_id returned by spawn_agent, explore_agent, or PlanAgent in this same parent session. The id must still exist and must not be cancelled or closed. A persisted id without its original parent-session owner, canonical role, Arrangement/write-scope capability profile, or provider/model identity cannot be resumed; KCoder never infers these from the mutable task description. If the live parent provider or model changed since this child's transcript was written, switch back or create a new agent; old reasoning signatures are never replayed into a different runtime."
                    }),
                );
                properties.insert(
                    "message".to_string(),
                    serde_json::json!({
                        "type": "string",
                        "description": "Non-empty follow-up instruction appended once to the selected child's saved transcript. Parent context is not copied again. If the child is running, this is queued FIFO; if completed or failed, it starts a background continuation."
                    }),
                );
                properties.insert(
                    "max_turns".to_string(),
                    serde_json::json!({
                        "type": "integer",
                        "minimum": MIN_AGENT_MAX_TURNS,
                        "maximum": MAX_AGENT_MAX_TURNS,
                        "description": "Maximum internal turns for this continuation only; it does not alter the original spawn limit recorded for the child. When omitted, uses default_subagent_max_turns from settings.json (60 if unset). Explicit values must be in 60..=180; out-of-range values fail schema validation before any message is queued or the child is resumed. Default semantic coercion may convert an integer-valued string such as \"60\"; strict/disabled coercion requires a JSON integer."
                    }),
                );
            }
        }
        schema
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let mut input = input;
        apply_configured_default_max_turns(&mut input, ctx);
        let input: SendMessageInput = parse_input(&input)?;
        let id = input.agent_id;
        let message = input.message.trim().to_string();
        let internal_existing_message_id = input.internal_existing_message_id;
        if message.is_empty() && internal_existing_message_id.is_none() {
            return Err(ToolError::InvalidInput(
                "message must not be empty".to_string(),
            ));
        }
        let max_turns = clamp_agent_max_turns(input.max_turns);
        let task = ctx
            .state
            .task(&id)
            .ok_or_else(|| ToolError::InvalidInput(format!("agent {id} not found")))?;
        // Resuming an existing agent must use its persisted spawn-time policy and cannot be silently redefined by hot-reloaded configuration.
        let delivery_lease_timeout_seconds = task.delivery_lease_timeout_seconds.clamp(30, 3600);
        let delivery_max_attempts = task.delivery_max_attempts.clamp(1, 64);
        if internal_existing_message_id.is_some()
            && !matches!(task.status, TaskStatus::Completed | TaskStatus::Failed)
        {
            return Err(ToolError::InvalidInput(
                "internal reliable-queue wake requires a completed or failed sub-agent".to_string(),
            ));
        }

        if crate::background::is_tool_background_task_description(&task.description) {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "not_a_subagent",
                    "queued": false,
                    "next_action": "Use TaskOutput/TaskStop for background command tasks; SendMessage only works with sub-agents."
                })
                .to_string(),
            ));
        }

        let Some(parent_session_id) = task.parent_session_id.as_deref() else {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "legacy_owner_missing",
                    "queued": false,
                    "next_action": "This persisted sub-agent has no parent-session owner. KCoder will not guess ownership or continue it from the current session. Spawn a fresh sub-agent instead."
                })
                .to_string(),
            ));
        };
        if parent_session_id != ctx.state.session_id() {
            return Err(ToolError::InvalidInput(format!(
                "agent {id} belongs to parent session {parent_session_id}, not the current session"
            )));
        }

        let output_file = task
            .output_path
            .as_ref()
            .map(|path| path.display().to_string());
        if matches!(task.status, TaskStatus::Cancelled) {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "cancelled",
                    "queued": false,
                    "output_file": output_file,
                    "next_action": "This sub-agent was cancelled and cannot be resumed. Spawn a new sub-agent if more work is needed."
                })
                .to_string(),
            ));
        }
        let Some(arrangement_mode) = task.arrangement_mode else {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "legacy_capability_profile_missing",
                    "queued": false,
                    "output_file": output_file,
                    "next_action": "This persisted sub-agent predates capability-profile tracking. KCoder will not infer permissions from the parent's current mode. Spawn a fresh sub-agent with the same task instead."
                })
                .to_string(),
            ));
        };
        let Some(saved_agent_kind) = task.agent_kind.as_deref() else {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "legacy_role_profile_missing",
                    "queued": false,
                    "output_file": output_file,
                    "next_action": "This persisted sub-agent has no canonical role identity. KCoder will not infer capabilities from its mutable description. Spawn a fresh sub-agent instead."
                })
                .to_string(),
            ));
        };
        let Some(agent_kind) = AgentKind::from_alias(saved_agent_kind)
            .filter(|kind| kind.as_str() == saved_agent_kind)
        else {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "invalid_capability_profile",
                    "queued": false,
                    "output_file": output_file,
                    "next_action": "This persisted sub-agent has a non-canonical or unknown role identity. KCoder will not reconstruct permissions from aliases or descriptions. Spawn a fresh sub-agent instead."
                })
                .to_string(),
            ));
        };
        if arrangement_mode
            && matches!(agent_kind, AgentKind::Implementer)
            && task.allowed_write_paths.is_empty()
        {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "invalid_capability_profile",
                    "queued": false,
                    "output_file": output_file,
                    "next_action": "This Arrangement implementer has no persisted allowed_write_paths, so its edit boundary cannot be reconstructed safely. Spawn a fresh scoped implementer instead."
                })
                .to_string(),
            ));
        }
        if arrangement_mode
            && !matches!(agent_kind, AgentKind::Implementer | AgentKind::Verifier)
            && !task.allowed_write_paths.is_empty()
        {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "invalid_capability_profile",
                    "queued": false,
                    "output_file": output_file,
                    "next_action": "This Arrangement role has an impossible persisted write scope. KCoder will not upgrade a read-only role from inconsistent metadata. Spawn a fresh sub-agent instead."
                })
                .to_string(),
            ));
        }
        if !matches!(agent_kind, AgentKind::Implementer | AgentKind::Verifier)
            && !task.allowed_shell_prefixes.is_empty()
        {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "invalid_capability_profile",
                    "queued": false,
                    "output_file": output_file,
                    "next_action": "This persisted read-only role has impossible allowed_shell_prefixes. KCoder will not upgrade it from inconsistent metadata. Spawn a fresh sub-agent instead."
                })
                .to_string(),
            ));
        }
        let resolved_persona = if let Some(roster_name) = task.roster_name.as_deref() {
            let (resolved_kind, persona) =
                crate::agent::resolve_agent_request(ctx, Some(roster_name))?;
            let persona = persona.ok_or_else(|| {
                ToolError::Execution("persisted roster name resolved as a base role".to_string())
            })?;
            if resolved_kind != agent_kind
                || task.orchestrate_work_id.as_deref() != Some(persona.work_id.as_str())
                || task.resolved_profile_fingerprint.is_none()
            {
                return Ok(ToolOutput::error(
                    serde_json::json!({
                        "agent_id": id,
                        "status": "incompatible_orchestrate_profile",
                        "queued": false,
                        "next_action": "The persona base role, active work, or persisted fingerprint changed. Spawn a fresh sub-agent; the old transcript was not replayed."
                    })
                    .to_string(),
                ));
            }
            if roster_name == "critic" {
                return Ok(ToolOutput::error(
                    serde_json::json!({
                        "agent_id": id,
                        "status": "binding_review_vote_session",
                        "queued": false,
                        "next_action": "A critic session owns exactly one binding ReviewVote. Spawn a fresh critic for a new plan revision or review cycle."
                    })
                    .to_string(),
                ));
            }
            Some(persona)
        } else {
            None
        };
        if resolved_persona.is_none()
            && let (Some(live_provider), Some(live_model)) = (
                ctx.runtime_provider.as_deref(),
                ctx.runtime_model.as_deref(),
            )
        {
            let (Some(saved_provider), Some(saved_model)) =
                (task.agent_provider.as_deref(), task.agent_model.as_deref())
            else {
                return Ok(ToolOutput::error(
                    serde_json::json!({
                        "agent_id": id,
                        "status": "legacy_runtime_profile_missing",
                        "queued": false,
                        "output_file": output_file,
                        "next_action": "This persisted sub-agent has no provider/model transcript identity. KCoder will not guess compatibility. Spawn a fresh sub-agent instead."
                    })
                    .to_string(),
                ));
            };
            if saved_provider != live_provider || saved_model != live_model {
                return Ok(ToolOutput::error(
                    serde_json::json!({
                        "agent_id": id,
                        "status": "incompatible_runtime_profile",
                        "queued": false,
                        "output_file": output_file,
                        "saved_provider": saved_provider,
                        "saved_model": saved_model,
                        "live_provider": live_provider,
                        "live_model": live_model,
                        "next_action": "Switch the parent back to the saved provider/model before calling SendMessage, or spawn a fresh sub-agent. The old transcript was not replayed."
                    })
                    .to_string(),
                ));
            }
        }

        match task.status {
            TaskStatus::Pending | TaskStatus::Running => {
                let Some(receipt) = ctx
                    .state
                    .enqueue_subagent_delivery(&id, message)
                    .map_err(|error| ToolError::Execution(error.to_string()))?
                else {
                    if ctx
                        .state
                        .task(&id)
                        .is_some_and(|current| !current.accepting_subagent_messages)
                    {
                        return Ok(ToolOutput::text(format_result(&SendMessageResult {
                            agent_id: id,
                            message_id: None,
                            status: "finishing".to_string(),
                            queued: false,
                            queue_position: None,
                            output_file,
                            next_action: "The sub-agent has closed its message queue and is committing completion. This message was not queued. Wait for the completion notification, then call SendMessage again if the follow-up is still needed.".to_string(),
                        }, &task)?));
                    }
                    return Err(ToolError::Execution(format!("agent {id} disappeared")));
                };
                let blocked_head = ctx.state.task(&id).and_then(|task| {
                    task.message_queue.first().and_then(|message| {
                        (message.status == kcoder_state::AgentMessageStatus::Blocked)
                            .then(|| message.message_id.clone())
                    })
                });
                return Ok(ToolOutput::text(format_result(&SendMessageResult {
                    agent_id: id,
                    message_id: Some(receipt.message_id),
                    status: if blocked_head.is_some() {
                        "queued_behind_blocked"
                    } else {
                        "queued_live"
                    }
                    .to_string(),
                    queued: true,
                    queue_position: Some(receipt.queue_position),
                    output_file,
                    next_action: blocked_head.map_or_else(
                        || "The message is durable and will be applied at this agent's next protocol-safe model/tool boundary. Do other useful work and wait for automatic notifications instead of polling.".to_string(),
                        |message_id| format!("The new delivery is durable but cannot pass blocked FIFO head {message_id}. Resolve that message explicitly with ControlAgent retry_message or discard_message."),
                    ),
                }, &task)?));
            }
            TaskStatus::Cancelled => unreachable!("cancelled tasks return before profile checks"),
            TaskStatus::Paused if task.control.run_mode == kcoder_state::AgentRunMode::Running => {}
            TaskStatus::Paused => {
                let Some(receipt) = ctx
                    .state
                    .enqueue_subagent_delivery(&id, message)
                    .map_err(|error| ToolError::Execution(error.to_string()))?
                else {
                    return Ok(ToolOutput::error(
                        serde_json::json!({
                            "agent_id": id,
                            "status": "paused_queue_closed",
                            "queued": false,
                            "output_file": output_file,
                            "next_action": "The paused agent no longer accepts deliveries; inspect AgentFleet and use ControlAgent or spawn a fresh agent."
                        })
                        .to_string(),
                    ));
                };
                let blocked_head = ctx.state.task(&id).and_then(|task| {
                    task.message_queue.first().and_then(|message| {
                        (message.status == kcoder_state::AgentMessageStatus::Blocked)
                            .then(|| message.message_id.clone())
                    })
                });
                return Ok(ToolOutput::text(format_result(&SendMessageResult {
                    agent_id: id,
                    message_id: Some(receipt.message_id),
                    status: "queued_paused".to_string(),
                    queued: true,
                    queue_position: Some(receipt.queue_position),
                    output_file,
                    next_action: blocked_head.map_or_else(
                        || "The delivery is durable. Use ControlAgent action=resume with the current control revision when the agent may continue.".to_string(),
                        |message_id| format!("The delivery is durable behind blocked message {message_id}. Resolve it with ControlAgent retry_message or discard_message before resuming."),
                    ),
                }, &task)?));
            }
            TaskStatus::Halted => {
                return Ok(ToolOutput::error(
                    serde_json::json!({
                        "agent_id": id,
                        "status": "halted",
                        "queued": false,
                        "output_file": output_file,
                        "next_action": "This agent was gracefully halted and cannot be resumed. Spawn a fresh sub-agent if more work is required."
                    })
                    .to_string(),
                ));
            }
            TaskStatus::Completed | TaskStatus::Failed => {}
        }

        if let Some(path) = task.transcript_path.as_ref()
            && !path.exists()
        {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "missing_transcript",
                    "queued": false,
                    "output_file": output_file,
                    "transcript_file": path,
                    "next_action": "This sub-agent does not have a saved transcript, so it cannot be resumed. Spawn a new sub-agent instead."
                })
                .to_string(),
            ));
        }
        if let Err(detail) = validate_persisted_agent_worktree(&ctx.state.cwd(), &id, &task) {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "invalid_worktree_binding",
                    "queued": false,
                    "output_file": output_file,
                    "detail": detail,
                    "next_action": "The persisted isolation worktree is missing or no longer matches this agent. Restore that exact managed worktree or spawn a fresh sub-agent; KCoder will not fall back to the parent workspace."
                })
                .to_string(),
            ));
        }

        let runner = ctx
            .agent_runner
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| ToolError::Execution("agent runner not available".into()))?;
        let cancellation = CancellationToken::new();
        let mut options =
            AgentRunOptions::with_allowed_write_paths(task.allowed_write_paths.clone())
                .with_allowed_shell_prefixes(task.allowed_shell_prefixes.clone())
                .with_artifact_requirements(task.artifact_requirements.clone())
                .with_block_shell_file_mutation(
                    crate::agent::agent_kind_blocks_shell_file_mutation(
                        agent_kind,
                        arrangement_mode,
                    ),
                )
                .with_arrangement_mode(arrangement_mode)
                .with_abort_token(cancellation.clone())
                .with_delivery_policy(delivery_lease_timeout_seconds, delivery_max_attempts);
        if let Some(persona) = resolved_persona {
            options = options
                .with_context_inheritance(persona.context_mode, task.context_turns.unwrap_or(2))
                .with_persona(crate::AgentPersonaOptions {
                    name: persona.name,
                    runtime: persona.runtime,
                    tool_allowlist: persona.tool_allowlist,
                    review_vote_channel: None,
                    work_id: persona.work_id,
                    critic_max_cycles: persona.critic_max_cycles,
                    critic_max_infrastructure_retries: persona.critic_max_infrastructure_retries,
                });
        }
        if !ctx
            .state
            .reopen_subagent_delivery_queue(&id)
            .map_err(|error| ToolError::Execution(error.to_string()))?
        {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "agent_id": id,
                    "status": "closed",
                    "queued": false,
                    "next_action": "This sub-agent cannot reopen its reliable delivery queue. Spawn a fresh sub-agent."
                })
                .to_string(),
            ));
        }
        let (message_id, queue_position) =
            if let Some(expected_message_id) = internal_existing_message_id {
                let task = ctx.state.task(&id).ok_or_else(|| {
                    ToolError::Execution(format!(
                        "agent {id} disappeared before its retried queue could be resumed"
                    ))
                })?;
                let Some((index, delivery)) = task
                    .message_queue
                    .iter()
                    .enumerate()
                    .find(|(_, delivery)| delivery.message_id == expected_message_id)
                else {
                    return Err(ToolError::Execution(format!(
                        "retried delivery {expected_message_id} disappeared before worker resume"
                    )));
                };
                if delivery.status != kcoder_state::AgentMessageStatus::Queued {
                    return Err(ToolError::Execution(format!(
                        "retried delivery {expected_message_id} is {:?}, not queued",
                        delivery.status
                    )));
                }
                (delivery.message_id.clone(), index.saturating_add(1))
            } else {
                let receipt = ctx
                .state
                .enqueue_subagent_delivery(&id, message)
                .map_err(|error| ToolError::Execution(error.to_string()))?
                .ok_or_else(|| {
                    ToolError::Execution(format!(
                        "agent {id} closed its delivery queue before the continuation was persisted"
                    ))
                })?;
                (receipt.message_id, receipt.queue_position)
            };
        if let Some(blocked_message_id) = ctx.state.task(&id).and_then(|task| {
            task.message_queue.first().and_then(|message| {
                (message.status == kcoder_state::AgentMessageStatus::Blocked)
                    .then(|| message.message_id.clone())
            })
        }) {
            return Ok(ToolOutput::text(format_result(
                &SendMessageResult {
                    agent_id: id,
                    message_id: Some(message_id),
                    status: "queued_behind_blocked".to_string(),
                    queued: true,
                    queue_position: Some(queue_position),
                    output_file,
                    next_action: format!(
                        "The delivery is durable behind blocked FIFO head {blocked_message_id}; no worker was started. Resolve the head with ControlAgent retry_message or discard_message."
                    ),
                },
                &task,
            )?));
        }
        let run_state = ctx.state.clone();
        let run_id = id.clone();
        let description = format!("{} agent: continuation", agent_kind.display_name());

        let cancel: Arc<dyn Fn() + Send + Sync> = Arc::new(move || cancellation.cancel());
        ctx.respawn_cancellable_subagent_background(
            id.clone(),
            description,
            async move {
                run_continued_subagent_loop(
                    run_state, runner, run_id, max_turns, agent_kind, options,
                )
                .await
            },
            cancel,
        )?;
        if let (Some(manager), Some(tool_call_id)) = (
            ctx.background_job_manager.as_ref(),
            ctx.tool_call_id.as_deref(),
        ) {
            manager
                .associate_subagent_tool_call(&id, tool_call_id, true)
                .map_err(|error| {
                    ToolError::Execution(format!(
                        "failed to associate resumed sub-agent `{id}` with tool call `{tool_call_id}`: {error}"
                    ))
                })?;
        }

        Ok(ToolOutput::text(format_result(&SendMessageResult {
            agent_id: id.clone(),
            message_id: Some(message_id),
            status: "resuming".to_string(),
            queued: true,
            queue_position: Some(queue_position),
            output_file,
            next_action: "The sub-agent has been resumed in the background. Use wait only if this result is on the critical path; otherwise rely on the automatic subagent notification.".to_string(),
        }, &task)?))
    }
}

fn format_result(
    result: &SendMessageResult,
    task: &kcoder_state::Task,
) -> Result<String, ToolError> {
    let mut value = serde_json::to_value(result)
        .map_err(|e| ToolError::Execution(format!("failed to serialize result: {e}")))?;
    // This acknowledges a new delivery, not completion of its artifact observation.
    // Even a still-Completed task may retain a report belonging to the previous run.
    if !task.artifact_requirements.is_empty() {
        value["artifact_validation_status"] = serde_json::json!("unavailable");
    }
    Ok(value.to_string())
}

fn validate_persisted_agent_worktree(
    cwd: &Path,
    agent_id: &str,
    task: &kcoder_state::Task,
) -> Result<(), String> {
    if agent_id.is_empty()
        || agent_id.len() > 128
        || matches!(agent_id, "." | "..")
        || !agent_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err("agent id is not a safe managed worktree component".to_string());
    }
    let binding = match (&task.worktree_path, &task.worktree_branch) {
        (None, None) => return Ok(()),
        (Some(_), None) | (None, Some(_)) => {
            return Err("persisted worktree path/branch binding is incomplete".to_string());
        }
        (Some(path), Some(branch)) => (path, branch),
    };
    let expected_branch = format!("worktree-{agent_id}");
    if binding.1 != &expected_branch {
        return Err(format!(
            "persisted branch {:?} does not match expected {:?}",
            binding.1, expected_branch
        ));
    }
    let repo_root = cwd
        .ancestors()
        .find(|ancestor| std::fs::symlink_metadata(ancestor.join(".git")).is_ok())
        .ok_or_else(|| {
            "current session is no longer inside the owning git repository".to_string()
        })?;
    let metadata = std::fs::symlink_metadata(binding.0)
        .map_err(|error| format!("persisted worktree is unavailable: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("persisted worktree path must be a real directory, not a symlink".to_string());
    }
    let repo_root = std::fs::canonicalize(repo_root)
        .map_err(|error| format!("owning repository cannot be canonicalized: {error}"))?;
    let managed_root = std::fs::canonicalize(repo_root.join(".kcoder/worktrees"))
        .map_err(|error| format!("managed worktree root is unavailable: {error}"))?;
    if !managed_root.starts_with(&repo_root) {
        return Err("managed worktree root escapes the owning repository".to_string());
    }
    let expected = managed_root.join(agent_id);
    let actual = std::fs::canonicalize(binding.0)
        .map_err(|error| format!("persisted worktree cannot be canonicalized: {error}"))?;
    if !actual.starts_with(&managed_root) || actual != expected {
        return Err(format!(
            "persisted worktree {:?} does not match managed path {:?}",
            actual, expected
        ));
    }
    let git_marker = actual.join(".git");
    let git_metadata = std::fs::symlink_metadata(&git_marker)
        .map_err(|error| format!("persisted worktree git marker is unavailable: {error}"))?;
    if git_metadata.file_type().is_symlink() || !git_metadata.is_file() {
        return Err("persisted worktree .git marker must be a real file".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentError, AgentRunner, BackgroundJobSpawner};
    use kcoder_state::{AppState, Task, TaskKind};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};

    struct FakeAgentRunner;

    #[async_trait]
    impl AgentRunner for FakeAgentRunner {
        async fn run_agent(
            &self,
            _prompt: String,
            _max_turns: usize,
        ) -> Result<String, AgentError> {
            Ok("ok".to_string())
        }
    }

    #[derive(Default)]
    struct FakeBackgroundJobManager {
        respawned: Mutex<Vec<String>>,
    }

    impl BackgroundJobSpawner for FakeBackgroundJobManager {
        fn spawn(
            &self,
            _description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, crate::SpawnError> {
            Ok("job-unused".to_string())
        }

        fn respawn_subagent(
            &self,
            id: String,
            _description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, crate::SpawnError> {
            self.respawned.lock().unwrap().push(id.clone());
            Ok(id)
        }

        fn subscribe(
            &self,
        ) -> tokio::sync::broadcast::Receiver<crate::background::BackgroundJobEvent> {
            let (_tx, rx) = tokio::sync::broadcast::channel(1);
            rx
        }

        fn abort(&self, _id: &str) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn send_message_artifact_ack_early_branches_are_unavailable() {
        for (status, accepting, blocked, expected) in [
            (TaskStatus::Running, false, false, "finishing"),
            (TaskStatus::Running, true, false, "queued_live"),
            (TaskStatus::Pending, true, false, "queued_live"),
            (TaskStatus::Running, true, true, "queued_behind_blocked"),
            (TaskStatus::Paused, true, false, "queued_paused"),
            (TaskStatus::Completed, true, true, "queued_behind_blocked"),
        ] {
            for declared in [false, true] {
                assert_artifact_ack(status, accepting, blocked, expected, declared).await;
            }
        }
    }

    #[tokio::test]
    async fn send_message_artifact_ack_resume_never_reuses_previous_pass() {
        for declared in [false, true] {
            assert_artifact_ack(TaskStatus::Completed, true, false, "resuming", declared).await;
        }
    }

    async fn assert_artifact_ack(
        status: TaskStatus,
        accepting: bool,
        blocked: bool,
        expected: &str,
        declared: bool,
    ) {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let mut task = Task::new("artifact-ack", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = status;
        task.parent_session_id = Some(state.session_id());
        task.arrangement_mode = Some(false);
        task.agent_kind = Some("general".into());
        task.accepting_subagent_messages = accepting;
        if status == TaskStatus::Paused {
            task.control.run_mode = kcoder_state::AgentRunMode::Paused;
        }
        if declared {
            task.artifact_requirements =
                serde_json::from_value(serde_json::json!([{"path":"artifact"}])).unwrap();
            let run = kcoder_state::ArtifactValidationRun {
                run_id: "previous-run".into(),
                declarations_sha256: kcoder_state::artifact_declarations_sha256(
                    &task.artifact_requirements,
                ),
                delivery_key: None,
            };
            task.artifact_validation_run = Some(run.clone());
            task.artifact_validation_report = Some(kcoder_state::ArtifactValidationReport {
                run,
                observed_at_ms: 1,
                entries: vec![kcoder_state::ArtifactValidationEntry {
                    index: 0,
                    path: "artifact".into(),
                    status: kcoder_state::ArtifactValidationStatus::Passed,
                    size_bytes: Some(1),
                    sha256: Some("previous-hash".into()),
                }],
            });
        }
        state.upsert_task(task.clone());
        if blocked {
            state
                .enqueue_subagent_delivery(&task.id, "blocked head")
                .unwrap()
                .unwrap();
            state.update_task(&task.id, |task| {
                task.message_queue[0].status = kcoder_state::AgentMessageStatus::Blocked
            });
        }
        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(state.clone())
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(manager);
        let output = SendMessageTool
            .call(
                serde_json::json!({"agent_id":task.id,"message":"new followup"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!output.is_error, "{output:?}");
        let value: serde_json::Value = serde_json::from_str(&output_text(&output)).unwrap();
        assert_eq!(value["status"], expected);
        if declared {
            assert_eq!(
                value["artifact_validation_status"], "unavailable",
                "{expected}: {value}"
            );
        } else {
            assert!(value.get("artifact_validation_status").is_none());
        }
        assert!(
            value.get("artifact_validation_report").is_none(),
            "{expected}: {value}"
        );
        assert!(output.execution_metadata.is_empty());
        assert!(output.user_context.is_empty());
        assert_eq!(
            state.task(&task.id).unwrap().artifact_validation_report,
            task.artifact_validation_report
        );
    }

    #[tokio::test]
    async fn send_message_queues_for_running_agent() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-1", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.parent_session_id = Some(state.session_id().to_string());
        task.arrangement_mode = Some(false);
        task.agent_kind = Some("general".to_string());
        state.upsert_task(task);

        let output = SendMessageTool
            .call(
                serde_json::json!({
                    "agent_id": "job-1",
                    "message": "check the parser too"
                }),
                &ToolContext::new(state.clone()),
            )
            .await
            .unwrap();

        let text = output_text(&output);
        let result: SendMessageResult = serde_json::from_str(&text).unwrap();
        assert_eq!(result.status, "queued_live");
        assert!(result.queued);
        assert_eq!(result.queue_position, Some(1));
        assert!(result.message_id.is_some());
        let task = state.task("job-1").unwrap();
        assert!(task.pending_messages.is_empty());
        assert_eq!(task.message_queue.len(), 1);
        assert_eq!(task.message_queue[0].body, "check the parser too");
        assert_eq!(
            result.message_id.as_deref(),
            Some(task.message_queue[0].message_id.as_str())
        );
    }

    #[tokio::test]
    async fn typed_steer_receipt_hides_tool_json_from_callers() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-typed", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.parent_session_id = Some(state.session_id());
        task.arrangement_mode = Some(false);
        task.agent_kind = Some("general".to_string());
        state.upsert_task(task);

        let receipt = SendMessageTool
            .steer_typed(
                serde_json::json!({
                    "agent_id": "job-typed",
                    "message": "change course"
                }),
                &ToolContext::new(state),
            )
            .await
            .unwrap();

        assert_eq!(receipt.status, SubagentSteerStatus::QueuedLive);
        assert_eq!(receipt.agent_id, "job-typed");
        assert!(receipt.queued);
        assert!(receipt.message_id.is_some());
        assert_eq!(receipt.queue_position, Some(1));
        assert!(!receipt.is_error);
    }

    #[test]
    fn internal_retry_selector_is_not_exposed_in_tool_schema() {
        let schema = SendMessageTool.input_schema();
        assert!(
            schema["properties"]
                .get("internal_existing_message_id")
                .is_none()
        );
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn send_message_rejects_agent_owned_by_another_parent_session() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-foreign", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.parent_session_id = Some("different-parent-session".to_string());
        state.upsert_task(task);

        let error = SendMessageTool
            .call(
                serde_json::json!({
                    "agent_id": "job-foreign",
                    "message": "continue"
                }),
                &ToolContext::new(state),
            )
            .await
            .expect_err("foreign agent continuation must be rejected");

        assert!(error.to_string().contains("belongs to parent session"));
    }

    #[tokio::test]
    async fn send_message_rejects_legacy_task_without_parent_session_owner() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-ownerless", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.arrangement_mode = Some(false);
        task.agent_provider = Some("provider-a".to_string());
        task.agent_model = Some("model-a".to_string());
        task.agent_kind = Some("general".to_string());
        state.upsert_task(task);

        let output = SendMessageTool
            .call(
                serde_json::json!({
                    "agent_id": "job-ownerless",
                    "message": "continue"
                }),
                &ToolContext::new(state.clone())
                    .with_agent_runtime_identity("provider-a", "model-a"),
            )
            .await
            .unwrap();

        let value: serde_json::Value = serde_json::from_str(&output_text(&output)).unwrap();
        assert_eq!(value["status"], "legacy_owner_missing");
        assert_eq!(value["queued"], false);
        assert!(
            state
                .task("job-ownerless")
                .unwrap()
                .pending_messages
                .is_empty()
        );
    }

    #[tokio::test]
    async fn send_message_reports_finishing_without_losing_or_claiming_message() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-finishing", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.accepting_subagent_messages = false;
        task.parent_session_id = Some(state.session_id().to_string());
        task.arrangement_mode = Some(false);
        task.agent_kind = Some("general".to_string());
        state.upsert_task(task);

        let output = SendMessageTool
            .call(
                serde_json::json!({
                    "agent_id": "job-finishing",
                    "message": "follow up after completion"
                }),
                &ToolContext::new(state.clone()),
            )
            .await
            .unwrap();
        let result: SendMessageResult = serde_json::from_str(&output_text(&output)).unwrap();

        assert_eq!(result.status, "finishing");
        assert!(!result.queued);
        assert!(result.message_id.is_none());
        assert_eq!(result.queue_position, None);
        let task = state.task("job-finishing").unwrap();
        assert!(task.pending_messages.is_empty());
        assert!(task.message_queue.is_empty());
        assert!(result.next_action.contains("was not queued"));
    }

    #[tokio::test]
    async fn send_message_queues_durably_for_paused_agent_without_resuming_it() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-paused", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Paused;
        task.control.run_mode = kcoder_state::AgentRunMode::Paused;
        task.parent_session_id = Some(state.session_id());
        task.arrangement_mode = Some(false);
        task.agent_kind = Some("general".to_string());
        state.upsert_task(task);

        let output = SendMessageTool
            .call(
                serde_json::json!({
                    "agent_id": "job-paused",
                    "message": "inspect this after resume"
                }),
                &ToolContext::new(state.clone()),
            )
            .await
            .unwrap();
        let result: SendMessageResult = serde_json::from_str(&output_text(&output)).unwrap();
        assert_eq!(result.status, "queued_paused");
        assert!(result.queued);
        let task = state.task("job-paused").unwrap();
        assert_eq!(task.status, TaskStatus::Paused);
        assert_eq!(task.message_queue.len(), 1);
        assert_eq!(task.message_queue[0].body, "inspect this after resume");
    }

    #[test]
    fn send_message_description_mentions_resume_scope() {
        let description = SendMessageTool.description();

        assert!(description.contains("preserves the tracked role and write scope"));
        assert!(description.contains("Cancelled, closed, or missing sub-agents cannot be resumed"));
        assert!(description.contains("Inspect the"));
        assert!(description.contains("output_file"));
    }

    #[tokio::test]
    async fn send_message_respawns_completed_agent_with_same_id() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        let transcript = tmp.path().join("transcript.json");
        std::fs::write(&transcript, "[]").unwrap();
        let mut task = Task::new("job-1", "Review agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Completed;
        task.transcript_path = Some(transcript);
        task.arrangement_mode = Some(false);
        task.parent_session_id = Some(state.session_id().to_string());
        task.agent_kind = Some("review".to_string());
        state.upsert_task(task);

        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(state.clone())
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(manager.clone());

        let output = SendMessageTool
            .call(
                serde_json::json!({
                    "agent_id": "job-1",
                    "message": "now verify the fix"
                }),
                &ctx,
            )
            .await
            .unwrap();

        let text = output_text(&output);
        let result: SendMessageResult = serde_json::from_str(&text).unwrap();
        assert!(result.queued);
        assert!(result.message_id.is_some());
        assert_eq!(result.queue_position, Some(1));
        assert_eq!(result.status, "resuming");
        assert_eq!(manager.respawned.lock().unwrap().as_slice(), ["job-1"]);
        let task = state.task("job-1").unwrap();
        assert_eq!(task.message_queue.len(), 1);
        assert_eq!(task.message_queue[0].body, "now verify the fix");
    }

    #[tokio::test]
    async fn send_message_fails_closed_when_managed_worktree_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        let state = AppState::new(tmp.path());
        let transcript = tmp.path().join("transcript.json");
        std::fs::write(&transcript, "[]").unwrap();
        let mut task = Task::new("job-worktree", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Completed;
        task.transcript_path = Some(transcript);
        task.arrangement_mode = Some(false);
        task.parent_session_id = Some(state.session_id());
        task.agent_kind = Some("general".to_string());
        task.worktree_path = Some(tmp.path().join(".kcoder/worktrees/job-worktree"));
        task.worktree_branch = Some("worktree-job-worktree".to_string());
        state.upsert_task(task);

        let output = SendMessageTool
            .call(
                serde_json::json!({
                    "agent_id": "job-worktree",
                    "message": "continue"
                }),
                &ToolContext::new(state.clone()),
            )
            .await
            .unwrap();

        assert!(output.is_error);
        let value: serde_json::Value = serde_json::from_str(&output_text(&output)).unwrap();
        assert_eq!(value["status"], "invalid_worktree_binding");
        assert!(
            value["next_action"]
                .as_str()
                .unwrap()
                .contains("will not fall back")
        );
        assert!(state.task("job-worktree").unwrap().message_queue.is_empty());
    }

    #[tokio::test]
    async fn send_message_rejects_legacy_task_without_capability_profile() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        let transcript = tmp.path().join("transcript.json");
        std::fs::write(&transcript, "[]").unwrap();
        let mut task = Task::new("legacy-agent", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Completed;
        task.transcript_path = Some(transcript);
        task.arrangement_mode = None;
        task.parent_session_id = Some(state.session_id().to_string());
        state.upsert_task(task);

        let output = SendMessageTool
            .call(
                serde_json::json!({
                    "agent_id": "legacy-agent",
                    "message": "continue"
                }),
                &ToolContext::new(state)
                    .with_agent_runner(Arc::new(FakeAgentRunner))
                    .with_arrangement_mode(false),
            )
            .await
            .unwrap();

        let value: serde_json::Value = serde_json::from_str(&output_text(&output)).unwrap();
        assert_eq!(value["status"], "legacy_capability_profile_missing");
        assert_eq!(value["queued"], false);
    }

    #[tokio::test]
    async fn send_message_rejects_missing_or_inconsistent_role_profile() {
        for (id, agent_kind, allowed_write_paths) in [
            ("missing-role", None, Vec::new()),
            ("unscoped-implementer", Some("implementer"), Vec::new()),
            ("scoped-read-only", Some("review"), vec!["src".to_string()]),
        ] {
            let state = AppState::new("/tmp");
            let mut task = Task::new(id, "mutable description must not define role");
            task.kind = TaskKind::Subagent;
            task.status = TaskStatus::Running;
            task.parent_session_id = Some(state.session_id().to_string());
            task.arrangement_mode = Some(true);
            task.agent_kind = agent_kind.map(str::to_string);
            task.allowed_write_paths = allowed_write_paths;
            state.upsert_task(task);

            let output = SendMessageTool
                .call(
                    serde_json::json!({"agent_id": id, "message": "continue"}),
                    &ToolContext::new(state.clone()),
                )
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(&output_text(&output)).unwrap();
            assert_eq!(value["queued"], false, "{id}");
            if agent_kind.is_none() {
                assert_eq!(value["status"], "legacy_role_profile_missing", "{id}");
            } else {
                assert_eq!(value["status"], "invalid_capability_profile", "{id}");
            }
            assert!(state.task(id).unwrap().pending_messages.is_empty(), "{id}");
        }
    }

    #[tokio::test]
    async fn send_message_rejects_provider_or_model_switched_transcript_before_respawn() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        let transcript = tmp.path().join("transcript.json");
        std::fs::write(&transcript, "[]").unwrap();
        let mut task = Task::new("model-switched", "General agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Completed;
        task.transcript_path = Some(transcript);
        task.arrangement_mode = Some(false);
        task.agent_provider = Some("old-provider".to_string());
        task.agent_model = Some("old-model".to_string());
        task.parent_session_id = Some(state.session_id().to_string());
        task.agent_kind = Some("general".to_string());
        state.upsert_task(task);
        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(state)
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(manager.clone())
            .with_agent_runtime_identity("new-provider", "new-model");

        let output = SendMessageTool
            .call(
                serde_json::json!({
                    "agent_id": "model-switched",
                    "message": "continue"
                }),
                &ctx,
            )
            .await
            .unwrap();

        let value: serde_json::Value = serde_json::from_str(&output_text(&output)).unwrap();
        assert_eq!(value["status"], "incompatible_runtime_profile");
        assert_eq!(value["queued"], false);
        assert!(manager.respawned.lock().unwrap().is_empty());
    }

    fn output_text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }
}
