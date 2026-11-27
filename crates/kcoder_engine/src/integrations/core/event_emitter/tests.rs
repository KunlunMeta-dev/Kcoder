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
    accept_output_batches: AtomicBool,
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
    fn accepts_model_output_batch(&self) -> bool {
        self.accept_output_batches.load(Ordering::SeqCst)
    }
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
        accept_output_batches: AtomicBool::new(false),
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
struct BoundedFragments {
    running_usage: bool,
}
impl kcoder_api::Provider for BoundedFragments {
    fn name(&self) -> &'static str {
        "owned-256-fragment-fixture"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let running_usage = self.running_usage;
        Ok(Box::pin(async_stream::stream! {
            let usage = |output_tokens| kcoder_types::StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Some(kcoder_types::Usage { input_tokens: 19, output_tokens, total_tokens: None, cache_creation_input_tokens: None, cache_read_input_tokens: None, iterations: None }),
                },
            };
            if running_usage {
                yield Ok(kcoder_types::StreamEvent::MessageStart {
                    message: kcoder_types::StreamingMessage {
                        id: "first-fragment".into(), role: "assistant".into(), content: Vec::new(),
                        model: "owned".into(), stop_reason: None, stop_sequence: None, usage: None,
                    },
                });
                yield Ok(usage(1));
            }
            yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index: 0, content_block: kcoder_types::ContentBlock::Text { text: String::new() } });
            for index in 0..256 {
                if running_usage && index > 0 {
                    yield Ok(usage(index + 1));
                }
                yield Ok(kcoder_types::StreamEvent::ContentBlockDelta { index: 0, delta: kcoder_types::ContentDelta::TextDelta { text: format!("fragment-{index};") } });
            }
            yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}

#[tokio::test]
async fn opted_in_child_authorizes_already_received_batches_and_publishes_each_original_fragment() {
    check_opted_in_fragments(false).await;
}

#[tokio::test]
async fn cumulative_usage_between_every_child_fragment_is_charged_once_without_breaking_output_batches()
 {
    check_opted_in_fragments(true).await;
}

