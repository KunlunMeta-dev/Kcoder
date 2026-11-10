#[test]
fn training_mode_does_not_disable_non_model_lifecycle_hooks() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        training_mode: true,
        ..Settings::default()
    };
    let engine = TestEngineBuilder::new(tmp.path())
        .settings(settings)
        .build_with_profile_directory();

    assert!(!engine.hook_registry().disabled);
}

#[test]
fn training_mode_discards_plugin_snapshot_and_kcoder_settings_skill() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp
        .path()
        .join(".kcoder/plugins/training-probe/.codex-plugin");
    let skill_dir = tmp.path().join(".kcoder/skills/kcoder-settings");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        plugin_dir.join("plugin.json"),
        r#"{"name":"training-probe","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: kcoder-settings\ndescription: Test settings skill\n---\n\n# Test\n",
    )
    .unwrap();
    let settings = Settings {
        training_mode: true,
        ..Settings::default()
    };

    let engine = TestEngineBuilder::new(tmp.path())
        .settings(settings)
        .folder_trusted(Some(true))
        .build_with_profile_directory();

    assert!(engine.plugin_snapshot().plugin_ids.is_empty());
    assert!(engine.plugin_snapshot().skill_roots.is_empty());
    assert!(engine.plugin_snapshot().hook_matchers.is_empty());
    assert!(engine.plugin_snapshot().mcp_configs.is_empty());
    assert!(
        engine
            .skill_registry
            .read()
            .unwrap()
            .get("kcoder-settings")
            .is_none()
    );
}

#[tokio::test]
async fn side_question_is_toolless_and_does_not_mutate_main_history() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(StaticTextProvider {
        requests: Arc::clone(&requests),
        text: "The answer is 42.".to_string(),
    });
    let engine = test_engine_with_settings(provider, tmp.path(), Settings::default());
    let original = vec![
        Message::user_text("What is the project doing?"),
        Message::assistant_text("It is compiling."),
    ];
    engine.state.set_messages(original.clone());

    let answer = engine
        .run_side_question("What was the answer?", CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(answer, "The answer is 42.");
    assert_eq!(engine.state.messages(), original);
    let request = requests.lock().unwrap().last().cloned().unwrap();
    assert!(request.tools.is_empty());
    let system = request.system.as_deref().unwrap_or_default();
    assert!(system.contains("You have no tools"));
    assert!(!system.contains("invoke the appropriate tool"));
    let prompt = request
        .messages
        .last()
        .map(|message| match message {
            Message::User { content, .. } | Message::Assistant { content, .. } => {
                content_blocks_plain_text(content)
            }
        })
        .unwrap_or_default();
    assert!(prompt.contains("What was the answer?"));
    assert!(prompt.contains("no tools"));
}

#[test]
fn query_engine_applies_configured_history_limit_to_state() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        history_max_messages: 2,
        ..Settings::default()
    };
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);

    engine.state.add_message(Message::user_text("one"));
    engine.state.add_message(Message::assistant_text("two"));
    engine.state.add_message(Message::user_text("three"));

    assert_eq!(engine.state.messages().len(), 1);
    assert_eq!(engine.state.messages()[0].preview(20), "three");
}

#[test]
fn estimated_token_count_uses_legitimate_compacted_model_state() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(tmp.path()).build_with_profile_directory();
    engine.state.set_messages(vec![
        Message::user_text("Earlier conversation summary: compacted"),
        Message::user_text("recent visible"),
    ]);

    let visible = messages_after_latest_compact_boundary(&engine.state.messages());

    assert_eq!(
        engine.estimated_token_count(),
        TokenCounter::count(&visible)
    );
    assert_eq!(
        engine.estimated_token_count(),
        TokenCounter::count(&engine.state.messages())
    );
}

