use super::*;

fn isolate(case: &str) -> bool {
    const CHILD: &str = "KCODER_TASK_DELIVERY_RPC_CHILD";
    if std::env::var(CHILD).as_deref() == Ok(case) {
        return false;
    }
    let config = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("app_server::task_delivery_requests::tests::{case}"),
            "--nocapture",
        ])
        .env(CHILD, case)
        .env("KCODER_CONFIG_DIR", config.path())
        .env_remove("KCODER_HISTORY_DIR")
        .env_remove("KCODER_HOME")
        .status()
        .unwrap();
    assert!(status.success(), "isolated delivery RPC fixture failed");
    true
}

fn runtime(workspace: &Path, histories: &Path) -> ThreadRuntime {
    runtime_with_storage(workspace, histories, true)
}
fn runtime_with_storage(workspace: &Path, histories: &Path, durable: bool) -> ThreadRuntime {
    let services = if durable {
        kcoder_engine::WorkspaceRuntimeServices::try_new_for_client(workspace, "delivery-rpc-test")
            .unwrap()
    } else {
        kcoder_engine::WorkspaceRuntimeServices::new(workspace, "delivery-rpc-temporary-test")
            .with_private_client_storage(Arc::new(
                kcoder_config::create_private_temp_dir("delivery-rpc-temporary-test").unwrap(),
            ))
    };
    let settings = kcoder_config::Settings::default();
    let engine = QueryEngine::try_new_for_client_with_services(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(workspace),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.to_path_buf(),
        Some(true),
        services,
    )
    .unwrap();
    let thread = engine.session_id();
    engine
        .state
        .with_history_path(histories.join(format!("{thread}.jsonl")));
    engine
        .state
        .add_message(kcoder_types::Message::user_text("owned delivery fixture"));
    engine.state.save_history().unwrap();
    let lease = SessionLease::acquire(&engine.session_lease_target()).unwrap();
    let projection = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let followups = Arc::new(BackgroundFollowupState::default());
    let (tx, _rx) = mpsc::channel(32);
    let turns = ResidentTurnState::new(
        tx.clone(),
        kcoder_config::PermissionMode::Bypass,
        Arc::new(AtomicU64::new(8_000_000)),
        Arc::new(StdMutex::new(InteractionReceipts::default())),
    );
    let pump =
        BackgroundEventPump::spawn(&engine, Arc::clone(&projection), Arc::clone(&followups), tx);
    ThreadRuntime::new(
        engine,
        lease,
        projection,
        followups,
        (pump, BackgroundFollowupScheduler::disabled_for_test()),
        turns,
    )
}
async fn git_ok(cwd: &Path, args: &[&str]) {
    let result = run_git_command(cwd, args, 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(
        result.success,
        "owned fixture git {args:?}: {}",
        result.stderr
    );
}
async fn repository(cwd: &Path) {
    git_ok(cwd, &["init", "-b", "main"]).await;
    git_ok(cwd, &["config", "user.name", "Delivery IPC Fixture"]).await;
    git_ok(cwd, &["config", "user.email", "ipc@example.invalid"]).await;
    git_ok(
        cwd,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/fixture/owned-ipc-test.git",
        ],
    )
    .await;
    std::fs::write(cwd.join("answer.txt"), "baseline\n").unwrap();
    git_ok(cwd, &["add", "answer.txt"]).await;
    git_ok(
        cwd,
        &["-c", "commit.gpgsign=false", "commit", "-m", "baseline"],
    )
    .await;
    git_ok(cwd, &["checkout", "-b", "owned-feature"]).await;
    std::fs::write(cwd.join("answer.txt"), "committed answer\n").unwrap();
    git_ok(cwd, &["add", "answer.txt"]).await;
    git_ok(
        cwd,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "actual owned feature",
        ],
    )
    .await;
}
fn labels(thread: &str) -> p::TaskDeliveryRecipient {
    p::TaskDeliveryRecipient {
        task_id: format!("kcoder:fixture-target:{thread}"),
        thread_id: thread.into(),
        device_id: "fixture-target".into(),
    }
}

