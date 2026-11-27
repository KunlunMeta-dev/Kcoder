//! Original history/factory/lease acceptance in an explicitly owned child.
use super::*;
use crate::app_server::ct85_test_support as owned;
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_cli_storage::session_lease::SessionLease;
use kcoder_config::{ConfigPaths, PrivateDirectory, Settings};
use kcoder_engine::{QueryEngine, WorkspaceRuntimeServices};
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_tools::{DenyAllUserQuestioner, ToolContext, ToolRegistry};
use kcoder_types::{
    ContentBlock, Message, MessagesRequest, StreamEvent, cross_session_messages::*,
};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
mod handoff_reason;

#[test]
fn an_actual_failed_cold_restore_explains_its_original_queued_wake() {
    owned::run_owned_case(
        concat!(module_path!(), "::owned_handoff_reason_case"),
        "cold-handoff-reason",
    );
}
#[tokio::test]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_handoff_reason_case() -> Result<()> {
    handoff_reason::run().await
}
use std::{ffi::OsStr, path::Path};
mod enrolled_transport;
mod pre_admission;

struct SourceTurnScript {
    destination: SessionAddressV1,
    calls: AtomicUsize,
    original_cid: Mutex<Option<String>>,
    original_message_id: Mutex<Option<String>>,
    waiting: AtomicBool,
    release: tokio::sync::Notify,
}
struct RecordedModel(
    Arc<Mutex<Vec<MessagesRequest>>>,
    Arc<Mutex<Option<Arc<SourceTurnScript>>>>,
    TargetToolScript,
);
/// One original target tool call before the target answer; never replayed.
type TargetToolScript = Arc<Mutex<Option<(String, Value)>>>;
/// Holds the original target's first dispatched response until a test event.
#[derive(Default)]
struct TargetPause {
    waiting: AtomicBool,
    release: tokio::sync::Notify,
}
static TARGET_PAUSE: Mutex<Option<Arc<TargetPause>>> = Mutex::new(None);
const TARGET_TOOL_USE_ID: &str = "owned-target-continuation-tool";
fn recorded_response(block: ContentBlock) -> ProviderStream {
    let stop = if matches!(&block, ContentBlock::ToolUse { .. }) {
        "tool_use"
    } else {
        "end_turn"
    };
    Box::pin(futures::stream::iter([
        Ok(StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "owned-cold-response".into(),
                role: "assistant".into(),
                model: "owned-model".into(),
                content: Vec::new(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        }),
        Ok(StreamEvent::ContentBlockStart {
            index: 0,
            content_block: block,
        }),
        Ok(StreamEvent::ContentBlockStop { index: 0 }),
        Ok(StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: Some(stop.into()),
                stop_sequence: None,
                usage: None,
            },
        }),
        Ok(StreamEvent::MessageStop),
    ]))
}
fn original_source_receipt(request: &MessagesRequest) -> AgentMessageReceipt {
    request
        .messages
        .iter()
        .rev()
        .flat_map(message_content)
        .find_map(|block| {
            let ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } = block
            else {
                return None;
            };
            if tool_use_id != "owned-source-native-send" {
                return None;
            }
            content.iter().find_map(|block| {
                let ContentBlock::Text { text } = block else {
                    return None;
                };
                serde_json::from_str(text).ok()
            })
        })
        .expect("the actual original Source tool must return its original receipt")
}
fn message_content(message: &Message) -> &[ContentBlock] {
    match message {
        Message::User { content, .. } | Message::Assistant { content, .. } => content,
    }
}
impl Provider for RecordedModel {
    fn name(&self) -> &'static str {
        "owned-cold-target-recorded-model"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<ProviderStream, ApiErrorKind> {
        let source = request.messages.iter().flat_map(message_content).any(|block| {
            matches!(block, ContentBlock::Text { text } if text == "Original Source authorizes this owned contribution")
        });
        let script = self.1.lock().unwrap().clone().filter(|_| source);
        let source_receipt = script
            .as_ref()
            .filter(|script| script.calls.load(Ordering::Acquire) == 1)
            .map(|_| original_source_receipt(&request));
        let woken = request.messages.iter().flat_map(message_content).any(|block| {
            matches!(block, ContentBlock::Text { text } if text.contains("Original cold contribution"))
        });
        let continued = request.messages.iter().flat_map(message_content).any(|block| {
            matches!(block, ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == TARGET_TOOL_USE_ID)
        });
        self.0.lock().unwrap().push(request);
        if let Some(script) = script {
            let number = script.calls.fetch_add(1, Ordering::AcqRel);
            let block = match number {
                0 => ContentBlock::ToolUse {
                    id: "owned-source-native-send".into(),
                    name: "SendSessionMessage".into(),
                    input: json!({"targetThreadId":script.destination.thread_id.clone(),
                        "targetAddress":script.destination.clone(),"mode":"wake_if_idle",
                        "text":"Owned cold contribution from the real Source stream"}),
                },
                1 => {
                    let receipt = source_receipt.expect("real Source send receipt");
                    *script.original_cid.lock().unwrap() = Some(receipt.client_message_id.clone());
                    *script.original_message_id.lock().unwrap() = Some(receipt.message_id);
                    ContentBlock::ToolUse {
                        id: "owned-source-native-get".into(),
                        name: "GetSessionMessageReceipt".into(),
                        input: json!({"clientMessageId":receipt.client_message_id}),
                    }
                }
                2 => {
                    script.waiting.store(true, Ordering::Release);
                    return Ok(Box::pin(
                        futures::stream::once(async move {
                            script.release.notified().await;
                            recorded_response(ContentBlock::Text {
                                text: "Owned Source stream finished".into(),
                            })
                        })
                        .flatten(),
                    ));
                }
                _ => panic!("the original Source provider request must not replay"),
            };
            return Ok(recorded_response(block));
        }
        if woken
            && !continued
            && let Some((name, input)) = self.2.lock().unwrap().clone()
        {
            let block = ContentBlock::ToolUse {
                id: TARGET_TOOL_USE_ID.into(),
                name,
                input,
            };
            if let Some(pause) = TARGET_PAUSE.lock().unwrap().take() {
                pause.waiting.store(true, Ordering::Release);
                return Ok(Box::pin(
                    futures::stream::once(async move {
                        pause.release.notified().await;
                        recorded_response(block)
                    })
                    .flatten(),
                ));
            }
            return Ok(recorded_response(block));
        }
        Ok(recorded_response(ContentBlock::Text {
            text: "Owned original target answer".into(),
        }))
    }
}

