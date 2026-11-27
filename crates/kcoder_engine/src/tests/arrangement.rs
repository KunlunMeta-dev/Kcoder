#[test]
fn ultgoal_uses_arrangement_subagent_registry_without_arrangement_tool_profile() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    assert!(engine.subagent_tools().get("WritePlan").is_none());
    engine.state.set_goal_prepared_with_mode(
        "orchestrate the implementation",
        None,
        None,
        kcoder_state::GoalMode::Arrangement,
    );

    let active = engine.active_subagent_tools();
    assert!(active.get("WritePlan").is_some());
    assert!(active.get("edit").is_some());
    assert!(active.get("write").is_some());
}

#[test]
fn orchestrate_session_mode_activates_read_only_registry_without_a_goal() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let state = AppState::new(tmp.path());
    state.enter_orchestrate_before_first_message().unwrap();
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        state,
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    assert!(engine.is_arrangement_mode_active());
    assert!(engine.active_tool_registry().get("bash").is_none());
    assert!(engine.active_tool_registry().get("spawn_agent").is_some());
    assert!(
        engine
            .active_tool_registry()
            .get("memory_search")
            .is_some()
    );
}

#[test]
fn orchestrate_main_optional_tool_allowlist_preserves_core_and_shrinks_extras() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.orchestrate.main.optional_tool_allowlist =
        Some(vec!["WebSearch".to_string(), "skill".to_string()]);
    let state = AppState::new(tmp.path());
    state.enter_orchestrate_before_first_message().unwrap();
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        state,
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    let active = engine.active_tool_registry();
    for required in [
        "read",
        "spawn_agent",
        "SendMessage",
        "AgentFleet",
        "CreateWorkPlan",
        "RecordTaskAcceptance",
        "update_goal",
    ] {
        assert!(active.get(required).is_some(), "missing core tool {required}");
    }
    for selected in ["WebSearch", "skill"] {
        assert!(
            active.get(selected).is_some(),
            "missing selected optional tool {selected}"
        );
    }
    for removed in ["memory_search", "PlanAgent", "Workflow", "cron_create"] {
        assert!(
            active.get(removed).is_none(),
            "optional tool {removed} should be filtered out"
        );
    }

    engine
        .settings
        .write()
        .unwrap()
        .orchestrate
        .main
        .optional_tool_allowlist = Some(Vec::new());
    let core_only = engine.active_tool_registry();
    assert!(core_only.get("spawn_agent").is_some());
    assert!(core_only.get("CreateWorkPlan").is_some());
    assert!(core_only.get("WebSearch").is_none());
    assert!(core_only.get("skill").is_none());
}

#[tokio::test]
async fn orchestrate_entry_after_engine_construction_updates_schema_without_changing_default() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    let default = engine.tool_definitions_for_model().await;
    let default_spawn = default
        .iter()
        .find(|definition| definition.name == "spawn_agent")
        .unwrap();
    let default_schema = default_spawn.input_schema.clone();
    assert!(!default_schema.to_string().contains("junior"));

    engine.state.enter_orchestrate_before_first_message().unwrap();
    let orchestrated = engine.tool_definitions_for_model().await;
    let orchestrated_spawn = orchestrated
        .iter()
        .find(|definition| definition.name == "spawn_agent")
        .unwrap();
    for persona in ["junior", "oracle", "librarian", "critic"] {
        assert!(orchestrated_spawn.input_schema.to_string().contains(persona));
    }
    assert_ne!(orchestrated_spawn.input_schema, default_schema);
}

#[test]
fn completed_goal_does_not_exit_orchestrate_session_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    state.enter_orchestrate_before_first_message().unwrap();
    state.set_goal("deliver", None);
    let goal = state.goal().unwrap();

    state
        .update_goal_status(kcoder_state::GoalStatus::Complete)
        .unwrap();

    assert!(state.session_mode().is_orchestrate());
    assert_eq!(state.goal().unwrap().goal_id, goal.goal_id);
}

#[test]
fn arrangement_system_prompt_documents_core_delegation_contracts() {
    let available = tool_names(&[
        "PlanAgent",
        "EditPlan",
        "explore_agent",
        "spawn_agent",
        "SendMessage",
        "close_agent",
        "Workflow",
        "update_goal",
    ]);
    let prompt = arrangement_system_prompt(&available, false, OrchestrateProvenance::Goal);

    assert!(prompt.contains("KCoder-Arrangement"));
    assert!(prompt.contains("main agent is an orchestrator, not an implementer"));
    assert!(prompt.contains("complete and authoritative Arrangement capability set"));
    assert!(prompt.contains("Use PlanAgent"));
    assert!(prompt.contains("Use EditPlan only to revise"));
    assert!(prompt.contains("agent_type=\"implementer\""));
    assert!(prompt.contains("Use explore_agent"));
    assert!(prompt.contains("At most 4 sub-agents"));
    assert!(prompt.contains("Use SendMessage"));
    assert!(prompt.contains("Use close_agent only for terminal"));
    assert!(prompt.contains("Workflow runs deterministic orchestration"));
    assert!(prompt.contains("Call update_goal with complete status"));
}