async fn check_opted_in_fragments(running_usage: bool) {
    let root = tempfile::tempdir().unwrap();
    let (parent, child, authority) = owned_child(root.path(), ToolRegistry::new(), None);
    let diagnostics = root.path().join("owned-exchange");
    if running_usage {
        std::fs::create_dir(&diagnostics).unwrap();
        child
            .state
            .with_llm_request_history_dir(&diagnostics, child.session_id());
    }
    authority
        .accept_output_batches
        .store(true, Ordering::SeqCst);
    *child.provider.write().unwrap() = Arc::new(BoundedFragments { running_usage });
    child
        .state
        .add_message(Message::user_text("bounded child output fixture"));
    let frames = child
        .state
        .history_attempt_scope(authority.attempt.clone())
        .unwrap()
        .run(async {
            child
                .run_native_turn_stream_with_subagent_finish_reminders(
                    &kcoder_permissions::AutoDenyPrompt,
                    1,
                    "owned-child",
                )
                .collect::<Vec<_>>()
                .await
        })
        .await;
    let output = frames
        .iter()
        .filter(|frame| matches!(frame.event(), EngineEvent::AssistantTextDelta(_)))
        .collect::<Vec<_>>();
    let before = authority.reads.load(Ordering::SeqCst);
    let mut published = Vec::new();
    let mut starts = frames
        .iter()
        .filter(|frame| matches!(frame.event(), EngineEvent::AssistantMessageStarted))
        .count();
    assert!(
        output
            .first()
            .is_some_and(|frame| frame.starts_assistant_message()),
    );
    for frame in &output {
        child
            .authorize_native_child_event(&parent, frame)
            .await
            .unwrap();
        frame.for_each_output(|event| {
            if matches!(event, EngineEvent::AssistantMessageStarted) {
                assert!(published.is_empty());
                starts += 1;
                return;
            }
            let EngineEvent::AssistantTextDelta(text) = event else {
                panic!("expected text fragment")
            };
            published.push(text.clone());
        });
    }
    let expected = (0..256)
        .map(|index| format!("fragment-{index};"))
        .collect::<Vec<_>>();
    assert_eq!(published, expected);
    assert_eq!(starts, 1);
    let reads = authority.reads.load(Ordering::SeqCst) - before;
    assert_eq!(reads, output.len());
    let max_reads = if running_usage { 32 } else { 16 };
    assert!(
        (2..=max_reads).contains(&reads),
        "256 fragments took {reads} full checks"
    );
    if running_usage {
        let charged = child.cumulative_usage();
        assert_eq!((charged.input_tokens, charged.output_tokens), (19, 256));
        assert!(
            child
                .state
                .flush_diagnostics_until(
                    std::time::Instant::now() + std::time::Duration::from_secs(3)
                )
                .await
        );
        let events = std::fs::read_dir(&diagnostics)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .find_map(|entry| {
                let record: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok()?;
                record["response"]["events"].as_array().cloned()
            })
            .expect("the model diagnostic captures the raw provider events");
        let captured = events
            .iter()
            .filter(|event| {
                matches!(
                    event["type"].as_str(),
                    Some("message_delta" | "content_block_delta")
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(captured.len(), 512);
        for (index, pair) in captured.chunks_exact(2).enumerate() {
            assert_eq!(pair[0]["delta"]["usage"]["output_tokens"], index + 1);
            assert_eq!(pair[1]["delta"]["text"], format!("fragment-{index};"));
        }
    }
    authority.enabled.store(false, Ordering::SeqCst);
    assert!(
        child
            .authorize_native_child_event(&parent, output[0])
            .await
            .is_err()
    );
}
#[tokio::test]
async fn bounded_256_fragment_stream_reuses_epoch_and_measures_actual_private_accepted_reads() {
    let root = tempfile::tempdir().unwrap();
    let (parent, child, authority) = owned_child(root.path(), ToolRegistry::new(), None);
    *child.provider.write().unwrap() = Arc::new(BoundedFragments {
        running_usage: false,
    });
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

#[derive(Debug)]
struct MissingToolThenRecovery {
    calls: AtomicUsize,
    requests: Mutex<Vec<kcoder_types::MessagesRequest>>,
}
impl kcoder_api::Provider for MissingToolThenRecovery {
    fn name(&self) -> &'static str {
        "owned-missing-tool-fixture"
    }
    fn stream_messages(
        &self,
        request: kcoder_types::MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Box::pin(async_stream::stream! {
            if call == 0 {
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index: 0, content_block: kcoder_types::ContentBlock::Text { text: "PREFIX_FROM_OWNED_CHILD".into() } });
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index: 1, content_block: kcoder_types::ContentBlock::ToolUse { id: "unknown-owned-call".into(), name: "not_registered_fixture".into(), input: serde_json::json!({"input":"untrusted-unknown-payload"}) } });
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 1 });
            } else {
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index: 0, content_block: kcoder_types::ContentBlock::Text { text: "RECOVERED_AFTER_UNKNOWN_TOOL".into() } });
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            }
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}

