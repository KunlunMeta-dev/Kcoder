//! Workflow agent runtime within the shared engine ownership boundary.

use super::*;

impl QueryEngine {
    /// Start a user-requested workflow without an extra model round-trip.
    /// Agent calls inside the workflow still use the normal engine runner,
    /// permissions, role filtering, cancellation, and artifact paths.
    pub async fn start_workflow(&self, input: serde_json::Value) -> Result<ToolOutput, ToolError> {
        if self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft {
            return Err(ToolError::Execution("Workflow generation sessions cannot execute workflows; start a separate run conversation".into()));
        }
        let (max_out, head_out, tail_out, max_subagents) = {
            let settings = recover_read_lock(&self.settings, "settings");
            (
                settings.max_tool_output_bytes,
                settings.tool_output_head_bytes,
                settings.tool_output_tail_bytes,
                Some(settings.max_concurrent_subagents),
            )
        };
        self.ensure_workflow_agent_context(max_out, head_out, tail_out, max_subagents);
        let tool = self
            .tools
            .get("Workflow")
            .ok_or_else(|| ToolError::Execution("Workflow tool is not registered".to_string()))?;
        let context = self.base_tool_context(max_out, head_out, tail_out, max_subagents);
        tool.call(input, &context).await
    }

    /// Send a targeted message to an existing sub-agent from an interactive or protocol entry point.
    ///
    /// This entry point reuses model-side `SendMessage` ownership, identity, queue,
    /// and recovery validation so the TUI and app-server do not implement separate state transitions.
    pub async fn steer_subagent(
        &self,
        agent_id: &str,
        message: &str,
    ) -> Result<kcoder_tools::SubagentSteerReceipt, ToolError> {
        let (max_out, head_out, tail_out, max_subagents) = {
            let settings = recover_read_lock(&self.settings, "settings");
            (
                settings.max_tool_output_bytes,
                settings.tool_output_head_bytes,
                settings.tool_output_tail_bytes,
                Some(settings.max_concurrent_subagents),
            )
        };
        let context = self.base_tool_context(max_out, head_out, tail_out, max_subagents);
        kcoder_tools::SendMessageTool
            .steer_typed(
                serde_json::json!({
                    "agent_id": agent_id,
                    "message": message,
                }),
                &context,
            )
            .await
    }

    pub(super) fn ensure_workflow_agent_context(
        &self,
        _max_out: usize,
        _head_out: usize,
        _tail_out: usize,
        _max_subagents: Option<usize>,
    ) {
        if self.cache_safe_snapshot().is_some() {
            return;
        }
        let (fork_context_messages, _) = message_repair::prepare_shared_request_messages(
            self.state.shared_messages_with_revision().0,
        );
        let params = crate::agent::CacheSafeParams {
            fork_context_messages,
            active_skills: recover_read_lock(&self.active_skills, "active_skills").clone(),
            snapshot_provider: self.provider_name(),
            snapshot_model: self.model_name(),
            full_context_compatible: true,
        };
        let mut slot = recover_write_lock(&self.last_cache_safe_params, "last_cache_safe_params");
        if slot.is_none() {
            *slot = Some(Arc::new(params));
        }
    }

    /// Explicit host/user cancellation stops this turn and its running subagents.
    /// Goal state must already be Cancelled/cleared before calling this.
    pub fn cancel_goal_execution(&self, turn_cancel: Option<&CancellationToken>) -> usize {
        // Host turns use their own tokens; never permanently cancel the reusable Engine.
        if let Some(cancel) = turn_cancel {
            cancel.cancel();
        }
        self.cancel_running_subagents_for_goal_stop("goal explicitly cancelled by user")
    }

    pub(super) fn cancel_running_subagents_for_goal_stop(&self, reason: &str) -> usize {
        let ids = self
            .state
            .tasks()
            .into_values()
            .filter(|task| matches!(task.kind, TaskKind::Subagent))
            .filter(|task| matches!(task.status, TaskStatus::Pending | TaskStatus::Running))
            .map(|task| task.id)
            .collect::<Vec<_>>();

        ids.into_iter()
            .filter(|id| self.background_jobs.cancel_for_goal_stop(id, reason))
            .count()
    }
}