#[test]
fn yolo_arrangement_system_prompt_omits_user_elicitation_contracts() {
    let available = tool_names(&["explore_agent", "spawn_agent"]);
    let prompt = arrangement_system_prompt(&available, true, OrchestrateProvenance::Goal);

    assert!(prompt.contains("User elicitation is disabled in yolo mode"));
    assert!(!prompt.contains("AskUserQuestion"));
    assert!(prompt.contains("state reasonable assumptions"));
}

#[test]
fn arrangement_system_prompt_omits_filtered_tool_contracts() {
    let prompt = arrangement_system_prompt(
        &tool_names(&["explore_agent"]),
        false,
        OrchestrateProvenance::Goal,
    );

    assert!(prompt.contains("explore_agent"));
    for unavailable in [
        "PlanAgent",
        "EditPlan",
        "spawn_agent",
        "SendMessage",
        "close_agent",
        "Workflow",
        "update_goal",
    ] {
        assert!(
            !prompt.contains(unavailable),
            "prompt unexpectedly names filtered tool {unavailable}"
        );
    }
}

#[test]
fn session_orchestrate_prompt_records_session_provenance_and_lifetime() {
    let prompt = arrangement_system_prompt(
        &HashSet::new(),
        false,
        OrchestrateProvenance::Session,
    );

    assert!(prompt.contains("entered with `/orchestrate` before the conversation began"));
    assert!(prompt.contains("lasts the entire session"));
    assert!(prompt.contains("`/goal` or `/goal-pro`"));
}

#[test]
fn session_orchestrate_prompt_documents_create_work_plan_grammar() {
    let prompt = arrangement_system_prompt(
        &tool_names(&["CreateWorkPlan"]),
        false,
        OrchestrateProvenance::Session,
    );

    assert!(prompt.contains("The plan is machine-parsed"));
    assert!(prompt.contains("`## Context`, `## TODOs`, and `## Final Verification Wave`"));
    assert!(prompt.contains("`  - artifacts:`"));
    assert!(prompt.contains("`  - write_scope:`"));
    assert!(prompt.contains("`  - acceptance:`"));
    assert!(prompt.contains("`  - verify:`"));
    assert!(prompt.contains("process_exit, artifact, citation, manual, schema, visual, not_applicable"));
    assert!(prompt.contains("exactly one indented `  - evidence:` line"));
}

#[tokio::test]
async fn arrangement_tool_batch_registry_snapshot_survives_goal_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    engine.state.set_goal_prepared_with_mode(
        "orchestrate the implementation",
        None,
        None,
        kcoder_state::GoalMode::Arrangement,
    );
    let arrangement_mode_snapshot = engine.is_arrangement_mode_active();
    let arrangement_snapshot = engine.active_tool_registry_for_mode(arrangement_mode_snapshot);

    let (complete, _, _, _) = engine
        .execute_tool_with_registry(
            "tool-1",
            "update_goal",
            serde_json::json!({"status": "complete"}),
            &kcoder_permissions::AutoAllowPrompt,
            &arrangement_snapshot,
            arrangement_mode_snapshot,
        )
        .await
        .unwrap();
    assert!(!complete.is_error);
    assert!(!engine.is_arrangement_mode_active());

    let (bash, decision, _, _) = engine
        .execute_tool_with_registry(
            "tool-2",
            "bash",
            serde_json::json!({"command": "echo should-not-run"}),
            &kcoder_permissions::AutoAllowPrompt,
            &arrangement_snapshot,
            arrangement_mode_snapshot,
        )
        .await
        .unwrap();
    assert!(bash.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    assert!(tool_output_text(&bash).contains("Unknown tool `bash`"));

    let (spawn, decision, _, _) = engine
        .execute_tool_with_registry(
            "tool-3",
            "spawn_agent",
            serde_json::json!({
                "agent_type": "implementer",
                "message": "edit the file without a scope"
            }),
            &kcoder_permissions::AutoAllowPrompt,
            &arrangement_snapshot,
            arrangement_mode_snapshot,
        )
        .await
        .unwrap();
    assert!(spawn.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    assert!(
        tool_output_text(&spawn)
            .contains("Arrangement implementer agents require allowed_write_paths")
    );
}
