use super::*;
use crate::integrations::core::{NativeToolAuthorization, NativeToolAuthorizationRequest};
use crate::test_support::{engine_builder::TestEngineBuilder, providers::StaticTextProvider};
use futures::StreamExt;
use kcoder_state::{
    AppState, Task, TaskKind,
    turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore},
};
use kcoder_tools::{Tool, ToolSource};
use kcoder_types::{Message, TurnAttemptIdentity, TurnAttemptStatus};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

// This policy fixture loads a real immutable Accepted record and verifies actual
// State/TI/parent. It is not the Root signed-policy or dedicated platform proof.
struct AcceptedAuthority {
    state: AppState,
    parent: AppState,
    store: Arc<TurnAttemptStore>,
    attempt: TurnAttemptIdentity,
    enabled: AtomicBool,
    reads: AtomicUsize,
    events: AtomicUsize,
    revoke_lease: Option<tokio_util::sync::CancellationToken>,
    allow_owned_write: AtomicBool,
}
impl AcceptedAuthority {
    fn verify(
        &self,
        execution: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        if !self.enabled.load(Ordering::SeqCst)
            || !execution.matches_state(&self.state)
            || execution.attempt() != Some(&self.attempt)
            || !execution
                .parent()
                .is_some_and(|parent| parent.matches_state(&self.parent))
        {
            return Err(NativeToolAuthorizationError::Denied);
        }
        self.reads.fetch_add(1, Ordering::SeqCst);
        let record = self
            .store
            .load(&self.attempt)
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?;
        if !record.is_some_and(|record| {
            record.status == TurnAttemptStatus::Accepted && record.completion.is_none()
        }) {
            return Err(NativeToolAuthorizationError::Unavailable);
        }
        Ok(())
    }
}
#[async_trait::async_trait]
impl NativeToolAuthorization for AcceptedAuthority {
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        if self.allow_owned_write.load(Ordering::SeqCst)
            && request.tool_name == "write"
            && request.source == ToolSource::Builtin
            && request.emitter.is_some_and(|emitter| {
                emitter
                    .downcast_tool::<kcoder_tools::FileWriteTool>()
                    .is_some()
            })
        {
            return self.verify(
                request
                    .execution
                    .ok_or(NativeToolAuthorizationError::Unavailable)?,
            );
        }
        Err(NativeToolAuthorizationError::Denied)
    }
    async fn authorize_provider(
        &self,
        execution: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.verify(execution)
    }
    async fn authorize_event(
        &self,
        frame: &NativeEngineEventFrame,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.verify(frame.execution())?;
        self.events.fetch_add(1, Ordering::SeqCst);
        if let Some(lease) = &self.revoke_lease {
            tokio::task::yield_now().await;
            lease.cancel();
        }
        Ok(())
    }
}
fn owned_child(
    root: &std::path::Path,
    registry: ToolRegistry,
    revoke_lease: Option<tokio_util::sync::CancellationToken>,
) -> (QueryEngine, QueryEngine, Arc<AcceptedAuthority>) {
    let parent = TestEngineBuilder::new(root).build_with_profile_directory();
    let mut task = Task::new("owned-child", "native event fixture");
    task.kind = TaskKind::Subagent;
    parent.state.start_background_task_run(task).unwrap();
    let child = TestEngineBuilder::new(root)
        .tool_registry(registry)
        .build_with_profile_directory()
        .with_subagent_runtime_control(
            parent.state.clone(),
            "owned-child".into(),
            root.join("child-transcript.json"),
        );
    let attempt = TurnAttemptIdentity {
        thread_id: child.session_id(),
        turn_id: "accepted-child-turn".into(),
        attempt_id: "accepted-child-attempt".into(),
    };
    let session = root.join("owned-attempts").join(child.session_id());
    let store = Arc::new(TurnAttemptStore::open(&session, &child.session_id()).unwrap());
    store
        .begin(TurnAttemptRecord {
            client_presentation: None,
            version: 1,
            identity: attempt.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })
        .unwrap();
    let authority = Arc::new(AcceptedAuthority {
        state: child.state.clone(),
        parent: parent.state.clone(),
        store,
        attempt,
        enabled: AtomicBool::new(true),
        reads: AtomicUsize::new(0),
        events: AtomicUsize::new(0),
        revoke_lease,
        allow_owned_write: AtomicBool::new(false),
    });
    let child = child.with_native_tool_authorization(authority.clone());
    (parent, child, authority)
}
#[tokio::test]
async fn producer_preserves_actual_accepted_child_ti_when_collector_has_no_task_local_scope() {
    let root = tempfile::tempdir().unwrap();
    let (parent, child, authority) = owned_child(root.path(), ToolRegistry::new(), None);
    // Replace only the test provider via the normal shared runtime slot.
    *child.provider.write().unwrap() = Arc::new(StaticTextProvider {
        requests: Arc::new(Mutex::new(Vec::new())),
        text: "visible owned output".into(),
    });
    child.state.add_message(Message::user_text("owned request"));
    let frames = child
        .state
        .history_attempt_scope(authority.attempt.clone())
        .unwrap()
        .run(async {
            child
                .run_native_turn_stream_with_max_turns(&kcoder_permissions::AutoDenyPrompt, 1)
                .collect::<Vec<_>>()
                .await
        })
        .await;
    assert!(child.state.current_history_attempt_identity().is_none());
    let frame = frames.iter().find(|frame| matches!(frame.event(), EngineEvent::AssistantTextDelta(text) if text == "visible owned output")).expect("real producer text frame");
    assert_eq!(frame.execution().attempt(), Some(&authority.attempt));
    child
        .authorize_native_child_event(&parent, frame)
        .await
        .unwrap();
    authority.enabled.store(false, Ordering::SeqCst);
    assert!(
        child
            .authorize_native_child_event(&parent, frame)
            .await
            .is_err()
    );
    assert_eq!(authority.events.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn new_parent_run_same_agent_label_cannot_consume_original_event() {
    let root = tempfile::tempdir().unwrap();
    let (parent, child, authority) = owned_child(root.path(), ToolRegistry::new(), None);
    let frame = child
        .state
        .history_attempt_scope(authority.attempt.clone())
        .unwrap()
        .run(async {
            child.native_event_frame(
                EngineEvent::AssistantTextDelta("original run output".into()),
                None,
            )
        })
        .await;
    child
        .authorize_native_child_event(&parent, &frame)
        .await
        .unwrap();
    let old = parent
        .state
        .task("owned-child")
        .unwrap()
        .background_run
        .unwrap();
    parent
        .state
        .commit_background_terminal(
            &kcoder_types::BackgroundEventIdentity::terminal(old.clone()),
            kcoder_types::TaskStatus::Completed,
            None,
        )
        .unwrap();
    let next = parent.state.begin_background_run("owned-child").unwrap();
    assert_ne!(old, next);
    assert!(
        child
            .authorize_native_child_event(&parent, &frame)
            .await
            .is_err()
    );
    assert_eq!(authority.events.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn replaced_child_state_epoch_refuses_original_frame_before_policy() {
    let root = tempfile::tempdir().unwrap();
    let (parent, child, authority) = owned_child(root.path(), ToolRegistry::new(), None);
    let history = root.path().join(format!("{}.jsonl", child.session_id()));
    child.state.with_history_path(&history);
    child
        .state
        .add_message(Message::user_text("native epoch fixture"));
    child.state.flush_history().await.unwrap();
    let frame = child
        .state
        .history_attempt_scope(authority.attempt.clone())
        .unwrap()
        .run(async {
            child.native_event_frame(
                EngineEvent::AssistantTextDelta("old epoch output".into()),
                None,
            )
        })
        .await;
    child.state.resume_from_history(&history).unwrap();
    assert!(
        child
            .authorize_native_child_event(&parent, &frame)
            .await
            .is_err()
    );
    assert_eq!(authority.events.load(Ordering::SeqCst), 0);
}
struct NoIo;
#[async_trait::async_trait]
impl kcoder_mcp::McpTransport for NoIo {
    async fn send(&mut self, _: &str) -> anyhow::Result<()> {
        anyhow::bail!("event fixture never dispatches MCP")
    }
    async fn recv(&mut self) -> anyhow::Result<Option<String>> {
        Ok(None)
    }
}
#[tokio::test]
async fn actual_mcp_arc_ceiling_and_lease_are_rechecked_after_event_authorization() {
    let root = tempfile::tempdir().unwrap();
    let lease = tokio_util::sync::CancellationToken::new();
    let handle = Arc::new(tokio::sync::Mutex::new(
        kcoder_mcp::McpClient::with_transport(Box::new(NoIo)),
    ));
    let tool: Arc<dyn Tool> = Arc::new(
        kcoder_mcp::McpTool::new(
            "owned-source",
            handle,
            serde_json::from_value(
                serde_json::json!({"name":"read","inputSchema":{"type":"object"}}),
            )
            .unwrap(),
        )
        .with_session_lease(lease.clone()),
    );
    let name = tool.name();
    let registry = ToolRegistry::new().register_arc(tool.clone());
    let (parent, child, authority) = owned_child(root.path(), registry.clone(), Some(lease));
    let child = child
        .with_native_tool_ceiling(std::slice::from_ref(&name))
        .unwrap();
    let frame = child
        .state
        .history_attempt_scope(authority.attempt.clone())
        .unwrap()
        .run(async {
            child.native_event_frame(
                EngineEvent::ToolResult {
                    id: "original-tool-id".into(),
                    name: name.clone(),
                    output: kcoder_tools::ToolOutput::text("withheld fixture output"),
                },
                Some(&registry),
            )
        })
        .await;
    assert!(frame.tool().unwrap().matches_tool(&tool));
    assert!(matches!(
        frame.tool().unwrap().source(),
        ToolSource::Mcp { .. }
    ));
    assert!(
        child
            .authorize_native_child_event(&parent, &frame)
            .await
            .is_err()
    );
    assert_eq!(authority.events.load(Ordering::SeqCst), 1);
    let child = child.with_native_tool_ceiling(&[]).unwrap();
    assert!(
        child
            .authorize_native_child_event(&parent, &frame)
            .await
            .is_err()
    );
    assert_eq!(authority.events.load(Ordering::SeqCst), 1);
}
struct ToolOnly;
#[async_trait::async_trait]
impl NativeToolAuthorization for ToolOnly {
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        Ok(())
    }
}

struct SlowProviderAuthority {
    state: AppState,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for SlowProviderAuthority {
    async fn authorize_provider(
        &self,
        execution: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        // Reproduce a legitimate source proof taking longer than the old five-second cap.
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        if execution.matches_state(&self.state) && execution.parent().is_none() {
            Ok(())
        } else {
            Err(NativeToolAuthorizationError::Denied)
        }
    }
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Denied)
    }
}
#[tokio::test]
async fn current_native_proof_longer_than_five_seconds_finishes_before_the_model_request() {
    let root = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root.path())
        .provider(Arc::new(StaticTextProvider {
            requests: requests.clone(),
            text: "owned delayed proof result".into(),
        }))
        .build_with_profile_directory();
    let state = engine.state.clone();
    let engine = engine.with_native_tool_authorization(Arc::new(SlowProviderAuthority { state }));
    engine.state.add_message(Message::user_text("owned input"));
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoDenyPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::Error(_)))
    );
}
#[tokio::test]
async fn missing_provider_verifier_is_unavailable_before_any_model_request() {
    let root = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root.path())
        .provider(Arc::new(StaticTextProvider {
            requests: requests.clone(),
            text: "must never publish".into(),
        }))
        .build_with_profile_directory()
        .with_native_tool_authorization(Arc::new(ToolOnly));
    engine.state.add_message(Message::user_text("owned input"));
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoDenyPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(|event| matches!(event, EngineEvent::Error(reason) if reason == "NATIVE_TASK_AUTHORITY_UNAVAILABLE")));
    assert!(requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn production_fork_without_real_child_attempt_never_starts_model_or_live_view() {
    let root = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root.path())
        .provider(Arc::new(StaticTextProvider {
            requests: requests.clone(),
            text: "must never publish".into(),
        }))
        .build_with_profile_directory()
        .with_native_tool_authorization(Arc::new(ToolOnly));
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            context_history_anchor: None,
            full_context_compatible: true,
        }
        .into(),
    );
    let result = engine
        .run_forked_agent(
            vec![Message::user_text("owned child input")],
            crate::agent::SubagentContextOverrides::default(),
            1,
        )
        .await;
    assert!(result.is_err());
    assert!(requests.lock().unwrap().is_empty());
    let error = result.unwrap_err().to_string();
    assert!(error.contains("native admission rejected"), "{error}");
}

