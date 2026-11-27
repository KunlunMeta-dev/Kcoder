//! Exercise the real model-tool/channel/resident-manager discovery boundary.
use super::*;
use crate::app_server::{
    BackgroundEventPump, BackgroundFollowupScheduler, BackgroundFollowupState,
    BackgroundProjectionState, InteractionReceipts, ResidentTurnState, SessionLease, ThreadRuntime,
};
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_app_protocol::{MetadataUpdate, ThreadMetadataUpdateParams, ThreadStatus, TurnStatus};
use kcoder_config::{PermissionMode, Settings, ToolProfile};
use kcoder_engine::WorkspaceRuntimeServices;
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_state::turn_attempt_store::{
    TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
};
use kcoder_tools::{DenyAllUserQuestioner, Tool, ToolContext, ToolOutput, ToolRegistry};
use kcoder_types::{
    ContentBlock, Message, MessagesRequest, StreamEvent, TurnAttemptIdentity, TurnAttemptStatus,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Mutex as StdMutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
use tokio::{sync::Mutex, task::JoinHandle};

#[test]
fn older_source_gateway_preserves_default_pages_and_reports_unsupported_search() {
    let cursor = json!({"cursor":"owned-token"});
    assert_eq!(
        gateway_search_input(json!({"limit":10}), false).unwrap(),
        json!({})
    );
    assert_eq!(
        gateway_search_input(json!({"cursor":"owned-token","limit":10}), false).unwrap(),
        cursor
    );
    for request in [
        json!({"title":"安装包"}),
        json!({"limit":32}),
        json!({"allowedMode":"wake_if_idle"}),
    ] {
        let error = gateway_search_input(request.clone(), false).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("session_discovery_search_unsupported")
        );
        assert_eq!(
            gateway_search_input(request.clone(), true).unwrap(),
            request
        );
    }
}

// Re-exec only this exact test with private configuration roots. The parent
// process never changes shared environment or loads a user's Hooks/plugins.
fn owned_case(case: &str) -> anyhow::Result<bool> {
    use std::process::{Command, Stdio};
    const ROOT: &str = "KCODER_SESSION_DISCOVERY_TEST_ROOT";
    const CASE: &str = "KCODER_SESSION_DISCOVERY_TEST_CASE";
    if let Some(actual) = std::env::var_os(CASE) {
        anyhow::ensure!(
            actual == std::ffi::OsStr::new(case),
            "wrong discovery fixture case"
        );
        let root = PathBuf::from(
            std::env::var_os(ROOT)
                .ok_or_else(|| anyhow::anyhow!("missing discovery fixture owner"))?,
        );
        kcoder_config::PrivateDirectory::open_existing(&root)?.verify_private_directory()?;
        anyhow::ensure!(
            std::fs::read_to_string(root.join("owner"))? == case,
            "discovery fixture marker mismatch"
        );
        for key in [
            "HOME",
            "KCODER_CONFIG_DIR",
            "KCODER_HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "TMPDIR",
        ] {
            let path = PathBuf::from(
                std::env::var_os(key).ok_or_else(|| anyhow::anyhow!("missing fixture {key}"))?,
            );
            anyhow::ensure!(
                path.starts_with(&root),
                "discovery fixture {key} escaped its owner"
            );
        }
        std::fs::write(root.join("entered"), case)?;
        return Ok(true);
    }
    let owner = kcoder_config::create_private_temp_dir("session-discovery-test-process")?;
    let directory = kcoder_config::PrivateDirectory::open_existing(owner.path())?;
    for name in ["home", "config", "data", "cache", "state", "tmp", "work"] {
        directory
            .create_private_child(std::ffi::OsStr::new(name))?
            .verify_private_directory()?;
    }
    std::fs::write(owner.path().join("owner"), case)?;
    let full_name = format!("{}::{case}", module_path!());
    let exact_name = full_name.split_once("::").unwrap().1;
    let mut command = Command::new(std::env::current_exe()?);
    command.env_clear();
    for key in [
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .args(["--exact", exact_name, "--nocapture", "--test-threads=1"])
        .current_dir(owner.path().join("work"))
        .env(ROOT, owner.path())
        .env(CASE, case)
        .env("HOME", owner.path().join("home"))
        .env("KCODER_CONFIG_DIR", owner.path().join("config"))
        .env("KCODER_HOME", owner.path().join("config"))
        .env("XDG_CONFIG_HOME", owner.path().join("config"))
        .env("XDG_DATA_HOME", owner.path().join("data"))
        .env("XDG_CACHE_HOME", owner.path().join("cache"))
        .env("XDG_STATE_HOME", owner.path().join("state"))
        .env("TMPDIR", owner.path().join("tmp"))
        .env("TMP", owner.path().join("tmp"))
        .env("TEMP", owner.path().join("tmp"))
        .env("RUST_MIN_STACK", "16777216")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    struct OwnedProcess(std::process::Child);
    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }
    let mut child = OwnedProcess(command.spawn()?);
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = child.0.try_wait()? {
            anyhow::ensure!(
                status.success(),
                "owned discovery fixture {case} failed: {status}"
            );
            anyhow::ensure!(
                std::fs::read_to_string(owner.path().join("entered"))? == case,
                "owned discovery fixture matched zero tests"
            );
            break;
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "owned discovery fixture {case} timed out"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(false)
}

struct NoModel(AtomicUsize);
impl Provider for NoModel {
    fn name(&self) -> &'static str {
        "owned-session-discovery-no-model"
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ApiErrorKind::Api {
            error_type: "test_unexpected_model_request".into(),
            message: "discovery must not request a model".into(),
        })
    }
}

