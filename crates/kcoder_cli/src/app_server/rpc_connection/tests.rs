//! Offline dispatcher tests; these do not claim real Native or platform admission.
use super::*;
use kcoder_config::{PermissionMode, Settings};
use kcoder_engine::WorkspaceRuntimeServices;
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
use std::sync::Weak;

struct ForbiddenModel;
impl kcoder_api::Provider for ForbiddenModel {
    fn name(&self) -> &'static str {
        "forbidden-rpc-control-model"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        panic!("Task management must not invoke a model")
    }
}
struct TestSource(Weak<()>);
impl RpcSource for TestSource {
    fn verify(&self, state: &ConnectionState) -> Result<()> {
        ensure!(
            state.initialized
                && !state.input_ended.is_cancelled()
                && self
                    .0
                    .ptr_eq(&Arc::downgrade(&state.source_management_owner))
                && self.0.upgrade().is_some(),
            "TEST_CLIENT_OWNER_ENDED"
        );
        Ok(())
    }
}
struct Client {
    context: Option<Box<RpcClient>>,
    frames: mpsc::Receiver<Value>,
}
struct Fixture {
    _root: tempfile::TempDir,
    workspace: QueryEngine,
    factory: AppServerEngineFactory,
    manager: ThreadManager,
    owners: NativeUiTaskOwners,
    #[cfg(target_os = "linux")]
    interruptions: turn_interrupt::NativeInterruptJobs,
    hub: rpc_hub::RpcHub,
    receipts: Arc<StdMutex<InteractionReceipts>>,
    interactions: Arc<AtomicU64>,
    sequence: Arc<AtomicU64>,
    server: String,
    serial: u64,
}

const WIKI_RPC_ISOLATION_ROOT_ENV: &str = "KCODER_TEST_RPC_WIKI_ISOLATION_ROOT";

struct OwnedWikiTestChild(std::process::Child);

impl Drop for OwnedWikiTestChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

