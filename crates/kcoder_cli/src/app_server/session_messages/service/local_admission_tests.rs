//! Real private profile, Source witness and durable queue; no models or personal sessions.
use super::*;
use crate::app_server::{ct85_test_support as owned, thread_metadata};
use async_trait::async_trait;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_cli_storage::session_lease::SessionLease;
use kcoder_engine::{QueryEngine, WorkspaceRuntimeServices};
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_tools::{
    DenyAllUserQuestioner, ToolError, ToolRegistry,
    session_messages::{SessionMessageCall, SessionMessageSendError, SessionMessagesHost},
};
use kcoder_types::{Message, MessagesRequest};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};

struct NoModel(Arc<AtomicUsize>);
impl Provider for NoModel {
    fn name(&self) -> &'static str {
        "owned-local-admission-no-model"
    }
    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> std::result::Result<ProviderStream, ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("admission must not invoke a Provider")
    }
}
struct UnusedHost;
#[async_trait]
impl SessionMessagesHost for UnusedHost {
    async fn send(
        &self,
        _: SessionMessageCall,
        _: AgentMessageIntent,
    ) -> std::result::Result<Value, SessionMessageSendError> {
        panic!("direct Native admission fixture")
    }
    async fn receipt(
        &self,
        _: SessionMessageCall,
        _: Value,
    ) -> std::result::Result<Value, ToolError> {
        panic!("direct Native admission fixture")
    }
}

#[test]
fn same_workspace_admission_rejects_missing_before_source_writes() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_messages::service::local_admission_tests::owned_same_workspace_admission",
        "same-workspace-missing",
    );
}

#[test]
fn same_workspace_admission_rejects_archived_before_source_writes() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_messages::service::local_admission_tests::owned_same_workspace_admission",
        "same-workspace-archived",
    );
}

#[test]
fn same_workspace_admission_preserves_original_after_archive_expiry_and_rejects_changed_intent() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_messages::service::local_admission_tests::owned_same_workspace_admission",
        "same-workspace-original",
    );
}

#[test]
fn same_workspace_admission_fresh_source_revoke_and_metadata_contention_do_not_write() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_messages::service::local_admission_tests::owned_same_workspace_admission",
        "same-workspace-fences",
    );
}

#[test]
fn same_workspace_admission_accepts_actual_live_endpoint_before_history_materializes() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_messages::service::local_admission_tests::owned_same_workspace_admission",
        "same-workspace-live-empty",
    );
}
#[test]
fn same_workspace_admission_resident_and_protected_role_keep_original_receipt() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_messages::service::local_admission_tests::owned_same_workspace_admission",
        "same-workspace-resident",
    );
}
#[test]
fn same_workspace_admission_cold_wake_requires_the_actual_executor() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_messages::service::local_admission_tests::owned_same_workspace_admission",
        "same-workspace-cold-mode",
    );
}

fn insert_runtime(
    manager: &mut crate::app_server::ThreadManager,
    engine: QueryEngine,
) -> Result<()> {
    use crate::app_server::{
        BackgroundEventPump, BackgroundFollowupScheduler, BackgroundFollowupState,
        BackgroundProjectionState, InteractionReceipts, ResidentTurnState, ThreadRuntime,
    };
    let (outbound, _receiver) = tokio::sync::mpsc::channel(8);
    let projection = Arc::new(tokio::sync::Mutex::new(BackgroundProjectionState::default()));
    let followups = Arc::new(BackgroundFollowupState::default());
    let turn_state = ResidentTurnState::new(
        outbound.clone(),
        kcoder_config::PermissionMode::Ask,
        Arc::new(std::sync::atomic::AtomicU64::new(1)),
        Arc::new(std::sync::Mutex::new(InteractionReceipts::default())),
    );
    let pump = BackgroundEventPump::spawn(&engine, projection.clone(), followups.clone(), outbound);
    let lease = SessionLease::acquire(&engine.session_lease_target())?;
    let runtime = ThreadRuntime::new(
        engine,
        lease,
        projection,
        followups,
        (pump, BackgroundFollowupScheduler::disabled_for_test()),
        turn_state,
    );
    assert!(manager.insert(runtime).is_ok());
    Ok(())
}