struct Fixture {
    root: kcoder_config::PrivateTempDir,
    workspace: PathBuf,
    services: WorkspaceRuntimeServices,
    host: Arc<dyn SessionDiscoveryHost>,
    requests: mpsc::Receiver<Request>,
    manager: ThreadManager,
    pages: DiscoveryPages,
    provider: Arc<NoModel>,
}
impl Fixture {
    fn new() -> anyhow::Result<Self> {
        let root = kcoder_config::create_private_temp_dir("session-discovery-host-test")?;
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace)?;
        let owner = Arc::new(kcoder_config::create_private_temp_dir_in(
            root.path(),
            "shared-profile",
        )?);
        let services = WorkspaceRuntimeServices::new(&workspace, "owned-discovery-test")
            .with_private_client_storage(owner);
        let provider = Arc::new(NoModel(AtomicUsize::new(0)));
        // Match the app-server bootstrap: freeze this connection's scope before
        // attaching its reader to independently resident engines.
        let origin = Self::unbound_engine(
            &workspace,
            services.clone(),
            Self::settings(),
            provider.clone(),
        )?;
        let (host, requests) = channel(&origin);
        Ok(Self {
            root,
            workspace,
            services,
            host,
            requests,
            manager: ThreadManager::with_resident_limit(64),
            pages: DiscoveryPages::default(),
            provider,
        })
    }

    fn settings() -> Settings {
        Settings {
            history_enabled: false,
            permission_mode: PermissionMode::Bypass,
            ..crate::test_fixtures::settings_with_default_provider()
        }
    }

    fn unbound_engine(
        workspace: &Path,
        services: WorkspaceRuntimeServices,
        settings: Settings,
        provider: Arc<dyn Provider>,
    ) -> anyhow::Result<QueryEngine> {
        QueryEngine::try_new_for_client_with_services_and_plugin_snapshot(
            provider,
            kcoder_state::AppState::new(workspace),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::empty(),
            Arc::new(DenyAllUserQuestioner),
            workspace.to_path_buf(),
            Some(false),
            services,
            kcoder_plugins::EffectivePluginSnapshot::default(),
            None,
        )
    }

    fn engine(
        &self,
        workspace: &Path,
        services: WorkspaceRuntimeServices,
        settings: Settings,
        provider: Arc<dyn Provider>,
    ) -> anyhow::Result<QueryEngine> {
        let engine = Self::unbound_engine(workspace, services, settings, provider)?
            .with_session_discovery_host(self.host.clone())?;
        let history = engine
            .session_storage_dir_for(&engine.session_id())
            .join(format!("{}.jsonl", engine.session_id()));
        engine.state.with_history_path(&history);
        engine
            .state
            .add_message(Message::user_text("Owned independent fixture session"));
        engine.state.save_history()?;
        Ok(engine)
    }

    fn add(&mut self) -> anyhow::Result<QueryEngine> {
        let engine = self.engine(
            &self.workspace,
            self.services.clone(),
            Self::settings(),
            self.provider.clone(),
        )?;
        self.insert(engine.clone(), false, false)?;
        Ok(engine)
    }

    fn insert(
        &mut self,
        engine: QueryEngine,
        ephemeral: bool,
        wrong_lease: bool,
    ) -> anyhow::Result<()> {
        let (outbound, _receiver) = mpsc::channel(8);
        let projection = Arc::new(Mutex::new(BackgroundProjectionState::default()));
        let followups = Arc::new(BackgroundFollowupState::default());
        let state = ResidentTurnState::new(
            outbound.clone(),
            PermissionMode::Bypass,
            Arc::new(AtomicU64::new(2_000_000)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        let pump =
            BackgroundEventPump::spawn(&engine, projection.clone(), followups.clone(), outbound);
        let path = engine.session_lease_target();
        let observed_state = engine.state.clone();
        let runtime = ThreadRuntime::new(
            engine,
            SessionLease::acquire(&path)?,
            projection,
            followups,
            (pump, BackgroundFollowupScheduler::disabled_for_test()),
            state,
        );
        let runtime = if ephemeral {
            runtime.with_ephemeral()
        } else {
            runtime
        };
        anyhow::ensure!(
            self.manager.insert(runtime).is_ok(),
            "fixture resident capacity exceeded"
        );
        if wrong_lease {
            // Establish a valid runtime first, then change only the owned fixture's
            // current target. Construction must never bypass the original lease guard.
            observed_state.with_history_path(
                self.root
                    .path()
                    .join(format!("wrong-{}.jsonl", observed_state.session_id())),
            );
            anyhow::ensure!(
                !self
                    .manager
                    .lease(&observed_state.session_id())
                    .unwrap()
                    .matches_target(
                        &self
                            .manager
                            .engine(&observed_state.session_id())
                            .unwrap()
                            .session_lease_target()
                    ),
                "fixture did not invalidate its current lease target"
            );
        }
        Ok(())
    }

    fn start_call(
        &self,
        source: &QueryEngine,
        input: Value,
    ) -> JoinHandle<Result<ToolOutput, ToolError>> {
        let tool = source
            .active_tool_registry()
            .get("ListSessions")
            .expect("real host tool installed");
        let context = ToolContext::new(source.state.clone());
        tokio::spawn(async move { tool.call(input, &context).await })
    }

    async fn list(
        &mut self,
        source: &QueryEngine,
        input: Value,
    ) -> anyhow::Result<AgentMessageTargetsResult> {
        let task = self.start_call(source, input);
        let request = tokio::time::timeout(Duration::from_secs(2), self.requests.recv())
            .await?
            .ok_or_else(|| anyhow::anyhow!("owned discovery channel closed"))?;
        dispatch(request, &self.manager, &mut self.pages).await;
        decode(task.await??)
    }

    async fn shutdown(mut self) {
        for runtime in self.manager.drain() {
            runtime.shutdown().await;
        }
    }
}

fn decode(output: ToolOutput) -> anyhow::Result<AgentMessageTargetsResult> {
    anyhow::ensure!(!output.is_error, "ListSessions returned a tool error");
    let text = output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    Ok(serde_json::from_str(&text)?)
}

fn files(root: &Path) -> anyhow::Result<BTreeMap<PathBuf, Vec<u8>>> {
    let mut found = BTreeMap::new();
    if !root.exists() {
        return Ok(found);
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            found.extend(files(&path)?);
        } else if kind.is_file() {
            found.insert(path.clone(), std::fs::read(path)?);
        }
    }
    Ok(found)
}