struct LiveForkAuthority {
    parent: AppState,
    enabled: AtomicBool,
    child: Mutex<Option<(AppState, TurnAttemptIdentity, Arc<TurnAttemptStore>)>>,
}
impl LiveForkAuthority {
    fn check(
        &self,
        witness: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(NativeToolAuthorizationError::Denied);
        }
        let lock = self
            .child
            .lock()
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?;
        let (state, identity, store) = lock
            .as_ref()
            .ok_or(NativeToolAuthorizationError::Unavailable)?;
        if !witness.matches_state(state)
            || witness.attempt() != Some(identity)
            || !witness
                .parent()
                .is_some_and(|parent| parent.matches_state(&self.parent))
        {
            return Err(NativeToolAuthorizationError::Denied);
        }
        if !store
            .load(identity)
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?
            .is_some_and(|record| {
                record.status == TurnAttemptStatus::Accepted && record.completion.is_none()
            })
        {
            return Err(NativeToolAuthorizationError::Unavailable);
        }
        Ok(())
    }
}
#[async_trait::async_trait]
impl NativeToolAuthorization for LiveForkAuthority {
    async fn authorize_child(
        &self,
        req: &crate::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        if !self.enabled.load(Ordering::SeqCst)
            || !req.parent_execution().matches_state(&self.parent)
            || req.parent_execution().attempt().is_none()
        {
            return Err(NativeToolAuthorizationError::Denied);
        }
        Ok(())
    }
    async fn observe_child_accepted(
        &self,
        req: &crate::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        let identity = req.identity().clone();
        let store = Arc::new(
            TurnAttemptStore::open(
                &req.child().session_storage_dir_for(&identity.thread_id),
                &identity.thread_id,
            )
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?,
        );
        if !store
            .load(&identity)
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?
            .is_some_and(|r| r.status == TurnAttemptStatus::Accepted && r.completion.is_none())
        {
            return Err(NativeToolAuthorizationError::Unavailable);
        }
        *self.child.lock().unwrap() = Some((req.child().state.clone(), identity, store));
        Ok(())
    }
    async fn authorize_provider(
        &self,
        witness: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.check(witness)
    }
    async fn authorize_event(
        &self,
        frame: &NativeEngineEventFrame,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.check(frame.execution())
    }
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Denied)
    }
}

#[tokio::test]
async fn actual_protected_child_unknown_tool_recovers_without_exposing_rejected_arguments() {
    use kcoder_tools::{AgentKind, AgentRunOptions, AgentRunner, SubagentContextMode};
    let root = tempfile::tempdir().unwrap();
    let provider = Arc::new(MissingToolThenRecovery {
        calls: AtomicUsize::new(0),
        requests: Mutex::new(Vec::new()),
    });
    let parent = TestEngineBuilder::new(root.path())
        .provider(provider.clone())
        .tool_registry(ToolRegistry::new().register(kcoder_tools::FileReadTool))
        .build_with_profile_directory();
    parent
        .state
        .with_history_path(root.path().join("parent.jsonl"));
    let authority = Arc::new(LiveForkAuthority {
        parent: parent.state.clone(),
        enabled: AtomicBool::new(true),
        child: Mutex::new(None),
    });
    let parent = parent.with_native_tool_authorization(authority.clone());
    *parent.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: vec![],
            snapshot_provider: parent.provider_name(),
            snapshot_model: parent.model_name(),
            context_history_anchor: None,
            full_context_compatible: true,
        }
        .into(),
    );
    let attempt = TurnAttemptIdentity {
        thread_id: parent.session_id(),
        turn_id: "parent-turn".into(),
        attempt_id: "parent-attempt".into(),
    };
    let store = TurnAttemptStore::open(
        &parent.session_storage_dir_for(&attempt.thread_id),
        &attempt.thread_id,
    )
    .unwrap();
    store
        .begin(TurnAttemptRecord {
            client_presentation: None,
            version: 1,
            identity: attempt.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "b".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })
        .unwrap();
    let result = parent
        .state
        .history_attempt_scope(attempt)
        .unwrap()
        .run(async {
            let runner = crate::agent::QueryEngineAgentRunner::new(parent.clone());
            let options = AgentRunOptions {
                context_mode: SubagentContextMode::None,
                ..AgentRunOptions::default()
            };
            runner
                .run_agent_session_with_options(
                    "owned-unknown-fixture".into(),
                    "do the harmless task".into(),
                    3,
                    AgentKind::General,
                    options,
                )
                .await
        })
        .await;
    let output =
        result.expect("an unavailable model call must not revoke the real child authority");
    assert!(output.contains("RECOVERED_AFTER_UNKNOWN_TOOL"));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let task = parent.state.task("owned-unknown-fixture").unwrap();
    assert_eq!(task.status, kcoder_state::TaskStatus::Completed);
    let binding = authority.child.lock().unwrap();
    let (state, id, store) = binding.as_ref().expect("real child attempt was accepted");
    assert_eq!(
        store.load(id).unwrap().unwrap().status,
        TurnAttemptStatus::Completed
    );
    let messages = state.messages();
    assert!(
        !serde_json::to_string(&messages)
            .unwrap()
            .contains("untrusted-unknown-payload")
    );
    assert!(!messages.iter().any(
        |message| matches!(message, Message::Assistant { content, .. }
        if content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::ToolUse { .. })))
    ));
    let public = crate::subagent_boundary_runtime::public_subagent_transcript(&messages).unwrap();
    assert!(!String::from_utf8_lossy(&public).contains("untrusted-unknown-payload"));
    let transcript = task.transcript_path.unwrap_or_else(|| {
        parent
            .state
            .subagent_transcript_path("owned-unknown-fixture")
    });
    let persisted = std::fs::read_to_string(&transcript).unwrap();
    assert!(!persisted.contains("untrusted-unknown-payload"));
    let public = std::fs::read_to_string(transcript.with_extension("public.txt")).unwrap();
    assert!(!public.contains("untrusted-unknown-payload"));
    let requests = provider.requests.lock().unwrap();
    assert!(
        !serde_json::to_string(&requests[1])
            .unwrap()
            .contains("untrusted-unknown-payload")
    );
    assert!(
        serde_json::to_string(&requests[1])
            .unwrap()
            .contains("arguments were discarded")
    );
    let mut conversation = parent
        .subscribe_subagent_conversation("owned-unknown-fixture")
        .unwrap();
    let snapshot = conversation.resynchronize();
    for entry in &snapshot.entries {
        assert!(
            !serde_json::to_string(&entry.message)
                .unwrap()
                .contains("untrusted-unknown-payload")
        );
    }
}

