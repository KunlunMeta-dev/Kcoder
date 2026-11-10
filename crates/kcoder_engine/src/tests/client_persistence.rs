#[test]
fn historyless_client_engine_routes_all_session_artifacts_outside_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = Settings::default();
    let state = AppState::new(&workspace);
    let engine = QueryEngine::try_new_for_client(
        Arc::new(EmptyProvider),
        state,
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(&workspace).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.clone(),
    )
    .unwrap();

    assert_eq!(
        engine.workspace_persistence_mode,
        WorkspacePersistenceMode::Client
    );
    let task_output = engine.state.managed_task_output_path("job-1");
    let nested_transcript = engine.state.subagent_transcript_path("agent-1");
    assert!(!task_output.starts_with(&workspace));
    assert!(!nested_transcript.starts_with(&workspace));
    assert!(!workspace.join(".kcoder").exists());
    assert!(engine.client_storage_owner.is_none());
    assert_eq!(
        engine.durable_client_storage_root(),
        Some(engine.client_storage_root())
    );
    assert!(engine.state.history_path().is_none());

    let configured = tmp.path().join("configured-project-data");
    let (configured_root, configured_owner) =
        client_session_storage_root_with(Ok(configured.clone()), || {
            panic!("fallback must not run for configured project data")
        })
        .unwrap();
    assert_eq!(configured_root, configured.join("client-sessions"));
    assert!(configured_owner.is_none());

    let fallback_failure = client_session_storage_root_with(
        Err(anyhow::anyhow!("project data unavailable")),
        || Err(anyhow::anyhow!("private fallback unavailable")),
    )
    .expect_err("injected storage failure must propagate");
    assert!(fallback_failure.to_string().contains("private fallback unavailable"));

    let (inherited_root, inherited_owner) = client_session_storage_root_with(
        Err(anyhow::anyhow!("project data unavailable")),
        || kcoder_config::create_private_temp_dir("kcoder-engine-test"),
    )
    .unwrap();
    let owner = inherited_owner.expect("fallback must return an owner");
    let owner_path = owner.path().to_path_buf();
    std::fs::create_dir(&inherited_root).unwrap();
    let fallback_state = AppState::new(&workspace);
    let fallback_settings = Settings::default();
    let fallback_engine = QueryEngine::try_new_with_folder_trust_and_project_skill_telemetry(
        Arc::new(EmptyProvider),
        fallback_state,
        ToolRegistry::new(),
        PermissionEngine::from_settings(&fallback_settings),
        fallback_settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(&workspace).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.clone(),
        None,
        None,
        WorkspacePersistenceMode::Client,
        Some(Ok((inherited_root.clone(), Some(owner.clone())))),
        None,
        true,
    )
    .unwrap();
    assert_eq!(fallback_engine.client_storage_root(), inherited_root);
    assert!(fallback_engine.durable_client_storage_root().is_none());
    assert!(Arc::ptr_eq(
        fallback_engine.client_storage_owner.as_ref().unwrap(),
        &owner
    ));
    drop(owner);
    assert!(owner_path.exists(), "engine must retain fallback owner");

    let child_settings = Settings::default();
    let child_engine = QueryEngine::try_new_with_folder_trust_and_project_skill_telemetry(
        Arc::new(EmptyProvider),
        AppState::new(&workspace),
        ToolRegistry::new(),
        PermissionEngine::from_settings(&child_settings),
        child_settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(&workspace).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.clone(),
        None,
        None,
        WorkspacePersistenceMode::Client,
        Some(Ok((
            fallback_engine.session_storage_root.clone(),
            fallback_engine.client_storage_owner.clone(),
        ))),
        None,
        true,
    )
    .unwrap();
    assert_eq!(
        child_engine.client_storage_root(),
        fallback_engine.client_storage_root()
    );
    let child_owner = child_engine.client_storage_owner.clone();
    assert!(child_engine.durable_client_storage_root().is_none());
    assert!(Arc::ptr_eq(
        child_owner.as_ref().unwrap(),
        fallback_engine.client_storage_owner.as_ref().unwrap()
    ));

    let interactive_fork_cwd = tmp.path().join("interactive-fork-worktree");
    std::fs::create_dir_all(&interactive_fork_cwd).unwrap();
    let interactive_settings = Settings::default();
    let interactive_child =
        QueryEngine::try_new_with_folder_trust_and_project_skill_telemetry(
            Arc::new(EmptyProvider),
            AppState::new(&interactive_fork_cwd),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&interactive_settings),
            interactive_settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::load_project_only(&interactive_fork_cwd).unwrap(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            interactive_fork_cwd.clone(),
            None,
            None,
            WorkspacePersistenceMode::Interactive,
            Some(Ok((
                fallback_engine.session_storage_root.clone(),
                fallback_engine.client_storage_owner.clone(),
            ))),
            None,
            true,
        )
        .unwrap();
    assert_eq!(
        interactive_child.client_storage_root(),
        interactive_fork_cwd.join(".kcoder").join("sessions")
    );
    assert!(interactive_child.client_storage_owner.is_none());
    assert!(interactive_child.durable_client_storage_root().is_none());
    drop(interactive_child);

    drop(fallback_engine);
    drop(child_engine);
    assert!(owner_path.exists(), "fork owner clone must prevent early cleanup");
    drop(child_owner);
    assert!(!owner_path.exists(), "last fallback owner must clean the root");

    let failed_try = QueryEngine::try_new_with_folder_trust_and_project_skill_telemetry(
        Arc::new(EmptyProvider),
        AppState::new(&workspace),
        ToolRegistry::new(),
        PermissionEngine::from_settings(&Settings::default()),
        Settings::default(),
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(&workspace).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace,
        None,
        None,
        WorkspacePersistenceMode::Client,
        Some(Err(anyhow::anyhow!("injected secure storage failure"))),
        None,
        true,
    )
    .err()
    .expect("injected constructor storage failure must propagate");
    assert!(failed_try.to_string().contains("injected secure storage failure"));
}