fn last_attempt(engine: &QueryEngine, status: TurnAttemptStatus) -> anyhow::Result<()> {
    let id = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "turn-7".into(),
        attempt_id: "attempt-7".into(),
    };
    let store = TurnAttemptStore::open(
        &engine.session_storage_dir_for(&engine.session_id()),
        &engine.session_id(),
    )?;
    store.begin(TurnAttemptRecord {
        client_presentation: None,
        version: 1,
        identity: id.clone(),
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 100,
        input_context_hash: "a".repeat(64),
        request_fingerprint: None,
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    })?;
    store.finish(
        &id,
        TurnAttemptCompletion {
            status,
            finished_at_ms: 200,
            error: None,
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        },
    )?;
    Ok(())
}

#[tokio::test]
async fn actual_host_tool_lists_stable_peer_identity_and_reads_without_writes_or_models()
-> anyhow::Result<()> {
    if !owned_case(
        "actual_host_tool_lists_stable_peer_identity_and_reads_without_writes_or_models",
    )? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let peer = fixture.add()?;
    thread_metadata::update_thread_metadata(
        &peer,
        ThreadMetadataUpdateParams {
            thread_id: peer.session_id(),
            title: MetadataUpdate::Set("Independent protocol review".into()),
            ..Default::default()
        },
        &HashSet::new(),
        true,
    )?;
    let source_messages = source.state.messages();
    let peer_messages = peer.state.messages();
    let before = files(&source.client_storage_root())?;
    let residents = fixture.manager.resident_engines().len();
    for _ in 0..2 {
        let page = fixture.list(&source, json!({})).await?;
        assert_eq!(
            page.coverage,
            AgentMessageDiscoveryCoverage::WorkspaceHistory
        );
        assert!(page.observed_at_ms > 0);
        assert_eq!(page.targets.len(), 1);
        let actual = &page.targets[0];
        assert_eq!(actual.thread_id, peer.session_id());
        assert_eq!(actual.title.as_deref(), Some("Independent protocol review"));
        assert_eq!(actual.status, ThreadStatus::Idle);
        assert!(
            actual.last_turn.is_none(),
            "idle does not invent a completed turn"
        );
        assert!(
            actual.allowed_modes.is_empty(),
            "discovery grants no send permission"
        );
        assert!(page.next_cursor.is_none());
    }
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.manager.resident_engines().len(), residents);
    assert_eq!(source.state.messages(), source_messages);
    assert_eq!(peer.state.messages(), peer_messages);
    assert_eq!(
        files(&source.client_storage_root())?,
        before,
        "warm discovery does not create or rewrite files"
    );
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn peer_activity_is_live_and_separate_from_committed_last_turn_outcomes() -> anyhow::Result<()>
{
    if !owned_case("peer_activity_is_live_and_separate_from_committed_last_turn_outcomes")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let peer = fixture.add()?;
    last_attempt(&peer, TurnAttemptStatus::Failed)?;
    let state = fixture.manager.turn_state(&peer.session_id()).unwrap();
    state.running.store(true, Ordering::SeqCst);
    let page = fixture.list(&source, json!({})).await?;
    assert_eq!(page.targets[0].status, ThreadStatus::Running);
    assert_eq!(
        page.targets[0].last_turn.as_ref().map(|turn| &turn.status),
        Some(&TurnStatus::Failed)
    );
    let (approval, _approval_answer) = oneshot::channel();
    state.pending_approvals.lock().unwrap().insert(41, approval);
    assert_eq!(
        fixture.list(&source, json!({})).await?.targets[0].status,
        ThreadStatus::WaitingForApproval
    );
    state.pending_approvals.lock().unwrap().remove(&41);
    let (question, _question_answer) = oneshot::channel();
    state.pending_questions.lock().unwrap().insert(42, question);
    assert_eq!(
        fixture.list(&source, json!({})).await?.targets[0].status,
        ThreadStatus::WaitingForAnswer
    );
    state.pending_questions.lock().unwrap().remove(&42);
    state.running.store(false, Ordering::SeqCst);
    let page = fixture.list(&source, json!({})).await?;
    assert_eq!(page.targets[0].status, ThreadStatus::Idle);
    assert_eq!(
        page.targets[0].last_turn.as_ref().map(|turn| &turn.status),
        Some(&TurnStatus::Failed)
    );
    let store = TurnAttemptStore::open(
        &peer.session_storage_dir_for(&peer.session_id()),
        &peer.session_id(),
    )?;
    let previous = TurnAttemptIdentity {
        thread_id: peer.session_id(),
        turn_id: "turn-7".into(),
        attempt_id: "attempt-7".into(),
    };
    let mut pending = store.load(&previous)?.unwrap();
    pending.identity.turn_id = "turn-8".into();
    pending.identity.attempt_id = "attempt-8".into();
    pending.accepted_at_ms = 300;
    pending.status = TurnAttemptStatus::Accepted;
    pending.completion = None;
    store.begin(pending.clone())?;
    let page = fixture.list(&source, json!({})).await?;
    assert_eq!(page.targets[0].status, ThreadStatus::Idle);
    assert!(
        page.targets[0].last_turn.is_none(),
        "an uncommitted latest attempt cannot fall back to an older terminal receipt"
    );
    store.finish(
        &pending.identity,
        TurnAttemptCompletion {
            status: TurnAttemptStatus::Completed,
            finished_at_ms: 400,
            error: None,
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        },
    )?;
    assert!(
        fixture.list(&source, json!({})).await?.targets[0]
            .last_turn
            .is_none(),
        "multiple wall-clock timestamps do not prove which terminal turn was last"
    );
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn shared_manager_does_not_expose_foreign_workspace_profile_ephemeral_or_protected_targets()
-> anyhow::Result<()> {
    if !owned_case(
        "shared_manager_does_not_expose_foreign_workspace_profile_ephemeral_or_protected_targets",
    )? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let peer = fixture.add()?;
    let other_workspace = fixture.root.path().join("other-workspace");
    std::fs::create_dir(&other_workspace)?;
    let foreign_workspace = fixture.engine(
        &other_workspace,
        fixture.services.clone(),
        Fixture::settings(),
        fixture.provider.clone(),
    )?;
    fixture.insert(foreign_workspace.clone(), false, false)?;
    let profile = Arc::new(kcoder_config::create_private_temp_dir_in(
        fixture.root.path(),
        "other-profile",
    )?);
    let services = fixture.services.with_private_client_storage(profile);
    let foreign_profile = fixture.engine(
        &fixture.workspace,
        services,
        Fixture::settings(),
        fixture.provider.clone(),
    )?;
    fixture.insert(foreign_profile.clone(), false, false)?;
    let ephemeral = fixture.engine(
        &fixture.workspace,
        fixture.services.clone(),
        Fixture::settings(),
        fixture.provider.clone(),
    )?;
    fixture.insert(ephemeral, true, false)?;
    let protected = fixture
        .engine(
            &fixture.workspace,
            fixture.services.clone(),
            Fixture::settings(),
            fixture.provider.clone(),
        )?
        .with_required_native_host_source_admission()?;
    fixture.insert(protected, false, false)?;
    let wrong_lease = fixture.engine(
        &fixture.workspace,
        fixture.services.clone(),
        Fixture::settings(),
        fixture.provider.clone(),
    )?;
    fixture.insert(wrong_lease, false, true)?;
    let page = fixture.list(&source, json!({})).await?;
    assert_eq!(
        page.targets
            .iter()
            .map(|target| &target.thread_id)
            .collect::<Vec<_>>(),
        vec![&peer.session_id()]
    );
    for foreign in [&foreign_workspace, &foreign_profile] {
        let task = fixture.start_call(foreign, json!({}));
        let request = fixture.requests.recv().await.unwrap();
        dispatch(request, &fixture.manager, &mut fixture.pages).await;
        assert!(
            task.await?.is_err(),
            "a host frozen to another scope cannot be borrowed"
        );
    }
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn forged_source_state_and_lifecycle_changes_cannot_borrow_an_owned_session()
-> anyhow::Result<()> {
    if !owned_case("forged_source_state_and_lifecycle_changes_cannot_borrow_an_owned_session")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    fixture.add()?;
    let forged = kcoder_state::AppState::new(&fixture.workspace);
    forged.resume_from_history(&source.state.history_path().unwrap())?;
    assert_eq!(forged.session_id(), source.session_id());
    assert!(!forged.shares_state_with(&source.state));
    let tool = source.active_tool_registry().get("ListSessions").unwrap();
    let task = tokio::spawn(async move { tool.call(json!({}), &ToolContext::new(forged)).await });
    let request = fixture.requests.recv().await.unwrap();
    dispatch(request, &fixture.manager, &mut fixture.pages).await;
    assert!(task.await?.is_err());
    let task = fixture.start_call(&source, json!({}));
    let request = fixture.requests.recv().await.unwrap();
    source.state.start_new_session()?;
    dispatch(request, &fixture.manager, &mut fixture.pages).await;
    assert!(
        task.await?.is_err(),
        "queued observation cannot follow a new State lifecycle"
    );
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn page_cursor_is_source_bound_and_rechecks_current_target_and_source_rights()
-> anyhow::Result<()> {
    if !owned_case("page_cursor_is_source_bound_and_rechecks_current_target_and_source_rights")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let other_source = fixture.add()?;
    for _ in 0..13 {
        fixture.add()?;
    }
    let page = fixture.list(&source, json!({})).await?;
    assert_eq!(page.targets.len(), AGENT_MESSAGE_TARGET_PAGE_SIZE);
    let cursor = page.next_cursor.unwrap();
    let task = fixture.start_call(&other_source, json!({"cursor":cursor}));
    let request = fixture.requests.recv().await.unwrap();
    dispatch(request, &fixture.manager, &mut fixture.pages).await;
    assert!(
        task.await?.is_err(),
        "another source cannot reuse the opaque cursor"
    );
    let shown: HashSet<_> = page
        .targets
        .iter()
        .map(|target| target.thread_id.as_str())
        .collect();
    let mut remaining = fixture
        .manager
        .resident_engines()
        .into_iter()
        .filter(|engine| {
            engine.session_id() != source.session_id()
                && !shown.contains(engine.session_id().as_str())
        })
        .collect::<Vec<_>>();
    assert!(remaining.len() >= 2);
    let revoked = remaining.pop().unwrap();
    let running = remaining.pop().unwrap();
    fixture.manager.replace_host_turn_engine(
        &revoked.session_id(),
        revoked
            .clone()
            .with_required_native_host_source_admission()?,
    )?;
    fixture
        .manager
        .turn_state(&running.session_id())
        .unwrap()
        .running
        .store(true, Ordering::SeqCst);
    let next = fixture.list(&source, json!({"cursor":cursor})).await?;
    assert!(
        !next
            .targets
            .iter()
            .any(|target| target.thread_id == revoked.session_id())
    );
    assert!(
        next.targets
            .iter()
            .any(|target| target.thread_id == running.session_id()
                && target.status == ThreadStatus::Running)
    );
    fixture
        .manager
        .turn_state(&running.session_id())
        .unwrap()
        .running
        .store(false, Ordering::SeqCst);
    // An empty turn registry deliberately recomposes the existing host tools.
    // Replace the actual contribution instead of pretending that removed it.
    let (replacement_host, mut replacement_requests) = channel(&source);
    fixture.manager.replace_host_turn_engine(
        &source.session_id(),
        source
            .clone()
            .with_session_discovery_host(replacement_host)?,
    )?;
    let task = fixture.start_call(&source, json!({"cursor":cursor}));
    let request = fixture.requests.recv().await.unwrap();
    dispatch(request, &fixture.manager, &mut fixture.pages).await;
    assert!(
        task.await?.is_err(),
        "old cursor and old tool object do not cache an allow verdict"
    );
    let refreshed = fixture.manager.engine(&source.session_id()).unwrap();
    let task = fixture.start_call(&refreshed, json!({}));
    let request = replacement_requests.recv().await.unwrap();
    dispatch(request, &fixture.manager, &mut fixture.pages).await;
    assert!(
        task.await?.is_ok(),
        "the actual replacement host remains usable"
    );
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn disabled_and_none_profiles_do_not_register_or_authorize_discovery() -> anyhow::Result<()> {
    if !owned_case("disabled_and_none_profiles_do_not_register_or_authorize_discovery")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    for none in [false, true] {
        let mut settings = Fixture::settings();
        if none {
            settings.tools.profile = ToolProfile::None;
        } else {
            settings.tools.disabled.push("ListSessions".into());
        }
        let engine = fixture.engine(
            &fixture.workspace,
            fixture.services.clone(),
            settings,
            fixture.provider.clone(),
        )?;
        assert!(engine.active_tool_registry().get("ListSessions").is_none());
        fixture.insert(engine.clone(), false, false)?;
        let tool = kcoder_tools::session_discovery::ListSessionsTool::new(fixture.host.clone());
        let task = tokio::spawn(async move {
            tool.call(json!({}), &ToolContext::new(engine.state.clone()))
                .await
        });
        let request = fixture.requests.recv().await.unwrap();
        dispatch(request, &fixture.manager, &mut fixture.pages).await;
        assert!(task.await?.is_err());
    }
    fixture.shutdown().await;
    Ok(())
}

struct ModelToolDiscovery {
    requests: StdMutex<Vec<MessagesRequest>>,
}

#[tokio::test]
async fn captured_model_tool_attempt_rejects_missing_late_turn_and_owner_drift()
-> anyhow::Result<()> {
    if !owned_case("captured_model_tool_attempt_rejects_missing_late_turn_and_owner_drift")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let provider = Arc::new(ModelToolDiscovery {
        requests: StdMutex::new(Vec::new()),
    });
    let source = fixture.engine(
        &fixture.workspace,
        fixture.services.clone(),
        Fixture::settings(),
        provider.clone(),
    )?;
    fixture.insert(source.clone(), false, false)?;
    fixture.add()?;
    let check = |call: &SessionDiscoveryCall| {
        crate::app_server::session_messages::host::verify_captured_attempt(
            &source,
            call.state(),
            call.lifecycle(),
            call.captured_attempt(),
            "owned_source_attempt_unavailable",
            "owned_source_attempt_changed",
        )
    };
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = source.run_turn_stream(&prompt);
    let mut original = None;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            tokio::select! {
                request = fixture.requests.recv() => {
                    let request = request.unwrap();
                    assert!(source.state.current_history_attempt_identity().is_none(), "manager task cannot borrow the model's task-local scope");
                    let attempt = check(request.call()).unwrap();
                    assert_eq!(Some(attempt), source.owned_turn_observer().current_identity().unwrap());
                    assert!(crate::app_server::session_messages::host::verify_captured_attempt(
                        &source, request.call().state(), request.call().lifecycle(), None,
                        "owned_source_attempt_unavailable", "owned_source_attempt_changed",
                    ).is_err(), "missing scope cannot be filled from an unrelated current owner");
                    original = Some(request.call().clone());
                    dispatch(request, &fixture.manager, &mut fixture.pages).await;
                }
                event = stream.next() => { if event.is_none() { break; } }
            }
        }
    }).await?;
    drop(stream);
    let original = original.unwrap();
    assert!(
        check(&original).is_err(),
        "closed original turn has no current authorization"
    );
    provider.requests.lock().unwrap().clear();
    let mut next = source.run_turn_stream(&prompt);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            tokio::select! {
                request = fixture.requests.recv() => {
                    let request = request.unwrap();
                    assert!(check(request.call()).is_ok());
                    assert_ne!(request.call().captured_attempt(), original.captured_attempt());
                    assert!(check(&original).is_err(), "late old call must not borrow the new real turn");
                    source.state.start_new_session().unwrap();
                    assert!(!request.call().is_current());
                    assert!(check(request.call()).is_err(), "an owner epoch change revokes the captured proof");
                    let Request::List(request) = request else { panic!("ListSessions request") };
                    let _ = request.reply.send(Err(unavailable("owned_source_changed")));
                    break;
                }
                event = next.next() => { assert!(event.is_some(), "new real tool call required"); }
            }
        }
    }).await?;
    drop(next);
    fixture.shutdown().await;
    Ok(())
}
impl Provider for ModelToolDiscovery {
    fn name(&self) -> &'static str {
        "owned-model-list-sessions"
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let mut requests = self.requests.lock().unwrap();
        let first = requests.is_empty();
        requests.push(request);
        let block = if first {
            ContentBlock::ToolUse {
                id: "owned-list-call".into(),
                name: "ListSessions".into(),
                input: json!({}),
            }
        } else {
            ContentBlock::Text {
                text: "Observed independent sessions".into(),
            }
        };
        Ok(Box::pin(futures::stream::iter(vec![
            Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: block,
            }),
            Ok(StreamEvent::ContentBlockStop { index: 0 }),
            Ok(StreamEvent::MessageStop),
        ])))
    }
}

