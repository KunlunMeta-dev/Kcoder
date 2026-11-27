//! Actual local carrier disappearance and original Native cold authorization.
use super::*;
use crate::app_server::ct85_test_support as owned;
use async_trait::async_trait;
use clap::Parser;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_config::{ConfigPaths, PrivateDirectory, Settings, SettingsLoader};
use kcoder_engine::WorkspaceRuntimeServices;
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
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
        "owned-local-cold-source-no-model"
    }
    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> std::result::Result<ProviderStream, ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("cold authorization must never invoke a model")
    }
}
struct UnavailableHost;
#[async_trait]
impl SessionMessagesHost for UnavailableHost {
    async fn send(
        &self,
        _: SessionMessageCall,
        _: AgentMessageIntent,
    ) -> std::result::Result<Value, SessionMessageSendError> {
        panic!("a cold authorization reader cannot send a new message")
    }
    async fn receipt(
        &self,
        _: SessionMessageCall,
        _: Value,
    ) -> std::result::Result<Value, ToolError> {
        panic!("a cold authorization reader cannot manufacture a receipt")
    }
}
#[test]
fn stopped_local_source_uses_original_history_and_fresh_configuration() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_messages::cold_source::local_owner::tests::owned_local_cold_source_case",
        "peer-local-cold-source",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_local_cold_source_case() -> Result<()> {
    assert_eq!(owned::owned_case(), "peer-local-cold-source");
    let workspace = owned::owned_tempdir();
    owned::prepare_workspace(workspace.path());
    let profile_path = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap());
    let profile = PrivateDirectory::open_existing(&profile_path)?;
    let client_storage_path = Settings::project_data_dir(workspace.path())?.join("client-sessions");
    PrivateDirectory::open_or_create(&client_storage_path)?.verify_trusted_config_directory()?;
    let document = json!({"active_provider":"fixture","model":"fixture-model","permission_mode":"bypass",
    "history_enabled":true,"tools":{"profile":"full"},"cross_session_messages":{"enabled":true,"wake_idle":false},
    "providers":{"fixture":{"api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:1/v1",
        "default_model":"fixture-model","context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192,
        "request_timeout_secs":30,"authentication":{"mode":"none"},"no_proxy":true,"models":{
            "fixture-model":{"context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192,"capabilities":{"tools":true}}
        }}}});
    profile.atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&document)?)?;
    let history = workspace.path().join("history");
    PrivateDirectory::open_or_create(&history)?;
    let calls = Arc::new(AtomicUsize::new(0));
    let settings: Settings = serde_json::from_value(document.clone())?;
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
        WorkspaceRuntimeServices::try_new_for_client(workspace.path(), "owned-local-cold-source")?,
        Some(profile_path.join("settings.json")),
        workspace.path().join("owned-session-ids"),
    )
    .with_session_configuration(
        SettingsLoader::new(workspace.path())
            .with_config_dir(&profile_path)
            .with_executable_dir(workspace.path()),
        crate::Cli::parse_from(["kcoder"]),
        false,
    )?;
    factory.set_session_messages_host(Arc::new(UnavailableHost));
    let service = PeerMessageService::capture(
        ConfigPaths::with_config_dir_and_executable_dir(workspace.path(), profile_path, None),
        workspace.path().into(),
        None,
    )?;
    assert!(
        !service.has_private_parent(),
        "the local owner never invents Gateway parent authority"
    );
    let native_capture = NativeColdPeerSourceVerifier::capture(
        service.clone(),
        factory.clone(),
        workspace.path().into(),
        client_storage_path.clone(),
        Some(history.clone()),
    );
    assert!(
        native_capture
            .err()
            .is_some_and(|error| error.to_string() == "peer_cold_source_native_owner_required"),
        "the Native management verifier must reject this same Local service"
    );
    let receiver_state = kcoder_state::AppState::new(workspace.path());
    let receiver_path = history.join(format!("{}.jsonl", receiver_state.session_id()));
    let receiver_lease = SessionLease::acquire(&receiver_path)?;
    receiver_state.with_history_path(&receiver_path);
    receiver_state.add_message(Message::user_text("Owned original receiver"));
    let receiver = factory.build_with_state(
        receiver_state,
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
    )?;
    assert_eq!(receiver.client_storage_root(), client_storage_path);
    receiver.state.flush_history().await?;
    let receiver_owner =
        BoundPeerSource::capture(&receiver, service.clone(), receiver_lease.native_witness()?)?;
    let receiver_status = receiver_owner.observe_status()?;
    assert_eq!(
        receiver_status.address,
        Some(receiver_owner.address()?),
        "the persisted receiver fixture must expose its current owned status before admission"
    );
    let receiver_endpoint = crate::peer_sessions::PeerSourceEndpoint::bind(receiver_owner.clone())?;
    let verifier =
        LocalNativeColdPeerSourceVerifier::capture(&receiver, &receiver_owner, factory.clone())?;
    let source_state = kcoder_state::AppState::new(workspace.path());
    let source_path = history.join(format!("{}.jsonl", source_state.session_id()));
    let source_lease = SessionLease::acquire(&source_path)?;
    source_state.with_history_path(&source_path);
    source_state.add_message(Message::user_text("Owned original Source permission"));
    let source =
        factory.build_with_state(source_state, Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    source.state.flush_history().await?;
    let source_owner =
        BoundPeerSource::capture(&source, service.clone(), source_lease.native_witness()?)?;
    let endpoint = crate::peer_sessions::PeerSourceEndpoint::bind(source_owner.clone())?;
    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: receiver.session_id(),
        target_address: Some(receiver_owner.address()?),
        client_message_id: "owned-local-cold-source-request".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "Original bounded peer contribution".into(),
    };
    let receipt = service.prepare_local(
        &source.state,
        source_owner.owner(),
        source_owner.as_ref(),
        &source.client_storage_root(),
        intent,
    )?;
    let record = service
        .mailbox()?
        .get_record_by_message_id(&receipt.message_id)?
        .context("original queued message")?;
    let original_bytes = std::fs::read(&source_path)?;
    let check = |access| {
        crate::peer_sessions::cold_source::verify_local_source_for_delivery(
            &service,
            &record,
            access,
            Some(verifier.as_ref()),
        )
    };
    check(kcoder_state::peer_agent_history::PeerHistoryAccess::Observe)?;
    endpoint.close().await;
    drop(source_owner);
    assert!(
        crate::peer_sessions::check_original_source(
            &service,
            record.source.address.as_ref().unwrap(),
            &crate::peer_sessions::OriginalSourceCheck::for_intent(&record.intent)?
        )
        .unwrap_err()
        .downcast_ref::<crate::peer_sessions::OriginalSourceUnavailable>()
        .is_some()
    );
    assert!(
        check(kcoder_state::peer_agent_history::PeerHistoryAccess::Append).is_err(),
        "missing carrier cannot bypass an original kernel lease which is still held"
    );
    drop(source_lease);
    for access in [
        kcoder_state::peer_agent_history::PeerHistoryAccess::Observe,
        kcoder_state::peer_agent_history::PeerHistoryAccess::Append,
        kcoder_state::peer_agent_history::PeerHistoryAccess::Wake,
    ] {
        check(access)?;
    }
    let mut denied = document.clone();
    denied["tools"]["disabled"] = json!(["SendSessionMessage"]);
    profile.atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&denied)?)?;
    assert!(
        check(kcoder_state::peer_agent_history::PeerHistoryAccess::Append).is_err(),
        "a stopped source cannot reuse its signed old tool permission"
    );
    profile.atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&document)?)?;
    check(kcoder_state::peer_agent_history::PeerHistoryAccess::Append)?;
    let source_metadata_directory = kcoder_thread_metadata::ensure_thread_metadata_directory(
        &receiver.client_storage_root(),
        &source.session_id(),
    )?;
    for archived in [true, false] {
        use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
        let mut fields = std::collections::BTreeMap::new();
        if archived {
            fields.insert("archivedAt".into(), Some("2026-11-13T00:00:00Z".into()));
        }
        let mut journal = JournalFence::try_acquire(
            &receiver.client_storage_root(),
            JournalDomain::ClientMetadata,
        )?;
        kcoder_thread_metadata::write_thread_metadata(
            &source_metadata_directory,
            &kcoder_thread_metadata::ThreadClientMetadata {
                version: 1,
                revision: 1,
                thread_id: source.session_id(),
                workspace: workspace.path().to_string_lossy().into_owned(),
                fields,
                updated_at: "1".into(),
            },
            &mut journal,
        )?;
        drop(journal);
        let result = check(kcoder_state::peer_agent_history::PeerHistoryAccess::Append);
        if archived {
            assert!(
                result.is_err(),
                "human archival revokes a stopped Source too"
            );
        } else {
            result?;
        }
    }
    let foreign_owner = SessionLease::acquire_existing_history(&source_path)?;
    assert!(check(kcoder_state::peer_agent_history::PeerHistoryAccess::Append).is_err());
    drop(foreign_owner);
    let mut changed = record.clone();
    changed.intent.text.push('!');
    assert!(
        crate::peer_sessions::cold_source::verify_local_source_for_delivery(
            &service,
            &changed,
            kcoder_state::peer_agent_history::PeerHistoryAccess::Append,
            Some(verifier.as_ref())
        )
        .is_err()
    );
    assert_eq!(std::fs::read(&source_path)?, original_bytes);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        service
            .mailbox()?
            .get_by_client_id(&record.source, &record.intent.client_message_id)?
            .unwrap()
            .message_id,
        receipt.message_id,
        "all recovery uses the same original CID and queued receipt"
    );
    receiver_endpoint.close().await;
    drop(receiver_lease);
    assert!(
        check(kcoder_state::peer_agent_history::PeerHistoryAccess::Append).is_err(),
        "the reader cannot prolong its actual receiver's weak kernel lease"
    );
    Ok(())
}
