//! Keep managed workers behind the original host's scheduling observation.
use super::*;

impl ToolContext {
    pub(super) fn with_admitted_subagent(
        &self,
        work: impl Future<Output = ToolOutput> + Send + 'static,
        spawn: impl FnOnce(
            Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        ) -> Result<String, ToolError>,
    ) -> Result<String, ToolError> {
        let (release, ready) = tokio::sync::oneshot::channel();
        let id = spawn(Box::pin(async move {
            if ready.await.is_err() {
                return ToolOutput::error("sub-agent scheduling was not accepted");
            }
            work.await
        }))?;
        if let Some(runner) = &self.agent_runner {
            let run = self.state.task(&id).and_then(|task| task.background_run);
            runner.observe_subagent_spawned(run.as_ref()).map_err(|_| {
                ToolError::Execution("native sub-agent scheduling was not accepted".into())
            })?;
        }
        let _ = release.send(());
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Runner {
        observed: Arc<AtomicBool>,
        effect: Arc<AtomicBool>,
        deny: bool,
    }
    #[async_trait]
    impl AgentRunner for Runner {
        async fn run_agent(&self, _: String, _: usize) -> Result<String, AgentError> {
            Err(AgentError::NotAvailable)
        }
        fn observe_subagent_spawned(
            &self,
            run: Option<&kcoder_types::BackgroundRunKey>,
        ) -> Result<(), AgentError> {
            assert!(run.is_some());
            assert!(
                !self.effect.load(Ordering::SeqCst),
                "worker ran before native scheduling observation"
            );
            self.observed.store(true, Ordering::SeqCst);
            if self.deny {
                Err(AgentError::NotAvailable)
            } else {
                Ok(())
            }
        }
    }
    #[tokio::test]
    async fn held_worker_starts_only_after_original_observation_and_denial_never_runs_work() {
        for deny in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let state = AppState::new(directory.path());
            state.with_history_path(directory.path().join("history.jsonl"));
            let observed = Arc::new(AtomicBool::new(false));
            let effect = Arc::new(AtomicBool::new(false));
            let context = ToolContext::new(state.clone()).with_agent_runner(Arc::new(Runner {
                observed: observed.clone(),
                effect: effect.clone(),
                deny,
            }));
            let expected = observed.clone();
            let actual = effect.clone();
            let mut worker = None;
            let result = context.with_admitted_subagent(
                async move {
                    assert!(expected.load(Ordering::SeqCst));
                    actual.store(true, Ordering::SeqCst);
                    ToolOutput::text("owned result")
                },
                |work| {
                    let mut task = kcoder_state::Task::new("owned-agent", "Original queued child");
                    task.kind = kcoder_state::TaskKind::Subagent;
                    state.start_background_task_run(task).unwrap();
                    worker = Some(tokio::spawn(work));
                    Ok("owned-agent".into())
                },
            );
            assert_eq!(result.is_err(), deny);
            let output = worker.unwrap().await.unwrap();
            assert_eq!(output.is_error, deny);
            assert_eq!(effect.load(Ordering::SeqCst), !deny);
        }
    }
}
