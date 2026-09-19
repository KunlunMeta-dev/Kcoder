#[tokio::test]
async fn unknown_tool_returns_tool_error_without_engine_error() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    let (output, decision, modified_input, events) = engine
        .execute_tool(
            "tool-1",
            "bash",
            serde_json::json!({"command":"pwd"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("unknown tools should be returned as model-visible tool errors");

    assert!(output.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    assert!(modified_input.is_none());
    assert!(events.is_empty());
    let text = output
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert!(text.contains("Unknown tool `bash`"));
    assert!(text.contains("Available tools: none"));
}

#[tokio::test]
async fn todo_write_string_items_are_normalized_before_validation() {
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

    let (output, decision, modified_input, events) = engine
        .execute_tool(
            "tool-1",
            "TodoWrite",
            serde_json::json!({"todos":["Inspect renderer", "Run tests"]}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("string todo items should be normalized");

    assert!(!output.is_error);
    assert_eq!(decision, PermissionDecision::Allow);
    assert!(modified_input.is_none());
    assert!(events.is_empty());
    let todos = engine.state.todos();
    assert_eq!(todos.len(), 2);
    assert_eq!(todos[0].content, "Inspect renderer");
    assert_eq!(todos[1].content, "Run tests");
    let text = output
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert!(text.contains("Current todo count: 2"));
    assert!(!text.contains("input validation failed"));
}

#[tokio::test]
async fn todo_write_blank_string_items_are_rejected_without_clearing_existing_todos() {
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
    engine.state.set_todos(vec![TodoItem {
        id: "todo-1".to_string(),
        content: "Keep existing todo".to_string(),
        active_form: None,
        status: TodoStatus::Pending,
    }]);

    let (output, decision, modified_input, events) = engine
        .execute_tool(
            "tool-1",
            "TodoWrite",
            serde_json::json!({"TodoList":[""]}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("blank TodoWrite string items should produce a model-visible tool error");

    let text = output
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or("");
    let remaining_todos = engine.state.todos();

    assert_eq!(
        (
            output.is_error,
            decision,
            modified_input.is_none(),
            events.is_empty(),
            remaining_todos.len(),
        ),
        (true, PermissionDecision::Deny, true, true, 1),
        "blank TodoWrite string items should be rejected instead of silently clearing existing todos; output text: {text}"
    );
    assert!(text.contains("TodoWrite-specific correction"));
    assert!(text.contains("{\"TodoList\":[\"\"]}"));
    assert!(text.contains("do not call TodoWrite again"));
    assert!(text.contains("The failed input contained a blank string item"));
    assert_eq!(remaining_todos[0].content, "Keep existing todo");
}

#[tokio::test]
async fn invalid_tool_input_returns_tool_error_without_engine_error() {
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

    let (output, decision, modified_input, events) = engine
        .execute_tool(
            "tool-1",
            "TodoWrite",
            serde_json::json!({"TodoList":"Inspect renderer"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("invalid tool input should be returned as a model-visible tool error");

    assert!(output.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    assert!(modified_input.is_none());
    assert!(events.is_empty());
    let text = output
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert!(text.contains("Tool `TodoWrite` input validation failed"));
    assert!(text.contains("$.TodoList"));
    assert!(text.contains("expected array `[...]`"));
    assert!(text.contains("got string"));
    assert!(text.contains("Use JSON arrays `[...]` for array fields"));
    assert!(text.contains("Expected JSON shape example:"));
    assert!(text.contains("\"TodoList\":[{"));
    assert!(text.contains("\"activeForm\""));
    assert!(text.contains("\"content\""));
    assert!(text.contains("\"status\""));
    assert!(!text.contains("Repeated tool failure detected"));
}

#[tokio::test]
async fn repeated_invalid_tool_input_gets_stronger_warning() {
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

    let mut last_text = String::new();
    for attempt in 1..=2 {
        let (output, _, _, _) = engine
            .execute_tool(
                "tool-1",
                "TodoWrite",
                serde_json::json!({"TodoList":"Inspect renderer"}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .expect("invalid tool input should be converted to model-visible output");
        last_text = output
            .content
            .iter()
            .find_map(|block| match block {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .unwrap();
        if attempt < 2 {
            assert!(!last_text.contains("Repeated tool failure detected"));
        }
    }

    assert!(last_text.contains("Repeated tool failure detected"));
    assert!(last_text.contains("failed attempt #2"));
    assert!(last_text.contains("Stop retrying the same arguments"));
    assert!(last_text.contains("Input preview:"));
}

#[tokio::test]
async fn yolo_repeated_tool_failure_does_not_recommend_user_elicitation() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Yolo,
        ..Settings::default()
    };
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

    let mut last_text = String::new();
    for _ in 0..2 {
        let (output, _, _, _) = engine
            .execute_tool(
                "tool-1",
                "TodoWrite",
                serde_json::json!({"TodoList":"Inspect renderer"}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .expect("invalid tool input should be model-visible");
        last_text = tool_output_text(&output);
    }

    assert!(last_text.contains("make a reasonable assumption"));
    assert!(last_text.contains("without asking the user"));
    assert!(!last_text.contains("ask the user a targeted question"));
}

#[tokio::test]
async fn third_consecutive_identical_tool_failure_gets_critical_loop_warning() {
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

    let mut texts = Vec::new();
    for _ in 1..=3 {
        let (output, _, _, _) = engine
            .execute_tool(
                "tool-1",
                "TodoWrite",
                serde_json::json!({"TodoList":"Inspect renderer"}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .expect("invalid tool input should be converted to model-visible output");
        texts.push(
            output
                .content
                .iter()
                .find_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .unwrap(),
        );
    }

    assert!(!texts[0].contains("Repeated tool failure detected"));
    assert!(texts[1].contains("Repeated tool failure detected"));
    assert!(!texts[1].contains("CRITICAL LOOP WARNING"));
    assert!(texts[2].contains("Repeated tool failure detected"));
    assert!(texts[2].contains("CRITICAL LOOP WARNING"));
    assert!(texts[2].contains("failed 3 consecutive times"));
    assert!(texts[2].contains("current strategy is wrong"));
    assert!(texts[2].contains("Try a different tool"));
}

#[tokio::test]
async fn invalid_tool_input_includes_past_failed_to_successful_repair_example() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let first_engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings.clone(),
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    let (first_failure, _, _, _) = first_engine
        .execute_tool(
            "tool-1",
            "TodoWrite",
            serde_json::json!({"TodoList":"Inspect renderer"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("invalid tool input should be model-visible");
    let first_failure_text = tool_output_text(&first_failure);
    assert!(!first_failure_text.contains("failed-to-successful repair example"));

    let (success, _, _, _) = first_engine
        .execute_tool(
            "tool-2",
            "TodoWrite",
            serde_json::json!({
                "TodoList": [{
                    "content": "Inspect renderer",
                    "activeForm": "Inspecting renderer",
                    "status": "in_progress"
                }]
            }),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("corrected tool input should succeed");
    assert!(!success.is_error);

    first_engine.run_session_end_hooks("success").await;

    let example_files = std::fs::read_dir(tool_repair::examples_dir(tmp.path()))
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .collect::<Vec<_>>();
    assert_eq!(example_files.len(), 1);

    let second_engine = QueryEngine::new(
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

    let (second_failure, _, _, _) = second_engine
        .execute_tool(
            "tool-3",
            "TodoWrite",
            serde_json::json!({"TodoList":"Run tests"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("invalid tool input should include repair hint");
    let text = tool_output_text(&second_failure);

    assert!(text.contains("A previous failed-to-successful repair example"));
    assert!(text.contains("Failed call:"));
    assert!(text.contains("\"TodoList\": \"Inspect renderer\""));
    assert!(text.contains("Successful corrected call:"));
    assert!(text.contains("\"TodoList\": ["));
    assert!(text.contains("Use the corrected JSON shape"));
}

#[tokio::test]
async fn invalid_tool_input_includes_top_three_past_repair_examples() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let seed_engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings.clone(),
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    let schema_fingerprint = seed_engine.schema_fingerprint_for_tool("TodoWrite");
    let examples = [
        tool_repair::ToolRepairExample {
            version: 1,
            session_id: "seed-a".to_string(),
            tool_name: "TodoWrite".to_string(),
            schema_fingerprint: schema_fingerprint.clone(),
            failure_signature: "todo-array-string".to_string(),
            error_summary: "$.TodoList expected array got string".to_string(),
            failed_input: serde_json::json!({"TodoList":"Inspect renderer"}),
            successful_input: serde_json::json!({
                "TodoList": [{
                    "content": "Inspect renderer",
                    "activeForm": "Inspecting renderer",
                    "status": "in_progress"
                }]
            }),
            created_at_ms: 1,
        },
        tool_repair::ToolRepairExample {
            version: 1,
            session_id: "seed-b".to_string(),
            tool_name: "TodoWrite".to_string(),
            schema_fingerprint: schema_fingerprint.clone(),
            failure_signature: "todo-array-object".to_string(),
            error_summary: "$.TodoList expected array got object".to_string(),
            failed_input: serde_json::json!({"TodoList":{"content":"Run tests"}}),
            successful_input: serde_json::json!({
                "TodoList": [{
                    "content": "Run tests",
                    "activeForm": "Running tests",
                    "status": "pending"
                }]
            }),
            created_at_ms: 2,
        },
        tool_repair::ToolRepairExample {
            version: 1,
            session_id: "seed-c".to_string(),
            tool_name: "TodoWrite".to_string(),
            schema_fingerprint,
            failure_signature: "todo-active-form".to_string(),
            error_summary: "$.TodoList[0].activeForm required string field is missing".to_string(),
            failed_input: serde_json::json!({
                "TodoList": [{"content":"Review logs","status":"pending"}]
            }),
            successful_input: serde_json::json!({
                "TodoList": [{
                    "content": "Review logs",
                    "activeForm": "Reviewing logs",
                    "status": "pending"
                }]
            }),
            created_at_ms: 3,
        },
    ];
    let dir = tool_repair::examples_dir(tmp.path());
    std::fs::create_dir_all(&dir).unwrap();
    let jsonl = examples
        .iter()
        .map(|example| serde_json::to_string(example).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(dir.join("seed.jsonl"), format!("{jsonl}\n")).unwrap();

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

    let (output, _, _, _) = engine
        .execute_tool(
            "tool-top3",
            "TodoWrite",
            serde_json::json!({"TodoList":"Run tests"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("invalid tool input should include top-3 repair hints");
    let text = tool_output_text(&output);

    assert!(text.contains("Top 3 previous failed-to-successful repair examples"));
    assert!(text.contains("Repair example 1"));
    assert!(text.contains("Repair example 2"));
    assert!(text.contains("Repair example 3"));
    assert_eq!(text.matches("Successful corrected call:").count(), 3);
    assert!(text.contains("Use the corrected JSON shapes"));
}
