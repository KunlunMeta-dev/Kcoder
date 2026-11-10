//! Actual ToolContext and manager admission retain the spawning attempt.
use super::*;
use crate::native_model_requests::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_tools::{AgentRunner, ToolContext, ToolOutput};
use kcoder_types::{MessagesRequest, TurnAttemptIdentity};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

struct Observer(Arc<Mutex<Vec<TurnAttemptIdentity>>>);
impl NativeModelRequestObserver for Observer {
    fn reserve(
        &self,
        _: &NativeModelRequestContext,
        _: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        Err(NativeModelRequestError::Denied)
    }
    fn observe_child_scheduled(
        &self,
        request: &NativeScheduledChildRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        self.0
            .lock()
            .unwrap()
            .push(request.parent_execution().attempt().unwrap().clone());
        assert!(
            request
                .parent()
                .background_jobs
                .has_live_run(&request.run().agent_id, request.run())
        );
        Ok(())
    }
}
#[tokio::test]
async fn actual_tool_spawn_observes_original_attempt_before_worker_and_rejects_foreign_run() {
    let directory = tempfile::tempdir().unwrap();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(directory.path()).build_with_profile_directory();
    engine
        .state
        .with_history_path(directory.path().join("history.jsonl"));
    let engine = engine
        .with_mandatory_native_model_request_observer(Arc::new(Observer(observed.clone())))
        .unwrap();
    let attempt = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "real-spawning-turn".into(),
        attempt_id: "real-spawning-attempt".into(),
    };
    let effect = Arc::new(AtomicBool::new(false));
    let mut events = engine.background_jobs.subscribe();
    engine
        .state
        .history_attempt_scope(attempt.clone())
        .unwrap()
        .run(async {
            let runner = Arc::new(crate::agent::QueryEngineAgentRunner::new(engine.clone()));
            let context = ToolContext::new(engine.state.clone())
                .with_agent_runner(runner.clone())
                .with_background_job_manager(engine.background_jobs.clone());
            let current = observed.clone();
            let actual = effect.clone();
            context
                .spawn_cancellable_subagent_background_with_id(
                    "original-queued-child",
                    "Original managed run",
                    async move {
                        assert_eq!(current.lock().unwrap().len(), 1);
                        actual.store(true, Ordering::SeqCst);
                        ToolOutput::text("owned result")
                    },
                    Arc::new(|| {}),
                )
                .unwrap();
            let foreign = kcoder_types::BackgroundRunKey {
                parent_session_id: "foreign-parent".into(),
                agent_id: "original-queued-child".into(),
                run_id: uuid::Uuid::new_v4().to_string(),
            };
            assert!(runner.observe_subagent_spawned(Some(&foreign)).is_err());
        })
        .await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if events.recv().await.unwrap().is_final() {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(effect.load(Ordering::SeqCst));
    assert_eq!(*observed.lock().unwrap(), vec![attempt]);
}
