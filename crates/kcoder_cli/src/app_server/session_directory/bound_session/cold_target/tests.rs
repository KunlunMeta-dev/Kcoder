//! Owned passive-resume regressions. These fixtures grant no product execution authority.
use super::*;
use crate::app_server::{ct85_test_support as owned, session_messages::service::PeerRouterLaunch};
use futures::StreamExt;
use kcoder_app_protocol::RetentionParentLaunchV1;
use kcoder_config::{ConfigPaths, PermissionMode};
use kcoder_state::AppState;
use kcoder_types::Message;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct TerminalSeed;
#[test]
fn cold_directory_does_not_infer_the_latest_terminal_from_wall_clock() {
    owned::run_owned_case(
        concat!(module_path!(), "::owned_terminal_order_case"),
        "cold-terminal-order",
    );
}

#[tokio::test]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_terminal_order_case() -> Result<()> {
    use kcoder_state::turn_attempt_store::{TurnAttemptCompletion, TurnAttemptStore};
    use kcoder_types::TurnAttemptStatus;
    assert_eq!(owned::owned_case(), "cold-terminal-order");
    let fixture = Fixture::new().await?;
    let id = fixture.state.session_id();
    let store = TurnAttemptStore::open_existing(&fixture.original_artifacts.join(&id), &id)?
        .context("actual original ledger")?;
    let mut earlier_clock = store
        .list_with_budget(4, 64 * 1024)?
        .pop()
        .context("original completed turn")?;
    earlier_clock.identity.turn_id = "owned-terminal-after-clock-rollback".into();
    earlier_clock.identity.attempt_id = "owned-attempt-after-clock-rollback".into();
    earlier_clock.accepted_at_ms = earlier_clock.accepted_at_ms.saturating_sub(1);
    earlier_clock.status = TurnAttemptStatus::Accepted;
    earlier_clock.completion = None;
    store.begin(earlier_clock.clone())?;
    store.finish(
        &earlier_clock.identity,
        TurnAttemptCompletion {
            status: TurnAttemptStatus::Completed,
            finished_at_ms: earlier_clock.accepted_at_ms,
            error: None,
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        },
    )?;
    let verify = || Ok(());
    let view = fixture.view(&verify)?;
    let target = SessionDirectory::default()
        .lookup_bound_view(&view, &id, &HashSet::new())?
        .context("original cold target remains discoverable")?;
    assert_eq!(
        target.observation().status,
        kcoder_app_protocol::ThreadStatus::Unknown
    );
    assert!(target.observation().last_turn.is_none());
    Ok(())
}

#[test]
fn budget_limited_first_ledger_does_not_hide_a_second_attempt_source() {
    owned::run_owned_case(
        concat!(module_path!(), "::owned_budget_ambiguous_case"),
        "cold-budget-ambiguous",
    );
}
#[tokio::test]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_budget_ambiguous_case() -> Result<()> {
    use kcoder_state::turn_attempt_store::{
        TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
    };
    use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
    assert_eq!(owned::owned_case(), "cold-budget-ambiguous");
    let fixture = Fixture::new().await?;
    let id = fixture.state.session_id();
    let store = TurnAttemptStore::open(&fixture.bootstrap_storage.join(&id), &id)?;
    for number in 0..257 {
        let identity = TurnAttemptIdentity {
            thread_id: id.clone(),
            turn_id: format!("bounded-source-{number}"),
            attempt_id: format!("bounded-attempt-{number}"),
        };
        store.begin(TurnAttemptRecord {
            version: 1,
            client_presentation: None,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })?;
        store.finish(
            &identity,
            TurnAttemptCompletion {
                status: TurnAttemptStatus::Completed,
                finished_at_ms: 2,
                error: None,
                provider_failure: None,
                partial_output: String::new(),
                partial_output_truncated: false,
                committed_history_uuid: None,
            },
        )?;
    }
    let verify = || Ok(());
    let view = fixture.view(&verify)?;
    let error = SessionDirectory::default()
        .lookup_bound_view(&view, &id, &HashSet::new())
        .err()
        .context("a second physical attempt source cannot be hidden by a budget limit")?;
    ensure!(
        error.to_string().contains("attempt_source_ambiguous"),
        "{error:#}"
    );
    Ok(())
}
impl kcoder_api::Provider for TerminalSeed {
    fn name(&self) -> &'static str {
        "owned-cold-material-terminal-seed"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        use kcoder_types::{ContentBlock, StreamEvent};
        Ok(Box::pin(futures::stream::iter([
            Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "owned-terminal".into(),
                    role: "assistant".into(),
                    content: Vec::new(),
                    model: "owned-terminal".into(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            }),
            Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: "Owned actual terminal seed".into(),
                },
            }),
            Ok(StreamEvent::ContentBlockStop { index: 0 }),
            Ok(StreamEvent::MessageStop),
        ])))
    }
}

