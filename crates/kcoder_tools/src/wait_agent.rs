use crate::agent::agent_status_json;
use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use kcoder_state::{Task, TaskStatus};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

/// Wait for a sub-agent (background job) to reach a terminal status.
#[derive(Debug, Default)]
pub struct WaitAgentTool;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct WaitAgentInput {
    /// Agent id returned by `spawn_agent`.
    pub agent_id: String,
    /// Maximum time to wait in milliseconds. Defaults to 5000.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_timeout_ms() -> u64 {
    5_000
}

const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Serialize, Deserialize)]
struct WaitAgentResult {
    agent_id: String,
    status: Value,
    output_file: Option<String>,
    timed_out: bool,
    effective_timeout_ms: u64,
    next_action: String,
}

#[async_trait]
impl Tool for WaitAgentTool {
    fn name(&self) -> String {
        "wait".to_string()
    }

    fn description(&self) -> String {
        "Short-poll a spawned sub-agent and report its status. \
         Use this only when blocked on the result. The engine will automatically notify \
         the main conversation when sub-agents finish, so do not use wait for long polling. \
         Returns `status` as a JSON value: the string \"pending\", \"running\", \
         \"cancelled\", or \"not_a_subagent\"; or an object {\"completed\": \"<output>\"} \
         / {\"failed\": \"<error>\"} when the sub-agent finishes. Also returns \
         `agent_id` (string), `output_file` (optional path), `timed_out` (bool), `effective_timeout_ms` (u64), \
         and `next_action` (string)."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(WaitAgentInput));
        if let Value::Object(ref mut map) = schema
            && let Some(Value::Object(props)) = map.get_mut("properties")
        {
            props.insert(
                "timeout_ms".to_string(),
                serde_json::json!({
                    "type": "integer",
                    "minimum": MIN_TIMEOUT_MS,
                    "maximum": MAX_TIMEOUT_MS,
                    "description": format!(
                        "Timeout in milliseconds. Defaults to {}, min {}, max {}.",
                        default_timeout_ms(),
                        MIN_TIMEOUT_MS,
                        MAX_TIMEOUT_MS
                    )
                }),
            );
        }
        schema
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let input: WaitAgentInput = parse_input(&input)?;
        let id = input.agent_id;
        let timeout_ms = input.timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

        let task = ctx
            .state
            .task(&id)
            .ok_or_else(|| ToolError::InvalidInput(format!("agent {id} not found")))?;

        if crate::background::is_tool_background_task_description(&task.description) {
            return Ok(ToolOutput::error(format_result(&WaitAgentResult {
                agent_id: id.clone(),
                status: serde_json::json!("not_a_subagent"),
                output_file: None,
                timed_out: false,
                effective_timeout_ms: timeout_ms,
                next_action: format!(
                    "`{id}` is a background command task, not a sub-agent. Use TaskOutput with block=false to inspect it, a short TaskOutput timeout only if its result is on the critical path, or TaskStop to cancel it."
                ),
            })?));
        }

        if is_final(task.status) {
            let task = ctx
                .state
                .task_for_wait_report(&id)
                .ok_or_else(|| ToolError::Execution(format!("agent {id} disappeared")))?;
            return Ok(ToolOutput::text(format_result(&WaitAgentResult {
                agent_id: id.clone(),
                status: agent_status_json(&task),
                output_file: task_output_file(&task),
                timed_out: false,
                effective_timeout_ms: timeout_ms,
                next_action: final_next_action(task.status),
            })?));
        }

        // Subscribe before re-checking to avoid missing a completion event.
        let mut rx = ctx.subscribe_background_jobs()?;

        if let Some(task) = ctx.state.task_for_wait_report(&id)
            && is_final(task.status)
        {
            return Ok(ToolOutput::text(format_result(&WaitAgentResult {
                agent_id: id.clone(),
                status: agent_status_json(&task),
                output_file: task_output_file(&task),
                timed_out: false,
                effective_timeout_ms: timeout_ms,
                next_action: final_next_action(task.status),
            })?));
        }

        let mut deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        let mut shortened = false;

