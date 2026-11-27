//! Clock-controlled expiry cases use real delivery, claim, stream and tool paths.
use super::*;
use std::sync::{Mutex, OnceLock, atomic::AtomicU64};
use tokio_util::sync::CancellationToken;
#[path = "peer_provider_response.rs"]
mod pending_response;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Case {
    LongPrefill,
    ExpiredBeforeDispatch,
    ExpiredBeforeBegin,
    Lazy,
    NoOwner,
    EmptyResponse,
    Revoked,
    RevokedAfterToolAdmission,
    Cancelled,
    OwnerChanged,
    Retired,
    NewUser,
    MixedPermit,
    Concurrent,
    DroppedStream,
    SafeParallel,
    TransportFailed,
    QueuedRevoke,
    QueuedCancel,
    QueuedRetire,
    ResponseBusy,
    ResponseBusyCancel,
    ResponseBusyOwnerChanged,
    ResponseBusyPoison,
    ResponseBusyEmpty,
    UntrustedHost,
}

struct Script {
    case: Case,
    clock: Arc<AtomicU64>,
    deadline: AtomicU64,
    calls: AtomicUsize,
    tools: Arc<AtomicUsize>,
    parallel_success: Arc<AtomicUsize>,
    host: Arc<ExpiryHost>,
    state: OnceLock<AppState>,
    cancel: CancellationToken,
    pending: OnceLock<Arc<pending_response::HeldResponse>>,
}
impl Provider for Script {
    fn name(&self) -> &'static str {
        "owned-prefill-expiry"
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let number = self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(number < 2, "a successful original request must not replay");
        let deadline = self.deadline.load(Ordering::Acquire);
        self.clock.store(deadline + 900_000, Ordering::Release);
        let case = self.case;
        let host = self.host.clone();
        let state = self.state.get().unwrap().clone();
        let cancel = self.cancel.clone();
        let pending = self.pending.get().cloned();
        if number == 0
            && let Some(held) = &pending
        {
            held.hold();
        }
        // The first invocation has actually crossed its dispatch boundary, but
        // no model event has been polled when this stream is constructed.
        if number == 0 {
            let original = host.original.lock().unwrap();
            let call = original.as_ref().unwrap();
            let permit = host.proof.get().unwrap();
            assert!(call.verify_current_provider_invocation(permit).is_err());
        }
        if matches!(case, Case::EmptyResponse | Case::ResponseBusyEmpty) {
            return Ok(Box::pin(async_stream::stream! {
                yield Ok(StreamEvent::ContentBlockStart { index:0,
                    content_block:ContentBlock::Text {text:String::new()} });
                yield Ok(StreamEvent::ContentBlockDelta {index:0,
                    delta:kcoder_types::ContentDelta::TextDelta {text:String::new()} });
                yield Ok(StreamEvent::Ping);
                yield Ok(StreamEvent::ToolCallProgress);
                if let Some(held)=&pending { held.release(); }
                {
                    let original = host.original.lock().unwrap();
                    let call = original.as_ref().unwrap();
                    let permit = host.proof.get().unwrap();
                    let error = call.verify_current_provider_invocation(permit).unwrap_err();
                    assert!(error.chain().any(|cause|cause.to_string()=="PEER_WAKE_PROVIDER_RESPONSE_REQUIRED"), "{error:#}");
                }
                yield Ok(StreamEvent::ContentBlockStop {index:0});
                yield Ok(StreamEvent::MessageStop);
            }));
        }
        let block = if number == 0 {
            ContentBlock::ToolUse {
                id: "original-expiry-tool".into(),
                name: "owned_expiry_tool".into(),
                input: serde_json::json!({}),
            }
        } else {
            ContentBlock::Text {
                text: "Original admitted turn finished after long prefill".into(),
            }
        };
        Ok(Box::pin(async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {index:0,content_block:block});
            if number==0 {
                if let Some(held)=&pending {
                    {
                        let original=host.original.lock().unwrap();
                        let error=original.as_ref().unwrap().verify_current_provider_invocation(host.proof.get().unwrap()).unwrap_err();
                        assert!(error.chain().any(|cause|cause.to_string()=="target_turn_owner_busy"),"{error:#}");
                    }
                    match case {
                        Case::ResponseBusyCancel=>cancel.cancel(),
                        Case::ResponseBusyOwnerChanged=>state.start_new_session().unwrap(),
                        _=>{}
                    }
                    held.release();
                }
                {
                    let original = host.original.lock().unwrap();
                    let call = original.as_ref().unwrap();
                    let permit = host.proof.get().unwrap();
                    if matches!(case,Case::ResponseBusyCancel|Case::ResponseBusyOwnerChanged|Case::ResponseBusyPoison) {
                        assert!(call.verify_current_provider_invocation(permit).is_err());
                    } else {
                        assert!(call.verify_current_provider_invocation(permit).is_ok(),
                            "the sole actual nonempty event must remain a fact after the owner lock is released");
                    }
                    if let Some(other) = host.other.get() {
                        assert!(call.verify_current_provider_invocation(other).is_err(),
                            "another genuine permit cannot borrow this response or stream");
                    }
                }
                match case {
                    Case::Revoked => host.inner.source_allowed.store(false, Ordering::Release),
                    Case::Cancelled => cancel.cancel(),
                    Case::OwnerChanged => state.start_new_session().unwrap(),
                    Case::Retired => host.owner.get().unwrap().revoke_active(),
                    Case::NewUser => {
                        let owner = state.inspection_lifecycle_identity();
                        let kcoder_state::UserInputStart::Accepted(input) = state.try_begin_user_input(
                            &owner, Message::user_text("A new actual User takes ownership"))
                            else { panic!("owned new User was not accepted") };
                        let input = input.wait_with_witness().await.unwrap();
                        let reset = input.peer_wake_reset_witness().unwrap().unwrap();
                        host.inner.store.record_fresh_peer_user_reset(
                            &reset, host.inner.store.revision().unwrap()).unwrap();
                        let original = host.original.lock().unwrap();
                        let call = original.as_ref().unwrap();
                        let permit = host.proof.get().unwrap();
                        assert!(call.verify_current_provider_invocation(permit).is_err());
                        assert_eq!(permit.observed_budget_usage().unwrap(), (2,0));
                    }
                    _ => {}
                }
                if case == Case::TransportFailed {
                    yield Err(ApiErrorKind::Api { error_type: "owned_transport_failed".into(), message: "Owned response ended without a terminal".into() });
                    return;
                }
            }
            yield Ok(StreamEvent::ContentBlockStop {index:0});
            if number == 0 && matches!(case,Case::SafeParallel|Case::QueuedRevoke|Case::QueuedCancel|Case::QueuedRetire) {
                yield Ok(StreamEvent::ContentBlockStart {index:1,content_block:ContentBlock::ToolUse {
                    id:"second-original-expiry-tool".into(),name:"owned_expiry_tool".into(),input:serde_json::json!({})
                }});
                yield Ok(StreamEvent::ContentBlockStop {index:1});
            }
            yield Ok(StreamEvent::MessageStop);
        }))
    }
}