#[tokio::test]
async fn native_entry_prepares_and_records_only_the_owned_thread_without_remote_publication() {
    if isolate("native_entry_prepares_and_records_only_the_owned_thread_without_remote_publication")
    {
        return;
    }
    let workspace = tempfile::tempdir().unwrap();
    let histories = tempfile::tempdir().unwrap();
    repository(workspace.path()).await;
    let owned = runtime(workspace.path(), histories.path());
    let engine = owned.engine();
    let thread = engine.session_id();
    let mut manager = ThreadManager::default();
    assert!(manager.insert(owned).is_ok());
    let prepared = request(
        dm::PREPARE,
        json!({"threadId":thread,"owner":labels(&thread),"baseBranch":"main"}),
        &manager,
    )
    .await
    .unwrap();
    assert_eq!(prepared["source"]["branch"], "owned-feature");
    assert_eq!(prepared["recipient"]["threadId"], thread);
    assert_eq!(prepared["recipient"]["taskId"], labels(&thread).task_id);
    assert_eq!(prepared["status"]["ciState"], "unknown");
    let intent = request(
        dm::REQUEST,
        json!({"threadId":thread,"owner":labels(&thread),
        "deliveryId":prepared["deliveryId"],"requestId":uuid::Uuid::new_v4().to_string(),
        "title":"Edited fixture title","body":"Synthetic fixture body"}),
        &manager,
    )
    .await
    .unwrap();
    assert!(
        intent["request"]["prompt"]
            .as_str()
            .unwrap()
            .contains("normal authorized tools")
    );
    assert_eq!(intent["status"]["pushState"], "unknown");
    assert!(intent["status"]["pullRequest"].is_null());
    let remote = run_git_command(
        workspace.path(),
        &["rev-parse", "--verify", "@{upstream}"],
        1024,
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    assert!(!remote.success);
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn native_entry_rejects_cold_unowned_thread_forged_owner_and_path_before_any_capture() {
    if isolate("native_entry_rejects_cold_unowned_thread_forged_owner_and_path_before_any_capture")
    {
        return;
    }
    let workspace = tempfile::tempdir().unwrap();
    let histories = tempfile::tempdir().unwrap();
    let owned = runtime(workspace.path(), histories.path());
    let engine = owned.engine();
    let thread = engine.session_id();
    let mut manager = ThreadManager::default();
    assert!(manager.insert(owned).is_ok());
    assert!(request(dm::PREPARE, json!({"threadId":"unowned-thread","owner":labels("unowned-thread"),"baseBranch":"main"}), &manager).await.is_err());
    assert!(
        request(
            dm::PREPARE,
            json!({"threadId":thread,"owner":labels("another-thread"),"baseBranch":"main"}),
            &manager
        )
        .await
        .is_err()
    );
    assert!(request(dm::PREPARE, json!({"threadId":thread,"owner":labels(&thread),"baseBranch":"main","path":"/forged/workspace"}), &manager).await.is_err());
    assert!(request(dm::PREPARE, json!({"threadId":thread,"owner":labels(&thread),"baseBranch":"main","comparisonId":"missing-comparison"}), &manager).await.is_err());
    assert!(
        !engine
            .session_storage_dir_for(&thread)
            .join("task-delivery")
            .exists()
    );
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn comparison_native_entry_routes_owner_a_and_never_candidate_b_thread_id() {
    if isolate("comparison_native_entry_routes_owner_a_and_never_candidate_b_thread_id") {
        return;
    }
    let workspace = tempfile::tempdir().unwrap();
    let histories = tempfile::tempdir().unwrap();
    let owned = runtime(workspace.path(), histories.path());
    let thread = owned.engine().session_id();
    let mut manager = ThreadManager::default();
    assert!(manager.insert(owned).is_ok());
    let input = json!({"sourcePath":workspace.path(),"deviceId":"fixture-target","comparisonId":"comparison-fixture","ownerThreadId":thread});
    let result = request(p::TASK_COMPARISON_READ, input.clone(), &manager)
        .await
        .unwrap();
    assert_eq!(result["ownerThreadId"], thread);
    assert_eq!(result["candidates"], json!([]));
    let mut wrong = input.clone();
    wrong["ownerThreadId"] = json!("not-owned");
    assert!(
        request(p::TASK_COMPARISON_READ, wrong, &manager)
            .await
            .is_err()
    );
    let mut forged = input;
    forged["sourcePath"] = json!(histories.path());
    assert!(
        request(p::TASK_COMPARISON_READ, forged, &manager)
            .await
            .is_err()
    );
    let select = json!({"sourcePath":workspace.path(),"deviceId":"fixture-target","comparisonId":"comparison-fixture", "ownerThreadId":"not-owned-a", "threadId":thread,"expectedRevision":1,"expectedHeadCommit":"a".repeat(40),"expectedContentToken":"b".repeat(64)});
    let error = request(p::TASK_COMPARISON_SELECT, select, &manager)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("review_owner_unavailable"));
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}

#[test]
fn native_capabilities_and_method_allowlist_are_explicit() {
    let capabilities = server_capabilities(false);
    assert_eq!(
        capabilities
            .experimental
            .get(p::CAPABILITY_TASK_COMPARISON_V1),
        Some(&true)
    );
    assert_eq!(
        capabilities
            .experimental
            .get(p::CAPABILITY_TASK_DELIVERY_V1),
        Some(&true)
    );
    for method in [
        dm::PREPARE,
        dm::READ,
        dm::REQUEST,
        dm::FAILURE,
        p::TASK_COMPARISON_BIND,
        p::TASK_COMPARISON_READ,
        p::TASK_COMPARISON_SELECT,
    ] {
        assert!(supports(method));
    }
    assert!(!supports("task/delivery/publish"));
    assert!(!supports("task/delivery/merge"));
}

#[tokio::test]
async fn temporary_storage_downgrades_capability_and_cannot_record_publication_intents() {
    if isolate("temporary_storage_downgrades_capability_and_cannot_record_publication_intents") {
        return;
    }
    let workspace = tempfile::tempdir().unwrap();
    let histories = tempfile::tempdir().unwrap();
    let owned = runtime_with_storage(workspace.path(), histories.path(), false);
    let engine = owned.engine();
    let thread = engine.session_id();
    let mut state = ConnectionState::default();
    let initialized = state.initialize(
        json!(1),
        &json!({"protocolVersion":PROTOCOL_VERSION,
        "clientInfo":{"name":"owned-delivery-fixture","version":"1"},"capabilities":{}}),
        &engine,
    );
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"][p::CAPABILITY_TASK_DELIVERY_V1],
        false
    );
    let mut manager = ThreadManager::default();
    assert!(manager.insert(owned).is_ok());
    let error = request(
        dm::PREPARE,
        json!({"threadId":thread,"owner":labels(&thread),"baseBranch":"main"}),
        &manager,
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("delivery_durable_storage_unavailable"));
    assert!(
        !engine
            .session_storage_dir_for(&thread)
            .join("task-delivery")
            .exists()
    );
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}