#[tokio::test]
async fn submit_message_records_structured_session_and_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        Settings::default(),
        memory_manager,
    );

    let session = engine
        .memory_manager
        .get_structured_session(&engine.session_id())
        .unwrap()
        .unwrap();
    assert_eq!(session.project_key, "project-a");
    assert_eq!(session.cwd, tmp.path().display().to_string());

    engine
        .submit_message(
            "remember public context <private>secret token</private>",
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await;

    let prompt = engine
        .memory_manager
        .get_structured_prompt(&engine.session_id(), 1)
        .unwrap()
        .unwrap();
    assert_eq!(prompt.prompt_text, "remember public context");
    assert_eq!(
        engine
            .memory_manager
            .get_structured_prompt(&engine.session_id(), 2)
            .unwrap(),
        None
    );
}
#[test]
fn cloned_workspace_services_keep_one_cron_scheduler_and_shell_snapshot_handle() {
    let temp = tempfile::tempdir().unwrap();
    let first = WorkspaceRuntimeServices::try_new_for_client(temp.path(), "workspace-runtime-test")
        .unwrap();
    let second = first.clone();

    assert!(Arc::ptr_eq(&first.cron_scheduler, &second.cron_scheduler));
    assert!(Arc::ptr_eq(
        &first.provider_prewarmed,
        &second.provider_prewarmed
    ));
    assert_eq!(
        first.shell_environment_snapshot.ready_path(),
        second.shell_environment_snapshot.ready_path()
    );
    let (first_root, first_owner) = first.client_storage.as_ref().unwrap();
    let (second_root, second_owner) = second.client_storage.as_ref().unwrap();
    assert_eq!(first_root, second_root);
    assert_eq!(first_owner.is_some(), second_owner.is_some());
    if let (Some(first_owner), Some(second_owner)) = (first_owner, second_owner) {
        assert!(Arc::ptr_eq(first_owner, second_owner));
    }
}

