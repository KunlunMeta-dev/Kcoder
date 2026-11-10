//! Real current Native turn/permission/Store lifecycle. No model/network or
//! actual Node dependency is claimed by the data-card-only local cases.
use super::super::native_host::NativeOfficeAcceptedTurnAuthority;
use super::*;
use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::{ClientPresentationV1, StudioWorkMode, TurnAttemptIdentity, TurnAttemptStatus};
use serde_json::json;
use std::ffi::OsStr;

struct Fixture {
    _temp: tempfile::TempDir,
    context: NativeIntegrationContext,
    engine: QueryEngine,
    task: OfficeTaskRef,
}
impl Fixture {
    fn new(enabled: bool) -> Self {
        Self::with_provider(enabled, None)
    }
    fn with_provider(enabled: bool, provider: Option<Arc<dyn kcoder_api::Provider>>) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        parent.create_private_child(OsStr::new("profile")).unwrap();
        parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let base = if let Some(provider) = provider {
            let settings = kcoder_config::Settings {
                history_enabled: false,
                ..crate::test_fixtures::settings_with_default_provider()
            };
            QueryEngine::try_new_for_client_with_services(
                provider,
                kcoder_state::AppState::new(&workspace),
                ToolRegistry::new(),
                kcoder_permissions::PermissionEngine::from_settings(&settings),
                settings,
                kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
                kcoder_skills::SkillRegistry::empty(),
                Arc::new(kcoder_tools::DenyAllUserQuestioner),
                workspace.clone(),
                Some(true),
                kcoder_engine::WorkspaceRuntimeServices::new(
                    &workspace,
                    "owned-lazy-office-model-case",
                ),
            )
            .unwrap()
        } else {
            crate::app_server::tests::catalog_list_test_engine(&workspace)
        };
        let engine = base
            .with_settings_persistence_path(profile.join("settings.json"))
            .with_client_presentation(Some(ClientPresentationV1 {
                version: 1,
                studio_work_mode: Some(StudioWorkMode::Kworker),
                inline_widgets: true,
                isolated_widgets: false,
            }));
        {
            let mut settings = engine.settings.write().unwrap();
            settings.integrations.office.enabled = enabled;
            settings.tools.luna.allowed.extend([
                "OfficeCard".into(),
                "OfficeData".into(),
                "OfficeDocument".into(),
                "OfficeRead".into(),
                "OfficeExport".into(),
            ]);
        }
        let context =
            NativeIntegrationContext::capture(&profile, &workspace, "lazy-office-case", "config-1")
                .unwrap();
        let thread = engine.session_id();
        TurnAttemptStore::open(&engine.session_storage_dir_for(&thread), &thread)
            .unwrap()
            .begin(TurnAttemptRecord {
                client_presentation: None,
                version: 1,
                identity: TurnAttemptIdentity {
                    thread_id: thread.clone(),
                    turn_id: "accepted-native-turn".into(),
                    attempt_id: "accepted-native-attempt".into(),
                },
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
        Self {
            _temp: temp,
            context,
            engine,
            task: OfficeTaskRef {
                thread_id: thread,
                turn_id: "accepted-native-turn".into(),
                run_id: None,
            },
        }
    }
    fn session(&self, wrong_turn: bool) -> NativeOfficeLazySession {
        self.session_with_revision(wrong_turn, "native-schema-revision")
    }
    fn session_with_revision(&self, wrong_turn: bool, revision: &str) -> NativeOfficeLazySession {
        let scope = self.context.scope().clone();
        let mut task = self.task.clone();
        if wrong_turn {
            task.turn_id = "guessed-turn".into();
        }
        let state = self.engine.state.inspection_identity();
        let resolver: OfficeToolOwnerResolver = Arc::new(move |ctx| {
            Ok(OfficeNativeToolOwner {
                scope: scope.clone(),
                task: task.clone(),
                state_identity: state.clone(),
                native_call_id: ctx
                    .tool_call_id
                    .clone()
                    .context("OFFICE_NATIVE_CALL_ID_REQUIRED")?,
                operation_id: "caller-cannot-choose-action-identity".into(),
            })
        });
        let package = kcoder_test_harness::workspace_root()
            .expect("resolve current workspace")
            .join("crates/kcoder_cli")
            .join("../../apps/kcoder-office-components");
        let installed = NativeOfficeInstalledPaths::from_native_installation(
            &std::env::current_exe().unwrap(),
            &package,
        )
        .unwrap();
        NativeOfficeLazySession::for_current_turn(
            &self.context,
            &self.engine,
            installed,
            NativeOfficeProviders {
                tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
                ..Default::default()
            },
            revision.into(),
            resolver,
        )
        .unwrap()
    }
    fn namespace_exists(&self) -> bool {
        NativeDomainGuard::observe(
            self.context.profile().unwrap(),
            self.context.scope(),
            NativeDomain::Office,
        )
        .unwrap()
        .is_some()
    }
}
fn card() -> Value {
    json!({"title":"Actual current-turn card","presentation":{"kind":"document","paragraphs":["Source remains literal data"]},"sourceRefs":[]})
}

#[tokio::test]
async fn disabled_registration_is_empty_and_does_not_initialize_namespace() {
    let fixture = Fixture::new(false);
    let session = fixture.session(false);
    assert!(session.registry().unwrap().names().is_empty());
    assert!(!fixture.namespace_exists());
}

#[tokio::test]
async fn registration_and_first_read_never_create_missing_store() {
    let fixture = Fixture::new(true);
    let session = fixture.session(false);
    let registry = session.registry().unwrap();
    assert_eq!(registry.names().len(), 5);
    assert!(!fixture.namespace_exists());
    let context =
        ToolContext::new(fixture.engine.state.clone()).with_tool_call_id("real-read-call");
    let read = registry
        .get("OfficeData")
        .unwrap()
        .call(
            json!({"action":"read_manifest","reference":{"id":"not-published","revision":1}}),
            &context,
        )
        .await;
    assert!(read.is_err());
    assert!(!fixture.namespace_exists());
    let input = json!({});
    let request = NativeOfficeToolProjectionRequest {
        session_id: &fixture.engine.session_id(),
        tool_call_id: "unknown-call",
        tool_name: "OfficeDocument",
        original_input: &input,
        input_sha256: &"a".repeat(64),
    };
    assert!(
        session
            .projection_authority()
            .resolve(&request)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!fixture.namespace_exists());
}

#[derive(Debug, Default)]
struct CardProvider(std::sync::atomic::AtomicUsize);
impl kcoder_api::Provider for CardProvider {
    fn name(&self) -> &'static str {
        "owned-office-card-recorder"
    }
    fn stream_messages(
        &self,
        _request: kcoder_types::MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let first = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
        Ok(Box::pin(async_stream::stream! {
            if first {
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart{index:0,content_block:kcoder_types::ContentBlock::ToolUse{id:"accepted-native-call".into(),name:"OfficeCard".into(),input:card()}});
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop{index:0});
                yield Ok(kcoder_types::StreamEvent::MessageDelta{delta:kcoder_types::MessageDeltaFields{stop_reason:Some("tool_use".into()),stop_sequence:None,usage:None}});
            }else{
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart{index:0,content_block:kcoder_types::ContentBlock::Text{text:"Done".into()}});
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop{index:0});
                yield Ok(kcoder_types::StreamEvent::MessageDelta{delta:kcoder_types::MessageDeltaFields{stop_reason:Some("end_turn".into()),stop_sequence:None,usage:None}});
            }
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}
#[tokio::test]
async fn actual_engine_permission_denial_keeps_first_write_uninitialized_then_allowed_call_initializes_once()
 {
    use futures::StreamExt;
    let denied = Fixture::with_provider(true, Some(Arc::new(CardProvider::default())));
    let denied_session = denied.session(false);
    let denied_engine = denied
        .engine
        .clone()
        .with_turn_tools(denied_session.registry().unwrap());
    denied_engine
        .permissions
        .write()
        .unwrap()
        .denied_tools
        .push("OfficeCard".into());
    let events = denied_engine
        .submit_message_stream(
            "Publish the literal approved data card",
            &kcoder_permissions::AutoAllowPrompt,
        )
        .collect::<Vec<_>>()
        .await;
    assert!(!denied.namespace_exists(), "{events:?}");
    let fixture = Fixture::with_provider(true, Some(Arc::new(CardProvider::default())));
    let session = fixture.session(false);
    let registry = session.registry().unwrap();
    let engine = fixture.engine.clone().with_turn_tools(registry.clone());
    assert!(engine.active_tool_registry().get("OfficeCard").is_some());
    let events = engine
        .submit_message_stream(
            "Publish the literal approved data card",
            &kcoder_permissions::AutoAllowPrompt,
        )
        .collect::<Vec<_>>()
        .await;
    assert!(fixture.namespace_exists(), "{events:?}");
    let composition = session
        .inner
        .composition
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    assert_eq!(
        composition
            .service()
            .store
            .list_artifacts(&fixture.engine.session_id())
            .unwrap()
            .len(),
        1
    );
    let replay =
        ToolContext::new(fixture.engine.state.clone()).with_tool_call_id("accepted-native-call");
    registry
        .get("OfficeCard")
        .unwrap()
        .call(card(), &replay)
        .await
        .unwrap();
    assert_eq!(
        composition
            .service()
            .store
            .list_artifacts(&fixture.engine.session_id())
            .unwrap()
            .len(),
        1
    );
    let mut changed = card();
    changed["title"] = json!("different intent with same Native call");
    assert!(
        registry
            .get("OfficeCard")
            .unwrap()
            .call(changed, &replay)
            .await
            .is_err()
    );
    assert_eq!(
        composition
            .service()
            .store
            .list_artifacts(&fixture.engine.session_id())
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn wrong_current_state_unaccepted_turn_and_cancellation_do_not_bootstrap() {
    let fixture = Fixture::new(true);
    let wrong = fixture.session(true);
    let context = ToolContext::new(fixture.engine.state.clone()).with_tool_call_id("real-call");
    assert!(
        wrong
            .registry()
            .unwrap()
            .get("OfficeCard")
            .unwrap()
            .call(card(), &context)
            .await
            .is_err()
    );
    assert!(!fixture.namespace_exists());
    let session = fixture.session(false);
    let foreign = ToolContext::new(kcoder_state::AppState::new(fixture.engine.state.cwd()))
        .with_tool_call_id("real-call");
    assert!(
        session
            .registry()
            .unwrap()
            .get("OfficeCard")
            .unwrap()
            .call(card(), &foreign)
            .await
            .is_err()
    );
    assert!(!fixture.namespace_exists());
    let token = tokio_util::sync::CancellationToken::new();
    token.cancel();
    let cancelled = ToolContext::new(fixture.engine.state.clone())
        .with_tool_call_id("real-call")
        .with_abort_token(token);
    assert!(
        session
            .registry()
            .unwrap()
            .get("OfficeCard")
            .unwrap()
            .call(card(), &cancelled)
            .await
            .is_err()
    );
    assert!(!fixture.namespace_exists());
}

#[tokio::test]
async fn reopened_lazy_read_uses_existing_original_store_without_replaying_write() {
    let fixture = Fixture::new(true);
    let session = fixture.session(false);
    let context = ToolContext::new(fixture.engine.state.clone()).with_tool_call_id("actual-write");
    session
        .registry()
        .unwrap()
        .get("OfficeCard")
        .unwrap()
        .call(card(), &context)
        .await
        .unwrap();
    let first = session
        .inner
        .composition
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .service()
        .store
        .list_artifacts(&fixture.engine.session_id())
        .unwrap()
        .remove(0);
    drop(session);
    let reopened = fixture.session(false);
    assert!(reopened.inner.composition.lock().unwrap().is_none());
    let read = ToolContext::new(fixture.engine.state.clone()).with_tool_call_id("actual-read");
    reopened
        .registry()
        .unwrap()
        .get("OfficeData")
        .unwrap()
        .call(
            json!({"action":"read_manifest","reference":{"id":first.id,"revision":1}}),
            &read,
        )
        .await
        .unwrap();
    assert_eq!(
        reopened
            .inner
            .composition
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .service()
            .store
            .list_artifacts(&fixture.engine.session_id())
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn disabling_after_registration_prevents_first_write_and_hides_registry() {
    let fixture = Fixture::new(true);
    let session = fixture.session(false);
    let registered = session.registry().unwrap();
    fixture
        .engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = false;
    assert!(session.registry().unwrap().names().is_empty());
    let context =
        ToolContext::new(fixture.engine.state.clone()).with_tool_call_id("before-disable");
    assert!(
        registered
            .get("OfficeCard")
            .unwrap()
            .call(card(), &context)
            .await
            .is_err()
    );
    assert!(!fixture.namespace_exists());
}

#[tokio::test]
async fn pending_original_action_after_reopen_and_source_revision_change_is_not_replayed() {
    let fixture = Fixture::new(true);
    let session = fixture.session(false);
    let original = "native-unknown-call";
    let context = ToolContext::new(fixture.engine.state.clone()).with_tool_call_id(original);
    // Inject a real durable reservation with a lost result at the exact Native
    // operation identity, rather than pretending a lost response means no write.
    let operation = format!(
        "office-call-{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                IntegrationOwner::from(fixture.context.scope()),
                &fixture.task,
                original,
                "OfficeCard"
            ))
            .unwrap()
        )
    );
    let composition = session
        .inner
        .composition(Some(&operation))
        .unwrap()
        .unwrap();
    let mut payload = card();
    payload["task"] = serde_json::to_value(&fixture.task).unwrap();
    composition
        .service()
        .store
        .begin_action(&operation, "artifact.createCard", &payload)
        .unwrap();
    composition
        .service()
        .store
        .dispatch_action_checkpoint(&operation, json!({"dispatched":true}))
        .unwrap();
    drop(composition);
    drop(session);
    let reopened = fixture.session_with_revision(false, "upgraded-native-schema-revision");
    assert!(
        reopened
            .registry()
            .unwrap()
            .get("OfficeCard")
            .unwrap()
            .call(card(), &context)
            .await
            .is_err()
    );
    let composition = reopened
        .inner
        .composition
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    assert!(
        composition
            .service()
            .store
            .list_artifacts(&fixture.engine.session_id())
            .unwrap()
            .is_empty()
    );
    let receipt = composition
        .service()
        .store
        .read_action(&operation)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.phase, "executing");
    assert_eq!(receipt.result, Some(json!({"dispatched":true})));
}
