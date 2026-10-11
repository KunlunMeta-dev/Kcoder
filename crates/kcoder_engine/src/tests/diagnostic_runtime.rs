fn diagnostic_usage_event() -> StreamEvent {
    StreamEvent::MessageDelta {
        delta: kcoder_types::MessageDeltaFields {
            stop_reason: None,
            stop_sequence: None,
            usage: Some(Usage {
                input_tokens: 17,
                output_tokens: 5,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            }),
        },
    }
}

fn diagnostic_engine(cwd: &Path, events: Vec<StreamEvent>) -> QueryEngine {
    let (provider, _) = SequentialEventsProvider::new(vec![events]);
    let mut settings = Settings::default();
    settings.session_memory.enabled = false;
    let engine = TestEngineBuilder::new(cwd)
        .provider(Arc::new(provider))
        .settings(settings)
        .build();
    engine
        .state
        .set_usage_history_root(Some(&cwd.join("usage")));
    engine.state.with_history_path(cwd.join("session.jsonl"));
    engine.state.commit_session_state();
    engine.state.add_message(Message::user_text("hello"));
    engine
}

fn diagnostic_usage(cwd: &Path) -> kcoder_types::usage_history::UsageCounters {
    kcoder_state::usage_history::read_usage(&cwd.join("usage"))
        .unwrap()
        .expect("observed attempt must persist usage")
        .days
        .values()
        .next()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn diagnostic_main_stream_drop_preserves_observed_usage_once() {
    let tmp = tempfile::tempdir().unwrap();
    let mut events = vec![diagnostic_usage_event()];
    events.extend(simple_text_events("observed response"));
    let engine = diagnostic_engine(tmp.path(), events);
    let mut stream = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt);
    while let Some(event) = stream.next().await {
        if matches!(event, EngineEvent::AssistantTextDelta(_)) {
            break;
        }
    }
    drop(stream);
    let usage = diagnostic_usage(tmp.path());
    assert_eq!(usage.requests, 1);
    assert_eq!(usage.input_tokens, 17);
    assert_eq!(usage.output_tokens, 5);
    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
}

#[tokio::test]
async fn diagnostic_main_reply_does_not_wait_for_saturated_capture_budget() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = diagnostic_engine(tmp.path(), simple_text_events("done"));
    let writer = engine.state.diagnostic_writer();
    let request = kcoder_state::DiagnosticRequest::new(MessagesRequest::new(
        "held",
        vec![Message::user_text("held")],
    ));
    let mut held = Vec::new();
    for _ in 0..32 {
        held.push(
            engine
                .state
                .begin_llm_exchange(request.clone(), false)
                .await,
        );
    }
    assert_eq!(writer.stats().reserved_jobs, 32);
    let events = tokio::time::timeout(
        Duration::from_secs(5),
        engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>(),
    )
    .await
    .expect("main reply must not wait for held diagnostics");
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::AssistantTextDelta(text) if text == "done"))
    );
    assert_eq!(writer.stats().reserved_jobs, 32);
    // The exchange and the recovery audit each reserve a diagnostic job.
    assert_eq!(writer.stats().dropped, 2);
    assert_eq!(diagnostic_usage(tmp.path()).requests, 1);
    drop(held);
    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
}