async fn first_input_write_failure_blocks_model_and_further_submissions_until_reload_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .build_with_profile_directory();
    let path = root.path().join("first.jsonl");
    engine.state.with_history_path(&path);
    // A directory at the destination deterministically rejects the actual write,
    // including when the test runs as root. No personal permissions are touched.
    std::fs::create_dir(&path).unwrap();
    kcoder_config::set_user_only_dir_permissions(&path).unwrap();
    kcoder_config::PrivateDirectory::open_existing(&path)
        .unwrap()
        .verify_private_directory()
        .unwrap();
    let first = engine
        .submit_message("accepted first input", &AlwaysDenyPrompt)
        .await;
    assert!(first.iter().any(
        |event| matches!(event, EngineEvent::Error(message) if message.contains("durability"))
    ));
    assert!(
        !first
            .iter()
            .any(|event| matches!(event, EngineEvent::UserMessageAdded))
    );
    let before = engine.state.messages();
    let second = engine.submit_message("must not append again", &AlwaysDenyPrompt).await;
    assert!(second.iter().any(|event| matches!(event, EngineEvent::Error(message) if message.contains("reload"))));
    assert_eq!(engine.state.messages(), before);
    let continued: Vec<_> = engine.run_turn_stream(&AlwaysDenyPrompt).collect().await;
    assert!(continued.iter().any(|event| matches!(event, EngineEvent::Error(message) if message.contains("reload"))));
    assert!(requests.lock().unwrap().is_empty());
}

async fn input_snapshot_replacement_before_commit_never_starts_the_model_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .build_with_profile_directory();
    let history = root.path().join("input-snapshot-race.jsonl");
    engine.state.with_history_path(&history);

    let mut stream = engine.submit_message_stream("uncommitted user input", &AlwaysDenyPrompt);
    let mut first = Box::pin(stream.next());
    // The current-thread executor cannot poll the history worker until this
    // test yields, so the input is queued but its original entry is not yet written.
    assert!(matches!(
        futures::poll!(first.as_mut()),
        std::task::Poll::Pending
    ));
    engine.state.set_messages(Vec::new());
    engine.state.save_history().unwrap();

    let mut events = Vec::new();
    if let Some(event) = first.await {
        events.push(event);
    }
    events.extend(stream.collect::<Vec<_>>().await);
    assert!(events.iter().any(
        |event| matches!(event, EngineEvent::Error(message) if message.contains("durability"))
    ));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::UserMessageAdded))
    );
    assert!(requests.lock().unwrap().is_empty());
    assert!(
        !std::fs::read_to_string(history)
            .unwrap()
            .contains("uncommitted user input")
    );
}

async fn structured_input_is_in_history_before_acceptance_and_model_dispatch_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .build_with_profile_directory();
    let history = root.path().join("structured-input.jsonl");
    engine.state.with_history_path(&history);
    let message = Message::user_content(vec![
        ContentBlock::Text {
            text: "inspect this image".into(),
        },
        ContentBlock::Image {
            source: kcoder_types::ImageSource::base64("image/png", "aW1hZ2U="),
        },
    ]);

    let mut stream =
        engine.submit_message_content_stream(message, "inspect this image", &AlwaysDenyPrompt);
    assert!(matches!(
        stream.next().await,
        Some(EngineEvent::UserMessageAdded)
    ));
    assert!(requests.lock().unwrap().is_empty());
    let saved = std::fs::read_to_string(&history).unwrap();
    assert!(saved.contains("inspect this image"));
    assert!(saved.contains("aW1hZ2U="));

    let _events = stream.collect::<Vec<_>>().await;
    assert!(!requests.lock().unwrap().is_empty());
}

