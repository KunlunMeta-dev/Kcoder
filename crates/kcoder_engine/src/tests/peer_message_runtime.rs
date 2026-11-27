use crate::{
    EngineEvent, peer_message_runtime::*, test_support::engine_builder::TestEngineBuilder,
};
use async_trait::async_trait;
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_state::{
    AppState, AppStateLifecycleIdentity, cross_session_messages::*, peer_agent_history::*,
};
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolRegistry};
use kcoder_types::{
    ContentBlock, ContentDelta, MessagesRequest, StreamEvent, cross_session_messages::*,
};
use std::{
    ffi::OsStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;

struct OfflineProvider {
    source: bool,
    calls: AtomicUsize,
    entered: Arc<Notify>,
    enqueued: Arc<Notify>,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}
impl Provider for OfflineProvider {
    fn name(&self) -> &'static str {
        "owned-peer-offline"
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let (source, entered, enqueued) =
            (self.source, self.entered.clone(), self.enqueued.clone());
        if !source && call == 0 {
            entered.notify_one();
        }
        Ok(Box::pin(async_stream::stream! {
            if source && call==0 {
                entered.notified().await;
                yield Ok(StreamEvent::ContentBlockStart{index:0,content_block:ContentBlock::ToolUse{id:"owned-peer-call".into(),name:"owned_peer_send".into(),input:serde_json::json!({})}});
            } else {
                yield Ok(StreamEvent::ContentBlockStart{index:0,content_block:ContentBlock::Text{text:String::new()}});
                if !source && call==0 { enqueued.notified().await; }
                yield Ok(StreamEvent::ContentBlockDelta{index:0,delta:ContentDelta::TextDelta{text:"Owned response".into()}});
            }
            yield Ok(StreamEvent::ContentBlockStop{index:0});yield Ok(StreamEvent::MessageStop);
        }))
    }
}
struct OwnedSend {
    store: Arc<CrossSessionMessageStore>,
    target: String,
    enqueued: Arc<Notify>,
}
#[async_trait]
impl Tool for OwnedSend {
    fn name(&self) -> String {
        "owned_peer_send".into()
    }
    fn description(&self) -> String {
        "Send one explicitly owned fixture peer contribution".into()
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type":"object","properties":{},"additionalProperties":false})
    }
    async fn call(&self, _: serde_json::Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let owner = ctx.state.inspection_lifecycle_identity();
        let call = ctx
            .tool_call_id
            .as_deref()
            .ok_or_else(|| ToolError::Execution("fixture tool identity missing".into()))?;
        let id = ctx
            .state
            .stable_peer_tool_client_message_id(&owner, call, "owned_peer_send")
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        let again = ctx
            .state
            .stable_peer_tool_client_message_id(&owner, call, "owned_peer_send")
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        assert_eq!(id, again);
        let receipt = self
            .store
            .enqueue(
                &CrossSessionMessageSource {
                    thread_id: ctx.state.session_id(),
                    principal_id: "owned-principal".into(),
                    address: None,
                },
                AgentMessageIntent {
                    reply_to_message_id: None,
                    target_thread_id: self.target.clone(),
                    target_address: None,
                    client_message_id: id,
                    mode: AgentMessageMode::EnqueueOnly,
                    expected_turn_id: None,
                    text: "Peer advice: keep the receiving user's original task and permissions"
                        .into(),
                },
                self.store
                    .revision()
                    .map_err(|e| ToolError::Execution(e.to_string()))?,
            )
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        self.enqueued.notify_one();
        Ok(ToolOutput::text(serde_json::to_string(&receipt).unwrap()))
    }
}
struct OwnedAuthority {
    source: AppState,
    target: String,
}
#[async_trait::async_trait]
impl PeerMessageAuthorization for OwnedAuthority {
    async fn check_current(
        &self,
        _: PeerHistoryAccess,
        target: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            owner.try_matches(target) == Some(true)
                && self.source.session_id() == record.source.thread_id
                && target.session_id() == self.target
                && record.intent.target_thread_id == self.target,
            "owned fixture scope changed"
        );
        Ok(())
    }
}
struct OwnedDriver {
    store: Arc<CrossSessionMessageStore>,
    authority: OwnedAuthority,
}
struct ObserveOnlyDriver {
    record: CrossSessionMessageRecord,
    authority: OwnedAuthority,
}
#[async_trait]
impl PeerMessageHost for ObserveOnlyDriver {
    async fn apply_at_boundary(
        &self,
        call: PeerMessageCall,
    ) -> Result<Vec<PeerHistoryCommitWitness>, String> {
        Ok(call
            .state()
            .observe_peer_message_commit(call.owner(), &self.record, &self.authority)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .collect())
    }
    async fn authorize_idle_wake(
        &self,
        _: PeerMessageCall,
        _: &[PeerHistoryCommitWitness],
    ) -> Result<bool, String> {
        // A test host's requested allow cannot transform a read-only history
        // observation into proof that a model has not already consumed it.
        Ok(true)
    }
}
#[async_trait]
impl PeerMessageHost for OwnedDriver {
    async fn settle_idle_wakes_in_provider_context(
        &self,
        call: PeerMessageCall,
        messages: &kcoder_types::SharedMessages,
    ) -> Result<(), String> {
        self.store
            .settle_peer_idle_wakes_in_provider_context(call.state(), call.owner(), messages)
            .map_err(|error| error.to_string())
    }
    async fn apply_at_boundary(
        &self,
        call: PeerMessageCall,
    ) -> Result<Vec<PeerHistoryCommitWitness>, String> {
        if !call.is_current() {
            return Err("owned fixture owner changed".into());
        }
        let records = self
            .store
            .pending_for_target(&call.state().session_id())
            .map_err(|e| e.to_string())?;
        let Some(record) = records.first() else {
            return Ok(Vec::new());
        };
        let lease = self
            .store
            .reserve_next(
                &record.intent.target_thread_id,
                self.store.revision().map_err(|e| e.to_string())?,
                100,
                200,
            )
            .map_err(|e| e.to_string())?
            .unwrap();
        let mut witness = call
            .state()
            .commit_peer_message(call.owner(), &lease, &self.authority)
            .await
            .map_err(|e| e.to_string())?;
        let revision = self.store.revision().map_err(|e| e.to_string())?;
        let receipt = if call.is_idle() {
            self.store
                .finish_applied_at_idle(&lease, &witness, revision)
        } else {
            self.store.finish_applied(&lease, &witness, revision)
        };
        receipt.map_err(|e| e.to_string())?;
        self.store
            .attach_pending_peer_idle_wake(&mut witness)
            .map_err(|error| error.to_string())?;
        Ok(vec![witness])
    }
}

