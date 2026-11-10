use super::*;
use crate::integrations::core::{
    NativeToolAuthorization, NativeToolAuthorizationError, NativeToolAuthorizationRequest,
    NativeWorkflowParentFacts, NativeWorkflowParentRequest,
};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

struct ProviderFixture {
    entered: Arc<Notify>,
    release: Arc<Notify>,
    calls: Arc<AtomicUsize>,
    wait: bool,
}
impl Provider for ProviderFixture {
    fn name(&self) -> &'static str {
        "owned-foreground-fixture"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        let release = self.release.clone();
        let wait = self.wait;
        Ok(Box::pin(async_stream::stream! {
            if wait { release.notified().await; }
            yield Ok(kcoder_types::StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: "owned node completed".into() },
            });
            yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}
fn fixture(root: &Path, wait: bool) -> (QueryEngineAgentRunner, Arc<ProviderFixture>) {
    let provider = Arc::new(ProviderFixture {
        entered: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
        calls: Arc::new(AtomicUsize::new(0)),
        wait,
    });
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root)
        .provider(provider.clone())
        .tool_registry(ToolRegistry::new())
        .build_with_profile_directory();
    engine.state.with_history_path(root.join("parent.jsonl"));
    *engine.last_cache_safe_params.write().unwrap() = Some(
        CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: vec![],
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            context_history_anchor: None,
            full_context_compatible: true,
        }
        .into(),
    );
    (QueryEngineAgentRunner::new(engine), provider)
}
fn options(cancel: CancellationToken) -> AgentRunOptions {
    let mut options = AgentRunOptions::default().with_abort_token(cancel);
    options.context_mode = SubagentContextMode::None;
    options
}
fn assert_terminal(
    runner: &QueryEngineAgentRunner,
    id: &str,
    status: TaskStatus,
) -> BackgroundRunKey {
    let task = runner.engine.state.task(id).unwrap();
    assert!(task.managed);
    assert_eq!(task.status, status);
    assert_eq!(task.delivery, TaskDelivery::Foreground);
    assert_eq!(
        task.parent_session_id.as_deref(),
        Some(runner.engine.state.session_id().as_str())
    );
    assert!(!task.notify_parent_on_completion);
    assert!(!task.accepting_subagent_messages);
    let run = task.background_run.unwrap();
    let record = runner.engine.state.background_run_record(&run).unwrap();
    assert_eq!(record.status, status);
    assert!(record.terminal.is_some());
    assert!(!runner.engine.background_jobs.has_live_run(id, &run));
    run
}