struct Fixture {
    _workspace: Option<tempfile::TempDir>,
    service: Arc<PeerMessageService>,
    factory: AppServerEngineFactory,
    original_factory: AppServerEngineFactory,
    source: QueryEngine,
    source_endpoint: Option<crate::peer_sessions::PeerSourceEndpoint>,
    source_lease: Option<SessionLease>,
    interactive: Option<crate::peer_sessions::InteractivePeerRuntime>,
    target: String,
    target_history: PathBuf,
    original_artifacts: PathBuf,
    bootstrap_artifacts: PathBuf,
    calls: Arc<Mutex<Vec<MessagesRequest>>>,
    source_script: Arc<Mutex<Option<Arc<SourceTurnScript>>>>,
    target_tool: TargetToolScript,
}
impl Fixture {
    async fn new() -> Result<Self> {
        Self::new_kind(false).await
    }
    async fn new_kind(owned_dispatcher: bool) -> Result<Self> {
        let workspace = owned::owned_tempdir();
        owned::prepare_workspace(workspace.path());
        let profile = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap());
        let paths = ConfigPaths::with_config_dir_and_executable_dir(
            workspace.path(),
            profile.clone(),
            None,
        );
        let mut settings = Settings {
            permission_mode: kcoder_config::PermissionMode::Bypass,
            history_enabled: true,
            ..Settings::default()
        };
        settings.tools.disabled.clear();
        settings.tools.profile = kcoder_config::ToolProfile::Full;
        settings.session_memory.enabled = false;
        settings.session_memory.compact_enabled = false;
        settings.cross_session_messages.enabled = true;
        settings.cross_session_messages.wake_idle = true;
        settings.providers.insert("owned-model".into(), serde_json::from_value(json!({
            "api_format":"openai_chat_completions", "endpoint":"http://127.0.0.1:1/v1", "authentication":{"mode":"none"},
            "default_model":"owned-model", "context_window_tokens":131072, "output_headroom_tokens":8192,
            "max_output_tokens":2048, "capabilities":{"text":true,"tools":true}, "discover_models":false
        }))?);
        settings.apply_provider(Some("owned-model"))?;
        PrivateDirectory::open_existing(&profile)?
            .atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&settings)?)?;
        let history = workspace.path().join("history");
        PrivateDirectory::open_or_create(&history)?;
        let original_artifacts = workspace.path().join(".kcoder/sessions");
        let original = PrivateDirectory::open_or_create(&original_artifacts)?;
        let bootstrap_artifacts = workspace.path().join("bootstrap-client-sessions");
        let bootstrap = PrivateDirectory::open_or_create(&bootstrap_artifacts)?;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let source_script = Arc::new(Mutex::new(None));
        let target_tool: TargetToolScript = Arc::new(Mutex::new(None));
        let provider: Arc<dyn Provider> = Arc::new(RecordedModel(
            calls.clone(),
            source_script.clone(),
            target_tool.clone(),
        ));
        let shared =
            WorkspaceRuntimeServices::try_new_for_client(workspace.path(), "owned-cold-target")?;
        let build = |services| {
            AppServerEngineFactory::new(
                provider.clone(),
                ToolRegistry::new(),
                PermissionEngine::from_settings(&settings),
                settings.clone(),
                MemoryManager::global_only(MemoryStore::empty()),
                SkillRegistry::empty(),
                kcoder_plugins::EffectivePluginSnapshot::default(),
                workspace.path().into(),
                Some(history.clone()),
                true,
                services,
                Some(paths.user_settings.clone()),
                workspace.path().join("session-ids"),
            )
        };
        let original_factory =
            build(shared.with_existing_client_storage(
                &original_artifacts,
                &original.directory_identity()?,
            )?);
        let factory = build(shared.with_existing_client_storage(
            &bootstrap_artifacts,
            &bootstrap.directory_identity()?,
        )?);
        let original_state = kcoder_state::AppState::new(workspace.path());
        let target = original_state.session_id();
        let target_history = history.join(format!("{target}.jsonl"));
        let original_lease = SessionLease::acquire(&target_history)?;
        original_state.with_history_path(&target_history);
        original_state.add_message(Message::user_text("Original target user task"));
        original_state.flush_history().await?;
        let original_engine =
            original_factory.build_with_state(original_state, Arc::new(DenyAllUserQuestioner))?;
        let events = original_engine
            .run_turn_stream(&kcoder_permissions::AutoDenyPrompt)
            .collect::<Vec<_>>()
            .await;
        ensure!(
            !events
                .iter()
                .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_))),
            "original seed failed: {events:?}"
        );
        ensure!(
            calls.lock().unwrap().len() == 1,
            "exactly one real original seed request"
        );
        write_metadata(&original_artifacts, &target, workspace.path(), false)?;
        retire(original_engine, original_lease).await?;
        let service = PeerMessageService::capture(paths.clone(), workspace.path().into(), None)?;
        let state = kcoder_state::AppState::new(workspace.path());
        let source_path = history.join(format!("{}.jsonl", state.session_id()));
        state.with_deferred_history_path(&source_path);
        let mut source = factory.build_with_state(state, Arc::new(DenyAllUserQuestioner))?;
        let (source_lease, source_endpoint, interactive) = if owned_dispatcher {
            let local = crate::peer_sessions::attach_with_factory(
                &mut source,
                paths.clone(),
                Some(factory.clone()),
            )?
            .context("actual original TUI host")?;
            let owner = crate::peer_sessions::InteractivePeerRuntime::capture_with_factory(
                &mut source,
                paths.clone(),
                Some(local),
                None,
                None,
                Some(factory.clone()),
            )?;
            (None, None, Some(owner))
        } else {
            let mut lease = SessionLease::acquire(&source_path)?;
            let bound = crate::peer_sessions::BoundPeerSource::capture(
                &source,
                service.clone(),
                lease.native_witness()?,
            )?;
            crate::peer_sessions::turn_retirement::bind(&mut lease, &source, Some(&bound));
            crate::peer_sessions::install_local_target_hosts(
                &mut source,
                &bound,
                lease.native_witness()?,
            )?;
            let endpoint = crate::peer_sessions::PeerSourceEndpoint::bind(bound)?;
            (Some(lease), Some(endpoint), None)
        };
        source.state.add_message(Message::user_text(
            "Original Source authorizes this owned contribution",
        ));
        source.state.flush_history().await?;
        Ok(Self {
            _workspace: Some(workspace),
            service,
            factory,
            original_factory,
            source,
            source_endpoint,
            source_lease,
            interactive,
            target,
            target_history,
            original_artifacts,
            bootstrap_artifacts,
            calls,
            source_script,
            target_tool,
        })
    }
    async fn send(&self, cid: &str, mode: AgentMessageMode) -> Result<AgentMessageReceipt> {
        let tool = self
            .source
            .active_tool_registry()
            .get("SendSessionMessage")
            .context("actual Source sender")?
            .clone();
        let output = tool.call(json!({"targetThreadId":self.target, "targetAddress":self.service.address(&self.target)?,
            "clientMessageId":cid,"mode":mode,"text":format!("Original cold contribution {cid}")}),
            &ToolContext::new(self.source.state.clone())).await?;
        ensure!(!output.is_error, "Source send failed: {output:?}");
        let text = output
            .content
            .iter()
            .find_map(|block| {
                if let ContentBlock::Text { text } = block {
                    Some(text)
                } else {
                    None
                }
            })
            .context("Source receipt body")?;
        Ok(serde_json::from_str(text)?)
    }
    fn driver(
        &self,
        local: bool,
    ) -> Result<(
        ColdTargetDriver,
        super::super::idle::PeerIdleDriver,
        ThreadManager,
        mpsc::Receiver<Value>,
    )> {
        let (tx, rx) = mpsc::channel(128);
        let sequence = Arc::new(AtomicU64::new(1));
        let cancel = CancellationToken::new();
        let cold = ColdTargetDriver::new(
            self.factory.clone(),
            self.service.clone(),
            self.bootstrap_artifacts.clone(),
            None,
            tx.clone(),
            "owned-cold-native".into(),
            sequence.clone(),
            Arc::new(AtomicU64::new(1)),
            Arc::new(Mutex::new(InteractionReceipts::default())),
            local,
            Some(cancel.child_token()),
        )?;
        let idle =
            super::super::idle::PeerIdleDriver::new(super::super::idle_turn::PeerIdleTurnContext {
                outbound: tx,
                server_id: "owned-cold-native".into(),
                sequence,
                next_turn_id: Arc::new(AtomicU64::new(1)),
                cancel,
                attended: false,
            });
        let mut manager = ThreadManager::with_resident_limit(4);
        manager.configure_peer_services(self.service.clone(), None);
        Ok((cold, idle, manager, rx))
    }
    async fn close(mut self) -> Result<()> {
        if let Some(owner) = self.interactive.take() {
            owner.close().await;
            return Ok(());
        }
        if let Some(endpoint) = self.source_endpoint.take() {
            endpoint.close().await;
        }
        retire(
            self.source,
            self.source_lease.take().context("actual Source lease")?,
        )
        .await
    }
}
async fn retire(engine: QueryEngine, lease: SessionLease) -> Result<()> {
    let writer = engine.state.capture_history_writer_retirement()?;
    writer.request_retirement();
    ensure!(
        writer.wait_for_quiescence().await,
        "original writer did not settle"
    );
    drop(engine);
    drop(lease);
    Ok(())
}
fn write_metadata(root: &Path, thread: &str, workspace: &Path, archived: bool) -> Result<()> {
    use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
    let directory = kcoder_thread_metadata::ensure_thread_metadata_directory(root, thread)?;
    let mut fields = std::collections::BTreeMap::from([(
        "permissionModeAtCreation".into(),
        Some("bypass".into()),
    )]);
    if archived {
        fields.insert("archivedAt".into(), Some("2026-11-13T00:00:00Z".into()));
    }
    let mut journal = JournalFence::try_acquire(root, JournalDomain::ClientMetadata)?;
    kcoder_thread_metadata::write_thread_metadata(
        &directory,
        &kcoder_thread_metadata::ThreadClientMetadata {
            version: 1,
            revision: 1,
            thread_id: thread.into(),
            workspace: workspace.to_string_lossy().into_owned(),
            fields,
            updated_at: "1".into(),
        },
        &mut journal,
    )
}