#[tokio::test]
async fn diagnostic_client_activation_and_fork_services_share_writer_and_owner() {
    let tmp = tempfile::tempdir().unwrap();
    let owner = Arc::new(kcoder_config::create_private_temp_dir("diagnostic-engine-test").unwrap());
    let owner_path = owner.path().to_path_buf();
    let services = WorkspaceRuntimeServices::new(tmp.path(), "diagnostic-test")
        .with_private_client_storage(owner.clone());
    let build = |services| {
        let settings = Settings::default();
        QueryEngine::try_new_for_client_with_services(
            Arc::new(EmptyProvider),
            AppState::new(tmp.path()),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::load_project_only(tmp.path()).unwrap(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            tmp.path().to_path_buf(),
            None,
            services,
        )
        .unwrap()
    };
    let parent = build(services);
    let root = kcoder_state::session_dir_path(
        &parent.session_storage_root,
        &parent.state.artifact_session_id(),
    );
    assert!(!root.exists(), "candidate must not create a ghost session");
    parent.activate_client_session();
    assert!(
        root.is_dir(),
        "activated historyless client needs an exact diagnostic anchor"
    );
    let child = build(parent.workspace_runtime_services());
    child.activate_client_session();
    let held = child
        .state
        .begin_llm_exchange(
            kcoder_state::DiagnosticRequest::new(MessagesRequest::new("held", vec![])),
            false,
        )
        .await;
    assert!(
        parent
            .state
            .flush_diagnostics_until(std::time::Instant::now())
            .await,
        "parent state scope excludes a fork's independent state"
    );
    assert!(
        !parent
            .flush_workspace_diagnostics_until(
                std::time::Instant::now() + Duration::from_millis(30)
            )
            .await,
        "workspace barrier includes the fork's capture but honors its deadline"
    );
    drop(held);
    assert!(
        parent
            .flush_workspace_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    parent.state.diagnostic_writer().close();
    let dropped_before = parent.state.diagnostic_writer().stats().dropped;
    let child_state = child.state.clone();
    let capture = child_state
        .begin_llm_exchange(
            kcoder_state::DiagnosticRequest::new(MessagesRequest::new(
                "test",
                vec![Message::user_text("test")],
            )),
            false,
        )
        .await;
    assert_eq!(
        child_state.diagnostic_writer().stats().dropped,
        dropped_before + 1
    );
    assert_eq!(
        parent.state.diagnostic_writer().stats().dropped,
        dropped_before + 1
    );
    drop(capture);
    drop(parent);
    drop(child);
    drop(owner);
    assert!(
        owner_path.exists(),
        "the exact state context retains its private owner"
    );
    drop(child_state);
    assert!(
        !owner_path.exists(),
        "last owner release cleans up private artifacts"
    );
}

#[tokio::test]
async fn diagnostic_session_end_waits_for_existing_capture_without_extra_provider_call() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(tmp.path())
        .provider(Arc::new(StaticTextProvider {
            requests: requests.clone(),
            text: "unused".into(),
        }))
        .build();
    engine
        .state
        .with_history_path(tmp.path().join("session.jsonl"));
    engine
        .state
        .set_usage_history_root(Some(&tmp.path().join("usage")));
    let capture = engine
        .state
        .begin_llm_exchange(
            kcoder_state::DiagnosticRequest::new(MessagesRequest::new(
                "held",
                vec![Message::user_text("held")],
            )),
            false,
        )
        .await;
    let ending = engine.run_session_end_hooks("success");
    tokio::pin!(ending);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut ending)
            .await
            .is_err(),
        "session teardown must wait for already-started diagnostics"
    );
    drop(capture);
    tokio::time::timeout(Duration::from_secs(5), ending)
        .await
        .unwrap();
    assert!(
        requests.lock().unwrap().is_empty(),
        "pure flush must not call the provider"
    );
    assert_eq!(engine.state.diagnostic_writer().stats().reserved_jobs, 0);
}

#[tokio::test]
async fn diagnostic_main_retry_finishes_each_attempt_once() {
    let tmp = tempfile::tempdir().unwrap();
    let retry = vec![
        diagnostic_usage_event(),
        StreamEvent::Error {
            error: kcoder_types::ApiError {
                error_type: "overloaded_error".into(),
                message: "temporarily unavailable 500".into(),
            },
        },
    ];
    let mut success = simple_text_events("done");
    success.insert(1, diagnostic_usage_event());
    let (provider, calls) = SequentialEventsProvider::new(vec![retry, success]);
    let settings = Settings {
        max_retries: 1,
        retry_base_delay_ms: 0,
        ..Settings::default()
    };
    let engine = TestEngineBuilder::new(tmp.path())
        .provider(Arc::new(provider))
        .settings(settings)
        .build();
    engine
        .state
        .with_history_path(tmp.path().join("session.jsonl"));
    engine
        .state
        .set_usage_history_root(Some(&tmp.path().join("usage")));
    engine.state.add_message(Message::user_text("retry"));
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::ProviderRetry(_)))
    );
    assert_eq!(*calls.lock().unwrap(), 2);
    let usage = diagnostic_usage(tmp.path());
    assert_eq!(usage.requests, 2);
    assert_eq!(usage.input_tokens, 34);
    assert_eq!(usage.output_tokens, 10);
    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    assert!(
        engine
            .flush_workspace_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    assert_eq!(engine.state.diagnostic_writer().stats().written, 3);
}

#[tokio::test]
async fn diagnostic_main_cancellation_finishes_observed_usage_once() {
    let tmp = tempfile::tempdir().unwrap();
    let mut events = simple_text_events("partial");
    events.insert(1, diagnostic_usage_event());
    let engine = diagnostic_engine(tmp.path(), events);
    let mut stream = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt);
    while let Some(event) = stream.next().await {
        if matches!(event, EngineEvent::AssistantTextDelta(_)) {
            engine.cancel_token().cancel();
            break;
        }
    }
    let remaining = stream.collect::<Vec<_>>().await;
    assert!(
        remaining
            .iter()
            .any(|event| matches!(event, EngineEvent::StreamAborted { .. }))
    );
    let usage = diagnostic_usage(tmp.path());
    assert_eq!(usage.requests, 1);
    assert_eq!(usage.input_tokens, 17);
    assert_eq!(usage.output_tokens, 5);
    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    assert!(
        engine
            .flush_workspace_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    assert_eq!(engine.state.diagnostic_writer().stats().written, 2);
}