/// Keep the four Wiki regressions independent of the caller's plugin/settings profile.
/// The child runs the exact same test body with all user config roots under one owned temp dir.
fn run_wiki_regression_in_isolated_child(test_name: &str) -> Result<bool> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    if let Some(root) = std::env::var_os(WIKI_RPC_ISOLATION_ROOT_ENV) {
        let root = std::path::PathBuf::from(root);
        for name in [
            "HOME",
            "XDG_CONFIG_HOME",
            "KCODER_CONFIG_DIR",
            "KCODER_HOME",
        ] {
            let path = std::env::var_os(name)
                .ok_or_else(|| anyhow::anyhow!("isolated Wiki test child has no {name}"))?;
            ensure!(
                std::path::Path::new(&path).starts_with(&root),
                "isolated Wiki test child {name} escaped its owned root"
            );
        }
        return Ok(true);
    }

    let isolation = tempfile::Builder::new()
        .prefix("kcoder-wiki-rpc-isolation-")
        .tempdir()?;
    let root = isolation.path();
    let home = root.join("home");
    let xdg_config = root.join("xdg-config");
    let config_dir = root.join("config");
    let kcoder_home = root.join("kcoder-home");
    let environment_directories = [&home, &xdg_config, &config_dir, &kcoder_home];
    for directory in environment_directories {
        std::fs::create_dir_all(directory)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for directory in environment_directories {
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    std::fs::write(
        config_dir.join("settings.json"),
        br#"{"meta":{"config_version":1}}"#,
    )?;

    let mut child = OwnedWikiTestChild(
        Command::new(std::env::current_exe()?)
            .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
            .env(WIKI_RPC_ISOLATION_ROOT_ENV, root)
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", &xdg_config)
            .env("KCODER_CONFIG_DIR", &config_dir)
            .env("KCODER_HOME", &kcoder_home)
            .env("RUST_MIN_STACK", "8388608")
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(status) = child.0.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.0.kill();
            let _ = child.0.wait();
            anyhow::bail!("isolated Wiki RPC test child timed out: {test_name}");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    ensure!(
        status.success(),
        "isolated Wiki RPC test child failed: {test_name}: {status}"
    );
    Ok(false)
}

fn hold_join_set_task(
    tasks: &mut tokio::task::JoinSet<()>,
    completed: Option<Arc<std::sync::atomic::AtomicUsize>>,
) -> tokio::sync::oneshot::Sender<()> {
    let (release, waiting) = tokio::sync::oneshot::channel();
    tasks.spawn(async move {
        let _ = waiting.await;
        if let Some(completed) = completed {
            completed.fetch_add(1, Ordering::SeqCst);
        }
    });
    release
}

struct TaskDropFlag(Arc<std::sync::atomic::AtomicBool>);

impl Drop for TaskDropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn hold_unfinished_task(
    tasks: &mut tokio::task::JoinSet<()>,
    dropped: Arc<std::sync::atomic::AtomicBool>,
) {
    let drop_flag = TaskDropFlag(dropped);
    tasks.spawn(async move {
        let _drop_flag = drop_flag;
        std::future::pending::<()>().await;
    });
}

impl Fixture {
    fn new() -> Result<Self> {
        let mut temporary = tempfile::Builder::new();
        temporary.prefix("kcoder-rpc-control-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let root = temporary.tempdir()?;
        let cwd = root.path().join("workspace");
        let profile = root.path().join("profile");
        std::fs::create_dir_all(&cwd)?;
        let root_directory = kcoder_config::PrivateDirectory::open_existing(root.path())?;
        root_directory.verify_private_directory()?;
        let profile_directory =
            root_directory.create_private_child(std::ffi::OsStr::new("profile"))?;
        let settings = Settings {
            history_enabled: true,
            permission_mode: PermissionMode::Ask,
            ..Default::default()
        };
        let settings_path = profile.join("settings.json");
        profile_directory.atomic_replace(
            std::ffi::OsStr::new("settings.json"),
            &serde_json::to_vec(&settings)?,
        )?;
        let storage = Arc::new(kcoder_config::create_private_temp_dir_in(
            root.path(),
            "rpc-client-assets",
        )?);
        let factory = AppServerEngineFactory::new(
            Arc::new(ForbiddenModel),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::empty(),
            Default::default(),
            cwd.clone(),
            Some(root.path().join("history")),
            true,
            WorkspaceRuntimeServices::new(&cwd, "original-rpc-test")
                .with_private_client_storage(storage),
            Some(settings_path),
            root.path().join("session-ids"),
        );
        let workspace = factory.create_new_thread(Arc::new(DenyAllUserQuestioner))?;
        Ok(Self {
            _root: root,
            workspace,
            factory,
            manager: Default::default(),
            owners: Default::default(),
            #[cfg(target_os = "linux")]
            interruptions: Default::default(),
            hub: Default::default(),
            receipts: Arc::new(StdMutex::new(InteractionReceipts::new(
                "original-rpc-core-epoch".into(),
            ))),
            interactions: Arc::new(AtomicU64::new(1_000_000)),
            sequence: Arc::new(AtomicU64::new(1)),
            server: "original-rpc-core".into(),
            serial: 0,
        })
    }
    fn client(&self) -> Result<Client> {
        let mut state = ConnectionState::default();
        let initialized = state.initialize(
            json!(0),
            &json!({
                "protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,
                "clientInfo":{"name":"offline-rpc-control","version":"1"},
                "capabilities":{"experimental":{"residentThreads":true}}
            }),
            &self.workspace,
        );
        ensure!(
            initialized.get("error").is_none(),
            "test initialize failed: {initialized}"
        );
        let (wire, frames) = mpsc::channel(128);
        // Production opens only after the kernel peer, host selection and original
        // admission were verified. Here only the common public handler is under test.
        let context = RpcClient::open_resources(
            state,
            &self.workspace,
            &self.factory,
            self.hub.clone(),
            wire,
            self.receipts.clone(),
        )?;
        Ok(Client {
            context: Some(context),
            frames,
        })
    }
    async fn frame(&mut self, client: &mut Client, frame: Value) -> Result<()> {
        ensure!(
            self.submit(client, Some(serde_json::to_string(&frame)?))
                .await?,
            "test client unexpectedly closed"
        );
        Ok(())
    }
    async fn submit(&mut self, client: &mut Client, line: Option<String>) -> Result<bool> {
        let context = client.context.take().context("test client missing")?;
        let source = Arc::new(TestSource(Arc::downgrade(
            &context.state.source_management_owner,
        )));
        let (reply, completed) = tokio::sync::oneshot::channel();
        Box::pin(dispatch(
            RpcRequest {
                client: context,
                line,
                source,
                reply,
            },
            HostContext {
                engine_factory: &self.factory,
                workspace_engine: &self.workspace,
                permission_mode: PermissionMode::Ask,
                thread_manager: &mut self.manager,
                next_interaction_id: &self.interactions,
                server_id: &self.server,
                sequence: &self.sequence,
                owners: &mut self.owners,
                #[cfg(target_os = "linux")]
                interruptions: &mut self.interruptions,
            },
        ))
        .await;
        let (context, result) = completed.await?;
        client.context = Some(context);
        result
    }
    async fn call(&mut self, client: &mut Client, method: &str, params: Value) -> Result<Value> {
        self.serial += 1;
        let id = self.serial;
        self.frame(
            client,
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )
        .await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame = client
                    .frames
                    .recv()
                    .await
                    .context("original output closed")?;
                if frame.get("method").is_none() && frame.get("id") == Some(&json!(id)) {
                    return Ok(frame);
                }
            }
        })
        .await?
    }
    async fn close(mut self) {
        #[cfg(target_os = "linux")]
        self.interruptions.drain().await;
        for runtime in self.manager.drain() {
            runtime.shutdown().await;
        }
        self.hub.close().await;
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn interrupt_settlement_survives_the_requesting_clients_disconnect() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let mut client = fixture.client()?;
    let started = fixture
        .call(
            &mut client,
            "thread/start",
            json!({"clientRequestId":"rpc-owned-interruption"}),
        )
        .await?;
    ensure!(
        started.get("error").is_none(),
        "original start failed: {started}"
    );
    let thread = started["result"]["thread"]["id"]
        .as_str()
        .context("task missing")?
        .to_owned();
    let cancel = CancellationToken::new();
    let (release, waiting) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let _ = waiting.await;
    });
    let turn = fixture
        .manager
        .turn_state(&thread)
        .context("runtime missing")?;
    *turn.active_turn.lock().await = Some(ActiveTurn {
        desktop_owner: None,
        input_owner: Some(Arc::downgrade(
            &client
                .context
                .as_ref()
                .unwrap()
                .state
                .source_management_owner,
        )),
        handle,
        attempt: None,
        origin: crate::app_server::request_origin::RequestOrigin::Unverified,
        cancel: cancel.clone(),
        thread_id: thread.clone(),
        turn_id: "owned-interrupt-turn".into(),
    });
    turn.running.store(true, Ordering::SeqCst);
    let interrupted = fixture
        .call(
            &mut client,
            "turn/interrupt",
            json!({"threadId":thread,"turnId":"owned-interrupt-turn"}),
        )
        .await?;
    assert_eq!(interrupted["result"]["interrupted"], true);
    tokio::task::yield_now().await;
    assert!(cancel.is_cancelled());
    assert!(
        fixture
            .interruptions
            .is_pending(Some(&thread), Some("owned-interrupt-turn"))
    );
    assert!(turn.running.load(Ordering::SeqCst));
    assert!(!fixture.submit(&mut client, None).await?);
    drop(client);
    assert!(
        fixture
            .interruptions
            .is_pending(Some(&thread), Some("owned-interrupt-turn"))
    );
    assert!(
        release.send(()).is_ok(),
        "disconnect aborted the original reply waiter"
    );
    fixture.interruptions.drain().await;
    assert!(!turn.running.load(Ordering::SeqCst));
    assert!(
        !fixture
            .interruptions
            .is_pending(Some(&thread), Some("owned-interrupt-turn"))
    );
    fixture.close().await;
    Ok(())
}
#[tokio::test]
async fn repeated_resume_and_last_disconnect_keep_host_runtime_and_history() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let mut client = fixture.client()?;
    let start = fixture
        .call(
            &mut client,
            "thread/start",
            json!({"clientRequestId":"rpc-repeat-resume"}),
        )
        .await?;
    ensure!(
        start.get("error").is_none(),
        "original start failed: {start}"
    );
    let thread = start["result"]["thread"]["id"]
        .as_str()
        .context("original task missing")?
        .to_owned();
    let original = fixture.manager.engine(&thread).unwrap();
    original.state.add_message(kcoder_types::Message::user_text(
        "completed input must survive a repeated view",
    ));
    original
        .state
        .add_message(kcoder_types::Message::assistant_text(
            "completed original response",
        ));
    original.state.save_history()?;
    let path = original
        .state
        .history_path()
        .context("original history missing")?;
    let history = std::fs::read(&path)?;
    let owner = fixture
        .manager
        .handoff_snapshot(&thread, &fixture.server)
        .owner_ref;
    let presentation = client.context.as_ref().unwrap().owners[&thread].clone();
    for _ in 0..2 {
        let resumed = fixture
            .call(&mut client, "thread/resume", json!({"threadId":thread}))
            .await?;
        ensure!(
            resumed.get("error").is_none(),
            "repeat resume failed: {resumed}"
        );
        assert!(
            fixture
                .manager
                .engine(&thread)
                .unwrap()
                .state
                .shares_state_with(&original.state)
        );
        assert_eq!(
            fixture
                .manager
                .handoff_snapshot(&thread, &fixture.server)
                .owner_ref,
            owner
        );
        assert_eq!(std::fs::read(&path)?, history);
        assert!(Arc::ptr_eq(
            &presentation,
            &client.context.as_ref().unwrap().owners[&thread],
        ));
    }
    drop(client);
    let mut selected = fixture.workspace.clone();
    fixture
        .owners
        .retire_ended(&mut fixture.manager, &mut selected, &fixture.workspace)
        .await;
    assert!(
        fixture.manager.owns(&thread),
        "A client disconnect cannot release the persistent task runtime"
    );
    assert_eq!(std::fs::read(&path)?, history);
    fixture.close().await;
    Ok(())
}
#[tokio::test]
async fn ended_client_cleanup_works_without_renewing_source_authority() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let mut client = fixture.client()?;
    client.context.as_ref().unwrap().state.input_ended.cancel();
    assert!(!fixture.submit(&mut client, None).await?);
    drop(client);
    fixture.close().await;
    Ok(())
}
#[tokio::test]
async fn transport_client_idle_shutdown_cannot_close_shared_task_admission() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let mut first = fixture.client()?;
    let mut second = fixture.client()?;
    let shutdown = fixture
        .call(
            &mut first,
            kcoder_app_protocol::method::SERVER_IDLE_SHUTDOWN,
            json!({"instanceId":resources_processor::instance_id()}),
        )
        .await?;
    assert_eq!(shutdown["result"]["accepted"], false);
    assert_eq!(shutdown["result"]["reason"], "persistentHost");
    drop(first);
    let start = fixture
        .call(
            &mut second,
            "thread/start",
            json!({"clientRequestId":"peer-after-client-idle-shutdown"}),
        )
        .await?;
    ensure!(
        start.get("error").is_none(),
        "peer admission closed: {start}"
    );
    assert!(
        fixture
            .manager
            .owns(start["result"]["thread"]["id"].as_str().unwrap())
    );
    drop(second);
    fixture.close().await;
    Ok(())
}
#[tokio::test]
async fn public_rpc_reuses_fork_delete_dispose_and_mode_handlers_on_one_manager() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let mut first = fixture.client()?;
    let mut second = fixture.client()?;
    let start = fixture
        .call(
            &mut first,
            "thread/start",
            json!({"clientRequestId":"rpc-original-task"}),
        )
        .await?;
    ensure!(
        start.get("error").is_none(),
        "original start failed: {start}"
    );
    let thread = start["result"]["thread"]["id"]
        .as_str()
        .context("original thread missing")?
        .to_owned();
    let mode = fixture
        .call(
            &mut first,
            "thread/sessionMode/set",
            json!({"threadId":thread,"mode":"orchestrate"}),
        )
        .await?;
    ensure!(
        mode.get("error").is_none(),
        "original mode handler failed: {mode}"
    );
    let original = fixture
        .manager
        .engine(&thread)
        .context("original runtime missing")?;
    assert_eq!(
        original.state.session_mode(),
        kcoder_state::SessionMode::Orchestrate
    );
    original.state.add_message(kcoder_types::Message::user_text(
        "fixture persisted context",
    ));
    original
        .state
        .add_message(kcoder_types::Message::assistant_text(
            "fixture completed context",
        ));
    original.state.save_history()?;
    let history = original
        .state
        .history_path()
        .context("original history missing")?;
    let original_bytes = std::fs::read(&history)?;
    let owner = fixture
        .manager
        .handoff_snapshot(&thread, &fixture.server)
        .owner_ref;
    let fork = fixture
        .call(
            &mut first,
            "thread/fork",
            json!({"threadId":thread,"lastTurnId":"turn-1"}),
        )
        .await?;
    ensure!(
        fork.get("error").is_none(),
        "original durable fork failed: {fork}"
    );
    let child = fork["result"]["thread"]["id"]
        .as_str()
        .context("fork id missing")?
        .to_owned();
    assert_ne!(child, thread);
    let read = fixture
        .call(&mut first, "thread/read", json!({"threadId":child}))
        .await?;
    ensure!(
        read.get("error").is_none(),
        "fork must use the original history reader: {read}"
    );
    let temporary = fixture
        .call(
            &mut first,
            "thread/fork",
            json!({"threadId":thread,"ephemeral":true}),
        )
        .await?;
    ensure!(
        temporary.get("error").is_none(),
        "original ephemeral fork failed: {temporary}"
    );
    let ephemeral = temporary["result"]["thread"]["id"]
        .as_str()
        .context("temporary id missing")?
        .to_owned();
    assert!(fixture.manager.is_ephemeral(&ephemeral));
    let denied = fixture
        .call(&mut second, "thread/dispose", json!({"threadId":ephemeral}))
        .await?;
    assert!(denied.get("error").is_some());
    assert!(
        fixture.manager.is_ephemeral(&ephemeral),
        "a peer may not destroy another client's temporary chat"
    );
    let disposed = fixture
        .call(&mut first, "thread/dispose", json!({"threadId":ephemeral}))
        .await?;
    ensure!(
        disposed.get("error").is_none(),
        "original dispose failed: {disposed}"
    );
    assert!(!fixture.manager.owns(&ephemeral));
    let mut selected = fixture.workspace.clone();
    fixture
        .owners
        .retire_ended(&mut fixture.manager, &mut selected, &fixture.workspace)
        .await;
    assert!(
        !first
            .context
            .as_ref()
            .unwrap()
            .state
            .input_ended
            .is_cancelled(),
        "retiring one temporary chat must not terminate its client's other tasks"
    );
    let deleted = fixture
        .call(&mut first, "thread/delete", json!({"threadId":child}))
        .await?;
    ensure!(
        deleted.get("error").is_none(),
        "original delete failed: {deleted}"
    );
    assert_eq!(std::fs::read(&history)?, original_bytes);
    assert_eq!(
        fixture
            .manager
            .handoff_snapshot(&thread, &fixture.server)
            .owner_ref,
        owner
    );
    assert!(fixture.manager.owns(&thread));
    drop((first, second));
    fixture.close().await;
    Ok(())
}
#[tokio::test]
async fn a_reply_never_reaches_another_clients_pending_interaction() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let mut first = fixture.client()?;
    let mut second = fixture.client()?;
    let frame = json!({"jsonrpc":"2.0","method":"question/request","id":1_000_007,
        "params":{"threadId":"original","turnId":"turn-1","questionId":"question-1"}});
    let output = first.context.as_ref().unwrap().outbound_tx.clone();
    output.send(frame.clone()).await?;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), first.frames.recv())
            .await?
            .unwrap(),
        frame
    );
    assert!(
        first
            .context
            .as_ref()
            .unwrap()
            .delivered_interactions
            .lock()
            .unwrap()
            .contains(&1_000_007)
    );
    assert!(
        !second
            .context
            .as_ref()
            .unwrap()
            .delivered_interactions
            .lock()
            .unwrap()
            .contains(&1_000_007)
    );
    fixture
        .frame(
            &mut second,
            json!({"jsonrpc":"2.0","id":1_000_007,"result":{"answers":{}}}),
        )
        .await?;
    assert!(second.frames.try_recv().is_err());
    drop((first, second));
    fixture.close().await;
    Ok(())
}
#[tokio::test]
async fn disconnecting_a_client_does_not_retire_a_peers_original_runtime() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let mut first = fixture.client()?;
    let mut second = fixture.client()?;
    let start = fixture
        .call(
            &mut first,
            "thread/start",
            json!({"clientRequestId":"rpc-peer-runtime"}),
        )
        .await?;
    ensure!(
        start.get("error").is_none(),
        "original start failed: {start}"
    );
    let thread = start["result"]["thread"]["id"]
        .as_str()
        .context("original task missing")?
        .to_owned();
    let resumed = fixture
        .call(&mut second, "thread/resume", json!({"threadId":thread}))
        .await?;
    ensure!(
        resumed.get("error").is_none(),
        "peer resume failed: {resumed}"
    );
    let original = fixture.manager.engine(&thread).unwrap().state.clone();
    let original_event_pipe = first.context.as_ref().unwrap().outbound_tx.clone();
    drop(first);
    let mut selected = fixture.workspace.clone();
    fixture
        .owners
        .retire_ended(&mut fixture.manager, &mut selected, &fixture.workspace)
        .await;
    assert!(fixture.manager.owns(&thread));
    assert!(
        fixture
            .manager
            .engine(&thread)
            .unwrap()
            .state
            .shares_state_with(&original)
    );
    let read = fixture
        .call(&mut second, "thread/read", json!({"threadId":thread}))
        .await?;
    assert!(read.get("error").is_none());
    let event = notification(
        "turn/completed",
        json!({"threadId":thread,
        "turn":{"id":"original-event","threadId":thread,"status":"completed"}}),
    );
    original_event_pipe.send(event.clone()).await?;
    let delivered = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = second.frames.recv().await.context("peer output closed")?;
            if frame == event {
                return Ok::<_, anyhow::Error>(());
            }
        }
    })
    .await?;
    delivered?;
    drop(original_event_pipe);
    drop(second);
    fixture.close().await;
    Ok(())
}