#[tokio::test]
async fn registered_tool_without_request_registry_witness_stays_denied() {
    let root = tempfile::tempdir().unwrap();
    let registry = ToolRegistry::new().register(kcoder_tools::FileReadTool);
    let (parent, child, authority) = owned_child(root.path(), registry, None);
    let frame = child
        .state
        .history_attempt_scope(authority.attempt.clone())
        .unwrap()
        .run(async {
            child.native_event_frame(
                EngineEvent::ToolUseStarted {
                    id: "known-without-witness".into(),
                    name: "read".into(),
                    input: serde_json::json!({"file_path":"private-sentinel"}),
                },
                None,
            )
        })
        .await;
    assert!(frame.has_tool_identity());
    assert!(frame.tool().is_none());
    assert!(
        child
            .authorize_native_child_event(&parent, &frame)
            .await
            .is_err()
    );
    assert_eq!(
        authority.events.load(Ordering::SeqCst),
        0,
        "the missing witness is rejected before policy"
    );
}

#[tokio::test]
async fn skipping_denied_tool_frame_alone_would_leak_through_live_and_recovery_projection() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owned-child.json");
    let secret = "UNWITNESSED_ARGUMENT_MUST_NOT_BE_PUBLIC";
    let messages = vec![Message::Assistant {
        content: vec![kcoder_types::ContentBlock::ToolUse {
            id: "unknown-owned-call".into(),
            name: "not_registered_fixture".into(),
            input: serde_json::json!({"private":"UNWITNESSED_ARGUMENT_MUST_NOT_BE_PUBLIC"}),
        }],
        usage: None,
    }];
    let live = crate::agent_live_view::AgentLiveViews::default();
    let writer = live.register("owned-agent", Vec::new());
    writer.update(&EngineEvent::AssistantMessageDone, || messages.clone());
    let snapshot = live.snapshot("owned-agent", None).unwrap();
    assert!(
        format!("{:?}", snapshot.messages).contains(secret),
        "a skipped frame alone leaves raw input in the live snapshot"
    );
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    use std::io::Write;
    options
        .open(&path)
        .unwrap()
        .write_all(&serde_json::to_vec(&messages).unwrap())
        .unwrap();
    crate::subagent_projection::materialize(&path).unwrap();
    let public = std::fs::read_to_string(path.with_extension("public.txt")).unwrap();
    assert!(
        public.contains(secret),
        "a later regeneration from a private checkpoint leaks raw input"
    );
}

