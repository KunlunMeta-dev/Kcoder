#[test]
fn training_mode_does_not_disable_non_model_lifecycle_hooks() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        training_mode: true,
        ..Settings::default()
    };
    let engine = TestEngineBuilder::new(tmp.path())
        .settings(settings)
        .build();

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
        .build();

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
    let engine = TestEngineBuilder::new(tmp.path()).build();
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