macro_rules! owned_test {
    ($name:ident, $case:literal) => {
        #[test]
        fn $name() {
            owned::run_owned_case(
                concat!(module_path!(), "::owned_cold_activation_case"),
                $case,
            );
        }
    };
}
owned_test!(
    cold_enqueue_preserves_zero_model_and_normal_original_resume,
    "enqueue"
);
owned_test!(
    cold_wake_uses_original_native_factory_history_artifacts_and_budget,
    "native-wake"
);
owned_test!(
    cold_wake_continues_its_original_turn_after_a_read_only_tool,
    "native-wake-read-tool"
);
owned_test!(
    cold_wake_continues_its_original_turn_after_a_peer_reply_tool,
    "native-wake-reply-tool"
);
owned_test!(
    cold_wake_user_input_during_its_first_response_stops_the_original_continuation,
    "native-wake-paused-steer"
);
owned_test!(
    cold_wake_keeps_its_original_permit_when_another_wake_arrives_mid_turn,
    "native-wake-paused-second-wake"
);
owned_test!(
    cold_wake_keeps_its_original_permit_when_an_enqueue_arrives_mid_turn,
    "native-wake-paused-second-enqueue"
);
owned_test!(
    cold_wake_cannot_displace_a_live_owner_or_bypass_source_revocation,
    "lease-and-source"
);
owned_test!(cold_wake_respects_human_archive_before_restore, "archive");
owned_test!(
    pure_tui_owned_cold_target_uses_the_same_dispatcher_and_releases_original_lease,
    "owned-tui"
);
owned_test!(
    cold_unavailable_owner_yields_to_normal_resume_and_new_queue_stamp,
    "backoff"
);
owned_test!(
    cold_pre_admission_source_rejections_preserve_the_original_native_terminal,
    "pre-admission-source"
);
owned_test!(
    pure_tui_original_resume_applies_enqueue_before_cold_wake,
    "owned-tui-resumed"
);
owned_test!(
    pure_tui_original_resume_and_source_refresh_preserve_cold_wake,
    "owned-tui-refreshed"
);
#[test]
fn pure_tui_cold_wake_completes_while_the_original_source_provider_waits() {
    owned::run_owned_case_with_timeout(
        concat!(module_path!(), "::owned_cold_activation_case"),
        "owned-tui-source-stream",
        Duration::from_secs(90),
    );
}
owned_test!(
    cold_wake_preserves_an_unsettled_original_native_turn,
    "unsettled"
);
owned_test!(
    cold_wake_rejects_an_ambiguous_latest_native_turn,
    "ambiguous"
);
owned_test!(
    cold_wake_does_not_infer_legacy_idle_from_assistant_history,
    "legacy"
);
owned_test!(
    cold_wake_rejects_corrupted_original_attempt_evidence,
    "corrupt"
);
owned_test!(
    cold_wake_rejects_unknown_original_native_outcomes,
    "unknown"
);
owned_test!(
    cold_wake_rejects_unsettled_attempt_after_wallclock_rollback,
    "clock-rollback"
);
owned_test!(
    long_native_history_remains_discoverable_and_cold_wake_safe,
    "long-history"
);
owned_test!(
    cold_v2_missing_pin_cannot_fall_back_to_local_source,
    "v2-missing"
);
owned_test!(
    cold_v2_pending_pin_cannot_fall_back_to_local_source,
    "v2-pending"
);
owned_test!(
    cold_v2_revoked_pin_cannot_fall_back_to_local_source,
    "v2-revoked"
);
owned_test!(
    cold_v2_completed_transport_restores_the_real_original_target,
    "v2-complete"
);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_cold_activation_case() -> Result<()> {
    let case = owned::owned_case();
    if case == "backoff" {
        return owned_backoff_case().await;
    }
    if case == "pre-admission-source" {
        return pre_admission::run().await;
    }
    if matches!(
        case.as_str(),
        "owned-tui" | "owned-tui-resumed" | "owned-tui-refreshed" | "owned-tui-source-stream"
    ) {
        return owned_tui_case(&case).await;
    }
    let mut fixture = Fixture::new().await?;
    let enrolled = if case.starts_with("v2-") {
        Some(enrolled_transport::prepare(&mut fixture, &case)?)
    } else {
        None
    };
    if case == "native-wake" {
        assert!(
            !fixture.service.has_private_parent(),
            "Independent local Source requires no Gateway parent"
        );
        fixture.service.check_selected_cold_transport()?;
    }
    let (mut cold, mut idle, mut manager, mut events) = fixture.driver(false)?;
    if let Some(enrolled) = enrolled.as_ref() {
        enrolled.bind_original_source(&cold)?;
    }
    if case == "long-history" {
        // The original seed plus 256 completed attempts crosses the 256-record status budget.
        add_completed_native_attempts(&fixture, 256)?;
        let listing = fixture
            .source
            .active_tool_registry()
            .get("ListSessions")
            .context("actual discovery")?
            .call(json!({}), &ToolContext::new(fixture.source.state.clone()))
            .await?;
        let text = listing
            .content
            .iter()
            .find_map(|block| {
                if let ContentBlock::Text { text } = block {
                    Some(text)
                } else {
                    None
                }
            })
            .context("actual directory result")?;
        let value: Value = serde_json::from_str(text)?;
        let row = value["targets"]
            .as_array()
            .context("target directory")?
            .iter()
            .find(|row| row["threadId"] == fixture.target)
            .context("long original target remains discoverable")?;
        assert!(row.get("lastTurn").is_none_or(Value::is_null));
        assert_eq!(row["status"], "unknown");
    }
    let before = std::fs::read(&fixture.target_history)?;
    if case == "enqueue" {
        let first = fixture
            .send("cold-enqueue-original", AgentMessageMode::EnqueueOnly)
            .await?;
        for _ in 0..4 {
            cold.next_inventory = Instant::now();
            cold.tick(&mut manager).await;
            tokio::task::yield_now().await;
        }
        assert!(manager.engine(&fixture.target).is_none());
        assert_eq!(fixture.calls.lock().unwrap().len(), 1);
        assert_eq!(std::fs::read(&fixture.target_history)?, before);
        let lease = SessionLease::acquire_existing_history(&fixture.target_history)?;
        let prepared = kcoder_state::prepare_session_resume(&fixture.target_history)?;
        let (mut resumed, _) = fixture
            .original_factory
            .resume_thread(prepared, Arc::new(DenyAllUserQuestioner))?;
        let bound = crate::peer_sessions::BoundPeerSource::capture(
            &resumed,
            fixture.service.clone(),
            lease.native_witness()?,
        )?;
        crate::peer_sessions::install_local_target_hosts(
            &mut resumed,
            &bound,
            lease.native_witness()?,
        )?;
        let endpoint = crate::peer_sessions::PeerSourceEndpoint::bind(bound)?;
        assert_eq!(
            resumed
                .apply_peer_messages_at_idle()
                .await
                .map_err(anyhow::Error::msg)?
                .len(),
            1
        );
        assert_eq!(resumed.client_storage_root(), fixture.original_artifacts);
        assert_eq!(fixture.calls.lock().unwrap().len(), 1);
        let repeated = fixture
            .send("cold-enqueue-original", AgentMessageMode::EnqueueOnly)
            .await?;
        assert_eq!(repeated.message_id, first.message_id);
        assert_eq!(repeated.status, AgentMessageStatus::Applied);
        endpoint.close().await;
        retire(resumed, lease).await?;
    } else {
        let pause = case
            .starts_with("native-wake-paused-")
            .then(|| Arc::new(TargetPause::default()));
        *TARGET_PAUSE.lock().unwrap() = pause.clone();
        let target_tool = match case.as_str() {
            "native-wake-read-tool"
            | "native-wake-paused-steer"
            | "native-wake-paused-second-wake"
            | "native-wake-paused-second-enqueue" => Some(("ListSessions".to_owned(), json!({}))),
            "native-wake-reply-tool" => {
                let source = fixture.source.session_id();
                Some((
                    "SendSessionMessage".to_owned(),
                    json!({"targetThreadId":source,"targetAddress":fixture.service.address(&source)?,
                        "mode":"enqueue_only","text":"Owned target reply from its original wake"}),
                ))
            }
            _ => None,
        };
        // A real user input supersedes the original wake: the dispatched first
        // response is kept, but its automatic continuation fails closed.
        let superseded = case == "native-wake-paused-steer";
        let expected_calls = if superseded {
            2
        } else if target_tool.is_some() {
            3
        } else {
            2
        };
        *fixture.target_tool.lock().unwrap() = target_tool;
        let first = fixture
            .send("cold-wake-original", AgentMessageMode::WakeIfIdle)
            .await
            .context("first original cold Wake admission")?;
        if let Some(enrolled) = enrolled.as_ref() {
            let original_mailbox = fixture.service.mailbox()?;
            if case == "v2-revoked" {
                enrolled.revoke(&fixture)?;
            }
            if case != "v2-complete" {
                assert!(fixture.service.check_selected_cold_transport().is_err());
                assert!(activate(&cold.owner, &fixture.target).await.is_err());
                for _ in 0..4 {
                    cold.next_inventory = Instant::now();
                    cold.tick(&mut manager).await;
                    tokio::task::yield_now().await;
                }
                assert!(manager.engine(&fixture.target).is_none());
                assert_eq!(
                    fixture.calls.lock().unwrap().len(),
                    1,
                    "No Provider before the original V2 transport is current"
                );
                assert_eq!(std::fs::read(&fixture.target_history)?, before);
                assert_eq!(
                    original_mailbox
                        .get_record_by_message_id(&first.message_id)?
                        .context("original queued contribution")?
                        .receipt
                        .status,
                    AgentMessageStatus::Queued
                );
                cold.shutdown(&mut manager).await;
                idle.shutdown().await;
                return fixture.close().await;
            }
            fixture.service.check_selected_cold_transport()?;
        }
        if matches!(
            case.as_str(),
            "unsettled" | "ambiguous" | "legacy" | "corrupt" | "unknown" | "clock-rollback"
        ) {
            original_ledger_negative(&fixture, &case)?;
            assert!(activate(&cold.owner, &fixture.target).await.is_err());
            assert_eq!(fixture.calls.lock().unwrap().len(), 1);
            assert_eq!(std::fs::read(&fixture.target_history)?, before);
            assert_eq!(
                fixture
                    .service
                    .mailbox()?
                    .get_record_by_message_id(&first.message_id)?
                    .context("the original queued contribution remains")?
                    .receipt
                    .status,
                AgentMessageStatus::Queued
            );
            cold.shutdown(&mut manager).await;
            idle.shutdown().await;
            return fixture.close().await;
        }
        let owner = if case == "lease-and-source" {
            Some(SessionLease::acquire_existing_history(
                &fixture.target_history,
            )?)
        } else {
            None
        };
        if case == "archive" {
            write_metadata(
                &fixture.original_artifacts,
                &fixture.target,
                &fixture.source.state.cwd(),
                true,
            )?;
        }
        if case == "lease-and-source" || case == "archive" {
            let error = activate(&cold.owner, &fixture.target)
                .await
                .err()
                .context("unsafe target must not activate")?;
            assert!(!error.to_string().is_empty());
            assert_eq!(fixture.calls.lock().unwrap().len(), 1);
            assert_eq!(std::fs::read(&fixture.target_history)?, before);
        }
        drop(owner);
        if case == "lease-and-source" {
            fixture
                .source
                .settings
                .write()
                .unwrap()
                .tools
                .disabled
                .push("SendSessionMessage".into());
            assert!(activate(&cold.owner, &fixture.target).await.is_err());
            assert_eq!(fixture.calls.lock().unwrap().len(), 1);
            assert_eq!(std::fs::read(&fixture.target_history)?, before);
            fixture
                .source
                .settings
                .write()
                .unwrap()
                .tools
                .disabled
                .retain(|name| name != "SendSessionMessage");
        }
        if case != "archive" {
            let mut observed = Vec::new();
            let mut terminals = Vec::new();
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    cold.next_inventory = Instant::now();
                    cold.tick(&mut manager).await;
                    idle.tick(&manager, Some(&fixture.service));
                    while let Ok(event) = events.try_recv() {
                        if event["method"] == "turn/completed" { terminals.push(event.clone()); }
                        if observed.len() < 16 { observed.push(event); }
                    }
                    if let Some(pause) = pause.as_ref()
                        && pause.waiting.swap(false, Ordering::AcqRel)
                    {
                        match case.as_str() {
                            "native-wake-paused-steer" => manager
                                .engine(&fixture.target)
                                .context("woken target resident")?
                                .state
                                .add_message(Message::user_text("Human input during the original wake")),
                            "native-wake-paused-second-wake" => {
                                fixture.send("cold-wake-second", AgentMessageMode::WakeIfIdle).await?;
                            }
                            _ => {
                                fixture.send("cold-wake-second", AgentMessageMode::EnqueueOnly).await?;
                            }
                        }
                        pause.release.notify_one();
                    }
                    if fixture.calls.lock().unwrap().len() >= expected_calls
                        && !manager.is_turn_running(&fixture.target)
                        && fixture
                            .service
                            .mailbox()?
                            .get_record_by_message_id(&first.message_id)?
                            .is_some_and(|record| {
                                record.receipt.status == AgentMessageStatus::Applied
                            })
                        {
                            break;
                        }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await
            .map_err(|error| {
                let preserved = fixture._workspace.take().map(tempfile::TempDir::keep);
                let resident = manager.engine(&fixture.target);
                anyhow::anyhow!("cold target did not settle: {error}; workspace={preserved:?}; calls={}; resident={}; peer_host={}; running={}; observations={}; restore_errors={:?}; events={observed:?}",
                    fixture.calls.lock().unwrap().len(), resident.is_some(),
                    resident.as_ref().is_some_and(QueryEngine::has_peer_message_host),
                    manager.is_turn_running(&fixture.target), manager.peer_idle_observations().len(), cold.restore_errors)
            })??;
            let restored = manager
                .engine(&fixture.target)
                .context("original target resident")?;
            assert_eq!(restored.client_storage_root(), fixture.original_artifacts);
            assert_ne!(restored.client_storage_root(), fixture.bootstrap_artifacts);
            assert_eq!(
                restored.state.history_path().as_ref(),
                Some(&fixture.target_history)
            );
            assert_eq!(restored.session_id(), fixture.target);
            assert!(restored.state.goal().is_none());
            while let Ok(event) = events.try_recv() {
                if event["method"] == "turn/completed" {
                    terminals.push(event);
                }
            }
            // The original wake must finish its whole turn, including a Provider
            // continuation after its own tool result, without a second claim.
            if pause.is_none() {
                assert_eq!(terminals.len(), 1, "one original wake turn: {terminals:?}");
            }
            assert!(!terminals.is_empty(), "original wake turn terminal");
            if superseded {
                assert_eq!(terminals[0]["params"]["turn"]["status"], "failed");
                assert_eq!(
                    terminals[0]["params"]["error"]["message"],
                    "KCoder peer turn authorization failed [peer_provider_start_permit_not_current]",
                    "user supersession is an Engine-side native permit rejection: {terminals:?}"
                );
            } else {
                assert_eq!(
                    terminals[0]["params"]["turn"]["status"], "completed",
                    "original wake turn did not complete: {terminals:?}"
                );
            }
            if pause.is_none() {
                assert_eq!(fixture.calls.lock().unwrap().len(), expected_calls);
            }
            assert_eq!(
                fixture
                    .send("cold-wake-original", AgentMessageMode::WakeIfIdle)
                    .await
                    .context("same-CID reconciliation after the original cold Wake completed")?
                    .message_id,
                first.message_id
            );
        }
    }
    cold.shutdown(&mut manager).await;
    idle.shutdown().await;
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    let rows = kcoder_state::load_history(&fixture.target_history)?;
    assert_eq!(
        rows.iter()
            .filter(|row| row.message.role() == kcoder_types::MessageRole::User
                && row.message.origin() == kcoder_types::MessageOrigin::User)
            .count(),
        if case == "native-wake-paused-steer" {
            2
        } else {
            1
        }
    );
    let lease = SessionLease::acquire_existing_history(&fixture.target_history)?;
    drop(lease);
    fixture.close().await
}