#[tokio::test]
async fn stop_hook_failure_waits_for_pending_tool_results() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_config::FolderTrustStore::load(tmp.path())
        .trust(tmp.path())
        .unwrap();
    let config_dir = tmp.path().join(".kcoder");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(
        config_dir.join("settings.json"),
        serde_json::json!({"hooks": {"Stop": [{"hooks": [{
            "type": "command", "command": "kcoder_missing_stop_hook_runtime_73491"
        }]}]}})
        .to_string(),
    )
    .unwrap();
    let (provider, calls) = SequentialEventsProvider::new(vec![
        named_tool_call_events(
            "stop-hook-read",
            "read",
            serde_json::json!({
                "file_path": tmp.path().join("missing.txt").to_string_lossy()
            }),
        ),
        simple_text_events("The read finished with an error."),
    ]);
    let mut engine = TestEngineBuilder::new(tmp.path())
        .provider(Arc::new(provider))
        .folder_trusted(Some(true))
        .tool_registry(kcoder_tools::default_registry())
        .build_with_profile_directory()
        .with_settings_persistence_path(tmp.path().join("settings.json"));
    // Keep command-hook trust checks in this fixture's private profile.
    for (_, matcher) in &mut engine.hook_registry.settings_hooks {
        if let Some(trust) = matcher
            .source
            .as_mut()
            .and_then(|source| source.required_trust.as_mut())
        {
            trust.config_dir = Some(tmp.path().to_path_buf());
        }
    }
    engine
        .state
        .add_message(Message::user_text("Read missing.txt"));
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert_eq!(*calls.lock().unwrap(), 2, "{events:?}");
    let result_index = events
        .iter()
        .position(|event| {
            matches!(event,
                EngineEvent::ToolResult { id, .. } if id == "stop-hook-read"
            )
        })
        .expect("requested tool must settle before a failing Stop hook");
    let hook_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::HookMessage { is_error: true, text }
                if text.contains("kcoder_missing_stop_hook_runtime_73491")
            )
        })
        .expect("Stop hook failure must remain visible");
    assert!(result_index < hook_index);
    assert!(
        engine
            .state
            .messages()
            .iter()
            .any(|message| matches!(message,
                Message::User { content, .. } if content.iter().any(|block| matches!(block,
                    ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "stop-hook-read"
                ))
            ))
    );
}

#[tokio::test]
async fn stop_hook_runs_once_after_tool_loop_finishes() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_config::FolderTrustStore::load(tmp.path())
        .trust(tmp.path())
        .unwrap();
    let config_dir = tmp.path().join(".kcoder");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(
        config_dir.join("settings.json"),
        serde_json::json!({"hooks": {"Stop": [{"hooks": [{
            "type": "command", "command": "echo stop>>stop-hook-count.txt"
        }]}]}})
        .to_string(),
    )
    .unwrap();
    let (provider, calls) = SequentialEventsProvider::new(vec![
        named_tool_call_events(
            "stop-hook-first",
            "read",
            serde_json::json!({
                "file_path": tmp.path().join("missing.txt").to_string_lossy()
            }),
        ),
        named_tool_call_events(
            "stop-hook-second",
            "read",
            serde_json::json!({
                "file_path": tmp.path().join("missing.txt").to_string_lossy()
            }),
        ),
        simple_text_events("Both reads finished."),
    ]);
    let mut engine = TestEngineBuilder::new(tmp.path())
        .provider(Arc::new(provider))
        .folder_trusted(Some(true))
        .tool_registry(kcoder_tools::default_registry())
        .build_with_profile_directory()
        .with_settings_persistence_path(tmp.path().join("settings.json"));
    // Keep command-hook trust checks in this fixture's private profile.
    for (_, matcher) in &mut engine.hook_registry.settings_hooks {
        if let Some(trust) = matcher
            .source
            .as_mut()
            .and_then(|source| source.required_trust.as_mut())
        {
            trust.config_dir = Some(tmp.path().to_path_buf());
        }
    }
    engine
        .state
        .add_message(Message::user_text("Read both files"));
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert_eq!(*calls.lock().unwrap(), 3, "{events:?}");
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, EngineEvent::ToolResult { .. }))
            .count(),
        2
    );
    let log = std::fs::read_to_string(tmp.path().join("stop-hook-count.txt"))
        .unwrap_or_else(|error| panic!("{error}: {events:?}"));
    assert_eq!(log.lines().count(), 1);
}
