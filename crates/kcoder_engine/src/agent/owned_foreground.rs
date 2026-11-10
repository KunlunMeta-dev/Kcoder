//! Direct agent callers share the original managed foreground lifecycle.

use super::*;
use crate::background::{BackgroundJobEvent, BackgroundJobManager};
use kcoder_state::{TaskDelivery, TaskStatus};
use kcoder_types::BackgroundRunKey;

pub(super) struct OwnedForeground {
    manager: Arc<BackgroundJobManager>,
    run: BackgroundRunKey,
    armed: bool,
}

impl Drop for OwnedForeground {
    fn drop(&mut self) {
        if self.armed && self.manager.has_live_run(&self.run.agent_id, &self.run) {
            // A dropped workflow node cannot leave its owned worker running.
            // The original manager persists cancellation and closes its stream.
            self.manager.abort_owned_foreground(&self.run);
        }
    }
}

impl OwnedForeground {
    pub(super) fn new(manager: Arc<BackgroundJobManager>, run: BackgroundRunKey) -> Self {
        Self {
            manager,
            run,
            armed: true,
        }
    }
    pub(super) async fn wait(
        mut self,
        engine: &QueryEngine,
        cancel: tokio_util::sync::CancellationToken,
        mut events: tokio::sync::broadcast::Receiver<BackgroundJobEvent>,
    ) -> Result<String, AgentError> {
        let manager = self.manager.clone();
        let run = self.run.clone();
        let owner = &mut self;
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    manager.abort_owned_foreground_and_wait(&run).await
                        .map_err(|error| AgentError::Execution(error.to_string()))?;
                    owner.armed = false;
                    return terminal_result(&engine.state, &run)
                        .unwrap_or_else(|| Err(AgentError::Cancelled("agent caller cancelled".into())));
                }
                event = events.recv() => {
                    match event {
                        Ok(event) if event.identity().is_some_and(|identity| identity.run == run) => {
                            if (event.is_final() || matches!(event.payload(), BackgroundJobEvent::Paused { .. }))
                                && let Some(result) = terminal_result(&engine.state, &run) {
                                    owner.armed = false;
                                    return result;
                            }
                        }
                        Ok(_) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            if let Some(result) = terminal_result(&engine.state, &run) {
                                owner.armed = false;
                                return result;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            return Err(AgentError::Execution("managed agent terminal unavailable".into()));
                        }
                    }
                }
            }
        }
    }
}