async fn complete_original_turn(state: &AppState, root: &Path) -> Result<()> {
    use kcoder_engine::WorkspaceRuntimeServices;
    let settings = kcoder_config::Settings {
        api_format: Some(kcoder_config::ApiFormat::OpenaiChatCompletions),
        model: "owned-terminal".into(),
        context_window_tokens: Some(131072),
        context_output_headroom: Some(8192),
        max_tokens: Some(2048),
        ..Default::default()
    };
    let directory = PrivateDirectory::open_existing(root)?;
    let services =
        WorkspaceRuntimeServices::try_new_for_client(&state.cwd(), "owned-cold-material")?
            .with_existing_client_storage(root, &directory.directory_identity()?)?;
    let engine = QueryEngine::try_new_for_client_with_services(
        Arc::new(TerminalSeed),
        state.clone(),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        state.cwd(),
        Some(true),
        services,
    )?;
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoDenyPrompt)
        .collect::<Vec<_>>()
        .await;
    ensure!(
        !events
            .iter()
            .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_))),
        "owned terminal seed failed: {events:?}"
    );
    let ledger = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
        &root.join(state.session_id()),
        &state.session_id(),
    )?
    .context("actual original seed ledger")?;
    let records = ledger.list_with_budget(4, 64 * 1024)?;
    ensure!(
        records.len() == 1 && records[0].status == kcoder_types::TurnAttemptStatus::Completed,
        "original real stream must settle"
    );
    Ok(())
}

