//! Local actual Native identity/Accepted ledger/Engine installation evidence.
//! A deterministic Provider exercises the real Engine; no paid model is used.
use super::super::native_host::{NativeOfficeAcceptedTurnAuthority, NativeOfficeComposition};
use super::*;
use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
use async_trait::async_trait;
use futures::StreamExt;
use kcoder_config::PrivateDirectory;
use kcoder_state::turn_attempt_store::{TurnAttemptCompletion, TurnAttemptStore};
use kcoder_tools::{Tool, ToolError, ToolOutput, ToolRegistry, ToolSource};
use kcoder_types::{ClientPresentationV1, ContentBlock, MessagesRequest, StreamEvent};
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    sync::atomic::{AtomicUsize, Ordering},
};

struct Fixture {
    _temp: tempfile::TempDir,
    context: NativeIntegrationContext,
    engine: QueryEngine,
    attempt: TurnAttemptIdentity,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        parent.create_private_child(OsStr::new("profile")).unwrap();
        parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let settings = kcoder_config::Settings {
            history_enabled: false,
            ..crate::test_fixtures::settings_with_default_provider()
        };
        let engine = QueryEngine::try_new_for_client_with_services(
            Arc::new(CardProvider::default()),
            kcoder_state::AppState::new(&workspace),
            ToolRegistry::new()
                .register(Named {
                    name: "read",
                    source: ToolSource::Builtin,
                })
                .register(Named {
                    name: "mcp__owned__deferred",
                    source: ToolSource::Mcp {
                        server: "owned".into(),
                        tool: "deferred".into(),
                    },
                }),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::empty(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            workspace.clone(),
            Some(true),
            kcoder_engine::WorkspaceRuntimeServices::new(&workspace, "owned-turn-binding"),
        )
        .unwrap()
        .with_settings_persistence_path(profile.join("settings.json"))
        .with_client_presentation(Some(ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(StudioWorkMode::Kworker),
            inline_widgets: true,
            isolated_widgets: false,
        }));
        {
            let mut settings = engine.settings.write().unwrap();
            settings.integrations.office.enabled = true;
            settings.tools.luna.allowed.extend([
                "OfficeRead".into(),
                "OfficeData".into(),
                "OfficeDocument".into(),
                "OfficeCard".into(),
                "OfficeExport".into(),
            ]);
        }
        let context = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "owned-turn-binding",
            "config-1",
        )
        .unwrap();
        let attempt = TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: "accepted-turn-one".into(),
            attempt_id: "accepted-attempt-one".into(),
        };
        let fixture = Self {
            _temp: temp,
            context,
            engine,
            attempt,
        };
        fixture.accept(&fixture.attempt);
        fixture
    }
    fn accept(&self, identity: &TurnAttemptIdentity) {
        TurnAttemptStore::open(
            &self.engine.session_storage_dir_for(&identity.thread_id),
            &identity.thread_id,
        )
        .unwrap()
        .begin(TurnAttemptRecord {
            client_presentation: None,
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: Some("b".repeat(64)),
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })
        .unwrap();
    }
    fn finish(&self, identity: &TurnAttemptIdentity) {
        TurnAttemptStore::open_existing(
            &self.engine.session_storage_dir_for(&identity.thread_id),
            &identity.thread_id,
        )
        .unwrap()
        .unwrap()
        .finish(
            identity,
            TurnAttemptCompletion {
                status: TurnAttemptStatus::Completed,
                finished_at_ms: 2,
                error: None,
                provider_failure: None,
                partial_output: String::new(),
                partial_output_truncated: false,
                committed_history_uuid: None,
            },
        )
        .unwrap();
    }
    fn paths(&self) -> NativeOfficeInstalledPaths {
        NativeOfficeInstalledPaths::from_native_installation(
            &std::env::current_exe().unwrap(),
            &kcoder_test_harness::workspace_root()
                .expect("resolve current workspace")
                .join("crates/kcoder_cli")
                .join("../../apps/kcoder-office-components"),
        )
        .unwrap()
    }
    fn providers(&self) -> NativeOfficeProviders {
        NativeOfficeProviders {
            tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
            ..Default::default()
        }
    }
    fn install(&self, engine: QueryEngine, identity: &TurnAttemptIdentity) -> Result<QueryEngine> {
        install_office_for_accepted_turn(
            &self.context,
            identity,
            engine,
            self.paths(),
            self.providers(),
            "native-office-source-r1".into(),
        )
    }
    fn exists(&self) -> bool {
        NativeDomainGuard::observe(
            self.context.profile().unwrap(),
            self.context.scope(),
            NativeDomain::Office,
        )
        .unwrap()
        .is_some()
    }
    fn artifacts(&self) -> Vec<kcoder_types::integrations::office::OfficeArtifactManifest> {
        NativeOfficeComposition::observe(
            &self.context,
            &self.engine,
            self.paths(),
            self.providers(),
        )
        .unwrap()
        .unwrap()
        .service()
        .store
        .list_artifacts(&self.engine.session_id())
        .unwrap()
    }
}
struct Named {
    name: &'static str,
    source: ToolSource,
}
#[async_trait]
impl Tool for Named {
    fn name(&self) -> String {
        self.name.into()
    }
    fn source(&self) -> ToolSource {
        self.source.clone()
    }
    fn description(&self) -> String {
        "Owned candidate registry contribution".into()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false})
    }
    async fn call(&self, _: Value, _: &ToolContext) -> std::result::Result<ToolOutput, ToolError> {
        Ok(ToolOutput::text("owned"))
    }
}
fn card() -> Value {
    json!({"title":"Owned exact accepted turn","presentation":{"kind":"document","paragraphs":["Literal verified input"]},"sourceRefs":[]})
}
#[derive(Default)]
struct CardProvider(AtomicUsize);
impl kcoder_api::Provider for CardProvider {
    fn name(&self) -> &'static str {
        "owned-turn-binding-provider"
    }
    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
        Ok(Box::pin(async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart{index:0,content_block:if first {ContentBlock::ToolUse{id:"native-current-call".into(),name:"OfficeCard".into(),input:card()}}else{ContentBlock::Text{text:"Done".into()}}});
            yield Ok(StreamEvent::ContentBlockStop{index:0});
            yield Ok(StreamEvent::MessageDelta{delta:kcoder_types::MessageDeltaFields{stop_reason:Some(if first{"tool_use"}else{"end_turn"}.into()),stop_sequence:None,usage:None}});
            yield Ok(StreamEvent::MessageStop);
        }))
    }
}
#[tokio::test]
async fn disabled_kcoder_and_cli_engines_receive_no_office_tools_or_storage() {
    let fixture = Fixture::new();
    let original = fixture.engine.tools.names();
    fixture
        .engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = false;
    let disabled = fixture
        .install(fixture.engine.clone(), &fixture.attempt)
        .unwrap();
    assert_eq!(disabled.tools.names(), original);
    fixture
        .engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = true;
    for engine in [
        fixture.engine.clone().with_client_presentation(None),
        fixture
            .engine
            .clone()
            .with_client_presentation(Some(ClientPresentationV1 {
                version: 1,
                studio_work_mode: Some(StudioWorkMode::Kcoder),
                inline_widgets: true,
                isolated_widgets: false,
            })),
    ] {
        assert_eq!(
            fixture
                .install(engine, &fixture.attempt)
                .unwrap()
                .tools
                .names(),
            original
        );
    }
    assert!(!fixture.exists());
}
#[tokio::test]
async fn installation_retains_all_candidates_and_final_native_ceiling() {
    let fixture = Fixture::new();
    let installed = fixture
        .install(fixture.engine.clone(), &fixture.attempt)
        .unwrap();
    assert_eq!(installed.tools.names().len(), 7);
    for name in fixture.engine.tools.names() {
        assert!(Arc::ptr_eq(
            &fixture.engine.tools.get(&name).unwrap(),
            &installed.tools.get(&name).unwrap()
        ));
    }
    for name in [
        "OfficeRead",
        "OfficeData",
        "OfficeDocument",
        "OfficeCard",
        "OfficeExport",
    ] {
        assert!(
            matches!(installed.tools.source(name),Some(ToolSource::NativeFeature{feature,tool,revision}) if feature=="office" && tool==name && revision=="native-office-source-r1")
        );
    }
    assert!(fixture.engine.tools.get("OfficeCard").is_none());
    let restricted = fixture
        .engine
        .clone()
        .with_native_tool_ceiling(&["read".into()])
        .unwrap();
    let installed = fixture.install(restricted, &fixture.attempt).unwrap();
    assert_eq!(installed.tools.names(), vec!["read"]);
    assert!(!fixture.exists());
}
#[tokio::test]
async fn exact_attempt_and_thread_are_required_without_latest_lookup() {
    let fixture = Fixture::new();
    let mut guessed = fixture.attempt.clone();
    guessed.attempt_id = "other-attempt-of-same-turn".into();
    assert!(fixture.install(fixture.engine.clone(), &guessed).is_err());
    guessed = fixture.attempt.clone();
    guessed.thread_id = "other-thread".into();
    assert!(fixture.install(fixture.engine.clone(), &guessed).is_err());
    fixture.finish(&fixture.attempt);
    assert!(
        fixture
            .install(fixture.engine.clone(), &fixture.attempt)
            .is_err()
    );
    assert!(!fixture.exists());
}
#[tokio::test]
async fn collision_rejects_instead_of_replacing_an_existing_tool() {
    let fixture = Fixture::new();
    let mut registry = fixture.engine.tools.clone();
    registry
        .try_register(Arc::new(Named {
            name: "OfficeCard",
            source: ToolSource::Builtin,
        }))
        .unwrap();
    let baseline = fixture.engine.clone().with_turn_tools(registry);
    let original = baseline.tools.get("OfficeCard").unwrap();
    assert!(fixture.install(baseline.clone(), &fixture.attempt).is_err());
    assert!(Arc::ptr_eq(
        &original,
        &baseline.tools.get("OfficeCard").unwrap()
    ));
    assert!(!fixture.exists());
}
#[tokio::test]
async fn real_engine_call_writes_only_after_accepted_binding_and_rejects_terminal_reuse() {
    let fixture = Fixture::new();
    let installed = fixture
        .install(fixture.engine.clone(), &fixture.attempt)
        .unwrap();
    assert!(!fixture.exists());
    let events = installed
        .submit_message_stream(
            "Publish the approved literal data card",
            &kcoder_permissions::AutoAllowPrompt,
        )
        .collect::<Vec<_>>()
        .await;
    assert!(fixture.exists(), "{events:?}");
    let items = fixture.artifacts();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].task.turn_id, fixture.attempt.turn_id);
    assert_eq!(items[0].task.thread_id, fixture.attempt.thread_id);
    fixture.finish(&fixture.attempt);
    let current =
        ToolContext::new(fixture.engine.state.clone()).with_tool_call_id("after-terminal");
    assert!(
        installed
            .tools
            .get("OfficeCard")
            .unwrap()
            .call(card(), &current)
            .await
            .is_err()
    );
    assert_eq!(fixture.artifacts().len(), 1);
}
#[tokio::test]
async fn foreign_state_missing_call_and_abort_cannot_create_namespace() {
    let fixture = Fixture::new();
    let installed = fixture
        .install(fixture.engine.clone(), &fixture.attempt)
        .unwrap();
    let token = tokio_util::sync::CancellationToken::new();
    token.cancel();
    for context in [
        ToolContext::new(kcoder_state::AppState::new(fixture.engine.state.cwd()))
            .with_tool_call_id("same-looking-call"),
        ToolContext::new(fixture.engine.state.clone()),
        ToolContext::new(fixture.engine.state.clone())
            .with_tool_call_id("cancelled-call")
            .with_abort_token(token),
    ] {
        assert!(
            installed
                .tools
                .get("OfficeCard")
                .unwrap()
                .call(card(), &context)
                .await
                .is_err()
        );
    }
    assert!(!fixture.exists());
}
#[tokio::test]
async fn consecutive_turn_clones_keep_the_resident_baseline_and_use_distinct_native_tasks() {
    let fixture = Fixture::new();
    let first = fixture
        .install(fixture.engine.clone(), &fixture.attempt)
        .unwrap();
    let context = ToolContext::new(fixture.engine.state.clone())
        .with_tool_call_id("same-call-id-across-turns");
    first
        .tools
        .get("OfficeCard")
        .unwrap()
        .call(card(), &context)
        .await
        .unwrap();
    fixture.finish(&fixture.attempt);
    let second = TurnAttemptIdentity {
        thread_id: fixture.attempt.thread_id.clone(),
        turn_id: "accepted-turn-two".into(),
        attempt_id: "accepted-attempt-two".into(),
    };
    fixture.accept(&second);
    let next = fixture.install(fixture.engine.clone(), &second).unwrap();
    next.tools
        .get("OfficeCard")
        .unwrap()
        .call(card(), &context)
        .await
        .unwrap();
    let artifacts = fixture.artifacts();
    assert_eq!(artifacts.len(), 2);
    let mut turns = artifacts
        .iter()
        .map(|item| item.task.turn_id.clone())
        .collect::<Vec<_>>();
    turns.sort();
    assert_eq!(turns, vec![fixture.attempt.turn_id, second.turn_id]);
    assert_eq!(
        fixture.engine.tools.names(),
        vec!["mcp__owned__deferred", "read"]
    );
}
