//! Workflow agent runtime within the shared engine ownership boundary.

use super::*;

impl QueryEngine {
    /// Start a user-requested workflow without an extra model round-trip.
    /// Agent calls inside the workflow still use the normal engine runner,
    /// permissions, role filtering, cancellation, and artifact paths.
    pub async fn start_workflow(&self, input: serde_json::Value) -> Result<ToolOutput, ToolError> {
        self.start_workflow_native(input, None, None).await
    }

    /// Register an exact persisted run with its native owner before dispatch.
    /// The observer is supplied by the host, never accepted from model or RPC JSON.
    pub async fn start_workflow_with_native_observer(
        &self,
        input: serde_json::Value,
        observer: Arc<dyn kcoder_tools::workflow::WorkflowNativeLaunchObserver>,
    ) -> Result<ToolOutput, ToolError> {
        self.start_workflow_native(input, Some(observer), None)
            .await
    }

    /// Consume one host-pinned graph through the original workflow runtime.
    /// Source authorization and immutable intent preparation remain host-owned.
    pub async fn start_workflow_with_native_definition(
        &self,
        input: serde_json::Value,
        definition: Arc<kcoder_tools::workflow::WorkflowNativeDefinition>,
        observer: Arc<dyn kcoder_tools::workflow::WorkflowNativeLaunchObserver>,
    ) -> Result<ToolOutput, ToolError> {
        self.start_workflow_native(input, Some(observer), Some(definition))
            .await
    }

    async fn start_workflow_native(
        &self,
        input: serde_json::Value,
        observer: Option<Arc<dyn kcoder_tools::workflow::WorkflowNativeLaunchObserver>>,
        definition: Option<Arc<kcoder_tools::workflow::WorkflowNativeDefinition>>,
    ) -> Result<ToolOutput, ToolError> {
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
        let mut context = self.base_tool_context(max_out, head_out, tail_out, max_subagents);
        if let Some(observer) = observer {
            context = context.with_workflow_native_launch_observer(observer);
        }
        if let Some(definition) = definition {
            context = context.with_workflow_native_definition(definition);
        }
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
        self.steer_subagent_with_client_id(agent_id, message, None)
            .await
    }

    pub async fn steer_subagent_with_client_id(
        &self,
        agent_id: &str,
        message: &str,
        client_message_id: Option<&str>,
    ) -> Result<kcoder_tools::SubagentSteerReceipt, ToolError> {
        self.steer_subagent_with_run_constraint(agent_id, message, client_message_id, None, false)
            .await
    }

    /// An exact live-run command cannot resume or retarget a replacement worker.
    pub async fn steer_subagent_run_with_client_id(
        &self,
        run: &kcoder_types::BackgroundRunKey,
        message: &str,
        client_message_id: &str,
    ) -> Result<kcoder_tools::SubagentSteerReceipt, ToolError> {
        self.steer_subagent_with_run_constraint(
            &run.agent_id,
            message,
            Some(client_message_id),
            Some(run),
            false,
        )
        .await
    }

    /// Explicit continuation retains the original role, transcript, queue and receipt identity.
    pub async fn continue_subagent_run_with_client_id(
        &self,
        run: &kcoder_types::BackgroundRunKey,
        message: &str,
        client_message_id: &str,
    ) -> Result<kcoder_tools::SubagentSteerReceipt, ToolError> {
        self.steer_subagent_with_run_constraint(
            &run.agent_id,
            message,
            Some(client_message_id),
            Some(run),
            true,
        )
        .await
    }