struct CurrentFence {
    current: AtomicBool,
    checks: AtomicUsize,
}
impl Default for CurrentFence {
    fn default() -> Self {
        Self {
            current: AtomicBool::new(true),
            checks: AtomicUsize::new(0),
        }
    }
}
impl ColdPeerTargetFence for CurrentFence {
    fn check_current(&self, _: &SessionAddressV1) -> Result<()> {
        self.checks.fetch_add(1, Ordering::SeqCst);
        ensure!(
            self.current.load(Ordering::SeqCst),
            "owned_current_route_revoked"
        );
        Ok(())
    }
}
struct Fixture {
    _workspace: tempfile::TempDir,
    service: Arc<PeerMessageService>,
    state: AppState,
    history: PathBuf,
    bootstrap_storage: PathBuf,
    original_artifacts: PathBuf,
    lease: Option<SessionLease>,
}
impl Fixture {
    async fn new() -> Result<Self> {
        let workspace = owned::owned_tempdir();
        owned::prepare_workspace(workspace.path());
        let profile_path = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap());
        let profile = PrivateDirectory::open_existing(&profile_path)?;
        profile.atomic_replace(
            OsStr::new("settings.json"),
            &serde_json::to_vec(&json!({
                "cross_session_messages":{"enabled":true,"wake_idle":false}
            }))?,
        )?;
        let service = PeerMessageService::capture(
            ConfigPaths::with_config_dir_and_executable_dir(
                workspace.path(),
                profile_path.clone(),
                None,
            ),
            workspace.path().into(),
            Some(PeerRouterLaunch {
                parent: RetentionParentLaunchV1::LocalOs,
                account_root: profile_path,
            }),
        )?;
        let history = workspace.path().join("original-history");
        PrivateDirectory::open_or_create(&history)?;
        let bootstrap_storage = workspace.path().join("bootstrap-client-sessions");
        PrivateDirectory::open_or_create(&bootstrap_storage)?;
        let original_artifacts = workspace.path().join(".kcoder/sessions");
        let artifacts = PrivateDirectory::open_or_create(&original_artifacts)?;
        let state = AppState::new(workspace.path());
        artifacts.create_private_child(OsStr::new(&state.session_id()))?;
        let path = history.join(format!("{}.jsonl", state.session_id()));
        let lease = SessionLease::acquire(&path)?;
        state.with_history_path(&path);
        state.add_message(Message::user_text("Original owned user request"));
        state.add_message(Message::assistant_text("Original owned terminal answer"));
        state.flush_history().await?;
        complete_original_turn(&state, &original_artifacts).await?;
        let result = Self {
            _workspace: workspace,
            service,
            state,
            history,
            bootstrap_storage,
            original_artifacts,
            lease: Some(lease),
        };
        result.metadata(false)?;
        Ok(result)
    }
    fn metadata(&self, archived: bool) -> Result<()> {
        use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
        let mut fields =
            BTreeMap::from([("permissionModeAtCreation".into(), Some("bypass".into()))]);
        if archived {
            fields.insert("archivedAt".into(), Some("2026-11-13T00:00:00Z".into()));
        }
        let mut journal =
            JournalFence::try_acquire(&self.original_artifacts, JournalDomain::ClientMetadata)?;
        kcoder_thread_metadata::write_thread_metadata(
            &self.original_artifacts.join(self.state.session_id()),
            &kcoder_thread_metadata::ThreadClientMetadata {
                version: 1,
                revision: 1,
                thread_id: self.state.session_id(),
                workspace: self.state.cwd().to_string_lossy().into_owned(),
                fields,
                updated_at: "1".into(),
            },
            &mut journal,
        )
    }
    fn view<'a>(
        &'a self,
        verify: &'a (dyn Fn() -> Result<()> + Send + Sync),
    ) -> Result<DirectorySourceView<'a>> {
        DirectorySourceView::from_host(
            &self.state.cwd(),
            &self.bootstrap_storage,
            Some(&self.history),
            "owned-cold-target-native-owner",
            verify,
        )
    }
    fn snapshot(&self) -> Result<Vec<Vec<u8>>> {
        let path = self
            .state
            .history_path()
            .context("owned original history")?;
        Ok(vec![
            std::fs::read(&path)?,
            std::fs::read(self.state.session_state_path().context("owned sidecar")?)?,
            std::fs::read(path.with_extension("hctl").join("source.json"))?,
        ])
    }
    fn wake(&self, enabled: bool) -> Result<()> {
        let current = self.service.policy()?;
        self.service.save_policy(&current.revision, true, enabled)?;
        Ok(())
    }
}

#[test]
fn cold_target_preparation_retains_original_owner_and_current_consent() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_discovery::session_directory::bound_session::cold_target::tests::owned_cold_target_owner_case",
        "peer-cold-target-owner",
    );
}
#[tokio::test]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_cold_target_owner_case() -> Result<()> {
    assert_eq!(owned::owned_case(), "peer-cold-target-owner");
    let mut fixture = Fixture::new().await?;
    let fence = CurrentFence::default();
    let address = fixture.service.address(&fixture.state.session_id())?;
    let verify = || Ok(());
    let before = fixture.snapshot()?;
    {
        let view = fixture.view(&verify)?;
        let observed = observe_cold_target(&fixture.service, &view, &address, &fence)?;
        assert_eq!(
            observed.observation().status,
            kcoder_app_protocol::ThreadStatus::Unknown
        );
        assert!(
            observed.observation().allowed_modes.is_empty(),
            "facts never manufacture a send permit"
        );
        assert!(
            PreparedColdPeerTarget::prepare_wake(&fixture.service, &view, &address, &fence)
                .is_err(),
            "enqueue eligibility never opts an idle target into wake"
        );
        fixture.wake(true)?;
        assert!(
            PreparedColdPeerTarget::prepare_wake(&fixture.service, &view, &address, &fence)
                .is_err(),
            "the original live owner cannot be displaced"
        );
    }
    fixture.lease.take();
    let view = fixture.view(&verify)?;
    let mut prepared =
        PreparedColdPeerTarget::prepare_wake(&fixture.service, &view, &address, &fence)?;
    assert_eq!(prepared.artifact_root(), fixture.original_artifacts);
    assert_ne!(prepared.artifact_root(), fixture.bootstrap_storage);
    assert_eq!(prepared.client_turn_count(), 1);
    assert_eq!(
        prepared.permission_mode_at_creation(),
        Some(PermissionMode::Bypass)
    );
    assert!(prepared.settings_template().is_none());
    assert!(
        SessionLease::acquire_existing_history(&fixture.state.history_path().unwrap()).is_err()
    );
    let material = prepared.take_prepared(&fixture.service, &view, &fence)?;
    assert_eq!(
        material.persisted_base_cwd(),
        Some(fixture.state.cwd().as_path())
    );
    assert!(
        prepared
            .take_prepared(&fixture.service, &view, &fence)
            .is_err()
    );
    prepared.verify(&fixture.service, &view, &fence)?;
    fence.current.store(false, Ordering::SeqCst);
    assert!(prepared.verify(&fixture.service, &view, &fence).is_err());
    fence.current.store(true, Ordering::SeqCst);
    fixture.wake(false)?;
    assert!(prepared.verify(&fixture.service, &view, &fence).is_err());
    fixture.wake(true)?;
    prepared.verify(&fixture.service, &view, &fence)?;
    assert_eq!(
        fixture.snapshot()?,
        before,
        "passive preparation adds no User, Peer, Goal or history writes"
    );
    drop(material);
    drop(prepared);
    SessionLease::acquire_existing_history(&fixture.state.history_path().unwrap())?;
    assert!(fence.checks.load(Ordering::SeqCst) >= 8);
    Ok(())
}

