use crate::{SendMessageTool, Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use kcoder_state::{
    AgentControlAction, AgentControlReceipt, AgentRunMode, SessionMode, TaskStatus,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Default)]
pub struct ControlAgentTool;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ControlAgentAction {
    Pause,
    Resume,
    Halt,
    GateTools,
    ClearToolGate,
    RetryMessage,
    DiscardMessage,
}

impl From<ControlAgentAction> for AgentControlAction {
    fn from(value: ControlAgentAction) -> Self {
        match value {
            ControlAgentAction::Pause => Self::Pause,
            ControlAgentAction::Resume => Self::Resume,
            ControlAgentAction::Halt => Self::Halt,
            ControlAgentAction::GateTools => Self::GateTools,
            ControlAgentAction::ClearToolGate => Self::ClearToolGate,
            ControlAgentAction::RetryMessage => Self::RetryMessage,
            ControlAgentAction::DiscardMessage => Self::DiscardMessage,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ControlAgentInput {
    agent_id: String,
    action: ControlAgentAction,
    expected_control_revision: u64,
    /// Bounded reason stored in the persistent control record and never concatenated directly as a system instruction.
    reason: String,
    /// Used only by gate_tools and must be a nonempty subset of the actual spawn-time tool set.
    #[serde(default)]
    tools: Vec<String>,
    /// Stable delivery ID required by retry_message and discard_message.
    #[serde(default)]
    message_id: Option<String>,
}

#[async_trait]
impl Tool for ControlAgentTool {
    fn name(&self) -> String {
        "ControlAgent".to_string()
    }

    fn description(&self) -> String {
        "Apply one revision-checked control action to a direct sub-agent owned by this Orchestrate session. pause/halt take effect at the next complete Provider/tool boundary; resume revalidates the persisted continuation profile and starts a reliable continuation; gate_tools can only shrink the exact spawn-time tool set; clear_tool_gate restores only that original set; retry_message requeues an explicitly identified blocked/dead-letter delivery; discard_message moves it to the retained dead-letter area. This tool cannot emergency-cancel work or control another session.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(ControlAgentInput));
        if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
            if let Some(reason) = properties.get_mut("reason").and_then(Value::as_object_mut) {
                reason.insert("minLength".to_string(), Value::from(1));
                reason.insert("maxLength".to_string(), Value::from(512));
            }
            if let Some(tools) = properties.get_mut("tools").and_then(Value::as_object_mut) {
                tools.insert("maxItems".to_string(), Value::from(128));
            }
        }
        schema
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.state.session_mode() != SessionMode::Orchestrate || ctx.agent_depth != 0 {
            return Err(ToolError::InvalidInput(
                "ControlAgent is only available to the main Orchestrate agent".to_string(),
            ));
        }
        if let Some(settings) = ctx.runtime_settings.as_ref() {
            let settings = settings.read().map_err(|_| {
                ToolError::Execution("runtime settings lock is poisoned".to_string())
            })?;
            if !settings.orchestrate.control.enabled {
                return Err(ToolError::InvalidInput(
                    "Orchestrate ControlAgent is disabled by settings".to_string(),
                ));
            }
        }
        let input: ControlAgentInput = parse_input(&input)?;
        let reason = input.reason.trim();
        if reason.is_empty() {
            return Err(ToolError::InvalidInput(
                "reason must not be empty".to_string(),
            ));
        }
        let parent_session_id = ctx.state.session_id();
        let action = AgentControlAction::from(input.action);
        let receipt = ctx.state.request_agent_control(
            &input.agent_id,
            &parent_session_id,
            action,
            input.expected_control_revision,
            reason,
            &input.tools,
            input.message_id.as_deref(),
        );
        let receipt = match receipt {
            Ok(receipt) => receipt,
            Err(error) => {
                ctx.state.record_orchestrate_runtime_event_after_commit(
                    "control_rejected",
                    ctx.state
                        .task(&input.agent_id)
                        .as_ref()
                        .and_then(|task| task.orchestrate_work_id.as_deref()),
                    None,
                    Some(&input.agent_id),
                    input.message_id.as_deref(),
                    json!({
                        "action": format!("{action:?}").to_ascii_lowercase(),
                        "reason": "authorization_or_state_validation_failed",
                    }),
                );
                return Err(ToolError::Execution(format!(
                    "ControlAgent rejected: {error:#}"
                )));
            }
        };

        if action == AgentControlAction::Resume {
            return resume_agent(ctx, receipt, reason, &parent_session_id).await;
        }
        if action == AgentControlAction::RetryMessage {
            return restart_agent_after_retry(ctx, receipt, reason).await;
        }
        let destructive = action == AgentControlAction::DiscardMessage;
        Ok(ToolOutput::text(
            serde_json::to_string_pretty(&json!({
                "receipt": receipt,
                "applied": matches!(action, AgentControlAction::GateTools | AgentControlAction::ClearToolGate | AgentControlAction::RetryMessage | AgentControlAction::DiscardMessage)
                    || receipt.run_mode == AgentRunMode::Halted,
                "pending_safe_boundary": matches!(receipt.run_mode, AgentRunMode::PauseRequested | AgentRunMode::HaltRequested),
                "destructive": destructive,
                "dead_letter_retained": destructive,
                "recoverable_with": destructive.then_some("ControlAgent action=retry_message using the same message_id"),
            }))
            .expect("ControlAgent receipt serialization cannot fail"),
        ))
    }
}

async fn restart_agent_after_retry(
    ctx: &ToolContext,
    receipt: AgentControlReceipt,
    _reason: &str,
) -> Result<ToolOutput, ToolError> {
    let task = ctx.state.task(&receipt.agent_id).ok_or_else(|| {
        ToolError::Execution(format!(
            "retried sub-agent {} disappeared before scheduling",
            receipt.agent_id
        ))
    })?;
    if task.status == TaskStatus::Paused {
        return Ok(ToolOutput::text(
            serde_json::to_string_pretty(&json!({
                "receipt": receipt,
                "applied": true,
                "status": "queued_paused",
                "next_action": "Resume the same agent explicitly; the retried delivery remains durable at the FIFO head.",
            }))
            .expect("ControlAgent retry receipt serialization cannot fail"),
        ));
    }
    if ctx
        .background_job_manager
        .as_ref()
        .is_some_and(|manager| manager.is_running(&receipt.agent_id))
    {
        return Ok(ToolOutput::text(
            serde_json::to_string_pretty(&json!({
                "receipt": receipt,
                "applied": true,
                "status": "queued_running",
                "next_action": "The live worker will consume the retried delivery from the FIFO head.",
            }))
            .expect("ControlAgent retry receipt serialization cannot fail"),
        ));
    }
    if !matches!(task.status, TaskStatus::Completed | TaskStatus::Failed) {
        return Err(ToolError::Execution(format!(
            "retried delivery is durable, but sub-agent {} has status {:?} without a live worker; explicit operator recovery is required",
            receipt.agent_id, task.status
        )));
    }
    let max_turns = task.max_turns.unwrap_or(ctx.default_subagent_max_turns);
    SendMessageTool
        .call(
            json!({
                "agent_id": receipt.agent_id,
                "message": "",
                "max_turns": max_turns,
                "internal_existing_message_id": receipt.message_id,
            }),
            ctx,
        )
        .await
}

async fn resume_agent(
    ctx: &ToolContext,
    receipt: AgentControlReceipt,
    reason: &str,
    parent_session_id: &str,
) -> Result<ToolOutput, ToolError> {
    debug_assert_eq!(receipt.status, TaskStatus::Paused);
    let max_turns = ctx
        .state
        .task(&receipt.agent_id)
        .and_then(|task| task.max_turns)
        .unwrap_or(ctx.default_subagent_max_turns);
    let message = format!(
        "[system][agent_control_resume] Runtime resumed this paused agent after capability, transcript, worktree, provider, model, and profile checks. Parent-supplied reason data: {}",
        serde_json::to_string(reason).expect("control reason JSON serialization cannot fail")
    );
    let output = SendMessageTool
        .call(
            json!({
                "agent_id": receipt.agent_id,
                "message": message,
                "max_turns": max_turns,
            }),
            ctx,
        )
        .await;
    match output {
        Ok(output) if !output.is_error => Ok(output),
        Ok(output) => {
            let diagnostic = output
                .content
                .iter()
                .filter_map(|block| match block {
                    kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>();
            let _ = ctx.state.rollback_agent_resume(
                &receipt.agent_id,
                parent_session_id,
                receipt.control_revision,
                &diagnostic,
            );
            Ok(output)
        }
        Err(error) => {
            let _ = ctx.state.rollback_agent_resume(
                &receipt.agent_id,
                parent_session_id,
                receipt.control_revision,
                &error.to_string(),
            );
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentError, AgentRunner, BackgroundJobSpawner, SpawnError};
    use async_trait::async_trait;
    use kcoder_state::{AgentDeliveryClaimOutcome, AppState, Task, TaskKind};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};

    struct FakeRunner;

    #[async_trait]
    impl AgentRunner for FakeRunner {
        async fn run_agent(
            &self,
            _prompt: String,
            _max_turns: usize,
        ) -> Result<String, AgentError> {
            Ok("unused".to_string())
        }
    }

    #[derive(Default)]
    struct FakeManager {
        respawned: Mutex<Vec<String>>,
    }

    impl BackgroundJobSpawner for FakeManager {
        fn spawn(
            &self,
            _description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            Ok("unused".to_string())
        }

        fn respawn_subagent(
            &self,
            id: String,
            _description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
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

    #[test]
    fn control_agent_is_stateful_and_schema_is_revisioned() {
        let tool = ControlAgentTool;
        assert!(!tool.is_concurrency_safe(&json!({})));
        let schema = tool.input_schema();
        assert!(
            schema["properties"]
                .get("expected_control_revision")
                .is_some()
        );
        assert!(schema["properties"].get("action").is_some());
    }

    #[tokio::test]
    async fn retry_restarts_terminal_worker_without_adding_a_synthetic_delivery() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path());
        state.enter_orchestrate_before_first_message().unwrap();
        let transcript = temp.path().join("agent-transcript.json");
        std::fs::write(&transcript, "[]").unwrap();
        let mut task = Task::new("agent-retry", "General agent: retry");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.parent_session_id = Some(state.session_id());
        task.arrangement_mode = Some(false);
        task.agent_kind = Some("general".to_string());
        task.transcript_path = Some(transcript);
        state.upsert_task(task);
        let receipt = state
            .enqueue_subagent_delivery("agent-retry", "original delivery")
            .unwrap()
            .unwrap();
        let claim = state
            .claim_next_subagent_delivery("agent-retry", 120, 1)
            .unwrap();
        let AgentDeliveryClaimOutcome::Claimed(claim) = claim else {
            panic!("delivery must be claimed")
        };
        state
            .fail_subagent_delivery(
                "agent-retry",
                &claim.message_id,
                &claim.lease_id,
                1,
                "provider timeout",
            )
            .unwrap();
        state.update_task("agent-retry", |task| {
            task.status = TaskStatus::Failed;
            task.accepting_subagent_messages = false;
        });
        let manager = Arc::new(FakeManager::default());
        let ctx = ToolContext::new(state.clone())
            .with_agent_runner(Arc::new(FakeRunner))
            .with_background_job_manager(manager.clone());

        let output = ControlAgentTool
            .call(
                json!({
                    "agent_id": "agent-retry",
                    "action": "retry_message",
                    "expected_control_revision": 0,
                    "reason": "retry the durable head",
                    "message_id": receipt.message_id,
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(!output.is_error);
        assert_eq!(
            manager.respawned.lock().unwrap().as_slice(),
            ["agent-retry"]
        );
        let task = state.task("agent-retry").unwrap();
        assert_eq!(task.message_queue.len(), 1);
        assert_eq!(task.message_queue[0].body, "original delivery");
        assert_eq!(task.message_queue[0].message_id, claim.message_id);
    }
}
