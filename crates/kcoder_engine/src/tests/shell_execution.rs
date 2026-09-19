#[derive(Debug, Clone, Copy)]
struct AlwaysDenyPrompt;

#[async_trait::async_trait]
impl PermissionPrompt for AlwaysDenyPrompt {
    async fn ask(
        &self,
        _tool_name: &str,
        _description: String,
        _input: &Value,
    ) -> PermissionResponse {
        PermissionResponse::DenyOnce
    }
}

fn named_tool_call_events(id: &str, name: &str, input: Value) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: format!("msg-{id}"),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "test".to_string(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::ToolUse {
                id: id.to_string(),
                name: name.to_string(),
                input: serde_json::json!({}),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::InputJsonDelta {
                partial_json: input.to_string(),
            },
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: Some("end_turn".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::MessageStop,
    ]
}

#[tokio::test]
async fn dont_ask_stops_after_two_consecutive_denials_in_one_capability() {
    let tmp = tempfile::tempdir().unwrap();
    let (provider, calls) = SequentialEventsProvider::new(vec![
        sleep_tool_call_events(0),
        sleep_tool_call_events(0),
        simple_text_events("must not be requested"),
    ]);
    let settings = Settings {
        permission_mode: PermissionMode::DontAsk,
        ..Settings::default()
    };
    let engine = QueryEngine::new(
        Arc::new(provider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    engine.state.add_message(Message::user_text("run the command"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert_eq!(*calls.lock().unwrap(), 2);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, EngineEvent::ToolDenied { .. }))
            .count(),
        2
    );
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::StreamAborted { reason }
            if reason == "permission_denial_limit:shell_execute"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::SystemNotice(text)
            if text.contains("shell_execute") && text.contains("2 consecutive")
    )));
}

