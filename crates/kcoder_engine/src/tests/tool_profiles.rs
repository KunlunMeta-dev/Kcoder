#[derive(Debug)]
struct CountingSchemaTool {
    schema_calls: Arc<AtomicUsize>,
}

#[derive(Clone)]
struct AsyncQuestionBackend {
    calls: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl kcoder_tools::UserQuestioner for AsyncQuestionBackend {
    fn supports_async_user_questions(&self) -> bool {
        true
    }

    async fn register_async_user_question(
        &self,
        state: &kcoder_state::AppState,
        owner: &kcoder_state::AppStateLifecycleIdentity,
        request: kcoder_types::async_user_questions::AsyncQuestionRequest,
    ) -> Result<kcoder_types::async_user_questions::AsyncQuestionAccepted, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        state
            .register_async_question(owner, request)
            .map_err(|error| error.to_string())
    }

    async fn ask(
        &self,
        _request: kcoder_tools::UserQuestionRequest,
    ) -> Result<kcoder_tools::UserQuestionResponse, String> {
        Err("synchronous question prompts are disabled for this test".into())
    }
}

fn async_question_input() -> Value {
    serde_json::json!({
        "questions": [{
            "question": "Which implementation should be used?",
            "header": "Approach",
            "options": [
                {"label": "A", "description": "Use the first implementation."},
                {"label": "B", "description": "Use the second implementation."}
            ],
            "multi_select": false
        }]
    })
}

fn async_question_engine(
    root: &std::path::Path,
    settings: Settings,
    questioner: Arc<dyn kcoder_tools::UserQuestioner>,
) -> QueryEngine {
    let state = AppState::new(root);
    state.with_history_path(root.join("async-question-history.jsonl"));
    QueryEngine::new(
        Arc::new(EmptyProvider),
        state,
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(root).unwrap(),
        questioner,
        root.to_path_buf(),
    )
}

#[async_trait::async_trait]
impl kcoder_tools::Tool for CountingSchemaTool {
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn name(&self) -> String {
        "counting_schema".to_string()
    }

    fn description(&self) -> String {
        "Test tool with an expensive schema.".to_string()
    }

    fn input_schema(&self) -> Value {
        self.schema_calls.fetch_add(1, Ordering::SeqCst);
        serde_json::json!({
            "type": "object",
            "properties": {
                "text": { "type": "string" }
            },
            "required": ["text"],
            "additionalProperties": false
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(
        &self,
        _input: Value,
        _ctx: &kcoder_tools::ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        Ok(ToolOutput::text("ok"))
    }
}

#[tokio::test]
async fn engine_reuses_cached_tool_schemas_for_requests_and_execution() {
    let tmp = tempfile::tempdir().unwrap();
    let schema_calls = Arc::new(AtomicUsize::new(0));
    let settings = crate::test_support::engine_builder::fixture_settings();
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        ToolRegistry::new().register(CountingSchemaTool {
            schema_calls: Arc::clone(&schema_calls),
        }),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    assert_eq!(schema_calls.load(Ordering::SeqCst), 1);
    assert_eq!(engine.tool_definitions_for_model().await.len(), 1);
    assert_eq!(engine.tool_definitions_for_model().await.len(), 1);
    assert_eq!(
        schema_calls.load(Ordering::SeqCst),
        1,
        "model-facing tool definitions should reuse cached schemas"
    );

    for id in ["tool-1", "tool-2"] {
        let (output, decision, _, _) = engine
            .execute_tool(
                id,
                "counting_schema",
                serde_json::json!({ "text": "hello" }),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .expect("tool execution should succeed");
        assert!(!output.is_error);
        assert_eq!(decision, PermissionDecision::Allow);
    }

    assert_eq!(
        schema_calls.load(Ordering::SeqCst),
        1,
        "tool execution should validate against cached schemas"
    );
}

#[tokio::test]
async fn text_only_model_exposes_no_tool_definitions() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        model_capabilities: kcoder_config::ModelCapabilities::text_only(),
        ..Default::default()
    };
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        ToolRegistry::new().register(CountingSchemaTool {
            schema_calls: Arc::new(AtomicUsize::new(0)),
        }),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    assert!(engine.tool_definitions_for_model().await.is_empty());
    let bundle = MemoryObserverEventBundle::new(
        "session",
        "project",
        None,
        Some("text-only observer prompt"),
        MemoryObserverSanitizationOptions::default(),
    );
    let observer_request = engine.memory_observer_model_request(&bundle, "text-only-model");
    assert!(observer_request.response_json_schema.is_none());
    assert!(
        observer_request
            .system
            .as_deref()
            .unwrap_or_default()
            .contains("Schema:"),
        "text-only fallback still needs the schema in plain-text instructions"
    );
}

#[tokio::test]
async fn yolo_mode_hides_user_elicitation_tools_from_model() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Yolo,
        ..crate::test_support::engine_builder::fixture_settings()
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

    let names = engine
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();

    assert!(!names.contains(&"AskUserQuestion".to_string()));
    assert!(!names.contains(&"EnterPlanMode".to_string()));
    assert!(!names.contains(&"ExitPlanMode".to_string()));
    assert!(names.contains(&"bash".to_string()) || names.contains(&"PowerShell".to_string()));
}

#[tokio::test]
async fn async_question_is_available_and_nonblocking_for_yolo_main_task() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Yolo,
        ..crate::test_support::engine_builder::fixture_settings()
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let questioner = Arc::new(AsyncQuestionBackend {
        calls: Arc::clone(&calls),
    });
    let mut engine = async_question_engine(tmp.path(), settings, questioner)
        .with_client_questions_supported(false)
        .with_async_user_questions_supported(true);