#[tokio::test]
async fn a_readonly_view_cannot_adopt_or_cancel_another_inputs_actual_token() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let mut creator = fixture.client()?;
    let mut viewer = fixture.client()?;
    let started = fixture
        .call(
            &mut creator,
            "thread/start",
            json!({"clientRequestId":"rpc-independent-input"}),
        )
        .await?;
    ensure!(
        started.get("error").is_none(),
        "original start failed: {started}"
    );
    let thread = started["result"]["thread"]["id"]
        .as_str()
        .context("task missing")?
        .to_owned();
    let independent = ConnectionState::default();
    let cancel = CancellationToken::new();
    let (release, waiting) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let _ = waiting.await;
    });
    let turn = fixture
        .manager
        .turn_state(&thread)
        .context("runtime missing")?;
    *turn.active_turn.lock().await = Some(ActiveTurn {
        desktop_owner: None,
        input_owner: Some(Arc::downgrade(&independent.source_management_owner)),
        handle,
        attempt: None,
        origin: crate::app_server::request_origin::RequestOrigin::Unverified,
        cancel: cancel.clone(),
        thread_id: thread.clone(),
        turn_id: "independent-turn".into(),
    });
    turn.running.store(true, Ordering::SeqCst);
    let read = fixture
        .call(&mut viewer, "thread/read", json!({"threadId":thread}))
        .await?;
    ensure!(read.get("error").is_none(), "read failed: {read}");
    drop(viewer);
    let mut selected = fixture.workspace.clone();
    fixture
        .owners
        .retire_ended(&mut fixture.manager, &mut selected, &fixture.workspace)
        .await;
    assert!(
        !cancel.is_cancelled(),
        "a viewer adopted another input's cancellation token"
    );
    let _ = release.send(());
    if let Some(active) = turn.active_turn.lock().await.take() {
        active.handle.await?;
    }
    turn.running.store(false, Ordering::SeqCst);
    drop(creator);
    fixture.close().await;
    Ok(())
}