#[tokio::test]
async fn real_engine_exposes_host_tool_and_receives_peer_metadata_through_model_tool_loop()
-> anyhow::Result<()> {
    if !owned_case(
        "real_engine_exposes_host_tool_and_receives_peer_metadata_through_model_tool_loop",
    )? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let provider = Arc::new(ModelToolDiscovery {
        requests: StdMutex::new(Vec::new()),
    });
    let source = fixture.engine(
        &fixture.workspace,
        fixture.services.clone(),
        Fixture::settings(),
        provider.clone(),
    )?;
    fixture.insert(source.clone(), false, false)?;
    let peer = fixture.add()?;
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = source.run_turn_stream(&prompt);
    let mut tool_results = 0;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tokio::select! {
                request = fixture.requests.recv() => {
                    let request = request.expect("real tool discovery request");
                    dispatch(request, &fixture.manager, &mut fixture.pages).await;
                }
                event = stream.next() => match event {
                    None => break,
                    Some(kcoder_engine::EngineEvent::ToolResult { name, output, .. }) if name == "ListSessions" => {
                        let result = decode(output).unwrap();
                        assert!(result.targets.iter().any(|target| target.thread_id == peer.session_id()));
                        tool_results += 1;
                    }
                    Some(kcoder_engine::EngineEvent::Error(error)) => panic!("real discovery Engine failed: {error}"),
                    _ => {}
                }
            }
        }
    }).await?;
    assert_eq!(tool_results, 1);
    {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[0]
                .tools
                .iter()
                .any(|tool| tool.name == "ListSessions")
        );
        assert!(
            serde_json::to_string(&requests[1])
                .unwrap()
                .contains(&peer.session_id())
        );
    }
    drop(stream);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn blocking_worker_results_are_rechecked_after_source_or_target_lifecycle_changes()