#[derive(Debug)]
struct UnknownWritePreviewProvider;
impl kcoder_api::Provider for UnknownWritePreviewProvider {
    fn name(&self) -> &'static str {
        "unknown-write-preview-fixture"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        Ok(Box::pin(async_stream::stream! {
            yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index: 0,
                content_block: kcoder_types::ContentBlock::ToolUse { id: "unknown-write-id".into(), name: "write".into(), input: serde_json::json!({}) } });
            yield Ok(kcoder_types::StreamEvent::ContentBlockDelta { index: 0,
                delta: kcoder_types::ContentDelta::InputJsonDelta { partial_json: r#"{"file_path":"unwitnessed-secret-path.txt","content":"test"}"#.into() } });
            yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}

#[tokio::test]
async fn unregistered_write_is_rejected_before_progress_preview_and_history() {
    let root = tempfile::tempdir().unwrap();
    let registry = ToolRegistry::new().register(kcoder_tools::FileReadTool);
    let (parent, child, authority) = owned_child(root.path(), registry, None);
    let child = child.with_tool_path_previews(true);
    *child.provider.write().unwrap() = Arc::new(UnknownWritePreviewProvider);
    child
        .state
        .add_message(Message::user_text("owned private fixture"));
    let mut stream =
        child.run_native_turn_stream_with_max_turns(&kcoder_permissions::AutoDenyPrompt, 1);
    let mut rejection = false;
    loop {
        let Some(frame) = child
            .state
            .history_attempt_scope(authority.attempt.clone())
            .unwrap()
            .run(stream.next())
            .await
        else {
            break;
        };
        child
            .authorize_native_child_event(&parent, &frame)
            .await
            .unwrap();
        assert!(!matches!(
            frame.event(),
            EngineEvent::ToolInputProgress { .. }
                | EngineEvent::ToolPathPreview { .. }
                | EngineEvent::ToolInputPreview { .. }
                | EngineEvent::ToolUseStarted { .. }
                | EngineEvent::ToolResult { .. }
        ));
        rejection |= matches!(frame.event(), EngineEvent::SystemNotice(text) if text.contains("rejected before execution"));
    }
    assert!(rejection);
    let serialized = serde_json::to_string(&child.state.messages()).unwrap();
    assert!(!serialized.contains("unwitnessed-secret-path"));
    assert!(!serialized.contains("unknown-write-id"));
    let public =
        crate::subagent_boundary_runtime::public_subagent_transcript(&child.state.messages())
            .unwrap();
    assert!(!String::from_utf8_lossy(&public).contains("unwitnessed-secret-path"));
}

struct RepeatedUnavailableTool {
    calls: AtomicUsize,
    mixed: bool,
}
impl kcoder_api::Provider for RepeatedUnavailableTool {
    fn name(&self) -> &'static str {
        "owned-repeated-unavailable-tool"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let mixed = self.mixed;
        Ok(Box::pin(async_stream::stream! {
            yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index: 0,
                content_block: kcoder_types::ContentBlock::ToolUse { id: format!("rejected-{call}"), name: "not_registered_fixture".into(), input: serde_json::json!({"secret":"rejected-initial-body"}) } });
            // Neither malformed JSON nor a forged text delta may escape the rejected slot.
            yield Ok(kcoder_types::StreamEvent::ContentBlockDelta { index: 0,
                delta: kcoder_types::ContentDelta::InputJsonDelta { partial_json: "{malformed-rejected-body".into() } });
            yield Ok(kcoder_types::StreamEvent::ContentBlockDelta { index: 0,
                delta: kcoder_types::ContentDelta::TextDelta { text: "rejected-slot-text-delta".into() } });
            yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            if mixed {
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index: 1,
                    content_block: kcoder_types::ContentBlock::ToolUse { id: format!("known-{call}"), name: "read".into(), input: serde_json::json!({"file_path":"owned-not-read.txt"}) } });
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 1 });
            }
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}

#[tokio::test]
async fn unavailable_tool_recovery_is_bounded_and_keeps_mixed_tool_pairs_complete() {
    for mixed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let registry = ToolRegistry::new().register(kcoder_tools::FileReadTool);
        let (parent, child, authority) = owned_child(root.path(), registry, None);
        let provider = Arc::new(RepeatedUnavailableTool {
            calls: AtomicUsize::new(0),
            mixed,
        });
        *child.provider.write().unwrap() = provider.clone();
        child
            .state
            .add_message(Message::user_text("owned fixture request"));
        let frames = child
            .state
            .history_attempt_scope(authority.attempt.clone())
            .unwrap()
            .run(async {
                child
                    .run_native_turn_stream_with_max_turns(&kcoder_permissions::AutoDenyPrompt, 5)
                    .collect::<Vec<_>>()
                    .await
            })
            .await;
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            2,
            "one recovery request only"
        );
        assert!(frames.iter().any(|frame| matches!(frame.event(), EngineEvent::Error(code) if code == "UNAVAILABLE_TOOL_RECOVERY_EXHAUSTED")));
        for frame in &frames {
            child
                .authorize_native_child_event(&parent, frame)
                .await
                .unwrap();
            assert!(
                !matches!(frame.event(), EngineEvent::ToolInputProgress { name, .. } | EngineEvent::ToolUseStarted { name, .. } | EngineEvent::ToolResult { name, .. } if name == "not_registered_fixture")
            );
            assert!(
                !matches!(frame.event(), EngineEvent::AssistantTextDelta(text) if text.contains("rejected-slot-text-delta"))
            );
        }
        let messages = child.state.messages();
        let encoded = serde_json::to_string(&messages).unwrap();
        for discarded in [
            "rejected-initial-body",
            "malformed-rejected-body",
            "rejected-slot-text-delta",
        ] {
            assert!(!encoded.contains(discarded));
        }
        if mixed {
            for call in 0..2 {
                let id = format!("known-{call}");
                assert!(messages.iter().any(|message| matches!(message, Message::Assistant { content, .. } if content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::ToolUse { id: current, .. } if current == &id)))));
                assert!(messages.iter().any(|message| matches!(message, Message::User { content, .. } if content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == &id)))));
            }
        }
    }
}

