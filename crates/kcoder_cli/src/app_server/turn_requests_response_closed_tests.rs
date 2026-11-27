//! Controlled Provider contract for outbound enqueue failure before task spawn.
use super::*;

struct CountingProvider(Arc<std::sync::atomic::AtomicUsize>);
impl kcoder_api::Provider for CountingProvider {
    fn name(&self) -> &'static str {
        "unstarted-turn-test"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(kcoder_api::ApiErrorKind::Api {
            error_type: "unexpected_test_dispatch".into(),
            message: "this turn must never execute".into(),
        })
    }
}

#[tokio::test]
async fn closed_acceptance_response_terminalizes_unstarted_turn_without_provider_dispatch() {
    let temp = tempfile::tempdir().unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let owner = Arc::new(kcoder_config::create_private_temp_dir("unstarted-turn-test").unwrap());
    let settings = kcoder_config::Settings {
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        ..Default::default()
    };
    let factory = AppServerEngineFactory::new(
        Arc::new(CountingProvider(calls.clone())),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        temp.path().to_path_buf(),
        None,
        true,
        kcoder_engine::WorkspaceRuntimeServices::new(temp.path(), "unstarted-turn-test")
            .with_private_client_storage(owner),
        None,
        temp.path().join("short-ids"),
    );
    let mut engine = factory
        .create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))
        .unwrap();
    let thread_id = engine.session_id();
    engine
        .state
        .with_history_path(temp.path().join(format!("{thread_id}.jsonl")));
    engine.state.save_history().unwrap();
    let lease = SessionLease::acquire(&engine.session_lease_target()).unwrap();
    let (tx, rx) = mpsc::channel(16);
    drop(rx);
    let sequence = Arc::new(AtomicU64::new(1));
    let turn_state = ResidentTurnState::new(
        tx.clone(),
        kcoder_config::PermissionMode::Bypass,
        Arc::new(AtomicU64::new(2_000_000)),
        Arc::new(StdMutex::new(InteractionReceipts::default())),
    );
    let runtime = build_resident_thread_runtime(
        engine.clone(),
        lease,
        0,
        turn_state.clone(),
        tx.clone(),
        "test-server".into(),
        sequence.clone(),
    );
    let mut manager = ThreadManager::default();
    assert!(manager.insert(runtime).is_ok());
    let mut state = ConnectionState::default();
    let mut attachments = AttachmentDirectories::default();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let result = dispatch(
        "turn/start",
        json!("closed-response"),
        json!({"threadId":thread_id,"clientMessageId":"original-message",
                "input":[{"type":"text","text":"do not execute"}]}),
        &mut engine,
        &factory,
        &tx,
        &mut manager,
        "test-server",
        &sequence,
        &mut state,
        &mut attachments,
        None,
    )
    .await;
    let records = turn_attempts::records(&engine, &thread_id);
    let terminal = turn_receipts::terminal_status(&engine, &thread_id, "turn-1");
    let receipt = turn_receipts::query(
        json!({"threadId":thread_id,"clientMessageId":"original-message"}),
        &manager,
        &engine,
    )
    .await;
    let running = turn_state.running.load(Ordering::SeqCst);
    let has_task = turn_state.active_turn.lock().await.is_some();
    let calls_after = calls.load(Ordering::SeqCst);
    #[cfg(target_os = "linux")]
    {
        let cancel = CancellationToken::new();
        let (release, waiting) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            let _ = waiting.await;
        });
        *turn_state.active_turn.lock().await = Some(ActiveTurn {
            desktop_owner: None,
            attempt: None,
            origin: request_origin::RequestOrigin::Unverified,
            input_owner: None,
            handle,
            cancel: cancel.clone(),
            thread_id: thread_id.clone(),
            turn_id: "owned-stop".into(),
        });
        turn_state.running.store(true, Ordering::SeqCst);
        let stopped = dispatch(
            "turn/interrupt",
            json!("closed-stop-response"),
            json!({"threadId":thread_id,"turnId":"owned-stop"}),
            &mut engine,
            &factory,
            &tx,
            &mut manager,
            "test-server",
            &sequence,
            &mut state,
            &mut attachments,
            None,
        )
        .await;
        let owned = state
            .native_interrupts
            .is_pending(Some(&thread_id), Some("owned-stop"));
        let _ = release.send(());
        state.native_interrupts.drain().await;
        assert!(
            stopped.is_err(),
            "A lost stop receipt cannot be reported delivered"
        );
        assert!(
            owned && cancel.is_cancelled(),
            "Stop cleanup must be owned before its reply can fail"
        );
        assert!(!turn_state.running.load(Ordering::SeqCst));
    }
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    assert!(
        result
            .err()
            .expect("closed response queue must reject dispatch")
            .chain()
            .any(|e| e.to_string().contains("outbound queue closed"))
    );
    let records = records.unwrap();
    assert_eq!(
        records.len(),
        1,
        "must reach durable acceptance before the send failure"
    );
    assert_eq!(
        records[0].status,
        kcoder_types::TurnAttemptStatus::Interrupted
    );
    assert_eq!(records[0].identity.turn_id, "turn-1");
    let completion = records[0].completion.as_ref().unwrap();
    assert!(completion.partial_output.is_empty());
    assert!(completion.provider_failure.is_none());
    assert_eq!(terminal.as_deref(), Some("interrupted"));
    let receipt = receipt.unwrap().receipt.unwrap();
    assert_eq!(
        receipt.status,
        kcoder_app_protocol::TurnReceiptStatus::Interrupted
    );
    assert_eq!(receipt.turn_id, "turn-1");
    assert!(!running);
    assert!(!has_task);
    assert_eq!(calls_after, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn interrupt_with_full_output_cancels_and_settles_before_the_response() {
    let temp = tempfile::tempdir().unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let owner = Arc::new(kcoder_config::create_private_temp_dir("interrupt-backpressure").unwrap());
    let settings = kcoder_config::Settings {
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        ..Default::default()
    };
    let factory = AppServerEngineFactory::new(
        Arc::new(CountingProvider(calls)),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        temp.path().to_path_buf(),
        None,
        true,
        kcoder_engine::WorkspaceRuntimeServices::new(temp.path(), "interrupt-backpressure")
            .with_private_client_storage(owner),
        None,
        temp.path().join("short-ids"),
    );
    let mut engine = factory
        .create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))
        .unwrap();
    let thread_id = engine.session_id();
    engine
        .state
        .with_history_path(temp.path().join(format!("{thread_id}.jsonl")));
    engine.state.save_history().unwrap();
    engine.state.set_goal("interrupt this turn", None);
    let lease = SessionLease::acquire(&engine.session_lease_target()).unwrap();
    let (outbound, mut receiver) = mpsc::channel(1);
    outbound.try_send(json!({"occupied": true})).unwrap();
    let sequence = Arc::new(AtomicU64::new(1));
    let turn_state = ResidentTurnState::new(
        outbound.clone(),
        kcoder_config::PermissionMode::Bypass,
        Arc::new(AtomicU64::new(2_000_000)),
        Arc::new(StdMutex::new(InteractionReceipts::default())),
    );
    let cancel = CancellationToken::new();
    let worker_cancel = cancel.clone();
    let handle = tokio::spawn(async move { worker_cancel.cancelled().await });
    turn_state.running.store(true, Ordering::SeqCst);
    *turn_state.active_turn.lock().await = Some(ActiveTurn {
        desktop_owner: None,
        input_owner: None,
        handle,
        cancel: cancel.clone(),
        thread_id: thread_id.clone(),
        turn_id: "owned-turn".into(),
        attempt: None,
        origin: request_origin::RequestOrigin::Unverified,
    });
    let runtime = build_resident_thread_runtime(
        engine.clone(),
        lease,
        0,
        turn_state.clone(),
        outbound.clone(),
        "test-server".into(),
        sequence.clone(),
    );
    let mut manager = ThreadManager::default();
    assert!(manager.insert(runtime).is_ok());
    let mut state = ConnectionState::default();
    let mut attachments = AttachmentDirectories::default();
    let mut request = Box::pin(dispatch(
        "turn/interrupt",
        json!("interrupt-id"),
        json!({"threadId":thread_id,"turnId":"owned-turn"}),
        &mut engine,
        &factory,
        &outbound,
        &mut manager,
        "test-server",
        &sequence,
        &mut state,
        &mut attachments,
        None,
    ));
    assert!(futures::poll!(request.as_mut()).is_pending());
    assert!(
        cancel.is_cancelled(),
        "cancel was delayed by a full output queue"
    );
    let read_response = async {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while turn_state.running.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("original turn did not settle while output was full");
        assert!(turn_state.activity_gate.try_lock().is_ok());
        assert_eq!(receiver.recv().await.unwrap()["occupied"], true);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let update = receiver.recv().await.unwrap();
            assert_eq!(update["method"], method::THREAD_GOAL_UPDATED);
            assert_eq!(update["params"]["goal"]["status"], "paused");
            let response = receiver.recv().await.unwrap();
            assert_eq!(response["id"], "interrupt-id");
            assert_eq!(response["result"]["interrupted"], true);
        })
        .await
        .expect("interruption response did not arrive");
    };
    let (result, ()) = tokio::join!(request.as_mut(), read_response);
    assert!(result.is_ok());
    drop(request);
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}