-> anyhow::Result<()> {
    if !owned_case(
        "blocking_worker_results_are_rechecked_after_source_or_target_lifecycle_changes",
    )? {
        return Ok(());
    }
    for change in 0..3 {
        let mut fixture = Fixture::new()?;
        let source = fixture.add()?;
        let peer = fixture.add()?;
        let task = fixture.start_call(&source, json!({}));
        let request = fixture.requests.recv().await.unwrap();
        let mut jobs = DiscoveryJobs::default();
        jobs.start(request, &fixture.manager, &mut fixture.pages);
        let completed = jobs
            .next()
            .await
            .expect("one owned blocking worker finished");
        if change == 1 {
            source.state.start_new_session()?;
        } else if change == 2 {
            let replacement = source
                .clone()
                .with_session_discovery_host(fixture.host.clone())?;
            fixture
                .manager
                .replace_host_turn_engine(&source.session_id(), replacement)?;
        } else {
            peer.state.start_new_session()?;
        }
        publish(completed, &fixture.manager);
        let result = task.await?;
        if change != 0 {
            assert!(
                result.is_err(),
                "finished I/O cannot reuse a revoked source owner"
            );
        } else {
            assert!(
                decode(result?)?.targets.is_empty(),
                "finished I/O cannot publish a replaced peer owner"
            );
        }
        jobs.finish().await;
        fixture.shutdown().await;
    }
    Ok(())
}

