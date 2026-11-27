//! Stop and restart the real public turn while an owned background Agent lives.
use super::*;
use crate::app_server::ct85_test_support;
use std::time::Duration;

#[test]
fn interrupted_source_bound_turn_can_restart_with_running_child() {
    ct85_test_support::run_owned_case(concat!(module_path!(), "::owned_dispatch"), "source-bound");
}

#[test]
fn interrupted_channel_turn_can_restart_with_running_child() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "channel-source-bound",
    );
}

#[test]
fn interrupted_turn_without_task_scope_management_can_restart_with_running_child() {
    ct85_test_support::run_owned_case(
        concat!(module_path!(), "::owned_dispatch"),
        "without-source-management",
    );
}

struct SpawnThenWaitProvider {
    calls: Arc<AtomicUsize>,
}

impl kcoder_api::Provider for SpawnThenWaitProvider {
    fn name(&self) -> &'static str {
        "interrupted-source-rebind-fixture"
    }

    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }

    fn stream_messages(
        &self,
        request: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if serde_json::to_string(&request.messages)
            .unwrap()
            .contains("Resume the interrupted owned parent.")
        {
            return Ok(probe_response());
        }
        if call == 0 {
            return Ok(Box::pin(futures::stream::iter([
                Ok(kcoder_types::StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: kcoder_types::ContentBlock::ToolUse {
                        id: "owned-background-spawn".into(),
                        name: "spawn_agent".into(),
                        input: serde_json::json!({
                            "message": "Wait in the isolated test provider.",
                            "agent_type": "general", "context_mode": "none",
                            "max_turns": 1, "run_in_background": true
                        }),
                    },
                }),
                Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 }),
                Ok(kcoder_types::StreamEvent::MessageStop),
            ])));
        }
        // Both the real child and the parent's next model request remain live
        // until their own cancellation, without sleeps or a network service.
        Ok(Box::pin(futures::stream::pending()))
    }
}

#[test]
#[ignore = "run only as the owned subprocess of an interruption regression"]
fn owned_dispatch() {
    let case = ct85_test_support::owned_case();
    on_dispatch_stack(move || run(case));
}