#[tokio::test]
async fn direct_node_owns_real_run_and_returns_only_after_original_terminal() {
    let root = tempfile::tempdir().unwrap();
    let (runner, provider) = fixture(root.path(), false);
    let mut events = runner.engine.background_jobs.subscribe();
    let result = runner
        .run_agent_session_with_options(
            "node-normal".into(),
            "complete node".into(),
            2,
            AgentKind::General,
            options(CancellationToken::new()),
        )
        .await
        .unwrap();
    assert_eq!(result, "owned node completed");
    let run = assert_terminal(&runner, "node-normal", TaskStatus::Completed);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let mut terminals = 0;
    while let Ok(event) = events.try_recv() {
        if event.is_final() {
            assert_eq!(event.identity().unwrap().run, run);
            terminals += 1;
        }
    }
    assert_eq!(terminals, 1);
    assert!(runner.transcript_path("node-normal").is_file());
    let before = run.clone();
    assert!(
        runner
            .run_agent_session_with_options(
                "node-normal".into(),
                "duplicate node".into(),
                2,
                AgentKind::General,
                options(CancellationToken::new())
            )
            .await
            .is_err()
    );
    assert_eq!(
        assert_terminal(&runner, "node-normal", TaskStatus::Completed),
        before
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn direct_node_cancel_uses_original_cleanup_without_cancelling_parent_or_peer() {
    check_direct_node_cancel(false).await;
}

#[tokio::test]
async fn public_exact_member_stop_uses_original_foreground_owner_without_cancelling_peer() {
    check_direct_node_cancel(true).await;
}

async fn check_direct_node_cancel(public_control: bool) {
    let root = tempfile::tempdir().unwrap();
    let (runner, provider) = fixture(root.path(), true);
    let peer_cancel = CancellationToken::new();
    let peer_work = peer_cancel.clone();
    runner
        .engine
        .background_jobs
        .spawn_subagent_with_id_with_cap(
            "owned-peer",
            "independent peer",
            Box::pin(async move {
                peer_work.cancelled().await;
                ToolOutput::text("peer completed")
            }),
            Some(4),
        )
        .unwrap();
    let peer_run = runner
        .engine
        .state
        .task("owned-peer")
        .unwrap()
        .background_run
        .unwrap();
    let cancel = CancellationToken::new();
    let child = runner.clone();
    let token = cancel.clone();
    let job = tokio::spawn(async move {
        child
            .run_agent_session_with_options(
                "node-cancel".into(),
                "wait node".into(),
                2,
                AgentKind::General,
                options(token),
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        provider.entered.notified(),
    )
    .await
    .unwrap();
    let run = runner
        .engine
        .state
        .task("node-cancel")
        .unwrap()
        .background_run
        .unwrap();
    assert!(
        runner
            .engine
            .background_jobs
            .has_live_run("node-cancel", &run)
    );
    if public_control {
        assert!(runner.engine.can_stop_subagent_run(&run));
        let mut wrong = run.clone();
        wrong.run_id = "not-the-original-run".into();
        assert!(runner.engine.stop_subagent_run(&wrong).await.is_err());
        assert!(
            runner
                .engine
                .background_jobs
                .has_live_run("node-cancel", &run)
        );
        assert!(runner.engine.stop_subagent_run(&run).await.unwrap());
        assert!(!cancel.is_cancelled());
    } else {
        cancel.cancel();
    }
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(8), job)
            .await
            .unwrap()
            .unwrap(),
        Err(AgentError::Cancelled(_))
    ));
    assert_terminal(&runner, "node-cancel", TaskStatus::Cancelled);
    assert!(
        runner
            .engine
            .background_jobs
            .has_live_run("owned-peer", &peer_run)
    );
    assert!(!peer_cancel.is_cancelled());
    assert!(
        runner
            .engine
            .background_jobs
            .abort_and_wait_for_run("owned-peer", &peer_run)
            .await
            .unwrap()
    );
    assert!(!runner.engine.cancel_token.is_cancelled());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn concurrent_duplicate_cannot_borrow_the_original_live_run() {
    let root = tempfile::tempdir().unwrap();
    let (runner, provider) = fixture(root.path(), true);
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let child = runner.clone();
    let job = tokio::spawn(async move {
        child
            .run_agent_session_with_options(
                "node-duplicate".into(),
                "wait node".into(),
                2,
                AgentKind::General,
                options(token),
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        provider.entered.notified(),
    )
    .await
    .unwrap();
    let run = runner
        .engine
        .state
        .task("node-duplicate")
        .unwrap()
        .background_run
        .unwrap();
    assert!(
        !runner
            .engine
            .background_jobs
            .current_work_owns_subagent("node-duplicate")
    );
    assert!(
        runner
            .run_agent_session_with_options(
                "node-duplicate".into(),
                "borrow owner".into(),
                2,
                AgentKind::General,
                options(CancellationToken::new())
            )
            .await
            .is_err()
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        runner
            .engine
            .state
            .task("node-duplicate")
            .unwrap()
            .background_run
            .as_ref(),
        Some(&run)
    );
    provider.release.notify_one();
    assert!(job.await.unwrap().is_ok());
    assert_terminal(&runner, "node-duplicate", TaskStatus::Completed);
    assert!(!cancel.is_cancelled());
}

struct MissingPrivateOrigin {
    state: AppState,
    observed: Mutex<Vec<BackgroundRunKey>>,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for MissingPrivateOrigin {
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Denied)
    }
    async fn workflow_parent_origin(
        &self,
        request: &NativeWorkflowParentRequest<'_>,
    ) -> Result<NativeWorkflowParentFacts, NativeToolAuthorizationError> {
        assert!(request.parent_execution().matches_state(&self.state));
        assert!(request.parent_execution().attempt().is_none());
        assert!(
            request
                .parent()
                .background_jobs
                .has_live_run(request.agent_id(), request.run())
        );
        self.observed.lock().unwrap().push(request.run().clone());
        // No private workflow receipt exists in this explicit negative fixture.
        Err(NativeToolAuthorizationError::Unavailable)
    }
}
#[tokio::test]
async fn missing_private_workflow_proof_reaches_real_callback_then_fails_zero_provider() {
    let root = tempfile::tempdir().unwrap();
    let (mut runner, provider) = fixture(root.path(), false);
    let authority = Arc::new(MissingPrivateOrigin {
        state: runner.engine.state.clone(),
        observed: Mutex::new(vec![]),
    });
    runner.engine = runner
        .engine
        .with_native_tool_authorization(authority.clone());
    let error = runner
        .run_agent_session_with_options(
            "node-denied".into(),
            "native node".into(),
            2,
            AgentKind::General,
            options(CancellationToken::new()),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("NATIVE_TASK_AUTHORITY_UNAVAILABLE")
    );
    let run = assert_terminal(&runner, "node-denied", TaskStatus::Failed);
    assert_eq!(authority.observed.lock().unwrap().as_slice(), &[run]);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    let original_run = runner
        .engine
        .state
        .task("node-denied")
        .unwrap()
        .background_run;
    assert!(
        runner
            .run_agent_session_with_options(
                "node-denied".into(),
                "native node".into(),
                2,
                AgentKind::General,
                options(CancellationToken::new())
            )
            .await
            .is_err()
    );
    assert_eq!(
        runner
            .engine
            .state
            .task("node-denied")
            .unwrap()
            .background_run,
        original_run
    );
    assert_eq!(
        authority.observed.lock().unwrap().len(),
        1,
        "Failed alone never authorizes a second child admission"
    );
}

#[tokio::test]
async fn dropped_workflow_node_cancels_original_owned_run() {
    let root = tempfile::tempdir().unwrap();
    let (runner, provider) = fixture(root.path(), true);
    let child = runner.clone();
    let job = tokio::spawn(async move {
        child
            .run_agent_session_with_options(
                "node-dropped".into(),
                "wait node".into(),
                2,
                AgentKind::General,
                options(CancellationToken::new()),
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        provider.entered.notified(),
    )
    .await
    .unwrap();
    job.abort();
    let _ = job.await;
    assert_terminal(&runner, "node-dropped", TaskStatus::Cancelled);
    assert!(!runner.engine.cancel_token.is_cancelled());
}