impl QueryEngineAgentRunner {
    pub(super) async fn run_managed_agent_session(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        mut options: AgentRunOptions,
    ) -> Result<String, AgentError> {
        let manager = &self.engine.background_jobs;
        if manager.current_work_owns_subagent(&agent_id) {
            return self
                .run_owned_agent_session_with_options(
                    agent_id, prompt, max_turns, agent_kind, options,
                )
                .await;
        }
        kcoder_state::validate_artifact_requirements(&options.artifact_requirements)
            .map_err(AgentError::Execution)?;
        let declared = if let Some(task) = self.engine.state.task(&agent_id) {
            // Validate immutable declarations before manager admission; a caller
            // cannot replace them by repeating an existing public agent ID.
            options.restore_artifact_requirements(&task)?;
            !task.managed
                && task.background_run.is_none()
                && task.status == TaskStatus::Pending
                && task.kind == kcoder_state::TaskKind::Subagent
        } else {
            false
        };
        let recovery = if let Some(proof) = options.workflow_recovery.as_ref() {
            let owner = manager.current_owned_workflow_run().ok_or_else(|| {
                AgentError::Execution("WORKFLOW_RECOVERY_NATIVE_OWNER_REQUIRED".into())
            })?;
            proof
                .verify_restart(
                    &self.engine.state,
                    &owner,
                    &agent_id,
                    &prompt,
                    max_turns,
                    agent_kind,
                    &options,
                )
                .map_err(|_| {
                    AgentError::Execution("WORKFLOW_RECOVERY_NATIVE_PROOF_CHANGED".into())
                })?;
            let task = self.engine.state.task(&agent_id).ok_or_else(|| {
                AgentError::Execution("WORKFLOW_RECOVERY_ORIGINAL_TASK_REQUIRED".into())
            })?;
            verify_recovery_declarations(&task, &prompt, max_turns, agent_kind, &options)?;
            Some(
                manager
                    .workflow_recovery_claim(proof.previous_child_run())
                    .map_err(|_| {
                        AgentError::Execution("WORKFLOW_RECOVERY_ORIGINAL_OWNER_CHANGED".into())
                    })?,
            )
        } else {
            None
        };
        let cancel = options
            .abort_token
            .as_ref()
            .unwrap_or(&self.engine.cancel_token)
            .child_token();
        if cancel.is_cancelled() {
            return Err(AgentError::Cancelled(
                "agent caller already cancelled".into(),
            ));
        }
        let has_artifact_declarations = !options.artifact_requirements.is_empty();
        options.abort_token = Some(cancel.clone());
        let runner = self.clone();
        let job_id = agent_id.clone();
        let description = prompt.clone();
        let (ready, start) = tokio::sync::oneshot::channel();
        let work = async move {
            if start.await.is_err() {
                return ToolOutput::error("agent declarations were not initialized");
            }
            runner.engine.state.update_task(&job_id, |task| {
                task.allowed_write_paths = options.allowed_write_paths.clone();
                task.allowed_shell_prefixes = options.allowed_shell_prefixes.clone();
                task.worktree_path = options.worktree_path.clone();
                task.agent_kind = Some(agent_kind.as_str().to_string());
                task.arrangement_mode = Some(options.arrangement_mode);
                task.context_mode = serde_json::to_value(options.context_mode)
                    .ok()
                    .and_then(|value| value.as_str().map(ToOwned::to_owned));
                task.context_turns = Some(options.context_turns);
                task.max_turns = Some(max_turns);
            });
            if !options.artifact_requirements.is_empty()
                && let Err(error) = runner
                    .engine
                    .state
                    .bind_subagent_artifact_requirements(&job_id, &options.artifact_requirements)
            {
                return ToolOutput::error(format!(
                    "failed to bind artifact declarations: {error:#}"
                ));
            }
            match runner
                .run_owned_agent_session_with_options(
                    job_id, prompt, max_turns, agent_kind, options,
                )
                .await
            {
                Ok(text) => ToolOutput::text(text),
                Err(error) => ToolOutput::error(error.to_string()),
            }
        };
        let events = manager.subscribe();
        let cancellation = cancel.clone();
        let max_concurrent = crate::effective_max_concurrent_subagents(&crate::recover_read_lock(
            &self.engine.settings,
            "settings",
        ));
        let cancellation: Arc<dyn Fn() + Send + Sync> = Arc::new(move || cancellation.cancel());
        let spawned = if let Some(claim) = recovery {
            manager.spawn_recovered_workflow_foreground(
                agent_id.clone(),
                description,
                Box::pin(work),
                cancellation,
                max_concurrent,
                claim,
            )
        } else if declared {
            manager.spawn_declared_subagent_foreground(
                agent_id.clone(),
                description,
                Box::pin(work),
                cancellation,
                max_concurrent,
            )
        } else {
            manager.spawn_cancellable_subagent_foreground_with_id_with_cap(
                agent_id.clone(),
                description,
                Box::pin(work),
                cancellation,
                Some(max_concurrent),
            )
        };
        spawned.map_err(|error| {
            if has_artifact_declarations
                && matches!(&error, kcoder_tools::SpawnError::Persistence { .. })
            {
                AgentError::Execution(format!(
                    "failed to bind artifact declarations: owned task admission failed: {error}"
                ))
            } else {
                AgentError::Execution(error.to_string())
            }
        })?;
        let run = self
            .engine
            .state
            .task(&agent_id)
            .and_then(|task| task.background_run)
            .ok_or_else(|| AgentError::Execution("managed agent run identity missing".into()))?;
        let owner = OwnedForeground::new(manager.clone(), run.clone());
        self.observe_subagent_spawned(Some(&run))?;
        // Start only after the original Task/run and scheduled authority exist.
        let _ = ready.send(());
        owner.wait(&self.engine, cancel, events).await
    }
}

fn verify_recovery_declarations(
    task: &kcoder_state::Task,
    prompt: &str,
    max_turns: usize,
    kind: AgentKind,
    options: &AgentRunOptions,
) -> Result<(), AgentError> {
    let mode = serde_json::to_value(options.context_mode)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned));
    if task.description != prompt
        || task.agent_kind.as_deref() != Some(kind.as_str())
        || task.max_turns != Some(max_turns)
        || task.arrangement_mode != Some(options.arrangement_mode)
        || task.context_mode != mode
        || task.context_turns != Some(options.context_turns)
        || task.allowed_write_paths != options.allowed_write_paths
        || task.allowed_shell_prefixes != options.allowed_shell_prefixes
        || task.worktree_path != options.worktree_path
        || task.artifact_requirements != options.artifact_requirements
    {
        return Err(AgentError::Execution(
            "WORKFLOW_RECOVERY_DECLARATIONS_CHANGED".into(),
        ));
    }
    Ok(())
}

fn terminal_result(state: &AppState, run: &BackgroundRunKey) -> Option<Result<String, AgentError>> {
    let task = state.task_for_background_run(run)?;
    if task.delivery != TaskDelivery::Foreground {
        return Some(Err(AgentError::Execution(
            "agent delivery owner changed".into(),
        )));
    }
    let text = task.output.unwrap_or_default();
    match task.status {
        TaskStatus::Completed => Some(Ok(text)),
        TaskStatus::Failed => Some(Err(AgentError::Execution(text))),
        TaskStatus::Cancelled => Some(Err(AgentError::Cancelled(text))),
        TaskStatus::Paused => Some(Err(AgentError::Paused(text))),
        TaskStatus::Halted => Some(Err(AgentError::Halted(text))),
        TaskStatus::Pending | TaskStatus::Running | TaskStatus::Unknown(_) => None,
    }
}

#[cfg(test)]
#[path = "owned_foreground_tests.rs"]
mod tests;