struct ExpiryHost {
    case: Case,
    inner: Arc<CurrentHost>,
    original: Mutex<Option<PeerMessageCall>>,
    proof: OnceLock<Arc<PeerAutoWakePermit>>,
    other: OnceLock<Arc<PeerAutoWakePermit>>,
    owner: OnceLock<crate::owned_turn::OwnedTurnObserver>,
    claims: AtomicUsize,
    accept_without_checking: bool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    held: AtomicBool,
}
#[async_trait]
impl PeerMessageHost for ExpiryHost {
    async fn apply_at_boundary(
        &self,
        call: PeerMessageCall,
    ) -> Result<Vec<PeerHistoryCommitWitness>, String> {
        self.inner.apply_at_boundary(call).await
    }
    async fn claim_idle_wake(
        &self,
        call: PeerMessageCall,
        witnesses: &[PeerHistoryCommitWitness],
    ) -> Result<PeerAutoWakeClaim, String> {
        self.claims.fetch_add(1, Ordering::SeqCst);
        self.inner.claim_idle_wake(call, witnesses).await
    }
    async fn settle_idle_wakes_in_provider_context(
        &self,
        call: PeerMessageCall,
        messages: &kcoder_types::SharedMessages,
    ) -> Result<(), String> {
        self.inner
            .settle_idle_wakes_in_provider_context(call, messages)
            .await
    }
    async fn authorize_claimed_provider_start(
        &self,
        call: PeerMessageCall,
        permit: &PeerAutoWakePermit,
    ) -> Result<(), String> {
        if self.accept_without_checking {
            // Public host responses are not continuation credentials.
            return Ok(());
        }
        self.inner
            .authorize_claimed_provider_start(call.clone(), permit)
            .await?;
        let metadata = permit
            .native_wake_presence()
            .message()
            .peer_agent_data()
            .unwrap()
            .0;
        let record = self
            .inner
            .store
            .get_record_by_message_id(&metadata.message_id)
            .map_err(|error| error.to_string())?
            .ok_or("original record missing")?;
        permit
            .verify_original_record(&record)
            .map_err(|error| error.to_string())?;
        if matches!(
            self.case,
            Case::QueuedRevoke | Case::QueuedCancel | Case::QueuedRetire
        ) && self.inner.provider_checks.load(Ordering::Acquire) == 2
            && !self.held.swap(true, Ordering::AcqRel)
        {
            self.entered.notify_one();
            self.release.notified().await;
            call.verify_current_provider_invocation(permit)
                .map_err(|_| "owned_waited_call_changed".to_owned())?;
            self.inner
                .authorize_claimed_provider_start(call.clone(), permit)
                .await?;
        }
        self.original.lock().unwrap().get_or_insert(call);
        if self.case == Case::RevokedAfterToolAdmission
            && self.inner.provider_checks.load(Ordering::Acquire) == 2
        {
            self.inner.source_allowed.store(false, Ordering::Release);
        }
        Ok(())
    }
}