#[tokio::test]
async fn diagnostic_main_protocol_error_finishes_observed_usage_once() {
    let tmp = tempfile::tempdir().unwrap();
    let mut events = simple_text_events("partial");
    events.insert(1, diagnostic_usage_event());
    events.insert(2, events[0].clone());
    let engine = diagnostic_engine(tmp.path(), events);
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(|event| matches!(event, EngineEvent::Error(text) | EngineEvent::ProviderFailed { message: text, .. } if text.contains("duplicate message_start"))));
    assert_eq!(diagnostic_usage(tmp.path()).requests, 1);
    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    assert!(
        engine
            .flush_workspace_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    assert_eq!(engine.state.diagnostic_writer().stats().written, 2);
}

#[derive(Debug)]
struct DiagnosticStartFailureProvider;

#[tokio::test]
async fn diagnostic_workspace_flush_snapshot_excludes_later_other_state_capture() {
    use std::future::Future;
    for no_target in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let engine = if no_target {
            TestEngineBuilder::new(tmp.path()).build()
        } else {
            diagnostic_engine(tmp.path(), Vec::new())
        };
        let writer = engine.state.diagnostic_writer();
        let request =
            || kcoder_state::DiagnosticRequest::new(MessagesRequest::new("held", Vec::new()));
        let old = engine.state.begin_llm_exchange(request(), false).await;
        let flush = engine
            .flush_workspace_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2));
        tokio::pin!(flush);
        std::future::poll_fn(|cx| {
            assert!(flush.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        let other = AppState::new(tmp.path());
        other.set_diagnostic_context(writer.clone(), None);
        if !no_target {
            let logs = tmp.path().join("later-logs");
            std::fs::create_dir(&logs).unwrap();
            other.with_llm_request_history_dir(logs, "later");
        }
        let later = other.begin_llm_exchange(request(), false).await;
        assert_eq!(writer.stats().pending_attempts, 2);
        assert_eq!(writer.stats().reserved_jobs, if no_target { 0 } else { 2 });
        drop(old);
        let completed = tokio::time::timeout(Duration::from_millis(250), &mut flush).await;
        let pending_later = writer.stats().pending_attempts;
        drop(later);
        assert!(writer.flush_until(std::time::Instant::now() + Duration::from_secs(2)));
        assert_eq!(pending_later, 1);
        assert!(
            matches!(completed, Ok(true)),
            "workspace flush included a later capture"
        );
    }
}

#[tokio::test]
async fn diagnostic_workspace_flush_waits_for_current_usage_scope_without_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(tmp.path()).build();
    assert!(engine.state.llm_request_history_dir().is_none());
    let held = engine
        .state
        .begin_llm_exchange(
            kcoder_state::DiagnosticRequest::new(MessagesRequest::new("held", vec![])),
            false,
        )
        .await;
    assert_eq!(engine.state.diagnostic_writer().stats().reserved_jobs, 0);
    assert!(
        !engine
            .flush_workspace_diagnostics_until(
                std::time::Instant::now() + Duration::from_millis(30)
            )
            .await,
        "current-state usage scope must complete even when raw diagnostics have no target"
    );
    drop(held);
    assert!(
        engine
            .flush_workspace_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
}

impl Provider for DiagnosticStartFailureProvider {
    fn name(&self) -> &'static str {
        "diagnostic-start-failure"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        Err(kcoder_api::ApiErrorKind::Api {
            error_type: "invalid_request_error".into(),
            message: "rejected request".into(),
        })
    }
}

#[tokio::test]
async fn diagnostic_start_and_transport_failures_record_attempt_counts_once() {
    let cases: Vec<(Arc<dyn Provider>, u64)> = vec![
        (Arc::new(DiagnosticStartFailureProvider), 1),
        (
            Arc::new(FlakyTransportErrorProvider {
                attempts: Arc::new(AtomicUsize::new(0)),
            }),
            1,
        ),
    ];
    for (provider, expected) in cases {
        let tmp = tempfile::tempdir().unwrap();
        let settings = Settings {
            max_retries: 1,
            retry_base_delay_ms: 0,
            ..Settings::default()
        };
        let engine = TestEngineBuilder::new(tmp.path())
            .provider(provider)
            .settings(settings)
            .build();
        engine
            .state
            .with_history_path(tmp.path().join("session.jsonl"));
        engine
            .state
            .set_usage_history_root(Some(&tmp.path().join("usage")));
        engine.state.add_message(Message::user_text("go"));
        engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        let usage = diagnostic_usage(tmp.path());
        assert_eq!(usage.requests, expected);
        assert_eq!(usage.unreported_requests, expected);
        assert!(
            engine
                .state
                .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
                .await
        );
        assert!(
            engine
                .flush_workspace_diagnostics_until(
                    std::time::Instant::now() + Duration::from_secs(2)
                )
                .await
        );
        assert_eq!(engine.state.diagnostic_writer().stats().written, expected + 1);
    }
}