async fn cancelled_before_input_does_not_append_or_poison_the_session_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let cancel = CancellationToken::new();
    cancel.cancel();
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .build_with_profile_directory()
        .with_cancel_token(cancel);
    let before = engine.state.messages();
    let events = engine
        .submit_message("never enqueued", &AlwaysDenyPrompt)
        .await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::StreamAborted { .. }))
    );
    assert_eq!(engine.state.messages(), before);
    assert!(!engine.input_persistence_failed.load(Ordering::Acquire));
    assert!(requests.lock().unwrap().is_empty());
}

async fn original_input_rewrite_after_acknowledgement_never_starts_provider_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .build_with_profile_directory();
    let history = root.path().join("rewrite-after-ack.jsonl");
    engine.state.with_history_path(&history);
    let mut stream = engine.submit_message_stream("original", &AlwaysDenyPrompt);
    assert!(matches!(
        stream.next().await,
        Some(EngineEvent::UserMessageAdded)
    ));
    assert!(requests.lock().unwrap().is_empty());
    engine.state.set_messages(engine.state.messages());
    let events = stream.collect::<Vec<_>>().await;
    assert!(events.iter().any(|event| matches!(event, EngineEvent::Error(message) if message.contains("no model request was sent"))));
    assert!(requests.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(history)
            .unwrap()
            .matches("original")
            .count(),
        1
    );
}

#[cfg(unix)]
async fn scoped_input_cancelled_while_state_is_locked_never_appends_impl() {
    use std::os::fd::AsRawFd;
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let cancel = CancellationToken::new();
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .build_with_profile_directory()
        .with_cancel_token(cancel.clone());
    let history = root.path().join("busy-before-input.jsonl");
    engine.state.with_history_path(&history);
    engine.state.materialize_history().unwrap();
    let owner = engine.state.inspection_lifecycle_identity();
    let attempt = kcoder_types::TurnAttemptIdentity {
        thread_id: engine.state.session_id(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    };
    let scope = engine.state.history_attempt_scope(attempt).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".kcoder-history.lock"))
        .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let snapshot_state = engine.state.clone();
    let snapshot = std::thread::spawn(move || snapshot_state.save_history());
    tokio::time::timeout(Duration::from_secs(5), async {
        while engine
            .state
            .try_check_lifecycle_identity(&owner)
            .unwrap()
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("snapshot must hold the original State lock");
    let task_engine = engine.clone();
    let task = tokio::spawn(scope.run(async move {
        task_engine
            .submit_message("must not append", &AlwaysDenyPrompt)
            .await
    }));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!task.is_finished());
    cancel.cancel();
    let events = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::StreamAborted { .. }))
    );
    assert!(!engine.input_persistence_failed.load(Ordering::Acquire));
    assert!(requests.lock().unwrap().is_empty());
    drop(lock);
    snapshot.join().unwrap().unwrap();
    assert!(engine.state.messages().is_empty());
    assert!(
        !std::fs::read_to_string(history)
            .unwrap()
            .contains("must not append")
    );
}

