#[test]
fn file_change_observation_records_tool_event_metadata() {
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
    let prompt_number = engine.next_memory_prompt_number();
    engine.record_user_prompt(prompt_number, "update src/lib.rs");

    engine.record_file_change_observation("tool-1", "write", &["src/lib.rs".to_string()], false);

    let observations = engine
        .memory_manager
        .search_structured_observations(Some("src/lib.rs"), 10)
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].observation_type, "file_change");
    assert_eq!(observations[0].tool_name.as_deref(), Some("write"));
    assert_eq!(observations[0].tool_call_id.as_deref(), Some("tool-1"));
    assert_eq!(observations[0].files_modified, vec!["src/lib.rs"]);
    assert_eq!(observations[0].source, "tool_event");
    assert_eq!(observations[0].prompt_number, Some(1));
    let sources = engine
        .memory_manager
        .structured_sources_for_memory("observation", observations[0].id)
        .unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source_type, "tool_call");
    assert_eq!(sources[0].source_ref.as_deref(), Some("tool-1"));
    assert!(sources[0].metadata_json.contains("file_change"));
}

#[tokio::test]
async fn successful_write_tool_records_file_change_observation() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        memory_manager,
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    let (output, decision, _, _) = engine
        .execute_tool(
            "tool-write",
            "write",
            serde_json::json!({
                "file_path": "notes.txt",
                "content": "remember structured file changes"
            }),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();

    assert!(!output.is_error, "unexpected output: {:?}", output);
    assert_eq!(decision, PermissionDecision::Allow);
    let observations = engine
        .memory_manager
        .search_structured_observations(Some("notes.txt"), 10)
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].observation_type, "file_change");
    assert_eq!(observations[0].tool_name.as_deref(), Some("write"));
    assert_eq!(observations[0].tool_call_id.as_deref(), Some("tool-write"));
    assert_eq!(observations[0].files_modified, vec!["notes.txt"]);
}

#[tokio::test]
async fn successful_tool_after_same_input_failure_records_recovery_observation() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        memory_manager,
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    let input = serde_json::json!({"command": "test -f marker.txt"});

    let (failed, _, _, _) = engine
        .execute_tool(
            "tool-fail",
            "bash",
            input.clone(),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(failed.is_error);

    std::fs::write(tmp.path().join("marker.txt"), "ok").unwrap();
    let (succeeded, _, _, _) = engine
        .execute_tool(
            "tool-success",
            "bash",
            input,
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(!succeeded.is_error, "unexpected output: {:?}", succeeded);

    let observations = engine
        .memory_manager
        .search_structured_observations(Some("recovered"), 10)
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].observation_type, "failure_recovered");
    assert_eq!(observations[0].tool_name.as_deref(), Some("bash"));
    assert_eq!(
        observations[0].tool_call_id.as_deref(),
        Some("tool-success")
    );
    assert!(observations[0].concepts.contains(&"gotcha".to_string()));
}

#[tokio::test]
async fn successful_verification_target_after_different_input_failure_records_recovery_observation()
{
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        memory_manager,
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    let (failed, _, _, _) = engine
        .execute_tool(
            "tool-fail",
            "bash",
            serde_json::json!({
                "command": "false # cargo test -p kcoder_engine memory_target"
            }),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(failed.is_error);

    let (succeeded, _, _, _) = engine
        .execute_tool(
            "tool-success",
            "bash",
            serde_json::json!({
                "command": "true # cargo test memory_target --package kcoder_engine -- --nocapture"
            }),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(!succeeded.is_error, "unexpected output: {:?}", succeeded);

    let observations = engine
        .memory_manager
        .search_structured_observations_with_options(
            Some("verification target"),
            kcoder_memory::MemorySearchOptions {
                observation_type: Some("failure_recovered".to_string()),
                ..kcoder_memory::MemorySearchOptions::default()
            },
        )
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].observation_type, "failure_recovered");
    assert_eq!(observations[0].tool_name.as_deref(), Some("bash"));
    assert_eq!(
        observations[0].tool_call_id.as_deref(),
        Some("tool-success")
    );
    assert!(
        observations[0]
            .concepts
            .contains(&"verification-target".to_string())
    );
    let sources = engine
        .memory_manager
        .structured_sources_for_memory("observation", observations[0].id)
        .unwrap();
    assert_eq!(sources.len(), 1);
    assert!(sources[0].metadata_json.contains("verification_target"));
    assert!(sources[0].metadata_json.contains("memory_target"));
}

#[test]
fn verification_command_label_recognizes_common_test_commands() {
    assert_eq!(
        verification_command_label("cargo test -p kcoder_memory"),
        Some("cargo test")
    );
    assert_eq!(
        verification_command_label("cargo check"),
        Some("cargo check")
    );
    assert_eq!(verification_command_label("pytest tests"), Some("pytest"));
    assert_eq!(verification_command_label("npm test"), Some("npm test"));
    assert_eq!(verification_command_label("echo not a test"), None);
}