#[derive(Debug)]
struct CountTool {
    calls: Arc<AtomicUsize>,
    parallel: Option<Arc<tokio::sync::Barrier>>,
    success: Arc<AtomicUsize>,
}
#[async_trait]
impl kcoder_tools::Tool for CountTool {
    fn name(&self) -> String {
        "owned_expiry_tool".into()
    }
    fn description(&self) -> String {
        "Record execution in this owned expiry fixture".into()
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type":"object","properties":{},"additionalProperties":false})
    }
    fn is_read_only(&self) -> bool {
        true
    }
    fn is_concurrency_safe(&self, _: &serde_json::Value) -> bool {
        true
    }
    async fn call(
        &self,
        _: serde_json::Value,
        _: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(parallel) = &self.parallel {
            tokio::time::timeout(std::time::Duration::from_secs(2), parallel.wait())
                .await
                .map_err(|_| {
                    kcoder_tools::ToolError::Execution("safe tools did not overlap".into())
                })?;
            self.success.fetch_add(1, Ordering::SeqCst);
        }
        Ok(kcoder_tools::ToolOutput::text(
            "Original admitted tool result",
        ))
    }
}

pub(super) async fn run() {
    for case in [
        Case::LongPrefill,
        Case::ExpiredBeforeDispatch,
        Case::ExpiredBeforeBegin,
        Case::Lazy,
        Case::NoOwner,
        Case::EmptyResponse,
        Case::Revoked,
        Case::RevokedAfterToolAdmission,
        Case::Cancelled,
        Case::OwnerChanged,
        Case::Retired,
        Case::NewUser,
        Case::MixedPermit,
        Case::Concurrent,
        Case::DroppedStream,
        Case::SafeParallel,
        Case::TransportFailed,
        Case::QueuedRevoke,
        Case::QueuedCancel,
        Case::QueuedRetire,
        Case::ResponseBusy,
        Case::ResponseBusyCancel,
        Case::ResponseBusyOwnerChanged,
        Case::ResponseBusyPoison,
        Case::ResponseBusyEmpty,
        Case::UntrustedHost,
    ] {
        run_case(case).await;
    }
}
async fn run_case(case: Case) {
    eprintln!("owned prefill continuation case: {case:?}");
    let root = crate::test_support::owned_case::owned_tempdir();
    let store = Arc::new(
        CrossSessionMessageStore::create_in(
            &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
            OsStr::new("expiry-queue"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )
        .unwrap(),
    );
    let inner = Arc::new(CurrentHost {
        store: store.clone(),
        source_allowed: AtomicBool::new(true),
        provider_checks: AtomicUsize::new(0),
        settlement_unavailable: AtomicBool::new(false),
    });
    let host = Arc::new(ExpiryHost {
        case,
        inner,
        original: Mutex::new(None),
        proof: OnceLock::new(),
        other: OnceLock::new(),
        owner: OnceLock::new(),
        claims: AtomicUsize::new(0),
        accept_without_checking: case == Case::UntrustedHost,
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        held: AtomicBool::new(false),
    });
    let script = Arc::new(Script {
        case,
        clock: Arc::new(AtomicU64::new(0)),
        deadline: AtomicU64::new(0),
        calls: AtomicUsize::new(0),
        tools: Arc::new(AtomicUsize::new(0)),
        parallel_success: Arc::new(AtomicUsize::new(0)),
        host: host.clone(),
        state: OnceLock::new(),
        cancel: CancellationToken::new(),
        pending: OnceLock::new(),
    });
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(script.clone())
        .tool_registry(kcoder_tools::ToolRegistry::new().register(CountTool {
            calls: script.tools.clone(),
            success: script.parallel_success.clone(),
            parallel: (case == Case::SafeParallel).then(|| Arc::new(tokio::sync::Barrier::new(2))),
        }))
        .build_with_profile_directory()
        .with_peer_message_host(host.clone());
    assert!(script.state.set(engine.state.clone()).is_ok());
    assert!(host.owner.set(engine.owned_turn_observer()).is_ok());
    engine
        .state
        .with_history_path(root.path().join(format!("{}.jsonl", engine.session_id())));
    engine
        .state
        .add_message(Message::user_text("Original actual User task"));
    engine.state.flush_history().await.unwrap();
    let enqueue = |id: &str| {
        store
            .enqueue(
                &CrossSessionMessageSource {
                    thread_id: "owned-original-source".into(),
                    principal_id: "owned-principal".into(),
                    address: None,
                },
                AgentMessageIntent {
                    reply_to_message_id: None,
                    target_thread_id: engine.session_id(),
                    target_address: None,
                    client_message_id: id.into(),
                    mode: AgentMessageMode::WakeIfIdle,
                    expected_turn_id: None,
                    text: "Original admitted contribution".into(),
                },
                store.revision().unwrap(),
            )
            .unwrap()
    };
    enqueue("original-expiry");
    let witnesses = engine.apply_peer_messages_at_idle().await.unwrap();
    let PeerAutoWakeClaim::Permit(permit) = engine.claim_peer_auto_wake(&witnesses).await.unwrap()
    else {
        panic!("one original permit required")
    };
    if case == Case::MixedPermit {
        enqueue("another-genuine-permit");
        let other_witnesses = engine.apply_peer_messages_at_idle().await.unwrap();
        let PeerAutoWakeClaim::Permit(other) =
            engine.claim_peer_auto_wake(&other_witnesses).await.unwrap()
        else {
            panic!("a distinct genuine permit is required")
        };
        assert!(host.other.set(Arc::from(other)).is_ok());
    }
    let deadline = permit
        .install_provider_test_clock(script.clock.clone())
        .unwrap();
    script.deadline.store(deadline, Ordering::Release);
    script.clock.store(deadline - 1, Ordering::Release);
    if case == Case::ExpiredBeforeBegin {
        script.clock.store(deadline, Ordering::Release);
        assert!(
            engine
                .clone()
                .prepare_peer_auto_wake_start(permit)
                .await
                .is_err()
        );
        assert_eq!(script.calls.load(Ordering::Acquire), 0);
        return;
    }
    let peer = engine
        .clone()
        .prepare_peer_auto_wake_start(permit)
        .await
        .unwrap();
    let proof = peer.peer_auto_wake_start.as_ref().unwrap().clone();
    assert!(host.proof.set(proof.clone()).is_ok());
    if matches!(case, Case::ExpiredBeforeDispatch | Case::UntrustedHost) {
        script.clock.store(deadline, Ordering::Release);
    }
    if matches!(case, Case::Lazy | Case::NoOwner) {
        let scoped = peer.peer_turn_engine();
        let mut lazy = scoped
            .current_provider()
            .stream_messages(MessagesRequest::new("owned-model", vec![]))
            .unwrap();
        assert!(
            scoped
                .peer_provider_scope
                .as_ref()
                .unwrap()
                .invocations
                .is_idle(),
            "constructing an unpolled stream must not acquire an invocation"
        );
        assert_eq!(script.calls.load(Ordering::Acquire), 0);
        if case == Case::NoOwner {
            assert!(lazy.next().await.unwrap().is_err());
            assert!(proof.provider_dispatch_pending());
        }
        drop(lazy);
        script.clock.store(deadline, Ordering::Release);
    }
    let actor = peer.peer_turn_engine();
    if matches!(
        case,
        Case::ResponseBusy
            | Case::ResponseBusyCancel
            | Case::ResponseBusyOwnerChanged
            | Case::ResponseBusyPoison
            | Case::ResponseBusyEmpty
    ) {
        assert!(
            script
                .pending
                .set(Arc::new(pending_response::HeldResponse::new(
                    actor.owned_turns.clone(),
                    case == Case::ResponseBusyPoison
                )))
                .is_ok()
        );
    }
    let events = if matches!(
        case,
        Case::QueuedRevoke | Case::QueuedCancel | Case::QueuedRetire
    ) {
        let steering = actor.begin_turn_steering().unwrap();
        let mut turn = actor.run_turn_stream_with_cancel_and_steering(
            &kcoder_permissions::AutoAllowPrompt,
            script.cancel.clone(),
            steering,
        );
        let mut events = Vec::new();
        loop {
            tokio::select! {
                _=host.entered.notified()=>break,
                event=turn.next()=>events.push(event.expect("original check must be held")),
            }
        }
        assert!(futures::poll!(turn.next()).is_pending());
        assert!(
            actor
                .peer_provider_scope
                .as_ref()
                .unwrap()
                .waiting_checks
                .load(Ordering::Acquire)
                > 0,
            "the second real tool must be queued behind the first fresh check"
        );
        assert_eq!(script.tools.load(Ordering::Acquire), 0);
        assert_eq!(script.calls.load(Ordering::Acquire), 1);
        match case {
            Case::QueuedRevoke => host.inner.source_allowed.store(false, Ordering::Release),
            Case::QueuedCancel => script.cancel.cancel(),
            Case::QueuedRetire => actor.owned_turn_observer().revoke_active(),
            _ => unreachable!(),
        }
        if case == Case::QueuedRetire {
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                loop {
                    let event = turn
                        .next()
                        .await
                        .expect("the waiting tool must observe retirement");
                    let denied = matches!(event, EngineEvent::ToolDenied { .. });
                    events.push(event);
                    if denied {
                        break;
                    }
                }
            })
            .await
            .expect("retirement must end the queued wait without the holder releasing");
            assert!(
                actor
                    .peer_provider_scope
                    .as_ref()
                    .unwrap()
                    .checks
                    .try_lock()
                    .is_err()
            );
            assert_eq!(
                actor
                    .peer_provider_scope
                    .as_ref()
                    .unwrap()
                    .waiting_checks
                    .load(Ordering::Acquire),
                0
            );
        }
        if case != Case::QueuedCancel {
            host.release.notify_one();
        }
        events.extend(
            tokio::time::timeout(std::time::Duration::from_secs(2), turn.collect::<Vec<_>>())
                .await
                .expect("original cancellation must drop the held authorization future"),
        );
        events
    } else if matches!(case, Case::Concurrent | Case::DroppedStream) {
        let steering = actor.begin_turn_steering().unwrap();
        let mut turn = actor.run_turn_stream_with_cancel_and_steering(
            &kcoder_permissions::AutoAllowPrompt,
            script.cancel.clone(),
            steering,
        );
        let mut events = Vec::new();
        loop {
            let event = turn.next().await.expect("original Provider must start");
            let started = matches!(event, EngineEvent::ToolUseStarted { .. });
            events.push(event);
            if started {
                break;
            }
        }
        let unpolled = actor
            .current_provider()
            .stream_messages(MessagesRequest::new("owned-model", vec![]))
            .unwrap();
        drop(unpolled);
        assert!(
            actor
                .peer_provider_scope
                .as_ref()
                .unwrap()
                .invocations
                .provider_active(),
            "dropping an unpolled clone cannot release the actual Provider invocation"
        );
        if case == Case::DroppedStream {
            drop(turn);
            assert!(
                actor
                    .owned_turn_observer()
                    .current_identity()
                    .unwrap()
                    .is_none()
            );
            assert!(
                actor
                    .peer_provider_scope
                    .as_ref()
                    .unwrap()
                    .invocations
                    .is_idle()
            );
            let mut old = actor
                .current_provider()
                .stream_messages(MessagesRequest::new("owned-model", vec![]))
                .unwrap();
            assert!(old.next().await.unwrap().is_err());
            assert_eq!(script.calls.load(Ordering::Acquire), 1);
            events
        } else {
            let identity = actor
                .owned_turn_observer()
                .current_identity()
                .unwrap()
                .unwrap();
            actor.state.history_attempt_scope(identity).unwrap().run(async {
            let mut concurrent = actor.current_provider().stream_messages(
                MessagesRequest::new("owned-model", vec![])).unwrap();
            let result = concurrent.next().await;
            assert!(matches!(result, Some(Err(ApiErrorKind::PeerTurnAuthorization { summary: ref error, .. }))
                if error.as_str() == "KCoder peer turn authorization failed [peer_provider_invocation_busy]"),
                "a clone must not dispatch a second Provider before the original stream ends: {result:?}");
            assert_eq!(script.calls.load(Ordering::Acquire), 1);
            assert_eq!(actor.authorize_peer_tool_continuation().await.unwrap_err(),
                "peer_provider_invocation_busy");
        }).await;
            for boundary in ["execution", "result"] {
                loop {
                    let event = turn
                        .next()
                        .await
                        .expect("original tool batch must continue");
                    let reached = match boundary {
                        "execution" => matches!(event, EngineEvent::ToolExecutionStarted { .. }),
                        _ => matches!(event, EngineEvent::ToolResult { .. }),
                    };
                    events.push(event);
                    if reached {
                        break;
                    }
                }
                let identity = actor
                    .owned_turn_observer()
                    .current_identity()
                    .unwrap()
                    .unwrap();
                actor.state.history_attempt_scope(identity).unwrap().run(async {
                let mut concurrent=actor.current_provider().stream_messages(MessagesRequest::new("owned-model",vec![])).unwrap();
                assert!(matches!(concurrent.next().await,Some(Err(ApiErrorKind::PeerTurnAuthorization { summary: ref error, .. })) if error.as_str() == "KCoder peer turn authorization failed [peer_provider_invocation_busy]"));
                assert_eq!(script.calls.load(Ordering::Acquire),1);
            }).await;
            }
            events.extend(turn.collect::<Vec<_>>().await);
            events
        }
    } else {
        let steering = actor.begin_turn_steering().unwrap();
        actor
            .run_turn_stream_with_cancel_and_steering(
                &kcoder_permissions::AutoAllowPrompt,
                script.cancel.clone(),
                steering,
            )
            .collect::<Vec<_>>()
            .await
    };
    let dispatched = matches!(
        case,
        Case::LongPrefill
            | Case::EmptyResponse
            | Case::Revoked
            | Case::RevokedAfterToolAdmission
            | Case::Cancelled
            | Case::OwnerChanged
            | Case::Retired
            | Case::NewUser
            | Case::MixedPermit
            | Case::Concurrent
            | Case::DroppedStream
            | Case::SafeParallel
            | Case::TransportFailed
            | Case::QueuedRevoke
            | Case::QueuedCancel
            | Case::QueuedRetire
            | Case::ResponseBusy
            | Case::ResponseBusyCancel
            | Case::ResponseBusyOwnerChanged
            | Case::ResponseBusyPoison
            | Case::ResponseBusyEmpty
    );
    let completes = matches!(
        case,
        Case::LongPrefill
            | Case::MixedPermit
            | Case::Concurrent
            | Case::SafeParallel
            | Case::ResponseBusy
    );
    assert_eq!(
        script.calls.load(Ordering::Acquire),
        if completes {
            2
        } else {
            usize::from(dispatched)
        },
        "{case:?}: {events:?}"
    );
    assert_eq!(
        script.tools.load(Ordering::Acquire),
        if case == Case::SafeParallel {
            2
        } else {
            usize::from(completes)
        },
        "{case:?}: {events:?}"
    );
    assert_eq!(
        host.claims.load(Ordering::Acquire),
        if case == Case::MixedPermit { 2 } else { 1 }
    );
    assert_eq!(
        proof.observed_budget_usage().unwrap(),
        match case {
            Case::NewUser => (2, 0),
            Case::MixedPermit => (1, 2),
            _ => (1, 1),
        }
    );
    if case == Case::SafeParallel {
        assert_eq!(
            script.parallel_success.load(Ordering::Acquire),
            2,
            "safe tools must remain parallel: {events:?}"
        );
    }
    assert_eq!(proof.provider_dispatch_pending(), !dispatched);
    assert!(
        actor
            .peer_provider_scope
            .as_ref()
            .unwrap()
            .invocations
            .is_idle(),
        "every completed/dropped/cancelled invocation must release its private slot"
    );
    assert_eq!(
        actor
            .peer_provider_scope
            .as_ref()
            .unwrap()
            .waiting_checks
            .load(Ordering::Acquire),
        0
    );
    if let Some(call) = host.original.lock().unwrap().as_ref() {
        let original = host.proof.get().unwrap();
        assert!(Arc::ptr_eq(original, &proof));
        assert!(
            call.verify_current_provider_invocation(original).is_err(),
            "a finished or cancelled turn cannot retain continuation authority"
        );
        // A different State cannot borrow the original history/budget identity.
        let foreign = AppState::new(root.path());
        assert!(original.observed_provider_budget_owner(&foreign).is_err());
    }
    if case == Case::LongPrefill {
        assert!(proof.observed_provider_budget_owner(&engine.state).is_ok());
        assert!(
            proof
                .verify_provider_start(&engine.state, &engine.state.inspection_lifecycle_identity())
                .is_err()
        );
        let again = peer
            .run_peer_message_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        assert_eq!(
            script.calls.load(Ordering::Acquire),
            2,
            "a new real turn must not reuse the old response: {again:?}"
        );
        assert_eq!(script.tools.load(Ordering::Acquire), 1);
        assert_eq!(
            engine
                .state
                .messages()
                .iter()
                .filter(|message| kcoder_types::is_real_user_message(message))
                .count(),
            1
        );
        assert!(engine.state.goal().is_none());
    }
}