    let names = engine
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(names.iter().any(|name| name == "AskUserQuestionAsync"));
    assert!(!names.iter().any(|name| name == "AskUserQuestion"));

    engine.native_web_source_identity = Some(kcoder_types::TurnAttemptIdentity {
        thread_id: engine.state.session_id(),
        turn_id: "yolo-main-turn".into(),
        attempt_id: "yolo-main-attempt".into(),
    });
    let (output, decision, _, _) = engine
        .execute_tool(
            "async-question-call-1",
            "AskUserQuestionAsync",
            async_question_input(),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert_eq!(decision, PermissionDecision::Allow);
    assert!(!output.is_error, "{}", tool_output_text(&output));
    let response: Value = serde_json::from_str(&tool_output_text(&output)).unwrap();
    assert_eq!(response["accepted"], true);
    assert!(response["questionId"].as_str().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn async_question_is_hidden_without_negotiated_capability_or_host_support() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = crate::test_support::engine_builder::fixture_settings();
    let questioner = Arc::new(AsyncQuestionBackend {
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let engine = async_question_engine(tmp.path(), settings.clone(), questioner)
        .with_async_user_questions_supported(false);
    let names = engine
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(!names.iter().any(|name| name == "AskUserQuestionAsync"));
    assert!(
        engine
            .effective_tool_catalog()
            .await
            .iter()
            .all(|tool| tool.name != "AskUserQuestionAsync")
    );

    let engine = async_question_engine(
        tmp.path(),
        settings,
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
    )
    .with_async_user_questions_supported(true);
    let names = engine
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(!names.iter().any(|name| name == "AskUserQuestionAsync"));
}

#[tokio::test]
async fn async_question_is_hidden_and_rejected_in_subagent() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = crate::test_support::engine_builder::fixture_settings();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = async_question_engine(
        tmp.path(),
        settings,
        Arc::new(AsyncQuestionBackend {
            calls: Arc::clone(&calls),
        }),
    )
    .with_async_user_questions_supported(true)
    .with_agent_depth(1);

    let names = engine
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(!names.iter().any(|name| name == "AskUserQuestionAsync"));

    let (output, decision, _, _) = engine
        .execute_tool(
            "async-question-child-call",
            "AskUserQuestionAsync",
            async_question_input(),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert_eq!(decision, PermissionDecision::Deny);
    assert!(output.is_error);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn channel_configuration_denies_questions_without_hiding_the_original_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Yolo,
        ..crate::test_support::engine_builder::fixture_settings()
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let mut web = async_question_engine(
        tmp.path(),
        settings,
        Arc::new(AsyncQuestionBackend {
            calls: Arc::clone(&calls),
        }),
    )
    .with_client_questions_supported(true)
    .with_async_user_questions_supported(true);
    web.state
        .bind_channel_task_source(kcoder_types::agent_definition::ChannelTaskSource {
            owner: kcoder_types::integrations::core::IntegrationOwner {
                account_id: "test-account".into(),
                target_id: "test-target".into(),
                workspace_id: kcoder_types::integrations::core::IntegrationNullable::Null,
                organization_id: None,
            },
            channel_id: "persisted-channel-source".into(),
        })
        .unwrap();
    web.native_web_source_identity = Some(kcoder_types::TurnAttemptIdentity {
        thread_id: web.state.session_id(),
        turn_id: "web-turn-after-channel-task".into(),
        attempt_id: "web-attempt".into(),
    });

    // Channel restrictions do not alter the original tool schemas or mode filters.
    let channel = web
        .clone()
        .with_unattended_input()
        .with_channel_tool_restrictions(kcoder_types::channel_tool_restrictions::ChannelToolRestrictions {
            enabled: true,
            disabled_tools: vec!["AskUserQuestion".into(), "AskUserQuestionAsync".into()],
        })
        .with_client_questions_supported(true)
        .with_async_user_questions_supported(true);
    let names = channel
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(names.iter().any(|name| name == "AskUserQuestionAsync"));
    // The original yolo mode still suppresses synchronous elicitation.
    assert!(!names.iter().any(|name| name == "AskUserQuestion"));

    for (id, name) in [
        ("channel-async-call", "AskUserQuestionAsync"),
        ("channel-sync-call", "AskUserQuestion"),
    ] {
        let (output, decision, _, _) = channel
            .execute_tool(
                id,
                name,
                async_question_input(),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert_eq!(decision, PermissionDecision::Deny);
        assert!(output.is_error);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    // The persistent source marker does not impose a permanent UI restriction.
    let names = web
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(names.iter().any(|name| name == "AskUserQuestionAsync"));
    let (output, decision, _, _) = web
        .execute_tool(
            "web-call-after-channel-task",
            "AskUserQuestionAsync",
            async_question_input(),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert_eq!(decision, PermissionDecision::Allow);
    assert!(!output.is_error, "{}", tool_output_text(&output));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn luna_mode_filters_model_definitions_and_execution_registry_from_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        tools: kcoder_config::ToolsSettings {
            luna: kcoder_config::LunaToolProfileSettings {
                allowed: vec!["read".to_string(), "grep".to_string()],
            },
            ..kcoder_config::ToolsSettings::default()
        },
        ..crate::test_support::engine_builder::fixture_settings()
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

    engine.set_luna_mode(true);
    let mut names = engine
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    names.sort();

    assert_eq!(names, vec!["grep", "read"]);
    assert!(engine.active_tool_registry().get("read").is_some());
    assert!(engine.active_tool_registry().get("write").is_none());

    engine.set_luna_mode(false);
    assert!(engine.active_tool_registry().get("write").is_some());
}

#[tokio::test]
async fn luna_mode_removes_spec_context_and_normal_mode_restores_it() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let skill_dir = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join("using-superpowers");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: using-superpowers\ndescription: Root protocol\n---\n\nSUPERPOWER_SKILL_SENTINEL",
        )
        .unwrap();
    let using_specs_dir = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join("using-specs");
    std::fs::create_dir_all(&using_specs_dir).unwrap();
    std::fs::write(
            using_specs_dir.join("SKILL.md"),
            "---\nname: using-specs\ndescription: Spec protocol\npaths:\n  - \".kcoder/specs/**\"\n---\n\nUSING_SPECS_SKILL_SENTINEL",
        )
        .unwrap();
    std::fs::write(
            tmp.path().join("AGENTS.md"),
            "# Agent Guide\n\nGENERAL_PROJECT_SENTINEL\n\n## Superpowers Protocol\n\nSUPERPOWERS_SECTION_SENTINEL\n\n## OpenSpec Workflow\n\nSPEC_SECTION_SENTINEL\n\n## Conventions\n\n- Keep Rust code formatted.\n- Spec-driven changes use SpecArchive. SPEC_LINE_SENTINEL\n",
        )
        .unwrap();

    let requests = Arc::new(Mutex::new(Vec::new()));
    let settings = crate::test_support::engine_builder::fixture_settings();
    let engine = QueryEngine::new(
        Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    assert!(engine.activate_superpowers_root_skill());
    assert!(!engine.active_skills.read().unwrap().is_empty());
    engine.set_luna_mode(true);
    engine.activate_matching_skills(&[".kcoder/specs/changes/demo/tasks.md".to_string()]);
    assert_eq!(
        engine.active_skills.read().unwrap().as_slice(),
        ["using-superpowers"]
    );
    engine.state.add_message(Message::user_text("luna turn"));
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}

    engine.start_new_session().unwrap();
    engine.active_skills.write().unwrap().clear();
    engine.set_luna_mode(false);
    engine.state.add_message(Message::user_text("normal turn"));
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);

    let luna = &requests[0];
    let luna_context = luna
        .messages
        .iter()
        .map(|message| message.preview(usize::MAX))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        luna.system
            .as_deref()
            .unwrap_or_default()
            .contains("Luna mode")
    );
    assert!(luna_context.contains("GENERAL_PROJECT_SENTINEL"));
    assert!(luna_context.contains("SUPERPOWERS_SECTION_SENTINEL"));
    assert!(luna_context.contains("Keep Rust code formatted"));
    assert!(!luna_context.contains("SPEC_SECTION_SENTINEL"));
    assert!(!luna_context.contains("SPEC_LINE_SENTINEL"));
    assert!(luna_context.contains("SUPERPOWER_SKILL_SENTINEL"));
    assert!(!luna_context.contains("USING_SPECS_SKILL_SENTINEL"));
    assert!(!luna.tools.iter().any(|tool| tool.name.starts_with("Spec")));
    assert!(!luna.tools.iter().any(|tool| tool.name == "ocr"));
    assert!(luna.tools.iter().any(|tool| tool.name == "TodoWrite"));
    assert!(luna.tools.iter().any(|tool| tool.name == "Workflow"));
    let luna_system = luna.system.as_deref().unwrap_or_default();
    assert!(!luna_system.contains("remember tool"));
    assert!(!luna_system.contains("OCR"));
    assert!(luna_system.contains("Workflow"));

    let normal = &requests[1];
    let normal_context = normal
        .messages
        .iter()
        .map(|message| message.preview(usize::MAX))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !normal
            .system
            .as_deref()
            .unwrap_or_default()
            .contains("Luna mode")
    );
    assert!(normal_context.contains("SPEC_SECTION_SENTINEL"));
    assert!(normal_context.contains("SPEC_LINE_SENTINEL"));
    assert!(normal_context.contains("SUPERPOWER_SKILL_SENTINEL"));
    assert!(
        normal
            .tools
            .iter()
            .any(|tool| tool.name.starts_with("Spec"))
    );
    let normal_system = normal.system.as_deref().unwrap_or_default();
    assert!(normal_system.contains("remember tool"));
    assert!(normal_system.contains("OCR"));
}

#[tokio::test]
async fn default_luna_allowlist_matches_registered_model_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = crate::test_support::engine_builder::fixture_settings();
    let mut expected = settings.tools.luna.allowed.clone();
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

    engine.set_luna_mode(true);
    let mut actual = engine
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    expected.sort();
    actual.sort();

    assert_eq!(actual, expected);
}

#[tokio::test]
async fn yolo_mode_rejects_hard_called_user_question_without_prompting() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Yolo,
        ..crate::test_support::engine_builder::fixture_settings()
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
            "tool-ask",
            "AskUserQuestion",
            serde_json::json!({
                "questions": [{
                    "question": "Should I continue?",
                    "header": "Choice",
                    "options": [
                        {"label": "Continue", "description": "Proceed autonomously."},
                        {"label": "Stop", "description": "Stop now."}
                    ],
                    "multi_select": false
                }]
            }),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();

    assert_eq!(decision, PermissionDecision::Deny);
    assert!(output.is_error);
    assert!(tool_output_text(&output).contains("yolo mode does not ask the user"));
    assert!(events.is_empty());
}