#[test]
fn verification_command_target_normalizes_common_test_targets() {
    let first =
        verification_command_target("cargo test -p kcoder_engine memory -- --nocapture").unwrap();
    let second = verification_command_target("cargo test memory --package kcoder_engine").unwrap();
    assert_eq!(first.key, second.key);
    assert_eq!(first.display, "cargo test -p kcoder_engine memory");

    let pytest =
        verification_command_target("python -m pytest tests/test_api.py::test_smoke -q").unwrap();
    assert_eq!(pytest.display, "pytest tests/test_api.py::test_smoke");
    assert_eq!(
        verification_command_target("npm test -- --watch")
            .unwrap()
            .display,
        "npm test"
    );
}

#[test]
fn verification_observation_records_successful_shell_validation() {
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

    engine.record_verification_observation(
        "tool-test",
        "bash",
        &serde_json::json!({"command": "cargo test -p kcoder_memory"}),
        false,
    );
    engine.record_verification_observation(
        "tool-bg",
        "bash",
        &serde_json::json!({"command": "cargo test", "run_in_background": true}),
        false,
    );
    engine.record_verification_observation(
        "tool-failed",
        "bash",
        &serde_json::json!({"command": "cargo test"}),
        true,
    );

    let observations = engine
        .memory_manager
        .search_structured_observations(Some("cargo test"), 10)
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].observation_type, "verification_passed");
    assert_eq!(observations[0].tool_name.as_deref(), Some("bash"));
    assert_eq!(observations[0].tool_call_id.as_deref(), Some("tool-test"));
    assert!(
        observations[0]
            .concepts
            .contains(&"verification".to_string())
    );
}

#[test]
fn auto_tool_memory_setting_disables_tool_event_observations() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        auto_tool_memory_enabled: false,
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings,
        memory_manager,
    );

    engine.record_file_change_observation("tool-write", "write", &["notes.txt".to_string()], false);
    engine.record_verification_observation(
        "tool-test",
        "bash",
        &serde_json::json!({"command": "cargo test"}),
        false,
    );
    engine.record_failure_recovery_observation(
        "tool-recovered",
        "bash",
        &serde_json::json!({"command": "test -f marker.txt"}),
        Some(&ToolFailureRecord {
            count: 1,
            input_preview: "{}".to_string(),
        }),
    );

    let observations = engine
        .memory_manager
        .search_structured_observations(None, 10)
        .unwrap();
    assert!(observations.is_empty());
}

#[test]
fn structured_memory_setting_disables_structured_store() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            structured_enabled: false,
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings,
        memory_manager,
    );

    engine.record_file_change_observation("tool-write", "write", &["notes.txt".to_string()], false);
    engine.record_user_prompt(1, "remember this prompt");
    let observations = engine
        .memory_manager
        .search_structured_observations(None, 10)
        .unwrap();
    assert!(observations.is_empty());
    assert!(
        engine
            .memory_manager
            .get_structured_prompt(&engine.session_id(), 1)
            .unwrap()
            .is_none()
    );
}

#[test]
fn private_by_default_minimizes_prompt_and_source_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            private_by_default: true,
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings,
        memory_manager,
    );

    engine.record_user_prompt(1, "deploy with token secret-token");
    engine.record_verification_observation(
        "tool-test",
        "bash",
        &serde_json::json!({"command": "cargo test -- --token secret-token"}),
        false,
    );
    engine.record_failure_recovery_observation(
        "tool-recovered",
        "bash",
        &serde_json::json!({}),
        Some(&ToolFailureRecord {
            count: 1,
            input_preview: "password=secret-token".to_string(),
        }),
    );

    let prompt = engine
        .memory_manager
        .get_structured_prompt(&engine.session_id(), 1)
        .unwrap()
        .unwrap();
    assert!(
        prompt
            .prompt_text
            .contains("memory.private_by_default=true")
    );
    assert!(!prompt.prompt_text.contains("secret-token"));

    let observations = engine
        .memory_manager
        .search_structured_observations(None, 10)
        .unwrap();
    assert_eq!(observations.len(), 2);
    let observation_json = serde_json::to_string(&observations).unwrap();
    assert!(!observation_json.contains("secret-token"));
    assert!(!observation_json.contains("password="));

    for observation in observations {
        let sources = engine
            .memory_manager
            .structured_sources_for_memory("observation", observation.id)
            .unwrap();
        assert_eq!(sources.len(), 1);
        let metadata = &sources[0].metadata_json;
        assert!(metadata.contains("private_by_default"));
        assert!(!metadata.contains("secret-token"));
        assert!(!metadata.contains("input_preview"));
        assert!(!metadata.contains("--token"));
    }
}

