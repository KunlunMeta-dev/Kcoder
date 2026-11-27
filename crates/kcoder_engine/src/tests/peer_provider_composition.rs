//! Real peer claim, native model binding and health observer through the production turn entry.
use super::*;
use crate::native_model_requests::*;

struct ModelObserver {
    state: AppState,
    reserves: Arc<AtomicUsize>,
}
struct ModelLease;
impl NativeModelRequestLease for ModelLease {
    fn finish(
        self: Box<Self>,
        _: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError> {
        Ok(())
    }
}
impl NativeModelRequestObserver for ModelObserver {
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        _: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        if !context.state().shares_state_with(&self.state)
            || !context.execution().matches_state(&self.state)
        {
            return Err(NativeModelRequestError::Denied);
        }
        self.reserves.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(ModelLease))
    }
}

pub(super) async fn run() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut settings: kcoder_config::Settings = serde_json::from_value(serde_json::json!({
        "active_provider":"fixture","model":"owned-model","max_tokens":128,"max_retries":0,
        "providers":{"fixture":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},
            "endpoint":"http://127.0.0.1:9/v1","default_model":"owned-model","context_window_tokens":128000,
            "max_output_tokens":128,"output_headroom_tokens":128}},
        "integrations":{"core":{"modelPolicies":[{"id":"owned-policy","candidates":[{"provider":"fixture","model":"owned-model"}]}]}}
    })).unwrap();
    settings.apply_provider(Some("fixture")).unwrap();
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .settings(settings)
        .provider(Arc::new(CountingProvider(calls.clone())))
        .build_with_profile_directory();
    engine
        .state
        .with_history_path(root.path().join(format!("{}.jsonl", engine.session_id())));
    engine
        .state
        .add_message(Message::user_text("Original owned User task"));
    engine.state.flush_history().await.unwrap();
    let reserves = Arc::new(AtomicUsize::new(0));
    let engine = engine
        .clone()
        .with_native_model_request_observer(Arc::new(ModelObserver {
            state: engine.state.clone(),
            reserves: reserves.clone(),
        }))
        .unwrap();
    assert!(engine.model_request_binding.is_some());
    assert!(
        !engine
            .settings
            .read()
            .unwrap()
            .integrations
            .core
            .model_policies
            .is_empty()
    );
    let store = Arc::new(
        CrossSessionMessageStore::create_in(
            &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
            OsStr::new("composition-queue"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )
        .unwrap(),
    );
    let host = Arc::new(CurrentHost {
        store: store.clone(),
        source_allowed: AtomicBool::new(true),
        provider_checks: AtomicUsize::new(0),
        settlement_unavailable: AtomicBool::new(false),
    });
    let engine = engine.with_peer_message_host(host.clone());
    store
        .enqueue(
            &CrossSessionMessageSource {
                thread_id: "owned-original-source".into(),
                principal_id: "owned-principal".into(),
                address: None,
            },
            AgentMessageIntent {
                target_thread_id: engine.session_id(),
                target_address: None,
                client_message_id: "original-composition-message".into(),
                mode: AgentMessageMode::WakeIfIdle,
                expected_turn_id: None,
                text: "Owned peer contribution".into(),
                reply_to_message_id: None,
            },
            store.revision().unwrap(),
        )
        .unwrap();
    let witnesses = engine.apply_peer_messages_at_idle().await.unwrap();
    let PeerAutoWakeClaim::Permit(permit) = engine.claim_peer_auto_wake(&witnesses).await.unwrap()
    else {
        panic!("original permit missing")
    };
    let peer = engine
        .clone()
        .prepare_peer_auto_wake_start(permit)
        .await
        .unwrap();
    let events = peer
        .run_peer_message_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "production composed peer provider must reach the base exactly once; events={events:?}"
    );
    assert_eq!(
        reserves.load(Ordering::SeqCst),
        1,
        "the actual native model observer must retain one admission"
    );
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "{events:?}"
    );
    assert_eq!(
        host.provider_checks.load(Ordering::SeqCst),
        1,
        "one original fresh peer authorization"
    );
    let replay = peer
        .run_peer_message_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(
        replay.iter().any(|event| matches!(event,
        EngineEvent::Error(code) if code == "peer_provider_start_actual_stream_changed")),
        "{replay:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "dedup never reuses a spent stream"
    );
    assert_eq!(reserves.load(Ordering::SeqCst), 1);

    store
        .enqueue(
            &CrossSessionMessageSource {
                thread_id: "owned-original-source".into(),
                principal_id: "owned-principal".into(),
                address: None,
            },
            AgentMessageIntent {
                target_thread_id: engine.session_id(),
                target_address: None,
                client_message_id: "composed-source-revoked".into(),
                mode: AgentMessageMode::WakeIfIdle,
                expected_turn_id: None,
                text: "Owned revoked peer contribution".into(),
                reply_to_message_id: None,
            },
            store.revision().unwrap(),
        )
        .unwrap();
    let witnesses = engine.apply_peer_messages_at_idle().await.unwrap();
    let PeerAutoWakeClaim::Permit(permit) = engine.claim_peer_auto_wake(&witnesses).await.unwrap()
    else {
        panic!("second original permit missing")
    };
    let peer = engine
        .clone()
        .prepare_peer_auto_wake_start(permit)
        .await
        .unwrap();
    host.source_allowed.store(false, Ordering::Release);
    let denied = peer
        .run_peer_message_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(
        denied.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "{denied:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the retained real peer guard still rejects revoked Source"
    );
    assert_eq!(
        reserves.load(Ordering::SeqCst),
        1,
        "revocation never reaches native reservation"
    );
}