#[cfg(unix)]
async fn cancelled_original_ticket_settles_once_without_provider_or_replay_impl() {
    use std::os::fd::AsRawFd;
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let cancel = CancellationToken::new();
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .settings(settings_using_main_summary_runtime(Settings::default()))
        .build_with_profile_directory()
        .with_cancel_token(cancel.clone());
    let history = root.path().join("locked-ticket.jsonl");
    engine.state.with_history_path(&history);
    engine.state.materialize_history().unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".kcoder-history.lock"))
        .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let mut stream = engine.submit_message_stream("one original input", &AlwaysDenyPrompt);
    let notice = tokio::time::timeout(Duration::from_secs(4), stream.next())
        .await
        .unwrap();
    assert!(matches!(notice, Some(EngineEvent::SystemNotice(text)) if text.contains("Saving")));
    assert!(
        tokio::time::timeout(
            Duration::from_millis(250),
            engine.run_session_end_hooks("cancelled")
        )
        .await
        .unwrap()
        .is_empty()
    );
    assert!(requests.lock().unwrap().is_empty());
    cancel.cancel();
    let events = tokio::time::timeout(Duration::from_secs(2), stream.collect::<Vec<_>>())
        .await
        .unwrap();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::StreamAborted { .. }))
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::UserMessageAdded))
    );
    assert!(engine.input_persistence_failed.load(Ordering::Acquire));
    assert!(requests.lock().unwrap().is_empty());
    assert!(
        tokio::time::timeout(
            Duration::from_millis(250),
            engine.run_session_end_hooks("cancelled")
        )
        .await
        .unwrap()
        .is_empty()
    );
    assert!(requests.lock().unwrap().is_empty());
    drop(lock);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if std::fs::read_to_string(&history)
                .is_ok_and(|body| body.contains("one original input"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(history)
            .unwrap()
            .matches("one original input")
            .count(),
        1
    );
    assert!(engine.run_session_end_hooks("cancelled").await.is_empty());
    assert!(requests.lock().unwrap().is_empty());
}

#[cfg(unix)]
async fn dropped_pending_input_never_reaches_session_end_provider_impl() {
    use std::os::fd::AsRawFd;
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .settings(settings_using_main_summary_runtime(Settings::default()))
        .build_with_profile_directory();
    let history = root.path().join("dropped-ticket.jsonl");
    engine.state.with_history_path(&history);
    engine.state.materialize_history().unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".kcoder-history.lock"))
        .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let mut stream = engine.submit_message_stream("not yet confirmed", &AlwaysDenyPrompt);
    let notice = tokio::time::timeout(Duration::from_secs(4), stream.next())
        .await
        .unwrap();
    assert!(matches!(notice, Some(EngineEvent::SystemNotice(text)) if text.contains("Saving")));
    drop(stream);
    assert!(engine.input_persistence_failed.load(Ordering::Acquire));
    assert!(
        tokio::time::timeout(
            Duration::from_millis(250),
            engine.run_session_end_hooks("closed")
        )
        .await
        .unwrap()
        .is_empty()
    );
    assert!(requests.lock().unwrap().is_empty());
    drop(lock);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if std::fs::read_to_string(&history)
                .is_ok_and(|body| body.contains("not yet confirmed"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(history)
            .unwrap()
            .matches("not yet confirmed")
            .count(),
        1
    );
    assert!(engine.run_session_end_hooks("closed").await.is_empty());
    assert!(requests.lock().unwrap().is_empty());
}

async fn confirmed_input_keeps_normal_session_end_summary_behavior_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .settings(settings_using_main_summary_runtime(Settings::default()))
        .build_with_profile_directory();
    let history = root.path().join("confirmed-input.jsonl");
    engine.state.with_history_path(&history);
    let events = engine
        .submit_message("confirmed input", &AlwaysDenyPrompt)
        .await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::UserMessageAdded))
    );
    assert!(!engine.input_persistence_failed.load(Ordering::Acquire));
    let before = requests.lock().unwrap().len();
    assert!(before > 0);
    let _ = engine.run_session_end_hooks("success").await;
    assert_eq!(requests.lock().unwrap().len(), before + 1);
}

async fn foreign_accepted_scope_never_falls_back_to_another_state_impl() {
    let first = crate::test_support::owned_case::owned_tempdir();
    let second = crate::test_support::owned_case::owned_tempdir();
    let original = AppState::new(first.path());
    let attempt = kcoder_types::TurnAttemptIdentity {
        thread_id: original.session_id(),
        turn_id: "original-turn".into(),
        attempt_id: "original-attempt".into(),
    };
    let scope = original.history_attempt_scope(attempt).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(second.path())
        .owned_test_fixture()
        .provider(Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }))
        .build_with_profile_directory();
    let history = second.path().join("foreign.jsonl");
    engine.state.with_history_path(&history);
    let events = scope
        .run(async {
            engine
                .submit_message("must stay with original", &AlwaysDenyPrompt)
                .await
        })
        .await;
    assert!(events.iter().any(|event| matches!(event, EngineEvent::Error(message) if message.contains("different session"))));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::UserMessageAdded))
    );
    assert!(engine.state.messages().is_empty());
    assert!(original.messages().is_empty());
    assert!(requests.lock().unwrap().is_empty());
    assert!(!history.exists());
}

