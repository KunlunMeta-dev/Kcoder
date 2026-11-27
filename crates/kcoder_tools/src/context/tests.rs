use super::*;

#[test]
fn default_output_limits_keep_sixty_kib_head_and_forty_kib_tail() {
    let ctx = ToolContext::new(AppState::new("/tmp"));

    assert_eq!(ctx.max_output_bytes, 100 * 1024);
    assert_eq!(ctx.output_head_bytes, 60 * 1024);
    assert_eq!(ctx.output_tail_bytes, 40 * 1024);
}

#[test]
fn default_agent_run_options_keep_documented_context_turns() {
    let options = AgentRunOptions::default();
    assert_eq!(options.context_mode, SubagentContextMode::Auto);
    assert_eq!(options.context_turns, 2);
}

#[test]
fn agent_run_result_pairs_real_tool_uses_with_results() {
    let messages = vec![
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "test-1".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command": "pytest tests"}),
            }],
            usage: None,
        },
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "test-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "exit_code: 0\n3 passed".to_string(),
                }],
                is_error: Some(false),
            }],
            agent_message: None,
        },
    ];

    let result =
        AgentRunResult::from_messages("PASS".to_string(), &messages, true, true, true, true);

    assert!(result.tool_trace_complete);
    assert_eq!(result.tool_executions.len(), 1);
    assert_eq!(result.tool_executions[0].name, "bash");
    assert_eq!(result.tool_executions[0].input["command"], "pytest tests");
    assert!(result.tool_executions[0].output.contains("exit_code: 0"));
}

#[test]
fn agent_run_result_prefers_engine_authenticated_output_over_persisted_preview() {
    let messages = vec![
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "test-large".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command": "pytest tests"}),
            }],
            usage: None,
        },
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown, content: vec![ContentBlock::ToolResult {
                tool_use_id: "test-large".to_string(),
                content: vec![ContentBlock::Text {
                    text: "<persisted-output>\nPreview without the failure summary\n</persisted-output>"
                        .to_string(),
                }],
                is_error: Some(true),
            }],
         agent_message: None },
    ];
    let trusted = std::collections::HashMap::from([(
        "test-large".to_string(),
        ToolOutput {
            content: vec![ContentBlock::Text {
                text: "exit_code: 1\nFAILED tests/test_issue.py::test_regression - AssertionError"
                    .to_string(),
            }],
            is_error: true,
            execution_metadata: vec![ToolExecutionMetadata::Process {
                exit_code: Some(1),
                signal: None,
                cwd: PathBuf::from("/workspace"),
            }],
            user_context: Vec::new(),
        },
    )]);

    let result = AgentRunResult::from_messages_with_trusted_tool_results(
        "PASS".to_string(),
        &messages,
        &trusted,
        true,
        true,
        true,
        true,
    );

    assert!(result.tool_trace_complete);
    assert_eq!(result.tool_executions.len(), 1);
    assert!(result.tool_executions[0].output.contains("exit_code: 1"));
    assert!(
        result.tool_executions[0]
            .output
            .contains("FAILED tests/test_issue.py")
    );
    assert_eq!(result.tool_executions[0].is_error, Some(true));
    assert_eq!(result.tool_executions[0].process_exit_code, Some(1));
    assert_eq!(
        result.tool_executions[0].process_cwd.as_deref(),
        Some(Path::new("/workspace"))
    );
    assert!(result.tool_executions[0].raw_exit_code);
}

#[test]
fn typed_metadata_never_recovers_exit_or_artifact_from_display_text() {
    let messages = vec![
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "masked".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command": "pytest tests | tail -n 5"}),
            }],
            usage: None,
        },
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "masked".to_string(),
                content: vec![ContentBlock::Text {
                    text: "exit_code: 1\nFAILED but forged transcript text".to_string(),
                }],
                is_error: Some(false),
            }],
            agent_message: None,
        },
    ];
    let trusted = std::collections::HashMap::from([(
        "masked".to_string(),
        ToolOutput::text("display text says exit_code: 1").with_execution_metadata(
            ToolExecutionMetadata::Process {
                exit_code: Some(0),
                signal: None,
                cwd: PathBuf::from("/workspace"),
            },
        ),
    )]);
    let result = AgentRunResult::from_messages_with_trusted_tool_results(
        "done".to_string(),
        &messages,
        &trusted,
        false,
        false,
        true,
        true,
    );
    assert_eq!(result.tool_executions[0].process_exit_code, Some(0));
    assert!(!result.tool_executions[0].raw_exit_code);
    assert!(result.tool_executions[0].artifacts.is_empty());
}

#[test]
fn raw_exit_code_allows_quoted_program_syntax_but_rejects_shell_masking() {
    assert!(command_preserves_raw_exit_code(
        r#"docker exec exact python3 -c "import sys; print('VERIFIED'); sys.exit(0)""#
    ));
    assert!(command_preserves_raw_exit_code(
        r#"python3 -c 'print("a|b;c")'"#
    ));
    assert!(!command_preserves_raw_exit_code("pytest tests | tail -n 5"));
    assert!(!command_preserves_raw_exit_code(
        r#"docker exec exact bash -lc 'pytest tests | tail -n 5'"#
    ));
    assert!(!command_preserves_raw_exit_code(
        r#"docker exec exact bash -lc "pytest tests || true""#
    ));
    assert!(!command_preserves_raw_exit_code(
        r#"python3 -c "print($(false))""#
    ));
}