#[tokio::test]
async fn dont_ask_groups_different_tool_names_by_capability() {
    let tmp = tempfile::tempdir().unwrap();
    let (provider, calls) = SequentialEventsProvider::new(vec![
        named_tool_call_events(
            "call-read",
            "read",
            serde_json::json!({"file_path": "Cargo.toml"}),
        ),
        named_tool_call_events(
            "call-grep",
            "grep",
            serde_json::json!({"pattern": "workspace", "path": "Cargo.toml"}),
        ),
        simple_text_events("must not be requested"),
    ]);
    let settings = Settings {
        permission_mode: PermissionMode::DontAsk,
        ..Settings::default()
    };
    let engine = QueryEngine::new(
        Arc::new(provider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    engine.state.add_message(Message::user_text("inspect the project"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert_eq!(*calls.lock().unwrap(), 2);
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::StreamAborted { reason }
            if reason == "permission_denial_limit:filesystem_read"
    )));
}

#[tokio::test]
async fn shell_sandbox_denial_retries_without_sandbox_after_approval() {
    let tmp = tempfile::tempdir().unwrap();
    let kcoder_dir = tmp.path().join(".kcoder");
    std::fs::create_dir_all(&kcoder_dir).unwrap();
    let hook_command = |message: &str| {
        if cfg!(windows) {
            format!("Write-Output '{{\"systemMessage\":\"{message}\"}}'")
        } else {
            format!("printf '{{\"systemMessage\":\"{message}\"}}'")
        }
    };
    std::fs::write(
            kcoder_dir.join("settings.json"),
            serde_json::to_vec(&serde_json::json!({
                "hooks": {
                    "SandboxEscalationAttempt": [{
                        "hooks": [{"type": "command", "command": hook_command("sandbox escalation attempt hook")}]
                    }],
                    "SandboxEscalated": [{
                        "hooks": [{"type": "command", "command": hook_command("sandbox escalated hook")}]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
        sandbox: kcoder_types::SandboxConfig {
            enabled: true,
            readonly: true,
            allow_shell_escalation: true,
            ..kcoder_types::SandboxConfig::default()
        },
        ..Settings::default()
    };
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

    let (output, decision, _, events) = engine
        .execute_tool(
            "tool-1",
            "bash",
            serde_json::json!({"command": "printf sandbox-ok"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();

    assert_eq!(decision, PermissionDecision::Allow);
    assert!(!output.is_error);
    assert!(tool_output_text(&output).contains("sandbox-ok"));
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::SystemNotice(text) if text.contains("without the sandbox")
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::HookMessage { text, .. } if text == "sandbox escalation attempt hook"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::HookMessage { text, .. } if text == "sandbox escalated hook"
    )));
}

#[tokio::test]
async fn user_shell_command_runs_through_tool_events() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
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

    let command = if cfg!(windows) {
        "Write-Output user-shell-ok"
    } else {
        "printf user-shell-ok"
    };
    let expected_tool = if cfg!(windows) { "PowerShell" } else { "bash" };
    let events = engine
        .run_user_shell_command(
            command.to_string(),
            &kcoder_permissions::AutoAllowPrompt,
            CancellationToken::new(),
        )
        .await;

    assert!(matches!(
        events.first(),
        Some(EngineEvent::ToolUseStarted { name, input, .. })
            if name == expected_tool && input["command"] == command
    ));
    assert!(events.iter().any(|event| matches!(
            event,
            EngineEvent::ToolResult { name, output, .. }
                if name == expected_tool && !output.is_error && tool_output_text(output).contains("user-shell-ok")
        )));
    assert!(engine.state.messages().is_empty());
}

#[tokio::test]
async fn user_shell_command_cancel_emits_abort_and_result() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
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
    let cancel = CancellationToken::new();
    cancel.cancel();

    let events = engine
        .run_user_shell_command(
            "printf should-not-run".to_string(),
            &kcoder_permissions::AutoAllowPrompt,
            cancel,
        )
        .await;

    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::StreamAborted { reason } if reason == "cancelled by user"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::ToolResult { output, .. }
            if output.is_error && tool_output_text(output).contains("interrupted")
    )));
}

#[tokio::test]
async fn shell_sandbox_escalation_denial_returns_permission_denied() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Ask,
        allowed_tools: vec!["bash".to_string()],
        sandbox: kcoder_types::SandboxConfig {
            enabled: true,
            readonly: true,
            allow_shell_escalation: true,
            ..kcoder_types::SandboxConfig::default()
        },
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

    let (output, decision, _, _) = engine
        .execute_tool(
            "tool-1",
            "bash",
            serde_json::json!({"command": "printf sandbox-ok"}),
            &AlwaysDenyPrompt,
        )
        .await
        .unwrap();

    assert_eq!(decision, PermissionDecision::Deny);
    assert!(output.is_error);
    assert!(tool_output_text(&output).contains("permission denied"));
}

#[tokio::test]
async fn yolo_shell_sandbox_escalation_skips_approval_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Yolo,
        sandbox: kcoder_types::SandboxConfig {
            enabled: true,
            readonly: true,
            allow_shell_escalation: true,
            require_shell_escalation_approval: true,
            ..kcoder_types::SandboxConfig::default()
        },
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

    let (output, decision, _, events) = engine
        .execute_tool(
            "tool-1",
            "bash",
            serde_json::json!({"command": "printf sandbox-ok"}),
            &AlwaysDenyPrompt,
        )
        .await
        .unwrap();

    assert_eq!(decision, PermissionDecision::Allow);
    assert!(!output.is_error);
    assert!(tool_output_text(&output).contains("sandbox-ok"));
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::SystemNotice(text)
            if text.contains("current permission mode bypasses prompts")
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        EngineEvent::SystemNotice(text) if text.contains("requesting approval")
    )));
}

#[tokio::test]
async fn shell_sandbox_escalation_chain_exhaustion_is_reported() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
        sandbox: kcoder_types::SandboxConfig {
            enabled: true,
            readonly: true,
            allow_shell_escalation: true,
            shell_escalation_max_attempts: 0,
            ..kcoder_types::SandboxConfig::default()
        },
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

    let (output, decision, _, _) = engine
        .execute_tool(
            "tool-1",
            "bash",
            serde_json::json!({"command": "printf sandbox-ok"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();

    assert_eq!(decision, PermissionDecision::Deny);
    assert!(output.is_error);
    assert!(tool_output_text(&output).contains("chain exhausted"));
}

#[tokio::test]
async fn normal_shell_error_does_not_trigger_sandbox_escalation() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
        sandbox: kcoder_types::SandboxConfig {
            allow_shell_escalation: true,
            ..kcoder_types::SandboxConfig::default()
        },
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

    let (output, decision, _, events) = engine
        .execute_tool(
            "tool-1",
            "bash",
            serde_json::json!({"command": "exit 7"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();

    assert_eq!(decision, PermissionDecision::Allow);
    assert!(output.is_error);
    assert!(!events.iter().any(|event| matches!(
        event,
        EngineEvent::SystemNotice(text) if text.contains("without the sandbox")
    )));
}
use kcoder_permissions::PermissionResponse;
