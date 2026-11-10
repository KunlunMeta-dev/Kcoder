//! Verifiers use the original managed foreground run and terminal waiter.
use super::owned_foreground::OwnedForeground;
use super::*;

impl QueryEngineAgentRunner {
    pub(super) async fn run_managed_verifier_session(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        runtime: Option<ForkedAgentRuntime>,
        guard: VerifierRuntimeGuard,
    ) -> Result<ForkedAgentResult, AgentError> {
        let manager = &self.engine.background_jobs;
        let events = manager.subscribe();
        let cancel = self.engine.cancel_token().child_token();
        if cancel.is_cancelled() {
            return Err(AgentError::Cancelled(
                "verifier caller already cancelled".into(),
            ));
        }
        let (ready, start) = tokio::sync::oneshot::channel();
        let (send_result, result) = tokio::sync::oneshot::channel();
        let runner = self.clone();
        let id = agent_id.clone();
        let work = async move {
            if start.await.is_err() {
                return ToolOutput::error("verifier run was not admitted");
            }
            runner.engine.state.update_task(&id, |task| {
                task.agent_kind = Some(AgentKind::Verifier.as_str().into());
                task.max_turns = Some(max_turns);
            });
            let outcome = runner
                .run_agent_session_result_with_kind_and_runtime(
                    id,
                    prompt,
                    max_turns,
                    AgentKind::Verifier,
                    runtime,
                    Some(guard),
                )
                .await;
            let output = match &outcome {
                Ok(value) => ToolOutput::text(value.output_text.clone()),
                Err(error) => ToolOutput::error(error.to_string()),
            };
            let _ = send_result.send(outcome);
            output
        };
        let cancellation = cancel.clone();
        let maximum = crate::effective_max_concurrent_subagents(&crate::recover_read_lock(
            &self.engine.settings,
            "settings",
        ));
        manager
            .spawn_cancellable_subagent_foreground_with_id_with_cap(
                agent_id.clone(),
                "Goal verification",
                Box::pin(work),
                Arc::new(move || cancellation.cancel()),
                Some(maximum),
            )
            .map_err(|error| AgentError::Execution(error.to_string()))?;
        let run = self
            .engine
            .state
            .task(&agent_id)
            .and_then(|task| task.background_run)
            .ok_or_else(|| {
                AgentError::Execution("verifier original run identity missing".into())
            })?;
        let owner = OwnedForeground::new(manager.clone(), run.clone());
        self.observe_subagent_spawned(Some(&run))?;
        let _ = ready.send(());
        owner.wait(&self.engine, cancel, events).await?;
        result
            .await
            .map_err(|_| AgentError::Execution("verifier original result unavailable".into()))?
    }
}