#[tokio::test]
async fn sequential_wiki_status_requests_reap_completed_rpc_tasks() -> Result<()> {
    if !run_wiki_regression_in_isolated_child(
        "app_server::rpc_connection::tests::sequential_wiki_status_requests_reap_completed_rpc_tasks",
    )? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let mut client = fixture.client()?;
    let outcome = async {
        for index in 0..20 {
            let response = fixture
                .call(
                    &mut client,
                    kcoder_app_protocol::knowledge_method::STATUS,
                    json!({}),
                )
                .await?;
            ensure!(
                response.get("error").is_none(),
                "knowledge/status request {index} failed: {response}"
            );
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    let _ = fixture.submit(&mut client, None).await?;
    fixture.close().await;
    outcome?;
    Ok(())
}

#[tokio::test]
async fn wiki_reads_do_not_consume_native_rpc_admission_slots() -> Result<()> {
    if !run_wiki_regression_in_isolated_child(
        "app_server::rpc_connection::tests::wiki_reads_do_not_consume_native_rpc_admission_slots",
    )? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let mut client = fixture.client()?;
    let mut releases = Vec::new();
    for _ in 0..16 {
        releases.push(hold_join_set_task(
            &mut client.context.as_mut().unwrap().state.knowledge_rpc_tasks,
            None,
        ));
    }
    let outcome = async {
        let response = fixture
            .call(
                &mut client,
                kcoder_app_protocol::knowledge_method::STATUS,
                json!({}),
            )
            .await?;
        ensure!(
            response.get("error").is_none(),
            "native RPC tasks blocked Wiki status: {response}"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    for release in releases {
        let _ = release.send(());
    }
    let _ = fixture.submit(&mut client, None).await?;
    fixture.close().await;
    outcome?;
    Ok(())
}

#[tokio::test]
async fn wiki_rpc_limit_rejects_only_active_tasks_and_recovers_after_settlement() -> Result<()> {
    if !run_wiki_regression_in_isolated_child(
        "app_server::rpc_connection::tests::wiki_rpc_limit_rejects_only_active_tasks_and_recovers_after_settlement",
    )? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let mut client = fixture.client()?;
    let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut releases = Vec::new();
    for _ in 0..16 {
        releases.push(hold_join_set_task(
            &mut client.context.as_mut().unwrap().state.wiki_rpc_tasks,
            Some(completed.clone()),
        ));
    }
    let outcome = async {
        let busy = fixture
            .call(
                &mut client,
                kcoder_app_protocol::knowledge_method::STATUS,
                json!({}),
            )
            .await?;
        ensure!(
            busy["error"]["code"] == -32000
                && busy["error"]["message"] == "knowledge service is busy",
            "the Wiki pool should reject at its own 16-active-task limit: {busy}"
        );
        client.context.as_mut().unwrap().state.client_transport_only = false;
        let idle_shutdown = fixture
            .call(
                &mut client,
                kcoder_app_protocol::method::SERVER_IDLE_SHUTDOWN,
                json!({"instanceId":resources_processor::instance_id()}),
            )
            .await?;
        ensure!(
            idle_shutdown["result"]["accepted"] == false
                && idle_shutdown["result"]["reason"] == "resources",
            "idle shutdown ignored active Wiki RPC tasks: {idle_shutdown}"
        );
        for release in releases.drain(..) {
            release
                .send(())
                .map_err(|_| anyhow::anyhow!("Wiki task release receiver ended early"))?;
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while completed.load(Ordering::SeqCst) != 16 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .context("Wiki tasks did not settle")?;
        ensure!(
            client.context.as_ref().unwrap().state.wiki_rpc_tasks.len() == 16,
            "completed Wiki task handles should remain pending reaping"
        );
        let recovered = fixture
            .call(
                &mut client,
                kcoder_app_protocol::knowledge_method::STATUS,
                json!({}),
            )
            .await?;
        ensure!(
            recovered.get("error").is_none(),
            "settled Wiki slots were not reclaimed before the next request: {recovered}"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    for release in releases {
        let _ = release.send(());
    }
    let _ = fixture.submit(&mut client, None).await?;
    fixture.close().await;
    outcome?;
    Ok(())
}

#[tokio::test]
async fn disconnect_cancels_only_its_wiki_rpc_tasks_and_leaves_peer_usable() -> Result<()> {
    if !run_wiki_regression_in_isolated_child(
        "app_server::rpc_connection::tests::disconnect_cancels_only_its_wiki_rpc_tasks_and_leaves_peer_usable",
    )? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let mut first = fixture.client()?;
    let mut second = fixture.client()?;
    let first_dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let second_dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    hold_unfinished_task(
        &mut first.context.as_mut().unwrap().state.wiki_rpc_tasks,
        first_dropped.clone(),
    );
    hold_unfinished_task(
        &mut second.context.as_mut().unwrap().state.wiki_rpc_tasks,
        second_dropped.clone(),
    );

    assert!(!fixture.submit(&mut first, None).await?);
    assert!(
        first_dropped.load(Ordering::SeqCst),
        "disconnect did not cancel and drain the first client's Wiki task"
    );
    assert!(
        !second_dropped.load(Ordering::SeqCst),
        "disconnect cancelled a peer's Wiki task"
    );
    assert_eq!(
        first.context.as_ref().unwrap().state.wiki_rpc_tasks.len(),
        0
    );
    assert_eq!(
        second.context.as_ref().unwrap().state.wiki_rpc_tasks.len(),
        1
    );
    let status = fixture
        .call(
            &mut second,
            kcoder_app_protocol::knowledge_method::STATUS,
            json!({}),
        )
        .await?;
    ensure!(
        status.get("error").is_none(),
        "peer Wiki requests failed after another client disconnected: {status}"
    );
    assert!(!second_dropped.load(Ordering::SeqCst));
    assert!(!fixture.submit(&mut second, None).await?);
    assert!(second_dropped.load(Ordering::SeqCst));
    fixture.close().await;
    Ok(())
}