#[test]
fn cold_target_preparation_rejects_archive_ambiguous_artifacts_and_replaced_sources() {
    owned::run_owned_case(
        "kcoder_cli_runtime::app_server::session_discovery::session_directory::bound_session::cold_target::tests::owned_cold_target_history_case",
        "peer-cold-target-history",
    );
}
#[tokio::test]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_cold_target_history_case() -> Result<()> {
    assert_eq!(owned::owned_case(), "peer-cold-target-history");
    let mut fixture = Fixture::new().await?;
    fixture.wake(true)?;
    fixture.lease.take();
    let fence = CurrentFence::default();
    let address = fixture.service.address(&fixture.state.session_id())?;
    let verify = || Ok(());
    let view = fixture.view(&verify)?;
    fixture.metadata(true)?;
    assert!(observe_cold_target(&fixture.service, &view, &address, &fence).is_err());
    fixture.metadata(false)?;
    let duplicate = PrivateDirectory::open_existing(&fixture.bootstrap_storage)?
        .create_private_child(OsStr::new(&address.thread_id))?;
    duplicate.verify_private_directory()?;
    assert!(
        PreparedColdPeerTarget::prepare_wake(&fixture.service, &view, &address, &fence).is_err()
    );
    drop(duplicate);
    std::fs::remove_dir(fixture.bootstrap_storage.join(&address.thread_id))?;
    let prepared = PreparedColdPeerTarget::prepare_wake(&fixture.service, &view, &address, &fence)?;
    let history = fixture.state.history_path().unwrap();
    let original = history.with_extension("owned-original");
    std::fs::rename(&history, &original)?;
    std::fs::write(&history, std::fs::read(&original)?)?;
    assert!(
        prepared.verify(&fixture.service, &view, &fence).is_err(),
        "same bytes cannot replace the held Native source"
    );
    drop(prepared);
    std::fs::remove_file(&history)?;
    std::fs::rename(&original, &history)?;
    let lease = history.with_extension("lease");
    let original_lease = history.with_extension("owned-lease");
    std::fs::rename(&lease, &original_lease)?;
    assert!(
        PreparedColdPeerTarget::prepare_wake(&fixture.service, &view, &address, &fence).is_err()
    );
    assert!(
        !lease.exists(),
        "automatic wake cannot repair a missing original lease"
    );
    observe_cold_target(&fixture.service, &view, &address, &fence)?;
    assert!(!lease.exists(), "enqueue observation remains read only");
    std::fs::rename(&original_lease, &lease)?;
    std::fs::rename(&history, &original)?;
    assert!(observe_cold_target(&fixture.service, &view, &address, &fence).is_err());
    assert!(
        !history.exists(),
        "missing history never creates an empty replacement"
    );
    std::fs::rename(&original, &history)?;
    Ok(())
}