fn original_ledger_negative(fixture: &Fixture, case: &str) -> Result<()> {
    use kcoder_state::turn_attempt_store::{
        TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
    };
    use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
    let held = SessionLease::acquire_existing_history(&fixture.target_history)?;
    let directory = fixture.original_artifacts.join(&fixture.target);
    let store = TurnAttemptStore::open_existing(&directory, &fixture.target)?
        .context("actual original ledger")?;
    let original = store
        .list_with_budget(4, 64 * 1024)?
        .pop()
        .context("actual terminal seed")?;
    if matches!(case, "unsettled" | "ambiguous" | "clock-rollback") {
        let accepted = if case == "clock-rollback" {
            original.accepted_at_ms - 1
        } else {
            original.accepted_at_ms + 1
        };
        for number in 0..if case == "ambiguous" { 2 } else { 1 } {
            let identity = TurnAttemptIdentity {
                thread_id: fixture.target.clone(),
                turn_id: format!("owned-original-unsettled-{number}"),
                attempt_id: format!("owned-original-attempt-{number}"),
            };
            store.begin(TurnAttemptRecord {
                version: 1,
                client_presentation: None,
                identity: identity.clone(),
                parent_attempt_id: None,
                retry_operation_id: None,
                accepted_at_ms: accepted,
                input_context_hash: original.input_context_hash.clone(),
                request_fingerprint: None,
                retained_input: None,
                status: TurnAttemptStatus::Accepted,
                completion: None,
            })?;
            if case == "ambiguous" && number == 0 {
                store.finish(
                    &identity,
                    TurnAttemptCompletion {
                        status: TurnAttemptStatus::Interrupted,
                        finished_at_ms: accepted + 1,
                        error: Some("owned original native input stopped before execution".into()),
                        provider_failure: None,
                        partial_output: String::new(),
                        partial_output_truncated: false,
                        committed_history_uuid: None,
                    },
                )?;
            }
        }
    } else {
        let attempts = std::fs::read_dir(directory.join("turn-attempts"))?
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().ends_with(".attempt.json"))
            .collect::<Vec<_>>();
        assert_eq!(attempts.len(), 1);
        if case == "legacy" {
            std::fs::rename(&attempts[0], attempts[0].with_extension("owned-saved"))?;
        } else if case == "unknown" {
            let mut record: Value = serde_json::from_slice(&std::fs::read(&attempts[0])?)?;
            record["status"] = json!("unknown_native_result");
            record["completion"]["status"] = json!("unknown_native_result");
            std::fs::write(&attempts[0], serde_json::to_vec(&record)?)?;
        } else {
            std::fs::write(&attempts[0], b"{invalid native attempt")?;
        }
    }
    drop(held);
    Ok(())
}

