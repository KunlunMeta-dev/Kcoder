#[derive(Debug)]
struct DoomLoopProvider;

impl Provider for DoomLoopProvider {
    fn name(&self) -> &'static str {
        "doom-loop"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            for index in 0..6usize {
                yield Ok(StreamEvent::ContentBlockStart {
                    index,
                    content_block: ContentBlock::ToolUse {
                        id: format!("tool-{index}"),
                        name: "bash".to_string(),
                        input: serde_json::json!({"command": "ls"}),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index });
            }
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn write_tool_checkpoint_enables_rewind() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("a.txt");
    std::fs::write(&file, b"original").unwrap();
    let settings = Settings::default();
    let engine = QueryEngine::new_with_folder_trust(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
        Some(true),
    );
    engine.state.add_message(Message::user_text("change it"));
    // Overwrite protection: the write tool requires the file read first.
    engine
        .state
        .record_file_read(file.clone(), Some("original".to_string()), None, None, None);

    let (output, ..) = engine
        .execute_tool(
            "t-1",
            "write",
            serde_json::json!({"file_path": file.to_str().unwrap(), "content": "mutated"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    let text: String = output
        .content
        .iter()
        .filter_map(|b| match b {
            kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert!(!output.is_error, "write should succeed: {text}");
    assert_eq!(std::fs::read(&file).unwrap(), b"mutated");

    let turns = engine.checkpoints_list();
    assert_eq!(turns.len(), 1);
    assert!(turns[0].files.contains(&file));

    let (report, conversation) = engine.checkpoints_rewind(1).await.unwrap();
    assert_eq!(report.restored, vec![file.clone()]);
    assert_eq!(std::fs::read(&file).unwrap(), b"original");
    // The conversation was truncated at the same prompt boundary: the
    // "change it" request is gone and only the rewind reminder remains.
    let outcome = conversation.expect("conversation rewind outcome");
    assert_eq!(outcome.removed, 1);
    let messages = engine.state.messages();
    assert_eq!(messages.len(), 1);
    assert!(
        matches!(&messages[0], Message::User { .. }),
        "only the rewind reminder should remain"
    );
}

#[test]
fn user_request_turn_previews_number_only_genuine_requests() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let engine = QueryEngine::new_with_folder_trust(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
        Some(true),
    );
    engine.state.add_message(Message::user_text("first prompt"));
    engine
        .state
        .add_message(Message::assistant_text("first answer"));
    // Tool-result-only user messages do not count as prompt turns.
    engine.state.add_message(Message::User {
        content: vec![kcoder_types::ContentBlock::ToolResult {
            tool_use_id: "t-1".to_string(),
            content: vec![kcoder_types::ContentBlock::Text {
                text: "tool output".to_string(),
            }],
            is_error: None,
        }],
    });
    engine
        .state
        .add_message(Message::user_text("second prompt\nwith a second line"));

    let turns = engine.user_request_turn_previews();
    assert_eq!(
        turns,
        vec![
            (1, "first prompt".to_string()),
            (2, "second prompt".to_string()),
        ]
    );
}
#[tokio::test]
async fn allow_always_persists_command_rule_for_shell_and_tool_grant_for_others() {
    let tmp = tempfile::tempdir().unwrap();
    let settings_path = tmp.path().join("test-config").join("settings.json");
    let engine = TestEngineBuilder::new(tmp.path()).build();

    // bash approval persists a command-specific rule, not a tool-wide grant.
    let input = serde_json::json!({"command": "cargo test"});
    let decision = permission_response_to_decision(
        kcoder_permissions::PermissionResponse::AllowAlways,
        "bash",
        &input,
        &engine,
    )
    .await;
    assert_eq!(decision, kcoder_permissions::PermissionDecision::Allow);
    {
        let settings = recover_read_lock(&engine.settings, "settings");
        assert!(
            settings
                .permission_rules
                .iter()
                .any(|rule| rule.tool == "bash"
                    && rule.input_pattern.as_deref() == Some("cargo test")
                    && rule.action == kcoder_config::PermissionAction::Allow),
            "expected a persisted allow rule for the exact command"
        );
        assert!(!settings.allowed_tools.iter().any(|t| t == "bash"));
    }
    // The live permission engine honors the new rule immediately, and
    // only for that command.
    {
        let permissions = recover_read_lock(&engine.permissions, "permissions");
        let tool = kcoder_tools::bash::BashTool;
        assert_eq!(
            permissions.decide(&tool, &serde_json::json!({"command": "cargo test"})),
            kcoder_permissions::PermissionDecision::Allow
        );
        assert_ne!(
            permissions.decide(&tool, &serde_json::json!({"command": "cargo clean"})),
            kcoder_permissions::PermissionDecision::Allow
        );
    }

    // DenyAlways persists a deny rule for the exact command.
    let deny_input = serde_json::json!({"command": "rm -rf /tmp/x"});
    let _ = permission_response_to_decision(
        kcoder_permissions::PermissionResponse::DenyAlways,
        "bash",
        &deny_input,
        &engine,
    )
    .await;
    {
        let settings = recover_read_lock(&engine.settings, "settings");
        assert!(
            settings
                .permission_rules
                .iter()
                .any(|rule| rule.tool == "bash"
                    && rule.input_pattern.as_deref() == Some("rm -rf /tmp/x")
                    && rule.action == kcoder_config::PermissionAction::Deny)
        );
    }

    // Non-shell tools keep the tool-wide grant behavior.
    let _ = permission_response_to_decision(
        kcoder_permissions::PermissionResponse::AllowAlways,
        "write",
        &serde_json::json!({"file_path": "a.txt"}),
        &engine,
    )
    .await;
    {
        let settings = recover_read_lock(&engine.settings, "settings");
        assert!(settings.allowed_tools.iter().any(|t| t == "write"));
    }

    let persisted = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .expect("permission settings should be persisted before the decision returns");
    assert!(
        persisted["allowed_tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| tool == "write"))
    );
    assert_eq!(
        persisted["permission_rules"].as_array().map(Vec::len),
        Some(2)
    );
}

#[tokio::test]
async fn settings_persistence_is_disabled_until_the_host_provides_a_user_path() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.allowed_tools.push("write".to_string());
    let engine = QueryEngine::new_with_folder_trust(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings.clone(),
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
        Some(true),
    );

    assert!(matches!(
        &*recover_read_lock(
            &engine.settings_persistence_target,
            "settings_persistence_target"
        ),
        SettingsPersistenceTarget::Disabled
    ));
    engine
        .persist_settings_fields(settings, &["allowed_tools"])
        .await
        .unwrap();

    assert!(!tmp.path().join("settings.json").exists());
    assert!(!tmp.path().join("test-config/settings.json").exists());
    assert!(!tmp.path().join(".kcoder/settings.json").exists());
}

#[tokio::test]
async fn field_persistence_preserves_user_text_without_materializing_effective_layers() {
    let tmp = tempfile::tempdir().unwrap();
    let settings_path = tmp.path().join("user/settings.json");
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    std::fs::write(
        &settings_path,
        r#"{
  // 用户层原有值必须保留，未选中的有效字段不能由合并快照覆盖。
  "permission_mode": "ask",
  "goal_pro": { "verifier_max_turns": 16 },
  "allowed_tools": ["read"]
}
"#,
    )
    .unwrap();

    let mut effective = Settings {
        permission_mode: PermissionMode::Yolo,
        model: "project-model".to_string(),
        code_theme: "overlay-theme".to_string(),
        ..Settings::default()
    };
    effective.goal_pro.verifier_max_turns = 99;
    effective.allowed_tools = vec!["read".to_string(), "write".to_string()];
    let engine = TestEngineBuilder::new(tmp.path())
        .settings(effective.clone())
        .build()
        .with_settings_persistence_path(settings_path.clone());

    engine
        .persist_settings_fields(effective, &["allowed_tools"])
        .await
        .unwrap();

    let document: Value = kcoder_config::read_settings_file(&settings_path).unwrap();
    assert_eq!(document["permission_mode"], "ask");
    assert_eq!(document["goal_pro"]["verifier_max_turns"], 16);
    assert_eq!(
        document["allowed_tools"],
        serde_json::json!(["read", "write"])
    );
    assert!(document.get("model").is_none());
    assert!(document.get("code_theme").is_none());
    assert!(document.get("providers").is_none());
}

#[tokio::test]
async fn concurrent_permission_rules_are_ordered_and_never_restore_an_old_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let settings_path = tmp.path().join("test-config/settings.json");
    let engine = TestEngineBuilder::new(tmp.path()).build();
    let first = serde_json::json!({"command": "cargo test first"});
    let second = serde_json::json!({"command": "cargo test second"});

    let (first_decision, second_decision) = tokio::join!(
        permission_response_to_decision(
            kcoder_permissions::PermissionResponse::AllowAlways,
            "bash",
            &first,
            &engine,
        ),
        permission_response_to_decision(
            kcoder_permissions::PermissionResponse::AllowAlways,
            "bash",
            &second,
            &engine,
        )
    );
    assert_eq!(first_decision, PermissionDecision::Allow);
    assert_eq!(second_decision, PermissionDecision::Allow);

    let document: Value =
        serde_json::from_str(&std::fs::read_to_string(settings_path).unwrap()).unwrap();
    let rules = document["permission_rules"].as_array().unwrap();
    assert_eq!(rules.len(), 2);
    for command in ["cargo test first", "cargo test second"] {
        assert!(rules.iter().any(|rule| {
            rule["tool"] == "bash" && rule["input_pattern"] == command && rule["action"] == "allow"
        }));
    }
}

#[tokio::test]
async fn independent_engines_merge_permission_rules_from_stale_snapshots() {
    let tmp = tempfile::tempdir().unwrap();
    let settings_path = tmp.path().join("test-config/settings.json");
    let first_engine = TestEngineBuilder::new(tmp.path()).build();
    let second_engine = TestEngineBuilder::new(tmp.path()).build();
    assert!(!Arc::ptr_eq(
        &first_engine.settings_persistence_order,
        &second_engine.settings_persistence_order
    ));

    // Both engines capture the same empty snapshot before persistence. The second
    // write must merge the first rule under the file lock rather than overwrite it with the second engine's stale memory snapshot.
    for (engine, command) in [
        (&first_engine, "cargo test from-first-engine"),
        (&second_engine, "cargo test from-second-engine"),
    ] {
        let decision = permission_response_to_decision(
            kcoder_permissions::PermissionResponse::AllowAlways,
            "bash",
            &serde_json::json!({"command": command}),
            engine,
        )
        .await;
        assert_eq!(decision, PermissionDecision::Allow);
    }

    let document: Value =
        serde_json::from_str(&std::fs::read_to_string(settings_path).unwrap()).unwrap();
    let rules = document["permission_rules"].as_array().unwrap();
    assert_eq!(rules.len(), 2);
    for command in [
        "cargo test from-first-engine",
        "cargo test from-second-engine",
    ] {
        assert!(rules.iter().any(|rule| {
            rule["tool"] == "bash" && rule["input_pattern"] == command && rule["action"] == "allow"
        }));
    }
}

#[tokio::test]
async fn config_tool_runtime_refresh_preserves_session_permissions() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
        ..Settings::default()
    };
    let engine = TestEngineBuilder::new(tmp.path())
        .settings(settings)
        .tool_registry(kcoder_tools::default_registry().register(kcoder_tools::ConfigTool))
        .build();
    {
        let mut permissions = recover_write_lock(&engine.permissions, "permissions");
        permissions.allow_for_session("write");
        permissions.session_allowed_shell_prefixes = vec!["cargo test".to_string()];
    }

    let (output, ..) = engine
        .execute_tool(
            "config-1",
            "Config",
            serde_json::json!({"setting": "render_markdown", "value": false}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(
        !output.is_error,
        "{}",
        output
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>()
    );

    let permissions = recover_read_lock(&engine.permissions, "permissions");
    assert_eq!(permissions.session_allowed, vec!["write"]);
    assert_eq!(
        permissions.session_allowed_shell_prefixes,
        vec!["cargo test"]
    );
    assert!(!recover_read_lock(&engine.settings, "settings").render_markdown);
}

#[tokio::test]
async fn doom_loop_aborts_after_six_identical_tool_calls() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let engine = QueryEngine::new_with_folder_trust(
        Arc::new(DoomLoopProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
        Some(true),
    );
    engine.state.add_message(Message::user_text("go"));
    let events: Vec<_> = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect()
        .await;
    assert!(
        events.iter().any(|event| matches!(
            event,
            EngineEvent::StreamAborted { reason } if reason.contains("doom loop")
        )),
        "expected a doom-loop abort event"
    );
    // The conversation must carry the strategy-change nudge from streak 3.
    let nudged = engine
        .state
        .messages()
        .iter()
        .any(|message| message.preview(4096).contains("3 times in a row"));
    assert!(nudged, "expected the streak-3 nudge in the conversation");
}

#[test]
fn doom_loop_limit_allows_unbounded_task_output_polling() {
    let settings = kcoder_config::DoomLoopSettings::default();
    assert_eq!(doom_loop_limit_for_tool("TaskOutput", &settings), None);
    assert_eq!(doom_loop_limit_for_tool("bash", &settings), Some(6));

    let mut custom = settings.clone();
    custom.tools.insert("Workflow".to_string(), 12);
    assert_eq!(doom_loop_limit_for_tool("Workflow", &custom), Some(12));
}