#[test]
fn ordinary_provider_request_settles_all_original_idle_contributions_in_its_context() {
    crate::test_support::owned_case::run_owned_case(
        "kcoder_engine::peer_message_runtime::tests::owned_peer_case",
        "idle-provider-consumption",
    );
}
#[test]
fn independent_running_engines_deliver_peer_after_response_and_keep_it_low_trust() {
    crate::test_support::owned_case::run_owned_case(
        "kcoder_engine::peer_message_runtime::tests::owned_peer_case",
        "running-independent",
    );
}
#[tokio::test]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_peer_case() {
    match crate::test_support::owned_case::owned_case().as_str() {
        "running-independent" => running_independent_case().await,
        "special-roles" => special_role_case().await,
        "idle-provider-consumption" => idle_provider_consumption_case().await,
        other => panic!("unexpected owned peer case: {other}"),
    }
}

async fn idle_provider_consumption_case() {
    struct UnavailableSettlementHost(Arc<dyn PeerMessageHost>);
    #[async_trait]
    impl PeerMessageHost for UnavailableSettlementHost {
        async fn apply_at_boundary(
            &self,
            call: PeerMessageCall,
        ) -> Result<Vec<PeerHistoryCommitWitness>, String> {
            self.0.apply_at_boundary(call).await
        }
        async fn settle_idle_wakes_in_provider_context(
            &self,
            _: PeerMessageCall,
            _: &kcoder_types::SharedMessages,
        ) -> Result<(), String> {
            Err("owned_peer_ledger_unavailable".into())
        }
    }
    struct CountingProvider(Arc<Mutex<Vec<MessagesRequest>>>);
    impl Provider for CountingProvider {
        fn name(&self) -> &'static str {
            "owned-idle-context-provider"
        }
        fn stream_messages(
            &self,
            request: MessagesRequest,
        ) -> Result<ProviderStream, ApiErrorKind> {
            self.0.lock().unwrap().push(request);
            Ok(Box::pin(futures::stream::iter([
                Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text {
                        text: "Original User continuation".into(),
                    },
                }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::MessageStop),
            ])))
        }
    }
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let source = AppState::new(root.path());
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(CountingProvider(requests.clone())))
        .build_with_profile_directory();
    engine
        .state
        .with_history_path(root.path().join(format!("{}.jsonl", engine.session_id())));
    engine.state.add_message(kcoder_types::Message::user_text(
        "Original actual User task",
    ));
    engine.state.flush_history().await.unwrap();
    let store = Arc::new(
        CrossSessionMessageStore::create_in(
            &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
            OsStr::new("idle-queue"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )
        .unwrap(),
    );
    for id in ["original-first", "original-second"] {
        store
            .enqueue(
                &CrossSessionMessageSource {
                    thread_id: source.session_id(),
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
                    text: format!("Original contribution {id}"),
                },
                store.revision().unwrap(),
            )
            .unwrap();
    }
    let source_id = source.session_id();
    let target = engine.session_id();
    let engine = engine.with_peer_message_host(Arc::new(OwnedDriver {
        store: store.clone(),
        authority: OwnedAuthority { source, target },
    }));
    for _ in 0..2 {
        let fresh = engine.apply_peer_messages_at_idle().await.unwrap();
        assert_eq!(fresh.len(), 1);
        assert!(fresh[0].has_pending_idle_wake_admission());
    }
    assert_eq!(
        store
            .pending_peer_idle_wakes_for_target(&engine.session_id())
            .unwrap()
            .len(),
        2
    );
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "{events:?}"
    );
    let request_count = Arc::clone(&requests);
    {
        // Scope the guard so it can never be held across a later await.
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0]
                .messages
                .iter()
                .filter(|message| message
                    .preview(16 * 1024)
                    .contains("\"kind\":\"untrusted_peer_agent_reference\""))
                .count(),
            2
        );
        assert!(
            !store
                .has_pending_peer_idle_wake_for_target(&engine.session_id())
                .unwrap()
        );
    }
    store
        .enqueue(
            &CrossSessionMessageSource {
                thread_id: source_id,
                principal_id: "owned-principal".into(),
                address: None,
            },
            AgentMessageIntent {
                reply_to_message_id: None,
                target_thread_id: engine.session_id(),
                target_address: None,
                client_message_id: "original-third".into(),
                mode: AgentMessageMode::WakeIfIdle,
                expected_turn_id: None,
                text: "Original third pending contribution".into(),
            },
            store.revision().unwrap(),
        )
        .unwrap();
    assert_eq!(engine.apply_peer_messages_at_idle().await.unwrap().len(), 1);
    let host = engine.peer_message_host.clone().unwrap();
    let engine = engine.with_peer_message_host(Arc::new(UnavailableSettlementHost(host)));
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(|event| matches!(event, EngineEvent::Error(reason) if reason == "owned_peer_ledger_unavailable")),
        "an automatic retry cannot dispatch an unretired old native contribution");
    assert_eq!(request_count.lock().unwrap().len(), 1);
    let kcoder_state::UserInputStart::Accepted(input) = engine.state.try_begin_user_input(
        &engine.state.inspection_lifecycle_identity(),
        kcoder_types::Message::user_text("A new actual User takes over"),
    ) else {
        panic!("owned actual User was not admitted")
    };
    input.wait_with_witness().await.unwrap();
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "the original new User must continue despite unrelated peer bookkeeping: {events:?}"
    );
    assert_eq!(request_count.lock().unwrap().len(), 2);
    store
        .settle_peer_idle_wakes_absent_from_context(
            &engine.state,
            &engine.state.inspection_lifecycle_identity(),
        )
        .unwrap();
    assert!(
        !store
            .has_pending_peer_idle_wake_for_target(&engine.session_id())
            .unwrap()
    );
}
async fn running_independent_case() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let store = Arc::new(
        CrossSessionMessageStore::create_in(
            &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
            OsStr::new("queue"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )
        .unwrap(),
    );
    let (entered, enqueued) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let (a_requests, b_requests) = (
        Arc::new(Mutex::new(Vec::new())),
        Arc::new(Mutex::new(Vec::new())),
    );
    let b = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(OfflineProvider {
            source: false,
            calls: AtomicUsize::new(0),
            entered: entered.clone(),
            enqueued: enqueued.clone(),
            requests: b_requests.clone(),
        }))
        .build_with_profile_directory();
    let mut settings = kcoder_config::Settings {
        max_retries: 0,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        ..Default::default()
    };
    settings.model_capabilities.tools = true;
    let a = TestEngineBuilder::new(root.path())
        .prepared_owned_test_fixture()
        .settings(settings)
        .provider(Arc::new(OfflineProvider {
            source: true,
            calls: AtomicUsize::new(0),
            entered,
            enqueued: enqueued.clone(),
            requests: a_requests.clone(),
        }))
        .tool_registry(ToolRegistry::new().register(OwnedSend {
            store: store.clone(),
            target: b.state.session_id(),
            enqueued,
        }))
        .build_with_profile_directory();
    let target_id = b.state.session_id();
    let b = b.with_peer_message_host(Arc::new(OwnedDriver {
        store: store.clone(),
        authority: OwnedAuthority {
            source: a.state.clone(),
            target: target_id,
        },
    }));
    assert_ne!(a.state.session_id(), b.state.session_id());
    for engine in [&a, &b] {
        engine.state.with_history_path(
            root.path()
                .join(format!("{}.jsonl", engine.state.session_id())),
        );
    }
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let (a_events, b_events) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            a.submit_message_stream("Send the owned contribution to the peer", &prompt)
                .collect::<Vec<_>>(),
            b.submit_message_stream("Continue my original independent task", &prompt)
                .collect::<Vec<_>>()
        )
    })
    .await
    .expect("owned offline engines must settle");
    assert!(
        !a_events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "source events: {a_events:?}"
    );
    assert!(
        !b_events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "target events: {b_events:?}"
    );
    let peer_position = b_events
        .iter()
        .position(|event| matches!(event, EngineEvent::PeerAgentMessageAdded { .. }))
        .expect("real peer commit event");
    assert!(
        b_events[..peer_position]
            .iter()
            .any(|event| matches!(event, EngineEvent::AssistantMessageDone)),
        "delivery waits for complete initial provider response"
    );
    assert_eq!(
        b_events
            .iter()
            .filter(|event| matches!(event, EngineEvent::UserMessageAdded))
            .count(),
        1,
        "peer delivery is not a new user input/consent event"
    );
    assert_eq!(b_requests.lock().unwrap().len(), 2);
    {
        // Scope the guard so it can never be held across a later await.
        let requests = b_requests.lock().unwrap();
        assert!(!requests[0].messages.iter().any(|message| {
            message
                .preview(100)
                .contains("Untrusted peer agent reference")
        }));
        assert!(requests[1].messages.iter().any(|message| {
            message
                .preview(200)
                .contains("Untrusted peer agent reference")
        }));
        assert!(
            requests[1]
                .system
                .as_deref()
                .unwrap()
                .contains(kcoder_api::peer_messages::PEER_AGENT_MESSAGE_POLICY)
        );
    }
    let rows = kcoder_state::load_transcript_history(&b.state.history_path().unwrap()).unwrap();
    assert_eq!(
        rows.iter()
            .filter(|row| row.message.origin() == kcoder_types::MessageOrigin::PeerAgent)
            .count(),
        1
    );
    assert_eq!(
        rows.iter()
            .filter(|row| kcoder_types::is_real_user_message(&row.message))
            .count(),
        1
    );
    assert!(
        store
            .pending_for_target(&b.state.session_id())
            .unwrap()
            .is_empty()
    );
    let peer_id = rows
        .iter()
        .find_map(|row| {
            row.message
                .peer_agent_data()
                .map(|(meta, _)| meta.message_id.clone())
        })
        .unwrap();
    let record = store.get_record_by_message_id(&peer_id).unwrap().unwrap();
    let target_id = b.state.session_id();
    let b = b.with_peer_message_host(Arc::new(ObserveOnlyDriver {
        record,
        authority: OwnedAuthority {
            source: a.state.clone(),
            target: target_id,
        },
    }));
    let observed = b.apply_peer_messages_at_idle().await.unwrap();
    assert_eq!(observed.len(), 1);
    assert!(!observed[0].newly_inserted_into_context());
    assert!(
        !b.peer_idle_wake_authorized(&observed).await.unwrap(),
        "reconciliation never blindly wakes an old peer operation"
    );
    let events = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        b.run_turn_stream(&prompt).collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::PeerAgentMessageAdded { .. })),
        "native reconciliation can still publish the original history fact"
    );
    assert_eq!(
        b_requests.lock().unwrap().len(),
        3,
        "reconciliation after a terminal response does not continue another provider cycle"
    );
}