fn add_completed_native_attempts(fixture: &Fixture, count: usize) -> Result<()> {
    use kcoder_state::turn_attempt_store::{
        TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
    };
    use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
    let held = SessionLease::acquire_existing_history(&fixture.target_history)?;
    let store = TurnAttemptStore::open_existing(
        &fixture.original_artifacts.join(&fixture.target),
        &fixture.target,
    )?
    .context("actual original ledger")?;
    let original = store
        .list_with_budget(4, 64 * 1024)?
        .pop()
        .context("actual original terminal")?;
    for number in 0..count {
        let identity = TurnAttemptIdentity {
            thread_id: fixture.target.clone(),
            turn_id: format!("owned-complete-{number}"),
            attempt_id: format!("owned-complete-attempt-{number}"),
        };
        let accepted = original.accepted_at_ms + number as u64 + 1;
        store.begin(TurnAttemptRecord {
            version: 1,
            client_presentation: None,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: accepted,
            input_context_hash: original.input_context_hash.clone(),
            request_fingerprint: None,
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })?;
        store.finish(
            &identity,
            TurnAttemptCompletion {
                status: TurnAttemptStatus::Completed,
                finished_at_ms: accepted + 1,
                error: None,
                provider_failure: None,
                partial_output: String::new(),
                partial_output_truncated: false,
                committed_history_uuid: None,
            },
        )?;
    }
    drop(held);
    Ok(())
}