macro_rules! owned_input_case {
    ($name:ident) => {
        #[test]
        fn $name() {
            crate::test_support::owned_case::run_owned_case(
                concat!(module_path!(), "::input_persistence_owned_dispatcher"),
                stringify!($name),
            );
        }
    };
}
owned_input_case!(first_input_write_failure_blocks_model_and_further_submissions_until_reload);
owned_input_case!(input_snapshot_replacement_before_commit_never_starts_the_model);
owned_input_case!(structured_input_is_in_history_before_acceptance_and_model_dispatch);
owned_input_case!(cancelled_before_input_does_not_append_or_poison_the_session);
owned_input_case!(original_input_rewrite_after_acknowledgement_never_starts_provider);
#[cfg(unix)]
owned_input_case!(scoped_input_cancelled_while_state_is_locked_never_appends);
#[cfg(unix)]
owned_input_case!(cancelled_original_ticket_settles_once_without_provider_or_replay);
#[cfg(unix)]
owned_input_case!(dropped_pending_input_never_reaches_session_end_provider);
owned_input_case!(confirmed_input_keeps_normal_session_end_summary_behavior);
owned_input_case!(foreign_accepted_scope_never_falls_back_to_another_state);

#[test]
#[ignore = "private dispatcher, launched and checked by each owned parent test"]
fn input_persistence_owned_dispatcher() {
    let case = crate::test_support::owned_case::owned_case();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    match case.as_str() {
        "first_input_write_failure_blocks_model_and_further_submissions_until_reload" => runtime
            .block_on(
                first_input_write_failure_blocks_model_and_further_submissions_until_reload_impl(),
            ),
        "input_snapshot_replacement_before_commit_never_starts_the_model" => {
            runtime.block_on(input_snapshot_replacement_before_commit_never_starts_the_model_impl())
        }
        "structured_input_is_in_history_before_acceptance_and_model_dispatch" => runtime
            .block_on(structured_input_is_in_history_before_acceptance_and_model_dispatch_impl()),
        "cancelled_before_input_does_not_append_or_poison_the_session" => {
            runtime.block_on(cancelled_before_input_does_not_append_or_poison_the_session_impl())
        }
        "original_input_rewrite_after_acknowledgement_never_starts_provider" => runtime
            .block_on(original_input_rewrite_after_acknowledgement_never_starts_provider_impl()),
        #[cfg(unix)]
        "scoped_input_cancelled_while_state_is_locked_never_appends" => {
            runtime.block_on(scoped_input_cancelled_while_state_is_locked_never_appends_impl())
        }
        #[cfg(unix)]
        "cancelled_original_ticket_settles_once_without_provider_or_replay" => runtime
            .block_on(cancelled_original_ticket_settles_once_without_provider_or_replay_impl()),
        #[cfg(unix)]
        "dropped_pending_input_never_reaches_session_end_provider" => {
            runtime.block_on(dropped_pending_input_never_reaches_session_end_provider_impl())
        }
        "confirmed_input_keeps_normal_session_end_summary_behavior" => {
            runtime.block_on(confirmed_input_keeps_normal_session_end_summary_behavior_impl())
        }
        "foreign_accepted_scope_never_falls_back_to_another_state" => {
            runtime.block_on(foreign_accepted_scope_never_falls_back_to_another_state_impl())
        }
        _ => panic!("unknown owned test case: {case}"),
    }
}