#[test]
fn record_prompt_placeholders_false_skips_private_prompt_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            private_by_default: true,
            record_prompt_placeholders: false,
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings,
        memory_manager,
    );

    engine.record_user_prompt(1, "deploy with token secret-token");

    assert!(
        engine
            .memory_manager
            .get_structured_prompt(&engine.session_id(), 1)
            .unwrap()
            .is_none()
    );
}

#[test]
fn fine_grained_memory_privacy_minimizes_paths_and_verification_targets() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            private_file_paths: true,
            private_verification_targets: true,
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings,
        memory_manager,
    );

    engine.record_file_change_observation(
        "tool-write",
        "write",
        &["secret/path.txt".to_string()],
        false,
    );
    engine.record_verification_target_recovery_observation(
        "tool-success",
        "bash",
        &serde_json::json!({"command": "cargo test secret_target"}),
        Some(&VerificationFailureRecord {
            count: 2,
            target: "cargo test secret_target".to_string(),
            command_preview: "cargo test secret_target -- --exact".to_string(),
        }),
    );

    let observations = engine
        .memory_manager
        .search_structured_observations(None, 10)
        .unwrap();
    assert_eq!(observations.len(), 2);
    let observation_json = serde_json::to_string(&observations).unwrap();
    assert!(!observation_json.contains("secret/path.txt"));
    assert!(!observation_json.contains("secret_target"));

    let file_change = observations
        .iter()
        .find(|observation| observation.observation_type == "file_change")
        .unwrap();
    assert_eq!(file_change.files_modified, Vec::<String>::new());
    assert!(
        file_change
            .narrative
            .as_deref()
            .unwrap_or_default()
            .contains("modified 1 file(s).")
    );
    let file_sources = engine
        .memory_manager
        .structured_sources_for_memory("observation", file_change.id)
        .unwrap();
    assert_eq!(file_sources.len(), 1);
    assert!(
        file_sources[0]
            .metadata_json
            .contains("files_modified_count")
    );
    assert!(!file_sources[0].metadata_json.contains("secret/path.txt"));

    let recovery = observations
        .iter()
        .find(|observation| {
            observation.observation_type == "failure_recovered"
                && observation
                    .concepts
                    .contains(&"verification-target".to_string())
        })
        .unwrap();
    assert_eq!(
        recovery.title.as_deref(),
        Some("Verification target recovered")
    );
    let recovery_sources = engine
        .memory_manager
        .structured_sources_for_memory("observation", recovery.id)
        .unwrap();
    assert_eq!(recovery_sources.len(), 1);
    let recovery_metadata: Value =
        serde_json::from_str(&recovery_sources[0].metadata_json).unwrap();
    assert!(recovery_metadata.get("verification_target").is_none());
    assert!(!recovery_sources[0].metadata_json.contains("secret_target"));
}

#[test]
fn memory_skip_tools_disables_selected_tool_event_observations() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            skip_tools: vec!["write".to_string()],
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings,
        memory_manager,
    );

    engine.record_file_change_observation("tool-write", "write", &["notes.txt".to_string()], false);
    engine.record_verification_observation(
        "tool-test",
        "bash",
        &serde_json::json!({"command": "cargo test"}),
        false,
    );

    let observations = engine
        .memory_manager
        .search_structured_observations(None, 10)
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].tool_name.as_deref(), Some("bash"));
    assert_eq!(observations[0].observation_type, "verification_passed");
}

#[test]
fn memory_query_projection_preserves_latest_real_user_text_selection() {
    let state = AppState::new("/");
    assert_eq!(latest_real_user_text(&state), None);
    state.add_message(Message::user_text("  retain original whitespace"));
    for message in [
        Message::assistant_text("assistant"),
        Message::user_text("  <project-instructions>injected"),
        Message::user_text("<relevant-memories>injected"),
        Message::user_text("<skill_content name=\"test\">injected"),
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown, content: vec![
                ContentBlock::Text {
                    text: "tool wrapper text".into(),
                },
                ContentBlock::ToolResult {
                    tool_use_id: "call".into(),
                    content: vec![],
                    is_error: None,
                },
            ],
        },
    ] {
        state.add_message(message);
        assert_eq!(
            latest_real_user_text(&state).as_deref(),
            Some("  retain original whitespace")
        );
    }
    state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown, content: vec![
            ContentBlock::Text {
                text: "<relevant-memories>skip block".into(),
            },
            ContentBlock::Text {
                text: "new user text".into(),
            },
            ContentBlock::Text {
                text: "not selected".into(),
            },
        ],
    });
    assert_eq!(
        latest_real_user_text(&state).as_deref(),
        Some("new user text")
    );
}