async fn owned_tui_case(case: &str) -> Result<()> {
    let mut fixture = Fixture::new_kind(true).await?;
    let enqueued = fixture
        .send("owned-tui-enqueue", AgentMessageMode::EnqueueOnly)
        .await?;
    tokio::time::sleep(Duration::from_millis(2200)).await;
    assert_eq!(fixture.calls.lock().unwrap().len(), 1);
    let lease = SessionLease::acquire_existing_history(&fixture.target_history)?;
    drop(lease);
    if case != "owned-tui" {
        let mut lease = SessionLease::acquire_existing_history(&fixture.target_history)?;
        let prepared = kcoder_state::prepare_session_resume(&fixture.target_history)?;
        let (mut resumed, _) = fixture
            .original_factory
            .resume_thread(prepared, Arc::new(DenyAllUserQuestioner))?;
        let bound = crate::peer_sessions::BoundPeerSource::capture(
            &resumed,
            fixture.service.clone(),
            lease.native_witness()?,
        )?;
        crate::peer_sessions::turn_retirement::bind(&mut lease, &resumed, Some(&bound));
        crate::peer_sessions::install_local_target_hosts(
            &mut resumed,
            &bound,
            lease.native_witness()?,
        )?;
        let endpoint = crate::peer_sessions::PeerSourceEndpoint::bind(bound)?;
        let applied = resumed
            .apply_peer_messages_at_idle()
            .await
            .map_err(anyhow::Error::msg)?;
        assert_eq!(applied.len(), 1);
        assert_eq!(resumed.session_id(), fixture.target);
        assert_eq!(resumed.client_storage_root(), fixture.original_artifacts);
        assert_eq!(fixture.calls.lock().unwrap().len(), 1);
        endpoint.close().await;
        retire(resumed, lease).await?;
        let unheld = SessionLease::acquire_existing_history(&fixture.target_history)?;
        drop(unheld);
        assert_eq!(
            fixture
                .service
                .mailbox()?
                .get_record_by_message_id(&enqueued.message_id)?
                .context("the original applied enqueue remains recorded")?
                .receipt
                .status,
            AgentMessageStatus::Applied
        );
    }
    if case == "owned-tui-refreshed" {
        fixture
            .source
            .settings
            .write()
            .unwrap()
            .tools
            .disabled
            .push("Glob".into());
        fixture.source = fixture
            .source
            .clone()
            .refresh_interactive_session_hosts()
            .await?;
    }
    if case == "owned-tui-source-stream" {
        return owned_source_stream_wake(fixture).await;
    }
    let wake_cid = "owned-tui-wake";
    let wake = if case == "owned-tui-refreshed" {
        tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                match fixture.send(wake_cid, AgentMessageMode::WakeIfIdle).await {
                    Ok(receipt) => return Ok(receipt),
                    Err(error) => {
                        let Some(kcoder_tools::ToolError::Execution(payload)) =
                            error.downcast_ref::<kcoder_tools::ToolError>()
                        else {
                            return Err(error);
                        };
                        let recoverable = serde_json::from_str::<serde_json::Value>(payload)
                            .is_ok_and(|value| {
                                value["code"] == "peer_message_original_operation_unconfirmed"
                                    && value["status"] == "unknown"
                                    && value["clientMessageId"] == wake_cid
                            });
                        if !recoverable {
                            return Err(error);
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        })
        .await
        .context("same-CID cold wake recovery remained unknown")??
    } else {
        fixture.send(wake_cid, AgentMessageMode::WakeIfIdle).await?
    };
    assert_eq!(wake.client_message_id, wake_cid);
    let lease = tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            if fixture.calls.lock().unwrap().len() == 2 {
                let store = fixture.service.mailbox()?;
                let applied = [enqueued.message_id.as_str(), wake.message_id.as_str()]
                    .iter()
                    .all(|id| {
                        store
                            .get_record_by_message_id(id)
                            .ok()
                            .flatten()
                            .is_some_and(|row| row.receipt.status == AgentMessageStatus::Applied)
                    });
                if applied
                    && let Ok(lease) =
                        SessionLease::acquire_existing_history(&fixture.target_history)
                {
                    break Ok::<_, anyhow::Error>(lease);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .context("owned TUI cold dispatcher did not settle and release its exact target")??;
    assert_eq!(
        fixture
            .send(wake_cid, AgentMessageMode::WakeIfIdle)
            .await?
            .message_id,
        wake.message_id
    );
    assert_eq!(fixture.calls.lock().unwrap().len(), 2);
    let source = fixture
        .service
        .message_source(&fixture.source.session_id())?;
    let binding = fixture
        .service
        .mailbox()?
        .get_receipt_binding_by_client_id(&source, wake_cid)?
        .context("the original wake has one mailbox binding")?;
    assert_eq!(binding.receipt.message_id, wake.message_id);
    assert_eq!(binding.receipt.status, AgentMessageStatus::Applied);
    let rows = kcoder_state::load_history(&fixture.target_history)?;
    assert_eq!(
        rows.iter()
            .filter(|row| row.message.peer_agent_data().is_some())
            .count(),
        2
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.message.role() == kcoder_types::MessageRole::User
                && row.message.origin() == kcoder_types::MessageOrigin::User)
            .count(),
        1
    );
    let attempts = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
        &fixture.original_artifacts.join(&fixture.target),
        &fixture.target,
    )?
    .context("original target attempt ledger")?;
    let records = attempts.list_with_budget(8, 64 * 1024)?;
    assert_eq!(records.len(), 2);
    assert!(
        records
            .iter()
            .all(|record| record.status == kcoder_types::TurnAttemptStatus::Completed)
    );
    assert!(!fixture.bootstrap_artifacts.join(&fixture.target).exists());
    drop(lease);
    fixture.close().await
}

async fn owned_source_stream_wake(mut fixture: Fixture) -> Result<()> {
    let script = Arc::new(SourceTurnScript {
        destination: fixture.service.address(&fixture.target)?,
        calls: AtomicUsize::new(0),
        original_cid: Mutex::new(None),
        original_message_id: Mutex::new(None),
        waiting: AtomicBool::new(false),
        release: tokio::sync::Notify::new(),
    });
    *fixture.source_script.lock().unwrap() = Some(script.clone());
    let source = fixture.source.clone();
    let mut turn = tokio::spawn(async move {
        source
            .run_turn_stream(&kcoder_permissions::AutoDenyPrompt)
            .collect::<Vec<_>>()
            .await
    });
    let result = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if script.waiting.load(Ordering::Acquire) && fixture.calls.lock().unwrap().len() == 5 {
                ensure!(fixture.source.owned_turn_observer().current_identity().map_err(anyhow::Error::msg)?.is_some(),
                    "the actual original Source attempt must still own its Provider wait");
                let message_id = script.original_message_id.lock().unwrap().clone()
                    .context("the original real Source tool receipt")?;
                if fixture.service.mailbox()?.get_record_by_message_id(&message_id)?
                    .is_some_and(|record| record.receipt.status == AgentMessageStatus::Applied)
                {
                    break Ok::<_, anyhow::Error>(());
                }
            }
            if turn.is_finished() { anyhow::bail!("the real Source turn ended before cold Wake"); }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.map_err(|error| anyhow::anyhow!(
        "cold Wake did not complete while the original Source waited: {error}; provider_requests={}; source_requests={}; source_waiting={}",
        fixture.calls.lock().unwrap().len(), script.calls.load(Ordering::Acquire), script.waiting.load(Ordering::Acquire)
    )).and_then(|result| result);
    // Releasing this original request is cleanup, never a retry or a new Source admission.
    script.release.notify_one();
    let source_result = match tokio::time::timeout(Duration::from_secs(3), &mut turn).await {
        Ok(Ok(events)) => {
            if events
                .iter()
                .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_)))
            {
                Err(anyhow::anyhow!(
                    "the actual Source stream failed: {events:?}"
                ))
            } else {
                Ok(())
            }
        }
        Ok(Err(error)) => Err(anyhow::anyhow!("original Source task failed: {error}")),
        Err(error) => {
            turn.abort();
            let _ = turn.await;
            Err(anyhow::anyhow!(
                "original Source task did not settle: {error}"
            ))
        }
    };
    if result.is_err() || source_result.is_err() {
        let retained = fixture._workspace.take().map(tempfile::TempDir::keep);
        eprintln!("owned real Source cold-Wake evidence retained at {retained:?}");
    }
    fixture.close().await?;
    source_result?;
    result
}

