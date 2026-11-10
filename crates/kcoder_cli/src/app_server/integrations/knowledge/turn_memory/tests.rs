use super::*;
use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
use anyhow::ensure;
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_config::{PrivateDirectory, Settings};
use kcoder_types::{
    ContentBlock, MessageDeltaFields, MessagesRequest, StreamEvent, StreamingMessage,
    integrations::{
        core::IntegrationNullable,
        knowledge::{MemoryOrigin, MemoryProposal, MemoryProvenance, MemoryReview},
    },
};
use serde_json::json;
use std::{
    ffi::OsStr,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

struct Source {
    guard: NativeDomainGuard,
    store: Arc<MemoryReviewStore>,
    allowed: AtomicBool,
    observations: AtomicUsize,
}
impl NativeReviewedMemorySource for Source {
    fn verified_store(&self, native: &NativeIntegrationContext) -> Result<&MemoryReviewStore> {
        native.verify()?;
        ensure!(
            self.allowed.load(Ordering::SeqCst),
            "controlled-native-memory-policy-unavailable"
        );
        let directory = self.guard.directory(native.profile()?)?;
        let data = directory.open_child(OsStr::new("data"), false)?;
        ensure!(
            data.directory_identity()? == self.store.storage_directory_identity()?
                && *self.store.owner() == KnowledgeOwner::from(native.scope()),
            "MEMORY_NATIVE_STORAGE_CHANGED"
        );
        self.observations.fetch_add(1, Ordering::SeqCst);
        Ok(&self.store)
    }
}

type FirstRequestHook = Arc<dyn Fn() + Send + Sync>;
type SharedFirstRequestHook = Arc<Mutex<Option<FirstRequestHook>>>;
mod composition_tests;
mod read_snapshot_tests;
struct RecordingProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    on_first: SharedFirstRequestHook,
}
impl Provider for RecordingProvider {
    fn name(&self) -> &'static str {
        "reviewed-memory-turn-fixture"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<ProviderStream, ApiErrorKind> {
        let model = request.model.clone();
        let mut requests = self.requests.lock().unwrap();
        let index = requests.len();
        requests.push(request);
        drop(requests);
        if index == 0
            && let Some(callback) = self.on_first.lock().unwrap().clone()
        {
            callback();
        }
        let block = if index < 2 {
            ContentBlock::ToolUse {
                id: format!("fixture-probe-{index}"),
                name: "MemoryBoundaryProbe".into(),
                input: json!({}),
            }
        } else {
            ContentBlock::Text {
                text: "Completed deterministic continuation.".into(),
            }
        };
        let events = vec![
            StreamEvent::MessageStart {
                message: StreamingMessage {
                    id: format!("fixture-message-{index}"),
                    role: "assistant".into(),
                    content: vec![],
                    model,
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            },
            StreamEvent::ContentBlockStart {
                index: 0,
                content_block: block,
            },
            StreamEvent::ContentBlockStop { index: 0 },
            StreamEvent::MessageDelta {
                delta: MessageDeltaFields {
                    stop_reason: Some(if index < 2 { "tool_use" } else { "end_turn" }.into()),
                    stop_sequence: None,
                    usage: None,
                },
            },
            StreamEvent::MessageStop,
        ];
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}
struct Probe;
#[async_trait::async_trait]
impl kcoder_tools::Tool for Probe {
    fn name(&self) -> String {
        "MemoryBoundaryProbe".into()
    }
    fn description(&self) -> String {
        "Continue a deterministic owned memory-boundary fixture.".into()
    }
    fn input_schema(&self) -> serde_json::Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn is_read_only(&self) -> bool {
        true
    }
    async fn call(
        &self,
        _: serde_json::Value,
        _: &kcoder_tools::ToolContext,
    ) -> std::result::Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        Ok(kcoder_tools::ToolOutput::text(
            "Continue the original owned turn.",
        ))
    }
}
struct Fixture {
    native: Arc<NativeIntegrationContext>,
    engine: QueryEngine,
    source: Arc<Source>,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    on_first: SharedFirstRequestHook,
    _root: tempfile::TempDir,
}
fn fixture(enabled: bool, on_first: Option<FirstRequestHook>) -> Result<Fixture> {
    let root = tempfile::tempdir()?;
    let parent = PrivateDirectory::open_or_create(root.path())?;
    let profile = parent.create_private_child(OsStr::new("profile"))?;
    parent.create_private_child(OsStr::new("workspace"))?;
    profile.atomic_replace(OsStr::new("settings.json"), b"{}")?;
    let profile_path = root.path().join("profile");
    let cwd = root.path().join("workspace");
    let mut settings = Settings::default();
    settings.integrations.knowledge.memory_center_enabled = enabled;
    settings.permission_mode = kcoder_config::PermissionMode::Bypass;
    settings.context_window_tokens = Some(1_000_000);
    settings.context_output_headroom = Some(10_000);
    settings.max_tokens = Some(1024);
    let owner = Arc::new(kcoder_config::create_private_temp_dir(
        "turn-memory-fixture",
    )?);
    let services = kcoder_engine::WorkspaceRuntimeServices::new(&cwd, "turn-memory-fixture")
        .with_private_client_storage(owner);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let on_first = Arc::new(Mutex::new(on_first));
    let engine = QueryEngine::try_new_for_client_with_services(
        Arc::new(RecordingProvider {
            requests: requests.clone(),
            on_first: on_first.clone(),
        }),
        kcoder_state::AppState::new(&cwd),
        kcoder_tools::ToolRegistry::new().register(Probe),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.clone(),
        Some(true),
        services,
    )?
    .with_settings_persistence_path(profile_path.join("settings.json"));
    let native = Arc::new(NativeIntegrationContext::capture(
        &profile_path,
        &cwd,
        "turn-memory-owner",
        &engine.active_model_configuration_summary()?.revision,
    )?);
    let (guard, store) = NativeDomainGuard::initialize(
        native.profile()?,
        native.scope(),
        NativeDomain::Memory,
        "fixture-explicit-memory-initialize",
        |directory| MemoryReviewStore::create_in(directory, OsStr::new("data"), native.scope()),
    )?;
    Ok(Fixture {
        _root: root,
        native,
        engine,
        source: Arc::new(Source {
            guard,
            store: Arc::new(store),
            allowed: AtomicBool::new(true),
            observations: AtomicUsize::new(0),
        }),
        requests,
        on_first,
    })
}
fn proposal(content: &str) -> MemoryProposal {
    MemoryProposal {
        title: "Reviewed formatting preference".into(),
        content: content.into(),
        category: "user".into(),
        origin: MemoryOrigin::Manual,
        provenance: vec![MemoryProvenance {
            kind: "native_message".into(),
            source_id: "fixture-source-message".into(),
            source_revision: "1".into(),
            description: "Synthetic user-reviewed fixture".into(),
        }],
        valid_until_ms: None,
    }
}
fn seed(f: &Fixture) -> Result<ReviewedMemory> {
    let confirmed = f.source.store.propose(
        "manual-proposal",
        proposal("Frozen reviewed revision one."),
        100,
    )?;
    let confirmed = f.source.store.review(
        "manual-accept",
        &confirmed.id,
        1,
        MemoryReview::Accept {
            edited_content: None,
        },
        101,
    )?;
    f.source.store.propose(
        "candidate-proposal",
        proposal("Candidate must never be injected."),
        102,
    )?;
    let disabled = f.source.store.propose(
        "disabled-proposal",
        proposal("Disabled must never be injected."),
        103,
    )?;
    let disabled = f.source.store.review(
        "disabled-accept",
        &disabled.id,
        1,
        MemoryReview::Accept {
            edited_content: None,
        },
        104,
    )?;
    f.source.store.set_enabled(
        "disable-for-future",
        &disabled.id,
        disabled.revision,
        false,
        105,
    )?;
    Ok(confirmed)
}
fn accepted(f: &Fixture) -> Result<TurnAttemptIdentity> {
    f.engine.state.add_message(Message::user_text(
        "Use the reviewed preference on this owned task.",
    ));
    let identity = TurnAttemptIdentity {
        thread_id: f.engine.session_id(),
        turn_id: "turn-1".into(),
        attempt_id: uuid::Uuid::new_v4().to_string(),
    };
    crate::app_server::turn_attempts::begin(
        &f.engine,
        &identity,
        false,
        None,
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&f.engine.state.messages())?)
        ),
        "a".repeat(64),
    )?;
    Ok(identity)
}
fn memory_text(request: &MessagesRequest) -> Vec<String> {
    request
        .messages
        .iter()
        .filter(|message| message.origin() == kcoder_types::MessageOrigin::Runtime)
        .flat_map(|message| match message {
            Message::User { content, .. } => content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text }
                        if text.starts_with("<reviewed-memory-turn-data>") =>
                    {
                        Some(text.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
            _ => vec![],
        })
        .collect()
}

#[tokio::test]
async fn three_actual_provider_continuations_share_one_reviewed_snapshot_without_system_or_state_rewrite()
-> Result<()> {
    let f = fixture(true, None)?;
    let confirmed = seed(&f)?;
    let identity = accepted(&f)?;
    let source = f.source.clone();
    let id = confirmed.id.clone();
    *f.on_first.lock().unwrap() = Some(Arc::new(move || {
        source
            .store
            .edit(
                "human-edit-mid-turn",
                &id,
                confirmed.revision,
                "Edited current revision two.".into(),
                200,
            )
            .unwrap();
    }));
    let scope = f.engine.state.history_attempt_scope(identity.clone())?;
    scope
        .run(async {
            let prepared = prepare_current_turn_memory(
                &f.native,
                &identity,
                &f.engine,
                Some(f.source.clone()),
            )?
            .context("snapshot not prepared")?;
            let original = prepared.snapshot().clone();
            let engine = f
                .engine
                .clone()
                .with_native_reviewed_memory_turn_context(prepared.binding())?;
            let events = engine
                .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 4)
                .collect::<Vec<_>>()
                .await;
            ensure!(
                !events
                    .iter()
                    .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_))),
                "{events:?}"
            );
            let requests = f.requests.lock().unwrap();
            assert_eq!(requests.len(), 3);
            let first = memory_text(&requests[0]);
            assert_eq!(first.len(), 1);
            assert!(first[0].contains("Frozen reviewed revision one."));
            assert!(!first[0].contains("Candidate must never"));
            assert!(!first[0].contains("Disabled must never"));
            assert!(!first[0].contains("Edited current"));
            for request in requests.iter() {
                assert_eq!(memory_text(request), first);
                assert_eq!(request.system, requests[0].system);
                assert_eq!(
                    serde_json::to_value(&request.tools)?,
                    serde_json::to_value(&requests[0].tools)?
                );
                assert!(
                    !request
                        .system
                        .as_deref()
                        .unwrap_or("")
                        .contains("Frozen reviewed")
                );
            }
            assert_eq!(
                f.source
                    .store
                    .read_task_snapshot(prepared.snapshot_id())?
                    .as_ref(),
                Some(&original)
            );
            assert_eq!(
                f.source.store.read(&confirmed.id)?.proposal.content,
                "Edited current revision two."
            );
            assert!(
                !serde_json::to_string(&engine.state.messages())?
                    .contains("<reviewed-memory-turn-data>")
            );
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn disabled_feature_observes_nothing_and_missing_source_or_unaccepted_payload_never_creates_snapshot()
-> Result<()> {
    let f = fixture(false, None)?;
    let fake = TurnAttemptIdentity {
        thread_id: f.engine.session_id(),
        turn_id: "payload-says-accepted".into(),
        attempt_id: "user-controlled".into(),
    };
    assert!(
        prepare_current_turn_memory(&f.native, &fake, &f.engine, Some(f.source.clone()))?.is_none()
    );
    assert_eq!(f.source.observations.load(Ordering::SeqCst), 0);
    f.engine
        .settings
        .write()
        .unwrap()
        .integrations
        .knowledge
        .memory_center_enabled = true;
    let scope = f.engine.state.history_attempt_scope(fake.clone())?;
    scope
        .run(async {
            assert!(
                prepare_current_turn_memory(&f.native, &fake, &f.engine, Some(f.source.clone()))
                    .is_err()
            );
            assert!(prepare_current_turn_memory(&f.native, &fake, &f.engine, None).is_err());
            assert!(
                f.source
                    .store
                    .read_task_snapshot(&snapshot_key(&f.native, &fake)?)?
                    .is_none()
            );
            assert!(f.requests.lock().unwrap().is_empty());
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn wrong_native_owner_and_unknown_live_source_are_rejected_before_provider() -> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let identity = accepted(&f)?;
    let foreign = fixture(true, None)?;
    f.engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            assert!(
                prepare_current_turn_memory(
                    &foreign.native,
                    &identity,
                    &f.engine,
                    Some(f.source.clone())
                )
                .is_err()
            );
            let prepared = prepare_current_turn_memory(
                &f.native,
                &identity,
                &f.engine,
                Some(f.source.clone()),
            )?
            .unwrap();
            f.source.allowed.store(false, Ordering::SeqCst);
            let engine = f
                .engine
                .clone()
                .with_native_reviewed_memory_turn_context(prepared.binding())?;
            let events = engine
                .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
                .collect::<Vec<_>>()
                .await;
            assert!(
                events
                    .iter()
                    .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_)))
            );
            assert!(f.requests.lock().unwrap().is_empty());
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn actual_native_identity_revocation_blocks_frozen_material_and_wrong_state_cannot_borrow_it()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let identity = accepted(&f)?;
    f.engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let prepared = prepare_current_turn_memory(
                &f.native,
                &identity,
                &f.engine,
                Some(f.source.clone()),
            )?
            .unwrap();
            let mut peer = f.engine.clone();
            peer.state = kcoder_state::AppState::new(f.engine.state.cwd());
            assert!(prepared.binding().runtime_message(&peer).is_err());
            let mut global = f.native.scope().clone();
            global.workspace_id = IntegrationNullable::Null;
            let authority = crate::app_server::integrations::core::NativeIdentity::observe(
                f.native.profile()?,
                &global,
            )?
            .unwrap();
            authority.disable(f.native.profile()?, "revoke-current-turn-memory", 1, 300)?;
            assert!(prepared.binding().runtime_message(&f.engine).is_err());
            assert!(f.requests.lock().unwrap().is_empty());
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn same_state_same_session_after_real_resume_cannot_reuse_the_previous_epoch_binding()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let history = f
        .native
        .profile_path()?
        .join(format!("{}.jsonl", f.engine.session_id()));
    f.engine.state.with_history_path(&history);
    let identity = accepted(&f)?;
    f.engine.state.flush_history().await?;
    let prepared = f
        .engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            prepare_current_turn_memory(&f.native, &identity, &f.engine, Some(f.source.clone()))?
                .context("missing snapshot")
        })
        .await?;
    let original_id = f.engine.session_id();
    f.engine.state.resume_from_history(&history)?;
    assert_eq!(f.engine.session_id(), original_id);
    f.engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            assert!(prepared.binding().runtime_message(&f.engine).is_err());
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn real_identity_revoked_between_provider_continuations_stops_before_the_second_send()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let identity = accepted(&f)?;
    let native = f.native.clone();
    *f.on_first.lock().unwrap() = Some(Arc::new(move || {
        let mut global = native.scope().clone();
        global.workspace_id = IntegrationNullable::Null;
        let authority = crate::app_server::integrations::core::NativeIdentity::observe(
            native.profile().unwrap(),
            &global,
        )
        .unwrap()
        .unwrap();
        authority
            .disable(native.profile().unwrap(), "revoke-between-requests", 1, 400)
            .unwrap();
    }));
    f.engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let prepared = prepare_current_turn_memory(
                &f.native,
                &identity,
                &f.engine,
                Some(f.source.clone()),
            )?
            .unwrap();
            let engine = f
                .engine
                .clone()
                .with_native_reviewed_memory_turn_context(prepared.binding())?;
            let events = engine
                .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 4)
                .collect::<Vec<_>>()
                .await;
            assert!(
                events
                    .iter()
                    .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_)))
            );
            assert_eq!(f.requests.lock().unwrap().len(), 1);
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn a_new_real_continuation_attempt_reuses_the_original_turn_snapshot_after_manual_edit()
-> Result<()> {
    let f = fixture(true, None)?;
    let confirmed = seed(&f)?;
    let first = accepted(&f)?;
    let original = f
        .engine
        .state
        .history_attempt_scope(first.clone())?
        .run(async {
            prepare_current_turn_memory(&f.native, &first, &f.engine, Some(f.source.clone()))?
                .context("missing original snapshot")
        })
        .await?;
    crate::app_server::turn_attempts::finish(
        &f.engine,
        &first,
        "failed",
        Some("controlled native continuation fixture"),
        None,
        &crate::app_server::turn_attempts::PartialOutput::default(),
    )?;
    f.source.store.edit(
        "edit-before-native-continuation",
        &confirmed.id,
        confirmed.revision,
        "Newer reviewed content for later tasks.".into(),
        500,
    )?;
    let next = TurnAttemptIdentity {
        attempt_id: uuid::Uuid::new_v4().to_string(),
        ..first.clone()
    };
    crate::app_server::turn_attempts::begin(
        &f.engine,
        &next,
        true,
        None,
        "b".repeat(64),
        "c".repeat(64),
    )?;
    f.engine
        .state
        .history_attempt_scope(next.clone())?
        .run(async {
            let continued =
                prepare_current_turn_memory(&f.native, &next, &f.engine, Some(f.source.clone()))?
                    .unwrap();
            assert_eq!(continued.snapshot(), original.snapshot());
            assert_eq!(continued.snapshot_id(), original.snapshot_id());
            let message = continued.binding().runtime_message(&f.engine)?.unwrap();
            let text = serde_json::to_string(&message)?;
            assert!(text.contains("Frozen reviewed revision one."));
            assert!(!text.contains("Newer reviewed content"));
            assert!(original.binding().runtime_message(&f.engine).is_err());
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn a_verified_existing_candidate_only_store_produces_an_empty_frozen_snapshot_without_candidate_context()
-> Result<()> {
    let f = fixture(true, None)?;
    f.source.store.propose(
        "only-unreviewed-candidate",
        proposal("Unreviewed candidate stays outside Provider input."),
        100,
    )?;
    let identity = accepted(&f)?;
    f.engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let prepared = prepare_current_turn_memory(
                &f.native,
                &identity,
                &f.engine,
                Some(f.source.clone()),
            )?
            .unwrap();
            assert!(prepared.snapshot().memories.is_empty());
            assert!(prepared.binding().runtime_message(&f.engine)?.is_none());
            assert!(
                f.source
                    .store
                    .read_task_snapshot(prepared.snapshot_id())?
                    .is_some()
            );
            let engine = f
                .engine
                .clone()
                .with_native_reviewed_memory_turn_context(prepared.binding())?;
            let events = engine
                .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 4)
                .collect::<Vec<_>>()
                .await;
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_)))
            );
            let requests = f.requests.lock().unwrap();
            assert_eq!(requests.len(), 3);
            assert!(requests.iter().all(|request| {
                memory_text(request).is_empty()
                    && !serde_json::to_string(request)
                        .unwrap()
                        .contains("Unreviewed candidate stays")
            }));
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn committed_native_memory_namespace_loss_never_becomes_a_fresh_empty_source() -> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let identity = accepted(&f)?;
    f.engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let prepared = prepare_current_turn_memory(
                &f.native,
                &identity,
                &f.engine,
                Some(f.source.clone()),
            )?
            .unwrap();
            let namespace = f.source.guard.namespace_id();
            std::fs::rename(
                f.native.profile_path()?.join(namespace),
                f.native.profile_path()?.join("held-original-memory"),
            )?;
            f.native
                .profile()?
                .create_private_child(OsStr::new(namespace))?;
            let engine = f
                .engine
                .clone()
                .with_native_reviewed_memory_turn_context(prepared.binding())?;
            let events = engine
                .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
                .collect::<Vec<_>>()
                .await;
            assert!(
                events
                    .iter()
                    .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_)))
            );
            assert!(f.requests.lock().unwrap().is_empty());
            assert!(
                !f.native
                    .profile_path()?
                    .join(namespace)
                    .join("data")
                    .exists()
            );
            Ok::<_, anyhow::Error>(())
        })
        .await
}