        loop {
            // Honour user cancellation. The previous implementation polled
            // neither the abort token nor the deadline aggressively, which
            // meant a Ctrl+C during wait could leave the parent turn hanging
            // until the deadline (up to one hour) elapsed.
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }

            let received = tokio::select! {
                _ = ctx.cancelled() => return Err(ToolError::Aborted),
                _ = ctx.shortened() => {
                    // The user collapsed the remaining wait to a short grace
                    // period; keep looping so an imminent completion event can
                    // still be reported without a full timeout.
                    shortened = true;
                    deadline = deadline.min(
                        tokio::time::Instant::now() + Duration::from_millis(500),
                    );
                    continue;
                }
                received = tokio::time::timeout(remaining, rx.recv()) => received,
            };
            match received {
                Ok(Ok(event)) => {
                    if event.id() == id && event.is_final() {
                        let task = ctx.state.task_for_wait_report(&id).ok_or_else(|| {
                            ToolError::Execution(format!("agent {id} disappeared"))
                        })?;
                        return Ok(ToolOutput::text(format_result(&WaitAgentResult {
                            agent_id: id.clone(),
                            status: agent_status_json(&task),
                            output_file: task_output_file(&task),
                            timed_out: false,
                            effective_timeout_ms: timeout_ms,
                            next_action: final_next_action(task.status),
                        })?));
                    }
                    // Non-matching event: ignore and keep waiting.
                }
                // `Elapsed` from the inner timeout: deadline reached.
                Err(_) => break,
                // `Lagged` means the receiver fell behind the broadcast queue
                // and missed events. Re-check the task state instead of
                // giving up — the target agent may have completed among the
                // dropped events.
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped))) => {
                    tracing::debug!(
                        "wait subscriber lagged, skipped {skipped} background events; re-checking state"
                    );
                    if let Some(task) = ctx.state.task_for_wait_report(&id)
                        && is_final(task.status)
                    {
                        return Ok(ToolOutput::text(format_result(&WaitAgentResult {
                            agent_id: id.clone(),
                            status: agent_status_json(&task),
                            output_file: task_output_file(&task),
                            timed_out: false,
                            effective_timeout_ms: timeout_ms,
                            next_action: final_next_action(task.status),
                        })?));
                    }
                }
                // Channel closed: the manager is gone, we cannot make progress.
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
            }
        }

        let task = ctx
            .state
            .task(&id)
            .ok_or_else(|| ToolError::Execution(format!("agent {id} disappeared")))?;
        let next_action = if shortened {
            "The wait was shortened at your request; the agent is still running. Do other useful work and rely on the automatic subagent notification instead of repeatedly calling wait.".to_string()
        } else {
            "The agent is still running. Do other useful work and rely on the automatic subagent notification instead of repeatedly calling wait.".to_string()
        };
        Ok(ToolOutput::text(format_result(&WaitAgentResult {
            agent_id: id,
            status: agent_status_json(&task),
            output_file: task_output_file(&task),
            timed_out: true,
            effective_timeout_ms: timeout_ms,
            next_action,
        })?))
    }
}

fn is_final(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Paused
            | TaskStatus::Halted
            | TaskStatus::Completed
            | TaskStatus::Failed
            | TaskStatus::Cancelled
    )
}

fn format_result(result: &WaitAgentResult) -> Result<String, ToolError> {
    serde_json::to_string(result)
        .map_err(|e| ToolError::Execution(format!("failed to serialize result: {e}")))
}

fn task_output_file(task: &Task) -> Option<String> {
    task.output_path
        .as_ref()
        .map(|path| path.display().to_string())
}