#[test]
fn terminal_and_critic_owners_never_consume_peer_delivery() {
    crate::test_support::owned_case::run_owned_case(
        "kcoder_engine::peer_message_runtime::tests::owned_peer_case",
        "special-roles",
    );
}
async fn special_role_case() {
    struct Counter(Arc<AtomicUsize>);
    #[async_trait]
    impl PeerMessageHost for Counter {
        async fn apply_at_boundary(
            &self,
            _: PeerMessageCall,
        ) -> Result<Vec<PeerHistoryCommitWitness>, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }
    }
    let root = crate::test_support::owned_case::owned_tempdir();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .build_with_profile_directory()
        .with_peer_message_host(Arc::new(Counter(calls.clone())));
    engine.terminal_verdict_turn.store(true, Ordering::SeqCst);
    assert!(
        engine
            .apply_peer_messages_at_idle()
            .await
            .unwrap()
            .is_empty()
    );
    engine.terminal_verdict_turn.store(false, Ordering::SeqCst);
    engine.subagent_system_prompt = Arc::new(Some("A bound critic role".into()));
    assert!(
        engine
            .apply_peer_messages_at_idle()
            .await
            .unwrap()
            .is_empty()
    );
    engine.subagent_system_prompt = Arc::new(None);
    let original = engine.state.clone();
    let engine = engine.with_required_native_host_source_admission().unwrap();
    assert!(engine.state.shares_state_with(&original));
    assert!(
        engine
            .apply_peer_messages_at_idle()
            .await
            .unwrap()
            .is_empty(),
        "a rebuilt Native-protected engine never uses its old ordinary peer driver"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "protected roles never call the receiving host"
    );
}