#[derive(Debug)]
struct BoundedFragments;
impl kcoder_api::Provider for BoundedFragments {
    fn name(&self) -> &'static str {
        "owned-256-fragment-fixture"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        Ok(Box::pin(async_stream::stream! {
            yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index: 0, content_block: kcoder_types::ContentBlock::Text { text: String::new() } });
            for index in 0..256 {
                yield Ok(kcoder_types::StreamEvent::ContentBlockDelta { index: 0, delta: kcoder_types::ContentDelta::TextDelta { text: format!("fragment-{index};") } });
            }
            yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}
#[tokio::test]
async fn bounded_256_fragment_stream_reuses_epoch_and_measures_actual_private_accepted_reads() {
    let root = tempfile::tempdir().unwrap();
    let (parent, child, authority) = owned_child(root.path(), ToolRegistry::new(), None);
    *child.provider.write().unwrap() = Arc::new(BoundedFragments);
    child
        .state
        .add_message(Message::user_text("bounded native IO fixture"));
    let started = std::time::Instant::now();
    let frames = child
        .state
        .history_attempt_scope(authority.attempt.clone())
        .unwrap()
        .run(async {
            child
                .run_native_turn_stream_with_max_turns(&kcoder_permissions::AutoDenyPrompt, 1)
                .collect::<Vec<_>>()
                .await
        })
        .await;
    let capture_elapsed = started.elapsed();
    assert!(child.state.current_history_attempt_identity().is_none());
    let fragments = frames
        .iter()
        .filter(|frame| matches!(frame.event(), EngineEvent::AssistantTextDelta(_)))
        .collect::<Vec<_>>();
    assert_eq!(fragments.len(), 256);
    assert!(
        fragments
            .iter()
            .all(|frame| std::ptr::eq(frame.execution(), fragments[0].execution())),
        "each token holds one Arc/epoch, never a history or TI clone"
    );
    let before = authority.reads.load(Ordering::SeqCst);
    let started = std::time::Instant::now();
    for frame in &frames {
        child
            .authorize_native_child_event(&parent, frame)
            .await
            .unwrap();
    }
    let verified_elapsed = started.elapsed();
    let reads = authority.reads.load(Ordering::SeqCst) - before;
    assert_eq!(
        reads,
        frames.len(),
        "the explicit policy fixture loads the real private Accepted on every call"
    );
    authority.enabled.store(false, Ordering::SeqCst);
    assert!(
        child
            .authorize_native_child_event(&parent, fragments[255])
            .await
            .is_err()
    );
    eprintln!(
        "C25_BOUNDED_NATIVE fragments=256 frames={} producer_us={} collector_us={} accepted_file_reads={} ipc_roundtrips=0 policy=explicit-owned-fixture no-root-signer-or-live-platform-claim",
        frames.len(),
        capture_elapsed.as_micros(),
        verified_elapsed.as_micros(),
        reads
    );
}

#[tokio::test]
async fn protected_private_checkpoint_and_safe_boundary_do_not_publish_denied_payloads() {
    let root = tempfile::tempdir().unwrap();
    let (_, child, _) = owned_child(root.path(), ToolRegistry::new(), None);
    let child = child.with_private_native_child_checkpoints();
    let control = child.subagent_runtime_control.as_ref().as_ref().unwrap();
    let messages = vec![Message::assistant_text("DENIED_NATIVE_PAYLOAD_SENTINEL")];
    control
        .checkpoint_writer
        .write(&control.transcript_path, &messages)
        .await
        .unwrap();
    child.state.set_messages(messages);
    assert!(
        control.transcript_path.is_file(),
        "original private recovery remains durable"
    );
    assert!(
        !control
            .transcript_path
            .with_extension("public.txt")
            .exists()
    );
    child.prepare_subagent_safe_boundary().unwrap();
    assert!(
        !control
            .transcript_path
            .with_extension("public.txt")
            .exists(),
        "a producer safe boundary cannot bypass the collector's native event gate"
    );
}

#[derive(Debug)]
struct OwnedWriteProvider {
    path: String,
}
impl kcoder_api::Provider for OwnedWriteProvider {
    fn name(&self) -> &'static str {
        "owned-native-write-fixture"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let path = self.path.clone();
        Ok(Box::pin(async_stream::stream! {
            yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index: 0, content_block: kcoder_types::ContentBlock::ToolUse { id: "owned-write-call".into(), name: "write".into(), input: serde_json::json!({"file_path":path,"content":"actual-effect-recorded-once"}) } });
            yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}
#[tokio::test]
async fn visible_tool_then_revoked_result_keeps_real_private_effect_and_terminal_without_success_payload()
 {
    let root = tempfile::tempdir().unwrap();
    let registry = kcoder_tools::default_registry().filtered_to_names(&["write".into()]);
    let (parent, child, authority) = owned_child(root.path(), registry, None);
    authority.allow_owned_write.store(true, Ordering::SeqCst);
    let path = root.path().join("actual-owned-write.txt");
    *child.provider.write().unwrap() = Arc::new(OwnedWriteProvider {
        path: path.to_string_lossy().into_owned(),
    });
    child
        .state
        .add_message(Message::user_text("write the isolated fixture file once"));
    let mut task = parent.state.task("owned-child").unwrap();
    task.parent_session_id = Some(parent.session_id());
    let run_id = task.background_run.as_ref().unwrap().run_id.clone();
    parent.state.upsert_task(task);
    let mut writer = parent.background_jobs.live_views.register_with_run(
        "owned-child",
        child.state.messages(),
        run_id.clone(),
    );
    let mut subscription = parent
        .subscribe_subagent_conversation("owned-child")
        .unwrap();
    let mut stream =
        child.run_native_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1);
    let mut visible_started = false;
    let mut actual_results = 0;
    let mut rejected = false;
    loop {
        // Poll the one actual producer inside the original persisted Accepted
        // scope, then collect outside it. No synthetic child TI or replay is used.
        let frame = child
            .state
            .history_attempt_scope(authority.attempt.clone())
            .unwrap()
            .run(stream.next())
            .await;
        let Some(frame) = frame else { break };
        assert!(child.state.current_history_attempt_identity().is_none());
        if matches!(frame.event(), EngineEvent::ToolResult { .. }) {
            actual_results += 1;
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                "actual-effect-recorded-once"
            );
            authority.enabled.store(false, Ordering::SeqCst);
        }
        if rejected {
            continue;
        }
        if child
            .authorize_native_child_event(&parent, &frame)
            .await
            .is_err()
        {
            rejected = true;
            child.cancel_token().cancel();
            continue;
        }
        visible_started |= matches!(frame.event(), EngineEvent::ToolUseStarted { .. });
        writer.update(frame.event(), || child.state.messages());
    }
    assert!(visible_started && rejected);
    assert_eq!(
        actual_results, 1,
        "the actual result is drained once without retrying the write"
    );
    assert!(child.state.messages().iter().any(|message| matches!(message, Message::User { content, .. } if content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::ToolResult { tool_use_id, is_error, .. } if tool_use_id == "owned-write-call" && *is_error != Some(true))))), "original authoritative private success remains, rather than inventing nonexecution");
    writer.finish_native_denial("failed");
    let mut public_results = 0;
    let mut terminal = false;
    while let Ok(frame) = subscription.receiver.try_recv() {
        match frame.delta {
            crate::agent_conversation_stream::AgentConversationDelta::Event(
                EngineEvent::ToolResult { .. },
            ) => public_results += 1,
            crate::agent_conversation_stream::AgentConversationDelta::Finished { status } => {
                assert_eq!(status, "failed");
                terminal = true;
            }
            _ => {}
        }
    }
    assert_eq!(public_results, 0);
    assert!(
        terminal,
        "the original native writer settles the visible run"
    );
    let snapshot = subscription.resynchronize();
    assert!(!snapshot.active && snapshot.status == "failed");
    assert!(snapshot.pending_events.is_empty());
    assert!(snapshot.entries.iter().any(|entry| matches!(&entry.message, Message::Assistant { content, .. } if content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::ToolUse { id, .. } if id == "owned-write-call")))));
    assert!(!snapshot.entries.iter().any(|entry| matches!(&entry.message, Message::User { content, .. } if content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::ToolResult { .. })))));
    assert_eq!(snapshot.run_id, run_id);
}