async fn run(case: String) -> Result<()> {
    let task_scope_management = case != "without-source-management";
    let unattended = case == "channel-source-bound";
    let workspace = ct85_test_support::owned_tempdir();
    ct85_test_support::prepare_workspace(workspace.path());
    let profile = std::path::PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap());
    let context = NativeIntegrationContext::capture(
        &profile,
        workspace.path(),
        "interrupt-rebind-fixture",
        "model-1",
    )?;
    let storage = Arc::new(kcoder_config::create_private_temp_dir("interrupt-rebind")?);
    let calls = Arc::new(AtomicUsize::new(0));
    let settings = kcoder_config::Settings {
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        max_retries: 0,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let workspace_path = workspace.path().to_path_buf();
    let services = std::thread::spawn(move || {
        kcoder_engine::WorkspaceRuntimeServices::new(&workspace_path, "interrupt-rebind")
    })
    .join()
    .expect("owned workspace services")
    .with_private_client_storage(storage);
    let factory = AppServerEngineFactory::new(
        Arc::new(SpawnThenWaitProvider {
            calls: calls.clone(),
        }),
        kcoder_tools::default_registry(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        workspace.path().to_path_buf(),
        None,
        true,
        services,
        None,
        profile.join("short-ids"),
    );
    let mut engine = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    let thread = engine.session_id();
    engine
        .state
        .with_history_path(profile.join(format!("{thread}.jsonl")));
    engine.state.save_history()?;
    let lease = SessionLease::acquire(&engine.session_lease_target())?;
    let (outbound, mut notifications) = mpsc::channel(256);
    let sequence = Arc::new(AtomicU64::new(1));
    let turn_state = ResidentTurnState::new(
        outbound.clone(),
        kcoder_config::PermissionMode::Bypass,
        Arc::new(AtomicU64::new(2_000_000)),
        Arc::new(StdMutex::new(InteractionReceipts::default())),
    );
    let resident = build_resident_thread_runtime(
        engine.clone(),
        lease,
        0,
        turn_state.clone(),
        outbound.clone(),
        "interrupt-rebind".into(),
        sequence.clone(),
    );
    let mut manager = ThreadManager::default();
    assert!(manager.insert(resident).is_ok());
    let mut state = ConnectionState {
        integration_context: Some(context),
        integration_task_capability_scope_v1: task_scope_management,
        ..Default::default()
    };
    manager
        .followups(&thread)
        .unwrap()
        .session_activity
        .attach(
            &state,
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
        )?;
    let mut attachments = AttachmentDirectories::default();
    turn_requests::dispatch(
        "turn/start", serde_json::json!("initial"),
        serde_json::json!({"threadId":thread,"clientMessageId":"initial-input",
            "unattended":unattended,"input":[{"type":"text","text":"Start the owned background child."}]}),
        &mut engine, &factory, &outbound, &mut manager, "interrupt-rebind",
        &sequence, &mut state, &mut attachments, None,
    ).await?;
    let child = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if calls.load(Ordering::SeqCst) >= 3
                && let Some(task) = engine.state.tasks().values().find(|task| {
                    task.kind == kcoder_state::TaskKind::Subagent
                        && task.status == kcoder_state::TaskStatus::Running
                })
            {
                return Ok::<_, anyhow::Error>(task.id.clone());
            }
            while let Ok(frame) = notifications.try_recv() {
                ensure!(
                    frame["method"] != "turn/completed",
                    "parent finished before the real background child started: {frame}"
                );
            }
            tokio::task::yield_now().await;
        }
    })
    .await??;
    let turn = turn_state
        .active_turn
        .lock()
        .await
        .as_ref()
        .context("owned parent turn missing")?
        .turn_id
        .clone();
    turn_requests::dispatch(
        "turn/interrupt",
        serde_json::json!("stop"),
        serde_json::json!({"threadId":thread,"turnId":turn}),
        &mut engine,
        &factory,
        &outbound,
        &mut manager,
        "interrupt-rebind",
        &sequence,
        &mut state,
        &mut attachments,
        None,
    )
    .await?;
    #[cfg(target_os = "linux")]
    state.native_interrupts.drain().await;
    assert!(!turn_state.running.load(Ordering::SeqCst));
    assert_eq!(
        engine.state.task(&child).unwrap().status,
        kcoder_state::TaskStatus::Running
    );
    let mut interrupted = false;
    while let Ok(frame) = notifications.try_recv() {
        if frame["id"] == "stop" {
            assert_eq!(frame["result"]["interrupted"], true, "{frame}");
            interrupted = true;
        }
    }
    assert!(interrupted, "owned stop response missing");
    let calls_before_restart = calls.load(Ordering::SeqCst);
    turn_requests::dispatch(
        "turn/start", serde_json::json!("restart"),
        serde_json::json!({"threadId":thread,"clientMessageId":"restart-input",
            "unattended":unattended,"input":[{"type":"text","text":"Resume the interrupted owned parent."}]}),
        &mut engine, &factory, &outbound, &mut manager, "interrupt-rebind",
        &sequence, &mut state, &mut attachments, None,
    ).await?;
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame = notifications
                .recv()
                .await
                .context("owned notification closed")?;
            if frame["method"] == "turn/completed" {
                return Ok::<_, anyhow::Error>(frame);
            }
        }
    })
    .await??;
    let calls_after_restart = calls.load(Ordering::SeqCst);
    // Clean up the actual child and resident even when the regression is red.
    engine.abort_background_job_and_wait(&child).await;
    for resident in manager.drain() {
        resident.shutdown().await;
    }
    eprintln!(
        "case={case}, provider_calls_before={calls_before_restart}, provider_calls_after={calls_after_restart}, completion={completed}"
    );
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "a stopped parent must remain usable while its independently owned child runs: {completed}"
    );
    assert!(calls_after_restart > calls_before_restart);
    Ok(())
}