fn final_next_action(status: TaskStatus) -> String {
    match status {
        TaskStatus::Completed => {
            "The agent has completed. Integrate the result and call close_agent when the task no longer needs to be tracked.".to_string()
        }
        TaskStatus::Failed => {
            "The agent failed. Read the failure payload, decide whether to recover locally, and call close_agent when done.".to_string()
        }
        TaskStatus::Cancelled => {
            "The agent was cancelled. Do not wait for it again; call close_agent when done.".to_string()
        }
        TaskStatus::Paused => {
            "The agent is paused at a safe boundary. Use ControlAgent with action=resume and the current control revision when it should continue.".to_string()
        }
        TaskStatus::Halted => {
            "The agent was gracefully halted and cannot resume. Integrate retained results or spawn a fresh sub-agent.".to_string()
        }
        TaskStatus::Pending | TaskStatus::Running => {
            "The agent is still running. Do other useful work and rely on the automatic subagent notification instead of repeatedly calling wait.".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BackgroundJobSpawner, SpawnError};
    use kcoder_state::AppState;
    use std::{future::Future, pin::Pin, sync::Arc};
    use tokio_util::sync::CancellationToken;

    struct SilentBackgroundJobs {
        tx: tokio::sync::broadcast::Sender<crate::background::BackgroundJobEvent>,
    }

    impl Default for SilentBackgroundJobs {
        fn default() -> Self {
            let (tx, _) = tokio::sync::broadcast::channel(1);
            Self { tx }
        }
    }

    impl BackgroundJobSpawner for SilentBackgroundJobs {
        fn spawn(
            &self,
            _description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            Ok("unused".to_string())
        }

        fn subscribe(
            &self,
        ) -> tokio::sync::broadcast::Receiver<crate::background::BackgroundJobEvent> {
            self.tx.subscribe()
        }

        fn abort(&self, _id: &str) -> bool {
            false
        }
    }

    #[test]
    fn wait_agent_tool_schema_is_object() {
        let tool = WaitAgentTool;
        let schema = tool.input_schema();
        assert_eq!(schema.get("type").unwrap(), "object");
        assert!(
            schema
                .get("properties")
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("agent_id")
        );
        let timeout = schema.get("properties").unwrap().get("timeout_ms").unwrap();
        assert_eq!(timeout.get("maximum").unwrap(), MAX_TIMEOUT_MS);
    }

    #[tokio::test]
    async fn wait_agent_returns_immediately_for_completed_task() {
        let state = AppState::new("/tmp");
        let mut task = kcoder_state::Task::new("job-1", "test");
        task.status = TaskStatus::Completed;
        task.output = Some("result".to_string());
        task.output_path =
            Some("/tmp/project/.kcoder/projects/session/subagents/job-1/output.md".into());
        state.upsert_task(task);

        let ctx = ToolContext::new(state);
        let tool = WaitAgentTool;
        let output = tool
            .call(serde_json::json!({"agent_id": "job-1"}), &ctx)
            .await
            .unwrap();

        let text = output_text(&output);
        let result: WaitAgentResult = serde_json::from_str(&text).unwrap();
        assert_eq!(result.agent_id, "job-1");
        assert!(!result.timed_out);
        assert_eq!(result.status, serde_json::json!({"completed": "result"}));
        assert_eq!(
            result.output_file.as_deref(),
            Some("/tmp/project/.kcoder/projects/session/subagents/job-1/output.md")
        );
    }

    #[tokio::test]
    async fn wait_agent_reports_clamped_timeout() {
        let state = AppState::new("/tmp");
        let mut task = kcoder_state::Task::new("job-1", "test");
        task.status = TaskStatus::Completed;
        state.upsert_task(task);

        let ctx = ToolContext::new(state);
        let tool = WaitAgentTool;
        let output = tool
            .call(
                serde_json::json!({"agent_id": "job-1", "timeout_ms": 300000}),
                &ctx,
            )
            .await
            .unwrap();

        let text = output_text(&output);
        let result: WaitAgentResult = serde_json::from_str(&text).unwrap();
        assert_eq!(result.effective_timeout_ms, MAX_TIMEOUT_MS);
        assert!(result.next_action.contains("completed"));
    }

    #[tokio::test]
    async fn wait_agent_rejects_background_command_tasks_without_subscribing() {
        let state = AppState::new("/tmp");
        let mut task = kcoder_state::Task::new(
            "job-shell",
            crate::background::tool_background_description("bash", "cargo test"),
        );
        task.status = TaskStatus::Running;
        state.upsert_task(task);

        let ctx = ToolContext::new(state);
        let output = WaitAgentTool
            .call(serde_json::json!({"agent_id": "job-shell"}), &ctx)
            .await
            .unwrap();

        assert!(output.is_error);
        let text = output_text(&output);
        let result: WaitAgentResult = serde_json::from_str(&text).unwrap();
        assert_eq!(result.agent_id, "job-shell");
        assert!(!result.timed_out);
        assert_eq!(result.status, serde_json::json!("not_a_subagent"));
        assert!(result.next_action.contains("TaskOutput"));
        assert!(result.next_action.contains("TaskStop"));
    }

    #[tokio::test]
    async fn wait_agent_wakes_promptly_when_turn_is_cancelled() {
        let state = AppState::new("/tmp");
        let mut task = kcoder_state::Task::new("job-1", "subagent");
        task.status = TaskStatus::Running;
        state.upsert_task(task);

        let token = CancellationToken::new();
        let ctx = ToolContext::new(state)
            .with_background_job_manager(Arc::new(SilentBackgroundJobs::default()))
            .with_abort_token(token.clone());
        let trigger = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            trigger.cancel();
        });

        let result = tokio::time::timeout(
            Duration::from_millis(100),
            WaitAgentTool.call(
                serde_json::json!({"agent_id": "job-1", "timeout_ms": MAX_TIMEOUT_MS}),
                &ctx,
            ),
        )
        .await
        .expect("turn cancellation should interrupt a silent background wait");

        assert!(matches!(result, Err(ToolError::Aborted)));
    }

    #[tokio::test]
    async fn wait_agent_shortens_its_deadline_when_the_user_signals() {
        let state = AppState::new("/tmp");
        let mut task = kcoder_state::Task::new("job-1", "subagent");
        task.status = TaskStatus::Running;
        state.upsert_task(task);

        let signal = Arc::new(tokio::sync::Notify::new());
        let ctx = ToolContext::new(state)
            .with_background_job_manager(Arc::new(SilentBackgroundJobs::default()))
            .with_shorten_signal(signal.clone());
        let trigger = signal.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            trigger.notify_waiters();
        });

        let start = std::time::Instant::now();
        let output = WaitAgentTool
            .call(
                serde_json::json!({"agent_id": "job-1", "timeout_ms": MAX_TIMEOUT_MS}),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            start.elapsed() < Duration::from_millis(1000),
            "wait should collapse to the half-second grace period"
        );
        let text = output_text(&output);
        let result: WaitAgentResult = serde_json::from_str(&text).unwrap();
        assert!(result.timed_out);
        assert!(
            result.next_action.contains("shortened"),
            "{}",
            result.next_action
        );
    }

    fn output_text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn wait_agent_claims_the_run_notification_on_terminal_status() {
        let state = AppState::new("/tmp");
        let mut task = kcoder_state::Task::new("job-1", "subagent");
        task.status = TaskStatus::Completed;
        task.run_started_at_ms = Some(1);
        state.upsert_task(task);

        // The running-agent branch subscribes to background jobs, so the
        // context must carry a manager even though nothing completes here.
        let ctx = ToolContext::new(state.clone())
            .with_background_job_manager(Arc::new(SilentBackgroundJobs::default()));
        let output = WaitAgentTool
            .call(serde_json::json!({"agent_id": "job-1"}), &ctx)
            .await
            .unwrap();
        assert!(!output.is_error);
        assert!(
            state
                .task("job-1")
                .unwrap()
                .notification_injected_at_ms
                .is_some(),
            "a terminal wait report must consume the completion notification"
        );

        // A timed-out wait on a running agent must NOT consume anything.
        let mut running = kcoder_state::Task::new("job-2", "subagent");
        running.status = TaskStatus::Running;
        state.upsert_task(running);
        let output = WaitAgentTool
            .call(
                serde_json::json!({"agent_id": "job-2", "timeout_ms": 1000}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!output.is_error);
        assert!(
            state
                .task("job-2")
                .unwrap()
                .notification_injected_at_ms
                .is_none(),
            "a still-running agent must stay claimable"
        );
    }
}
