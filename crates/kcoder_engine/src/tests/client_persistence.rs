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