    async fn steer_subagent_with_run_constraint(
        &self,
        agent_id: &str,
        message: &str,
        client_message_id: Option<&str>,
        expected_run: Option<&kcoder_types::BackgroundRunKey>,
        continuation: bool,
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
        let mut context = self.base_tool_context(max_out, head_out, tail_out, max_subagents);
        let task = self
            .state
            .task(agent_id)
            .filter(|task| {
                task.kind == kcoder_state::TaskKind::Subagent
                    && task.parent_session_id.as_deref() == Some(self.session_id().as_str())
            })
            .ok_or_else(|| ToolError::Execution("agent_not_found_or_not_owned".into()))?;
        if let Some(expected) = expected_run {
            let replay = if continuation {
                client_message_id
                    .map(|id| self.state.subagent_command_receipt(agent_id, id))
                    .transpose()
                    .map_err(|error| ToolError::Execution(error.to_string()))?
                    .flatten()
                    .is_some_and(|receipt| receipt.background_run.as_ref() == Some(expected))
            } else {
                false
            };
            if expected.parent_session_id != self.session_id()
                || (!replay && task.background_run.as_ref() != Some(expected))
            {
                return Err(ToolError::Execution("subagent_run_changed".into()));
            }
            if !replay
                && if continuation {
                    !matches!(task.status, TaskStatus::Completed | TaskStatus::Failed)
                } else {
                    !matches!(
                        task.status,
                        TaskStatus::Pending | TaskStatus::Running | TaskStatus::Paused
                    )
                }
            {
                return Err(ToolError::Execution("subagent_run_not_active".into()));
            }
            context = if continuation {
                context.with_subagent_continuation(expected.clone())
            } else {
                context.with_subagent_run_constraint(expected.clone())
            };
        }
        let message = message.trim();
        if message.is_empty() {
            return Err(ToolError::InvalidInput("message must not be empty".into()));
        }
        let generated_id = format!(
            "cmd:{}:{}",
            task.command_receipt_epoch,
            uuid::Uuid::new_v4()
        );
        let client_id = client_message_id.unwrap_or(&generated_id);
        self.state
            .validate_subagent_command_client_id(agent_id, client_id)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let previous = self
            .state
            .subagent_command_receipt(agent_id, client_id)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        use sha2::Digest as _;
        let content_hash = format!("{:x}", sha2::Sha256::digest(message.as_bytes()));
        if previous
            .as_ref()
            .is_some_and(|receipt| receipt.body_sha256 != content_hash)
        {
            return Err(ToolError::InvalidInput(
                "client_message_payload_conflict".into(),
            ));
        }
        let roots = self
            .settings_persistence_path()
            .as_deref()
            .and_then(std::path::Path::parent)
            .map(|profile| {
                (
                    profile.join("workflow-runs"),
                    profile.join("workflow-library"),
                )
            });
        let control = if previous.is_none() {
            match roots.as_ref() {
                Some((runs, library)) => kcoder_tools::workflow_runs::prepare_user_control(
                    runs,
                    library,
                    &self.session_id(),
                    agent_id,
                    client_id,
                    &content_hash,
                )
                .map_err(|error| ToolError::Execution(error.to_string()))?,
                None => None,
            }
        } else {
            // Existing durable command identities must not mark a later run or resume.
            None
        };
        let result = kcoder_tools::SendMessageTool
            .steer_typed(
                serde_json::json!({"agent_id":agent_id, "message":message,
                "internal_client_message_id":client_id}),
                &context,
            )
            .await?;
        if control.is_some()
            && self
                .state
                .subagent_command_receipt(agent_id, client_id)
                .map_err(|error| ToolError::Execution(error.to_string()))?
                .is_some()
            && let Some((runs, _)) = roots.as_ref()
        {
            // On failure the caller looks up the durable queue receipt; it must not resend.
            kcoder_tools::workflow_runs::acknowledge_user_control(
                runs, &self.session_id(), agent_id, client_id, &content_hash,
            ).map_err(|error| ToolError::Execution(format!(
                "workflow_control_ack_unknown: command receipt may already exist; query it before retrying: {error}"
            )))?;
        }
        Ok(result)
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
        let context_history_anchor = self.state.context_history_anchor(&fork_context_messages);
        let params = crate::agent::CacheSafeParams {
            fork_context_messages,
            active_skills: self.effective_active_skill_names(),
            snapshot_provider: self.provider_name(),
            snapshot_model: self.model_name(),
            context_history_anchor,
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