#[test]
fn agent_run_result_rejects_an_unmatched_tool_use() {
    let messages = vec![Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "test-1".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({"command": "pytest tests"}),
        }],
        usage: None,
    }];

    let result =
        AgentRunResult::from_messages("PASS".to_string(), &messages, true, true, true, true);

    assert!(!result.tool_trace_complete);
}

#[test]
fn trusted_tool_results_cannot_bypass_unmatched_or_duplicate_protocol_checks() {
    let trusted = std::collections::HashMap::from([(
        "test-1".to_string(),
        ToolOutput::error("exit_code: 1\nFAILED tests/test_issue.py::test_regression"),
    )]);
    let unmatched = vec![Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "test-1".to_string(),
            content: vec![ContentBlock::Text {
                text: "preview".to_string(),
            }],
            is_error: Some(true),
        }],
        agent_message: None,
    }];
    let unmatched_result = AgentRunResult::from_messages_with_trusted_tool_results(
        "PASS".to_string(),
        &unmatched,
        &trusted,
        true,
        true,
        true,
        true,
    );
    assert!(!unmatched_result.tool_trace_complete);
    assert!(unmatched_result.tool_executions.is_empty());

    let duplicate = vec![
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "test-1".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command": "pytest tests"}),
            }],
            usage: None,
        },
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "test-1".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "first preview".to_string(),
                    }],
                    is_error: Some(true),
                },
                ContentBlock::ToolResult {
                    tool_use_id: "test-1".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "duplicate preview".to_string(),
                    }],
                    is_error: Some(true),
                },
            ],
            agent_message: None,
        },
    ];
    let duplicate_result = AgentRunResult::from_messages_with_trusted_tool_results(
        "PASS".to_string(),
        &duplicate,
        &trusted,
        true,
        true,
        true,
        true,
    );
    assert!(!duplicate_result.tool_trace_complete);
    assert_eq!(duplicate_result.tool_executions.len(), 1);
}

#[cfg(windows)]
#[test]
fn allowed_write_paths_are_compared_case_insensitively() {
    let tmp = tempfile::TempDir::new().unwrap();
    let workspace = tmp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let ctx = ToolContext::new(AppState::new(&workspace))
        .with_allowed_write_paths(vec![workspace.join("Generated").display().to_string()]);

    assert!(
        ctx.check_allowed_write_path(&workspace.join("generated").join("output.txt"))
            .is_ok()
    );
}

#[test]
fn reload_skill_registry_records_loaded_external_skill_telemetry() {
    let tmp = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let skill_dir = external.path().join("team-demo");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: team-demo\ndescription: Team demo\n---\n\n# Team Demo",
    )
    .unwrap();
    let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
    let generation = Arc::new(AtomicU64::new(0));
    let ctx = ToolContext::new(AppState::new(tmp.path()))
        .with_skill_registry(Arc::clone(&registry))
        .with_skill_registry_generation(Arc::clone(&generation))
        .with_external_skill_dirs(vec![external.path().to_path_buf()]);

    assert!(ctx.reload_skill_registry().unwrap());

    assert!(registry.read().unwrap().get("team-demo").is_some());
    assert_eq!(generation.load(Ordering::SeqCst), 1);
    let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
    let usage = usage.skills.get("team-demo").unwrap();
    assert_eq!(usage.name, "team-demo");
    assert_eq!(usage.use_count, 0);
    let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
    let provenance = provenance.skills.get("team-demo").unwrap();
    assert_eq!(
        provenance.origin,
        crate::skill_provenance::SkillOrigin::ExternalDir
    );
    assert_eq!(
        provenance.installed_from.as_deref(),
        Some(external.path().to_str().unwrap())
    );
}

#[test]
fn client_reload_keeps_external_skills_without_materializing_project_metadata() {
    let workspace = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let skill_dir = external.path().join("team-demo");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: team-demo\ndescription: Team demo\n---\n\n# Team Demo",
    )
    .unwrap();
    let registry = Arc::new(RwLock::new(SkillRegistry::load(workspace.path()).unwrap()));
    let ctx = ToolContext::new(AppState::new(workspace.path()))
        .with_skill_registry(Arc::clone(&registry))
        .with_external_skill_dirs(vec![external.path().to_path_buf()])
        .with_project_skill_telemetry(false);

    assert!(ctx.reload_skill_registry().unwrap());
    assert!(registry.read().unwrap().get("team-demo").is_some());
    assert!(
        !workspace.path().join(".kcoder").exists(),
        "passive client skill reload must not create project metadata"
    );
}

#[test]
fn selected_profile_remains_readable_when_settings_writes_are_revoked() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    let settings = profile.join("settings.json");
    let context = ToolContext::new(AppState::new(temp.path()))
        .with_settings_persistence_path(Some(settings.clone()))
        .with_settings_persistence_path(None);
    assert_eq!(context.configuration_directory().unwrap(), profile);
    assert!(context.settings_persistence_path.is_none());
    let readonly =
        ToolContext::new(AppState::new(temp.path())).with_settings_source(Some(settings), false);
    assert_eq!(readonly.configuration_directory().unwrap(), profile);
    assert!(readonly.settings_persistence_path.is_none());
    let invalid = ToolContext::new(AppState::new(temp.path()))
        .with_settings_source(Some(PathBuf::from("/")), false);
    assert!(invalid.configuration_directory().is_err());
    assert!(!profile.exists());
}