#[tokio::test]
async fn cancelling_after_rejection_does_not_start_a_recovery_request() {
    let root = tempfile::tempdir().unwrap();
    let (parent, child, authority) = owned_child(root.path(), ToolRegistry::new(), None);
    let provider = Arc::new(RepeatedUnavailableTool {
        calls: AtomicUsize::new(0),
        mixed: false,
    });
    *child.provider.write().unwrap() = provider.clone();
    child
        .state
        .add_message(Message::user_text("owned cancellable fixture"));
    let mut stream =
        child.run_native_turn_stream_with_max_turns(&kcoder_permissions::AutoDenyPrompt, 5);
    let mut cancelled = false;
    let mut settled = false;
    loop {
        let Some(frame) = child
            .state
            .history_attempt_scope(authority.attempt.clone())
            .unwrap()
            .run(stream.next())
            .await
        else {
            break;
        };
        child
            .authorize_native_child_event(&parent, &frame)
            .await
            .unwrap();
        if matches!(frame.event(), EngineEvent::SystemNotice(text) if text.contains("rejected before execution"))
        {
            cancelled = true;
            child.cancel_token().cancel();
        }
        settled |= matches!(frame.event(), EngineEvent::StreamAborted { reason } if reason == "cancelled by user");
    }
    assert!(cancelled && settled);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(
        !serde_json::to_string(&child.state.messages())
            .unwrap()
            .contains("rejected-initial-body")
    );
}