#[tokio::test]
async fn actual_factory_installs_discovery_for_normal_sessions_and_strips_ephemeral_inheritance()
-> anyhow::Result<()> {
    if !owned_case(
        "actual_factory_installs_discovery_for_normal_sessions_and_strips_ephemeral_inheritance",
    )? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let settings = Fixture::settings();
    let mut factory = crate::app_server::engine_factory::AppServerEngineFactory::new(
        fixture.provider.clone(),
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        fixture.workspace.clone(),
        None,
        false,
        fixture.services.clone(),
        None,
        fixture.root.path().join("factory-session-ids"),
    );
    factory.set_session_discovery_host(fixture.host.clone());
    let source = factory.create_new_thread(Arc::new(DenyAllUserQuestioner))?;
    let original_tool = source
        .active_tool_registry()
        .get("ListSessions")
        .expect("the actual normal factory installs its owned reader");
    let source_id = source.session_id();
    let original_messages = source.state.messages();
    fixture.insert(source.clone(), false, false)?;
    let peer = fixture.add()?;
    assert!(
        fixture
            .list(&source, json!({}))
            .await?
            .targets
            .iter()
            .any(|target| target.thread_id == peer.session_id())
    );
    let (ephemeral, lifecycle) = factory.create_ephemeral_thread_with_lifecycle(
        &source,
        source.state.messages(),
        Arc::new(DenyAllUserQuestioner),
    )?;
    assert!(lifecycle.matches(&ephemeral.state));
    assert!(!source.state.shares_state_with(&ephemeral.state));
    assert_ne!(
        ephemeral.client_storage_root(),
        source.client_storage_root()
    );
    assert!(
        ephemeral.tools.get("ListSessions").is_none(),
        "ephemeral creation must strip the source's inherited tool object, not only clear a host option"
    );
    assert!(
        ephemeral
            .active_tool_registry()
            .get("ListSessions")
            .is_none()
    );
    assert_eq!(source.session_id(), source_id);
    assert_eq!(source.state.messages(), original_messages);
    let retained_tool = source
        .active_tool_registry()
        .get("ListSessions")
        .expect("filtering the fork cannot mutate the original reader");
    assert!(Arc::ptr_eq(&original_tool, &retained_tool));
    assert_eq!(
        fixture.manager.resident_engines().len(),
        2,
        "an ephemeral Engine constructor does not create a resident peer"
    );
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    drop(ephemeral);
    fixture.shutdown().await;
    Ok(())
}

include!("persistent_tests.rs");

include!("read_tests.rs");

include!("../session_directory/query_cursor_tests.rs");