async fn owned_backoff_case() -> Result<()> {
    let mut fixture = Fixture::new().await?;
    let (mut cold, mut idle, mut manager, mut events) = fixture.driver(true)?;
    let wake = fixture
        .send("original-backoff-wake", AgentMessageMode::WakeIfIdle)
        .await?;
    let runtime = activate(&cold.owner, &fixture.target).await?;
    assert!(manager.insert_cold_peer(runtime).is_ok());
    fixture
        .source
        .settings
        .write()
        .unwrap()
        .tools
        .disabled
        .push("SendSessionMessage".into());
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            idle.tick(&manager, Some(&fixture.service));
            let retired = manager.take_completed_local_cold_peers(&idle);
            if !retired.is_empty() {
                for runtime in retired {
                    assert!(!idle.verified_empty_pass_for(
                        &fixture.target,
                        &runtime.engine().state.inspection_lifecycle_identity()
                    ));
                    cold.note_retired(&runtime, false);
                    runtime.shutdown().await;
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    // An unavailable Source does not retain a cold model's original writer.
    let user_lease = SessionLease::acquire_existing_history(&fixture.target_history)?;
    assert_eq!(fixture.calls.lock().unwrap().len(), 1);
    drop(user_lease);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            cold.next_inventory = Instant::now();
            cold.tick(&mut manager).await;
            if cold
                .retry_hints
                .get(&fixture.target)
                .is_some_and(|hint| hint.backoff.delay >= Duration::from_secs(4))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    assert_eq!(fixture.calls.lock().unwrap().len(), 1);
    let old_deadline = cold.retry_hints.get(&fixture.target).unwrap().backoff.until;
    let user_lease = SessionLease::acquire_existing_history(&fixture.target_history)?;
    let prepared = kcoder_state::prepare_session_resume(&fixture.target_history)?;
    let (user_engine, _) = fixture
        .original_factory
        .resume_thread(prepared, Arc::new(DenyAllUserQuestioner))?;
    assert_eq!(user_engine.session_id(), fixture.target);
    assert_eq!(
        user_engine.client_storage_root(),
        fixture.original_artifacts
    );
    for _ in 0..3 {
        cold.next_inventory = Instant::now();
        cold.tick(&mut manager).await;
        tokio::task::yield_now().await;
        assert!(
            manager.engine(&fixture.target).is_none(),
            "a normal user's original lease cannot be displaced"
        );
    }
    retire(user_engine, user_lease).await?;
    fixture
        .source
        .settings
        .write()
        .unwrap()
        .tools
        .disabled
        .retain(|name| name != "SendSessionMessage");
    let later = fixture
        .send("new-original-queue-hint", AgentMessageMode::EnqueueOnly)
        .await?;
    let expected_ids = [wake.message_id.clone(), later.message_id.clone()]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    let mut fresh_recheck_at = None;
    let mut turn_events = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            cold.next_inventory = Instant::now();
            cold.tick(&mut manager).await;
            if fresh_recheck_at.is_none() && (cold.in_flight.contains(&fixture.target) || manager.engine(&fixture.target).is_some()) {
                let observed = Instant::now();
                assert!(observed < old_deadline, "a new queue stamp must trigger an actual restore recheck before the old scheduling hint expires");
                fresh_recheck_at = Some(observed);
            }
            idle.tick(&manager, Some(&fixture.service));
            while let Ok(event) = events.try_recv() {
                if turn_events.len() < 16 && matches!(event["method"].as_str(), Some("turn/started" | "turn/completed")) { turn_events.push(event); }
            }
            let requests = fixture.calls.lock().unwrap().clone();
            let mut previous = std::collections::BTreeSet::new();
            for request in requests.iter().skip(1) {
                let current = request.messages.iter().flat_map(message_content).filter_map(|block| {
                    let ContentBlock::Text {text} = block else { return None; };
                    if !text.contains("\"kind\":\"untrusted_peer_agent_reference\"") { return None; }
                    let value:Value=serde_json::from_str(&text[text.find('{')?..]).ok()?;
                    value["messageId"].as_str().map(str::to_owned)
                }).collect::<std::collections::BTreeSet<_>>();
                ensure!(current.contains(&wake.message_id) && current.is_subset(&expected_ids), "Provider request contains the one original wake plus only known native peer IDs");
                ensure!(previous.is_subset(&current) && current.len()>previous.len(), "the same model context must not be dispatched again without a new peer");
                previous=current;
            }
            let store = fixture.service.mailbox()?;
            let all_applied = [&wake.message_id, &later.message_id].iter().all(|id| {
                store.get_record_by_message_id(id).ok().flatten().is_some_and(|record| record.receipt.status == AgentMessageStatus::Applied)
            });
            if !previous.is_empty() && all_applied && !manager.is_turn_running(&fixture.target) { break Ok::<_,anyhow::Error>(()); }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.map_err(|error| anyhow::anyhow!("original backoff delivery did not complete: {error}; fresh_recheck={}; provider_calls={}; resident={}; restore_errors={:?}",
        fresh_recheck_at.is_some(), fixture.calls.lock().unwrap().len(), manager.engine(&fixture.target).is_some(), cold.restore_errors))??;
    assert!(
        fresh_recheck_at.is_some(),
        "a completed delivery requires an observed native recheck"
    );
    let receipt = fixture
        .service
        .mailbox()?
        .get_record_by_message_id(&wake.message_id)?
        .unwrap()
        .receipt;
    assert_eq!(receipt.status, AgentMessageStatus::Applied);
    assert_eq!(receipt.client_message_id, wake.client_message_id);
    assert_eq!(receipt.message_id, wake.message_id);
    let attempts = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
        &fixture.original_artifacts.join(&fixture.target),
        &fixture.target,
    )?
    .unwrap()
    .list_with_budget(8, 1024 * 1024)?;
    while let Ok(event) = events.try_recv() {
        if turn_events.len() < 16
            && matches!(
                event["method"].as_str(),
                Some("turn/started" | "turn/completed")
            )
        {
            turn_events.push(event);
        }
    }
    let provider_contexts = fixture
        .calls
        .lock()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, request)| {
            let peers = request
                .messages
                .iter()
                .flat_map(message_content)
                .filter_map(|block| {
                    let ContentBlock::Text { text } = block else {
                        return None;
                    };
                    if !text.contains("\"kind\":\"untrusted_peer_agent_reference\"") {
                        return None;
                    }
                    let reference: Value = serde_json::from_str(&text[text.find('{')?..]).ok()?;
                    reference["messageId"].as_str().map(str::to_owned)
                })
                .collect::<Vec<_>>();
            json!({"index":index,"sessionId":request.debug_session_id,"peerIds":peers})
        })
        .collect::<Vec<_>>();
    let observation = json!({
        "target":fixture.target,"history":fixture.target_history,
        "artifacts":fixture.original_artifacts,"attempts":attempts,
        "turnEvents":turn_events,"providerContexts":provider_contexts,
        "originalWake":wake,"laterEnqueue":later
    });
    // Retain exact owned evidence before a failing assertion can drop its workspace.
    PrivateDirectory::open_existing(&std::env::current_dir()?)?.atomic_replace(
        OsStr::new("cold-backoff-observation.json"),
        &serde_json::to_vec_pretty(&observation)?,
    )?;
    if attempts.len() != 2 {
        let retained = fixture._workspace.take().map(tempfile::TempDir::keep);
        eprintln!("original backoff workspace retained at {retained:?}");
    }
    assert_eq!(
        attempts.len(),
        2,
        "only seed plus one original automatic turn may exist"
    );
    assert!(
        attempts
            .iter()
            .all(|record| record.status == kcoder_types::TurnAttemptStatus::Completed)
    );
    while let Ok(event) = events.try_recv() {
        if turn_events.len() < 16
            && matches!(
                event["method"].as_str(),
                Some("turn/started" | "turn/completed")
            )
        {
            turn_events.push(event);
        }
    }
    let starts = turn_events
        .iter()
        .filter(|event| event["method"] == "turn/started")
        .collect::<Vec<_>>();
    let terminals = turn_events
        .iter()
        .filter(|event| event["method"] == "turn/completed")
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), 1);
    assert_eq!(terminals.len(), 1);
    assert_eq!(
        starts[0]["params"]["turnId"],
        terminals[0]["params"]["turnId"]
    );
    let mailbox = fixture
        .service
        .profile_path()
        .join("peer-router-v1")
        .join(format!(
            "mailbox-{}",
            fixture.service.identity()?.workspace_id
        ));
    let disk: Value = serde_json::from_slice(&std::fs::read(mailbox.join("messages.json"))?)?;
    let child = disk["binding"]["child"]
        .as_str()
        .context("the original fixture archive")?;
    ensure!(
        child.starts_with("receipt-archive-") && !child.contains(['/', '\\']),
        "owned archive leaf only"
    );
    let db = rusqlite::Connection::open_with_flags(
        mailbox.join(child).join("catalog.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let checkpoint: Vec<u8> = db.query_row(
        "SELECT body FROM receipt_archive_checkpoint WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    let checkpoint: Value = serde_json::from_slice(&checkpoint)?;
    assert_eq!(
        checkpoint["peerWakeBudgets"][&fixture.target]["generation"],
        1
    );
    assert_eq!(checkpoint["peerWakeBudgets"][&fixture.target]["used"], 1);
    let mut statement =
        db.prepare("SELECT body FROM receipt_archive_rows WHERE message_id LIKE 'claim/%'")?;
    let claims = statement
        .query_map([], |row| row.get::<_, Vec<u8>>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    assert_eq!(claims.len(), 1);
    assert_eq!(
        serde_json::from_slice::<Value>(&claims[0])?["messageId"],
        wake.message_id
    );

    let rows = kcoder_state::load_history(&fixture.target_history)?;
    assert_eq!(
        rows.iter()
            .filter(|row| row.message.peer_agent_data().is_some())
            .count(),
        2
    );
    assert_eq!(
        rows.iter()
            .filter(|row| kcoder_types::is_real_user_message(&row.message))
            .count(),
        1
    );
    cold.shutdown(&mut manager).await;
    idle.shutdown().await;
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    fixture.close().await
}