struct RevokeBeforeCommit<'a> {
    source: &'a crate::peer_sessions::BoundPeerSource,
    checks: AtomicUsize,
}
impl LocalPeerSourceAuthorization for RevokeBeforeCommit<'_> {
    fn check_current(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        intent: &AgentMessageIntent,
    ) -> Result<()> {
        if self.checks.fetch_add(1, Ordering::SeqCst) != 0 {
            self.source.revoke();
        }
        self.source.check_current(state, owner, intent)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_same_workspace_admission() -> Result<()> {
    let case = owned::owned_case();
    assert!(
        [
            "same-workspace-missing",
            "same-workspace-archived",
            "same-workspace-original",
            "same-workspace-fences",
            "same-workspace-live-empty",
            "same-workspace-resident",
            "same-workspace-cold-mode"
        ]
        .contains(&case.as_str())
    );
    let workspace = owned::owned_tempdir();
    owned::prepare_workspace(workspace.path());
    let profile = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap());
    let mut settings: kcoder_config::Settings = serde_json::from_value(json!({
        "active_provider":"fixture", "model":"fixture-model", "permission_mode":"ask", "history_enabled":true,
        "max_tokens":2048,
        "cross_session_messages":{"enabled":true,"wake_idle":true},
        "providers":{"fixture":{"api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:1/v1",
            "default_model":"fixture-model","authentication":{"mode":"none"},"no_proxy":true,
            "context_window_tokens":128000,"max_output_tokens":2048,"output_headroom_tokens":8192}}
    }))?;
    settings.apply_provider(Some("fixture"))?;
    kcoder_config::PrivateDirectory::open_existing(&profile)?
        .atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&settings)?)?;
    let history = workspace.path().join("history");
    kcoder_config::PrivateDirectory::open_or_create(&history)?;
    let storage = Arc::new(kcoder_config::create_private_temp_dir_in(
        workspace.path(),
        "client-sessions",
    )?);
    let services = WorkspaceRuntimeServices::new(workspace.path(), "owned-local-admission")
        .with_private_client_storage(storage);
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = |persist: bool| -> Result<QueryEngine> {
        let value = QueryEngine::try_new_for_client_with_services_and_plugin_snapshot(
            Arc::new(NoModel(calls.clone())),
            AppState::new(workspace.path()),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings.clone(),
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::empty(),
            Arc::new(DenyAllUserQuestioner),
            workspace.path().to_owned(),
            Some(false),
            services.clone(),
            kcoder_plugins::EffectivePluginSnapshot::default(),
            Some(&profile.join("settings.json")),
        )?
        .with_session_messages_host(Arc::new(UnusedHost))?;
        value
            .state
            .with_history_path(history.join(format!("{}.jsonl", value.session_id())));
        if persist {
            value
                .state
                .add_message(Message::user_text("Owned admission source or target"));
            value.state.save_history()?;
        }
        Ok(value)
    };
    let source = engine(true)?;
    let target = engine(case != "same-workspace-live-empty")?;
    if case == "same-workspace-archived" {
        thread_metadata::update_thread_metadata(
            &target,
            kcoder_app_protocol::ThreadMetadataUpdateParams {
                thread_id: target.session_id(),
                archived_at: kcoder_app_protocol::MetadataUpdate::Set(
                    "2026-11-15T00:00:00Z".into(),
                ),
                ..Default::default()
            },
            &Default::default(),
            true,
        )?;
    }
    let source_lease = SessionLease::acquire(&source.session_lease_target())?;
    let service = PeerMessageService::capture(
        ConfigPaths::with_config_dir_and_executable_dir(workspace.path(), profile, None),
        workspace.path().to_owned(),
        None,
    )?;
    let bound = crate::peer_sessions::BoundPeerSource::capture(
        &source,
        service.clone(),
        source_lease.native_witness()?,
    )?;
    if [
        "same-workspace-live-empty",
        "same-workspace-resident",
        "same-workspace-cold-mode",
    ]
    .contains(&case.as_str())
    {
        let intent = AgentMessageIntent {
            reply_to_message_id: None,
            target_thread_id: target.session_id(),
            target_address: None,
            client_message_id: "original-valid-native-target".into(),
            mode: AgentMessageMode::EnqueueOnly,
            expected_turn_id: None,
            text: "Owned valid Native target".into(),
        };
        let prepare = |intent| {
            service.prepare_local(
                &source.state,
                bound.owner(),
                bound.as_ref(),
                &source.client_storage_root(),
                intent,
            )
        };
        if case == "same-workspace-live-empty" {
            assert_eq!(target.state.message_count(), 0);
            let target_lease = SessionLease::acquire(&target.session_lease_target())?;
            let target_owner = crate::peer_sessions::BoundPeerSource::capture(
                &target,
                service.clone(),
                target_lease.native_witness()?,
            )?;
            let endpoint = crate::peer_sessions::PeerSourceEndpoint::bind(target_owner)?;
            let receipt = prepare(intent.clone())?;
            assert_eq!(
                receipt.status,
                kcoder_types::cross_session_messages::AgentMessageStatus::Queued
            );
            thread_metadata::update_thread_metadata(
                &target,
                kcoder_app_protocol::ThreadMetadataUpdateParams {
                    thread_id: target.session_id(),
                    archived_at: kcoder_app_protocol::MetadataUpdate::Set(
                        "2026-11-15T00:00:00Z".into(),
                    ),
                    ..Default::default()
                },
                &Default::default(),
                true,
            )?;
            assert_eq!(prepare(intent.clone())?, receipt);
            let mut new = intent;
            new.client_message_id.push_str("-new");
            assert!(matches!(
                super::local_send_error(prepare(new).unwrap_err()),
                SessionMessageSendError::Rejected {
                    code: "peer_message_target_archived"
                }
            ));
            endpoint.close().await;
        } else if case == "same-workspace-resident" {
            let mut manager = crate::app_server::ThreadManager::with_resident_limit(2);
            insert_runtime(&mut manager, target.clone())?;
            let prepare_resident = |manager: &crate::app_server::ThreadManager, intent| {
                service.prepare_local_in_manager(
                    &source.state,
                    bound.owner(),
                    bound.as_ref(),
                    &source.client_storage_root(),
                    intent,
                    manager,
                )
            };
            let receipt = prepare_resident(&manager, intent.clone())?;
            let mut stale_turn = intent.clone();
            stale_turn.client_message_id.push_str("-turn");
            stale_turn.expected_turn_id = Some("turn-missing".into());
            assert!(prepare_resident(&manager, stale_turn).is_err());
            let runtime = manager
                .remove_if_idle(&target.session_id())
                .unwrap()
                .unwrap();
            assert!(manager.insert(runtime.with_ephemeral()).is_ok());
            assert_eq!(prepare_resident(&manager, intent.clone())?, receipt);
            let mut new = intent;
            new.client_message_id.push_str("-protected");
            let id = new.client_message_id.clone();
            assert!(prepare_resident(&manager, new).is_err());
            assert!(
                service
                    .authority()?
                    .store()?
                    .read_operation(&PeerMessageService::operation_id(
                        &service.address(&source.session_id())?,
                        &id
                    )?)?
                    .is_none()
            );
            for runtime in manager.drain() {
                runtime.shutdown().await;
            }
        } else {
            prepare(intent.clone())?;
            let mut wake = intent;
            wake.client_message_id.push_str("-wake");
            wake.mode = AgentMessageMode::WakeIfIdle;
            assert!(matches!(
                super::local_send_error(prepare(wake).unwrap_err()),
                SessionMessageSendError::Rejected {
                    code: "peer_message_mode_denied"
                }
            ));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        return Ok(());
    }
    let target_id = if case == "same-workspace-missing" {
        "missing-original-target".to_owned()
    } else {
        target.session_id()
    };
    if case == "same-workspace-original" || case == "same-workspace-fences" {
        let intent = AgentMessageIntent {
            reply_to_message_id: None,
            target_thread_id: target.session_id(),
            target_address: Some(service.address(&target.session_id())?),
            client_message_id: "original-admission-request".into(),
            mode: AgentMessageMode::EnqueueOnly,
            expected_turn_id: None,
            text: "Owned original contribution".into(),
        };
        let prepare = |intent| {
            service.prepare_local(
                &source.state,
                bound.owner(),
                bound.as_ref(),
                &source.client_storage_root(),
                intent,
            )
        };
        if case == "same-workspace-fences" {
            let locks = kcoder_thread_metadata::try_acquire_thread_lifecycle_locks_at_root(
                &target.client_storage_root(),
                &[&target.session_id()],
            )?;
            let before = service.mailbox()?.revision()?;
            assert!(prepare(intent.clone()).is_err());
            drop(locks);
            let authorization = RevokeBeforeCommit {
                source: &bound,
                checks: AtomicUsize::new(0),
            };
            let result = service.prepare_local(
                &source.state,
                bound.owner(),
                &authorization,
                &source.client_storage_root(),
                intent.clone(),
            );
            assert!(result.is_err());
            assert!(matches!(
                super::local_send_error(result.unwrap_err()),
                SessionMessageSendError::Rejected { .. }
            ));
            assert!(
                service
                    .authority()?
                    .store()?
                    .read_operation(&PeerMessageService::operation_id(
                        &bound.service().address(&source.session_id())?,
                        &intent.client_message_id
                    )?)?
                    .is_none()
            );
            assert!(
                service
                    .mailbox()?
                    .get_by_client_id(
                        &service.message_source(&source.session_id())?,
                        &intent.client_message_id
                    )?
                    .is_none()
            );
            assert_eq!(service.mailbox()?.revision()?, before);
        } else {
            let original = prepare(intent.clone())?;
            assert_eq!(
                original.status,
                kcoder_types::cross_session_messages::AgentMessageStatus::Queued
            );
            let before = service.mailbox()?.revision()?;
            assert_eq!(prepare(intent.clone())?, original);
            assert_eq!(service.mailbox()?.revision()?, before);
            service.mailbox()?.expire_queued(before, u64::MAX)?;
            let expired = prepare(intent.clone())?;
            assert_eq!(expired.reason_code.as_deref(), Some("message_expired"));
            thread_metadata::update_thread_metadata(
                &target,
                kcoder_app_protocol::ThreadMetadataUpdateParams {
                    thread_id: target.session_id(),
                    archived_at: kcoder_app_protocol::MetadataUpdate::Set(
                        "2026-11-15T00:00:00Z".into(),
                    ),
                    ..Default::default()
                },
                &Default::default(),
                true,
            )?;
            let before = service.mailbox()?.revision()?;
            assert_eq!(prepare(intent.clone())?, expired);
            let mut changed = intent.clone();
            changed.text.push_str(" changed");
            assert!(prepare(changed).is_err());
            let mut changed = intent;
            changed.mode = AgentMessageMode::WakeIfIdle;
            assert!(prepare(changed).is_err());
            assert_eq!(service.mailbox()?.revision()?, before);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        return Ok(());
    }
    {
        for explicit in [false, true] {
            let cid = format!("invalid-{case}-{explicit}");
            let intent = AgentMessageIntent {
                reply_to_message_id: None,
                target_thread_id: target_id.clone(),
                target_address: explicit.then(|| service.address(&target_id)).transpose()?,
                client_message_id: cid.clone(),
                mode: AgentMessageMode::EnqueueOnly,
                expected_turn_id: None,
                text: "Owned invalid-target admission probe".into(),
            };
            let operation_id =
                PeerMessageService::operation_id(&service.address(&source.session_id())?, &cid)?;
            let before = service.mailbox()?.revision()?;
            let result = service.prepare_local(
                &source.state,
                bound.owner(),
                bound.as_ref(),
                &source.client_storage_root(),
                intent,
            );
            assert!(
                result.is_err(),
                "invalid target must reject before admission, got {result:?}"
            );
            assert!(matches!(
                super::local_send_error(result.unwrap_err()),
                SessionMessageSendError::Rejected { .. }
            ));
            assert!(
                service
                    .authority()?
                    .store()?
                    .read_operation(&operation_id)?
                    .is_none(),
                "invalid target cannot create a Source operation"
            );
            assert!(
                service
                    .mailbox()?
                    .get_by_client_id(&service.message_source(&source.session_id())?, &cid)?
                    .is_none()
            );
            assert_eq!(service.mailbox()?.revision()?, before);
        }
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    Ok(())
}
