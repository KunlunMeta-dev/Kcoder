//! Real management-owned cold verifier in a private re-exec; no Gateway/network acceptance is claimed.
use super::*;
use crate::app_server::{ct85_test_support as owned, session_messages::service::PeerRouterLaunch};
use async_trait::async_trait;
use clap::Parser;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_app_protocol::RetentionParentLaunchV1;
use kcoder_config::{ConfigPaths, PrivateDirectory, Settings, SettingsLoader};
use kcoder_engine::WorkspaceRuntimeServices;
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_state::AppState;
use kcoder_tools::{
    ToolError, ToolRegistry,
    session_messages::{SessionMessageCall, SessionMessageSendError, SessionMessagesHost},
};
use kcoder_types::{Message, MessagesRequest, cross_session_messages::*};
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    sync::atomic::{AtomicUsize, Ordering},
};

struct NoModel(Arc<AtomicUsize>);
impl Provider for NoModel {
    fn name(&self) -> &'static str {
        "owned-cold-source-no-model"
    }
    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> std::result::Result<ProviderStream, ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("a cold permission observation must not invoke a model")
    }
}
struct UnavailableHost(Arc<AtomicUsize>);
#[async_trait]
impl SessionMessagesHost for UnavailableHost {
    async fn send(
        &self,
        _: SessionMessageCall,
        _: AgentMessageIntent,
    ) -> std::result::Result<Value, SessionMessageSendError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(SessionMessageSendError::Rejected {
            code: "owned_fixture_host_unavailable",
        })
    }
    async fn receipt(
        &self,
        _: SessionMessageCall,
        _: Value,
    ) -> std::result::Result<Value, ToolError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ToolError::Execution("owned fixture unavailable".into()))
    }
}
#[test]
fn stopped_original_source_is_rechecked_without_provider_history_or_config_writes() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_messages::cold_source::tests::owned_cold_source_case",
        "peer-cold-source",
    );
}
#[tokio::test]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_cold_source_case() -> Result<()> {
    assert_eq!(owned::owned_case(), "peer-cold-source");
    let workspace = owned::owned_tempdir();
    owned::prepare_workspace(workspace.path());
    let profile_path = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap());
    let profile = PrivateDirectory::open_existing(&profile_path)?;
    let settings_path = profile_path.join("settings.json");
    let settings_json = json!({
        "active_provider":"fixture","model":"fixture-model","permission_mode":"bypass",
        "history_enabled":true,"tools":{"profile":"full"},
        "cross_session_messages":{"enabled":true,"wake_idle":false},
        "providers":{"fixture":{"api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:1/v1","default_model":"fixture-model","context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192,"request_timeout_secs":30,"authentication":{"mode":"none"},"no_proxy":true,"extra_body":{},"models":{
            "fixture-model":{"context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192,"capabilities":{"tools":true}},
            "no-tools":{"context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192,"capabilities":{"tools":false}}
        }}}
    });
    profile.atomic_replace(
        OsStr::new("settings.json"),
        &serde_json::to_vec(&settings_json)?,
    )?;
    let history = workspace.path().join("history");
    PrivateDirectory::open_or_create(&history)?;
    let storage = workspace.path().join("client-sessions");
    PrivateDirectory::open_or_create(&storage)?;
    let calls = Arc::new(AtomicUsize::new(0));
    let host_calls = Arc::new(AtomicUsize::new(0));
    let settings = Settings::default();
    let mut factory = AppServerEngineFactory::new(
        Arc::new(NoModel(calls.clone())),
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        workspace.path().into(),
        Some(history.clone()),
        true,
        WorkspaceRuntimeServices::try_new_for_client(workspace.path(), "peer-cold-source-test")?,
        Some(settings_path.clone()),
        workspace.path().join("owned-session-ids"),
    )
    .with_session_configuration(
        SettingsLoader::new(workspace.path())
            .with_config_dir(&profile_path)
            .with_executable_dir(workspace.path()),
        crate::Cli::parse_from(["kcoder"]),
        false,
    )?;
    factory.set_session_messages_host(Arc::new(UnavailableHost(host_calls.clone())));
    let paths = ConfigPaths::with_config_dir_and_executable_dir(
        workspace.path(),
        profile_path.clone(),
        None,
    );
    let service = PeerMessageService::capture(
        paths,
        workspace.path().into(),
        Some(PeerRouterLaunch {
            parent: RetentionParentLaunchV1::LocalOs,
            account_root: profile_path.clone(),
        }),
    )?;
    let source = AppState::new(workspace.path());
    let path = history.join(format!("{}.jsonl", source.session_id()));
    let live_lease = SessionLease::acquire(&path)?;
    source.with_history_path(&path);
    source.add_message(Message::user_text(
        "Original source task admitted at its real Native history",
    ));
    source.flush_history().await?;
    let witness = source.peer_source_admission_history(&source.inspection_lifecycle_identity())?;
    assert!(
        witness
            .reference()
            .native_session_lease_identity()
            .is_some()
    );
    let address = service.address(&source.session_id())?;
    let destination = kcoder_types::session_address::SessionAddressV1 {
        target_id: "another-native-target".into(),
        workspace_id: "other-workspace".into(),
        thread_id: source.session_id(),
    };
    let message = PeerRouterMessageV1 {
        reply_to_message_id: None,
        client_message_id: "owned-cold-operation".into(),
        mode: AgentMessageMode::WakeIfIdle,
        expected_turn_id: None,
        text: "Owned cold-source contribution".into(),
    };
    let intent = message.clone().into_intent(destination);
    let id = PeerMessageService::operation_id(&address, &message.client_message_id)?;
    let authority = service.authority()?;
    let store = authority.store()?;
    store.prepare(&id, address.clone(), &intent)?;
    store.record_source_history(&id, &witness)?;
    let operation = store.mark_dispatching(&id)?;
    let verifier = NativeColdPeerSourceVerifier::capture(
        service.clone(),
        factory,
        workspace.path().into(),
        storage,
        Some(history),
    )?;
    assert!(
        verifier
            .check_current(&operation, &message, PeerRouterHistoryAccess::Observe)
            .is_err(),
        "a held original kernel lease forbids cold fallback"
    );
    drop(live_lease);
    let sidecar = source
        .session_state_path()
        .context("actual source sidecar")?;
    let control = path.with_extension("hctl").join("source.json");
    let before = (
        std::fs::read(&path)?,
        std::fs::read(&sidecar)?,
        std::fs::read(&control)?,
        std::fs::read(&settings_path)?,
    );
    for access in [
        PeerRouterHistoryAccess::Observe,
        PeerRouterHistoryAccess::Append,
        PeerRouterHistoryAccess::Wake,
    ] {
        verifier.check_current(&operation, &message, access)?;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(host_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        before,
        (
            std::fs::read(&path)?,
            std::fs::read(&sidecar)?,
            std::fs::read(&control)?,
            std::fs::read(&settings_path)?
        ),
        "cold verification does not write source history, sidecar, native controls or config"
    );
    source.set_model_selection(
        kcoder_types::ModelSelectionMode::Explicit,
        Some("fixture::no-tools".into()),
    )?;
    assert!(
        verifier
            .check_current(&operation, &message, PeerRouterHistoryAccess::Append)
            .is_err(),
        "an explicit source model without tools cannot borrow the target default model's tool capability"
    );
    source.set_model_selection(kcoder_types::ModelSelectionMode::FollowTargetDefault, None)?;
    verifier.check_current(&operation, &message, PeerRouterHistoryAccess::Observe)?;
    let mut changed = message.clone();
    changed.text.push('!');
    assert!(
        verifier
            .check_current(&operation, &changed, PeerRouterHistoryAccess::Append)
            .is_err()
    );
    let mut without = intent.clone();
    without.client_message_id = "signature-without-history".into();
    let other = PeerMessageService::operation_id(&address, &without.client_message_id)?;
    store.prepare(&other, address, &without)?;
    let unsigned_history = store.mark_dispatching(&other)?;
    let without = PeerRouterMessageV1 {
        reply_to_message_id: None,
        client_message_id: without.client_message_id,
        mode: without.mode,
        expected_turn_id: without.expected_turn_id,
        text: without.text,
    };
    assert!(
        verifier
            .check_current(
                &unsigned_history,
                &without,
                PeerRouterHistoryAccess::Observe
            )
            .is_err(),
        "a source signature cannot replace original history facts"
    );
    let mut disabled = settings_json.clone();
    disabled["tools"]["disabled"] = json!(["SendSessionMessage"]);
    profile.atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&disabled)?)?;
    assert!(
        verifier
            .check_current(&operation, &message, PeerRouterHistoryAccess::Append)
            .is_err()
    );
    let mut denied = settings_json.clone();
    denied["permission_rules"] = json!([{"tool":"SendSessionMessage","input_pattern":"text=Owned cold-source contribution","action":"deny"}]);
    profile.atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&denied)?)?;
    assert!(
        verifier
            .check_current(&operation, &message, PeerRouterHistoryAccess::Append)
            .is_err(),
        "current body-dependent denial is read for every access"
    );
    profile.atomic_replace(
        OsStr::new("settings.json"),
        &serde_json::to_vec(&settings_json)?,
    )?;
    verifier.check_current(&operation, &message, PeerRouterHistoryAccess::Observe)?;
    let lease_path = path.with_extension("lease");
    std::fs::rename(&lease_path, workspace.path().join("original-source.lease"))?;
    let parent = PrivateDirectory::open_existing(path.parent().unwrap())?;
    parent.open_read_write_file(lease_path.file_name().unwrap(), true)?;
    assert!(
        verifier
            .check_current(&operation, &message, PeerRouterHistoryAccess::Observe)
            .is_err(),
        "a new lock leaf cannot stand in for the original kernel lease"
    );
    std::fs::remove_file(&lease_path)?;
    assert!(
        verifier
            .check_current(&operation, &message, PeerRouterHistoryAccess::Observe)
            .is_err()
    );
    assert!(
        !lease_path.exists(),
        "missing native lock files are not repaired by a read"
    );
    std::fs::rename(workspace.path().join("original-source.lease"), &lease_path)?;
    verifier.check_current(&operation, &message, PeerRouterHistoryAccess::Observe)?;
    let mut altered: Value = serde_json::from_slice(&std::fs::read(&control)?)?;
    altered["incarnation"] = serde_json::to_value(uuid::Uuid::new_v4())?;
    std::fs::write(&control, serde_json::to_vec(&altered)?)?;
    assert!(
        verifier
            .check_current(&operation, &message, PeerRouterHistoryAccess::Observe)
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(host_calls.load(Ordering::SeqCst), 0);
    Ok(())
}
