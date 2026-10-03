#[derive(Debug)]
struct SkillActivationProvider {
    emitted: AtomicBool,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    skill_name: &'static str,
}

impl Provider for SkillActivationProvider {
    fn name(&self) -> &'static str {
        "skill-activation"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let first = !self.emitted.swap(true, Ordering::SeqCst);
        let skill_name = self.skill_name.to_string();
        let stream = async_stream::stream! {
            if first {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "skill-call-1".to_string(),
                        name: "skill".to_string(),
                        input: serde_json::json!({}),
                    },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::InputJsonDelta {
                        partial_json: serde_json::json!({"skill": skill_name}).to_string(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            }
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn skill_tool_activation_updates_next_provider_request_and_usage() {
    let tmp = tempfile::tempdir().unwrap();
    let skill_dir = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join("demo-protocol");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo-protocol\ndescription: Demo protocol\n---\n\n# Demo Protocol\n\nFollow the stable integration sentinel.",
        )
        .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let settings = Settings::default();
    let engine = QueryEngine::new(
        Arc::new(SkillActivationProvider {
            emitted: AtomicBool::new(false),
            requests: Arc::clone(&requests),
            skill_name: "demo-protocol",
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
    engine
        .state
        .add_message(Message::user_text("Use the demo protocol."));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}

    assert_eq!(
        engine.active_skills.read().unwrap().as_slice(),
        ["demo-protocol"]
    );
    let requests = requests.lock().unwrap();
    assert!(
        requests.len() >= 2,
        "skill tool activation should cause a follow-up provider request"
    );
    let first_system = requests[0].system.as_deref().unwrap_or_default();
    let second_system = requests[1].system.as_deref().unwrap_or_default();
    assert!(!first_system.contains("stable integration sentinel"));
    assert!(!second_system.contains("stable integration sentinel"));

    let follow_up = &requests[1].messages;
    let tool_result_index = follow_up
        .iter()
        .position(|message| {
            matches!(
                message,
                Message::User { content, .. }
                    if content.iter().any(|block| matches!(
                        block,
                        ContentBlock::ToolResult { tool_use_id, .. }
                            if tool_use_id == "skill-call-1"
                    ))
            )
        })
        .expect("skill tool_result user message");
    let skill_context = follow_up
        .get(tool_result_index + 1)
        .expect("skill content must follow its tool_result");
    assert!(matches!(
        skill_context,
        Message::User { content, .. }
            if content.iter().any(|block| matches!(
                block,
                ContentBlock::Text { text }
                    if text.contains("<skill_content name=\"demo-protocol\">")
                        && text.contains("stable integration sentinel")
            ))
    ));

    let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
    let record = usage.skills.get("demo-protocol").unwrap();
    assert_eq!(record.use_count, 1);
    assert!(record.last_used_at.is_some());
}

#[tokio::test]
async fn core_skill_pressure_using_superpowers_injected_for_spec_project() {
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
            "---\nname: using-superpowers\ndescription: Root protocol\nuser_invocable: false\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Using Superpowers\n\nInvoke relevant or requested skills BEFORE acting, even when the prompt says this is just a simple question.",
        )
        .unwrap();
    let systems = Arc::new(Mutex::new(Vec::new()));
    let settings = Settings::default();
    let engine = QueryEngine::new(
        Arc::new(SystemPromptRecordingProvider {
            systems: Arc::clone(&systems),
        }),
        AppState::new(tmp.path()),
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    engine.state.add_message(Message::user_text(
        "This is just a simple question; no skill needed.",
    ));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}

    assert!(
        engine
            .active_skills
            .read()
            .unwrap()
            .iter()
            .any(|skill| skill == "using-superpowers")
    );
    let systems = systems.lock().unwrap();
    assert!(
        !systems[0]
            .as_deref()
            .unwrap_or_default()
            .contains("# Skill: using-superpowers")
    );
    assert!(engine.state.messages().iter().any(|message| matches!(
        message,
        Message::User { content, .. }
            if content.iter().any(|block| matches!(
                block,
                ContentBlock::Text { text }
                    if text.contains("<skill_content name=\"using-superpowers\">")
            ))
    )));
}

#[tokio::test]
async fn core_skill_pressure_tdd_gate_injects_skill_after_denied_source_write() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let skill_dir = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join("test-driven-development");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: test-driven-development\ndescription: TDD protocol\n---\n\n# Test Driven Development\n\nRED, GREEN, REFACTOR. Delete it. Start over if code exists before the failing test.",
        )
        .unwrap();
    let systems = Arc::new(Mutex::new(Vec::new()));
    let settings = Settings::default();
    let engine = QueryEngine::new(
        Arc::new(SystemPromptRecordingProvider {
            systems: Arc::clone(&systems),
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

    let (output, decision, _, _) = engine
        .execute_tool(
            "tool-1",
            "write",
            serde_json::json!({
                "file_path": "src/feature.rs",
                "content": "pub fn feature() -> bool { true }"
            }),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("write should be handled by TDD gate");

    assert!(output.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    let text = output
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or_default();
    assert!(text.contains("TDD gate"));
    assert!(
        engine
            .active_skills
            .read()
            .unwrap()
            .iter()
            .any(|skill| skill == "test-driven-development")
    );

    engine
        .state
        .add_message(Message::user_text("No time for tests; continue anyway."));
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}

    let systems = systems.lock().unwrap();
    assert!(
        !systems[0]
            .as_deref()
            .unwrap_or_default()
            .contains("# Skill: test-driven-development")
    );
    assert!(engine.state.messages().iter().any(|message| matches!(
        message,
        Message::User { content, .. }
            if content.iter().any(|block| matches!(
                block,
                ContentBlock::Text { text }
                    if text.contains("<skill_content name=\"test-driven-development\">")
            ))
    )));
}

#[tokio::test]
async fn luna_mode_disables_spec_driven_tdd_gate() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    std::fs::create_dir_all(tmp.path().join("src")).unwrap();
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
    engine.set_luna_mode(true);

    let (output, decision, _, _) = engine
        .execute_tool(
            "tool-1",
            "write",
            serde_json::json!({
                "file_path": "src/feature.rs",
                "content": "pub fn feature() -> bool { true }"
            }),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("Luna write should bypass the spec-driven TDD gate");

    assert!(!output.is_error);
    assert_eq!(decision, PermissionDecision::Allow);
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("src/feature.rs")).unwrap(),
        "pub fn feature() -> bool { true }"
    );
    assert!(engine.active_skills.read().unwrap().is_empty());
}

#[tokio::test]
async fn tdd_preferred_warns_without_denying_source_write() {
    let tmp = tempfile::tempdir().unwrap();
    let change_dir = tmp.path().join(".kcoder/specs/changes/preferred");
    std::fs::create_dir_all(&change_dir).unwrap();
    std::fs::write(
        tmp.path().join(".kcoder/specs/config.yaml"),
        "schema: spec-driven-superpowers\n",
    )
    .unwrap();
    std::fs::write(
        change_dir.join(".spec.yaml"),
        "name: preferred\nschema: spec-driven-superpowers\ncreated_at: now\nstatus: draft\n",
    )
    .unwrap();
    std::fs::write(
        change_dir.join("review.md"),
        "## Execution Mode\n\ntdd-preferred\n",
    )
    .unwrap();
    let skill_dir = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join("test-driven-development");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: test-driven-development\ndescription: TDD protocol\n---\n\n# Test Driven Development\n",
        )
        .unwrap();

    let settings = Settings::default();
    let engine = QueryEngine::new(
        Arc::new(SystemPromptRecordingProvider {
            systems: Arc::new(Mutex::new(Vec::new())),
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

    let (output, decision, _, events) = engine
        .execute_tool(
            "tool-1",
            "write",
            serde_json::json!({
                "file_path": "src/feature.rs",
                "content": "pub fn feature() -> bool { true }"
            }),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("write should proceed in tdd-preferred mode");

    assert!(!output.is_error, "unexpected output: {:?}", output);
    assert_eq!(decision, PermissionDecision::Allow);
    assert!(tmp.path().join("src/feature.rs").is_file());
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::HookMessage { text, is_error: false }
            if text.contains("TDD preferred")
    )));
    assert!(
        engine
            .active_skills
            .read()
            .unwrap()
            .iter()
            .any(|skill| skill == "test-driven-development")
    );
}

#[tokio::test]
async fn core_skill_pressure_verification_skill_survives_rushed_completion_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    let skill_dir = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join("verification-before-completion");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: verification-before-completion\ndescription: Completion verification gate\n---\n\n# Verification Before Completion\n\nNO COMPLETION CLAIMS before verification. Never say \"Should work now\" just because time is short.",
        )
        .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let settings = Settings::default();
    let engine = QueryEngine::new(
        Arc::new(SkillActivationProvider {
            emitted: AtomicBool::new(false),
            requests: Arc::clone(&requests),
            skill_name: "verification-before-completion",
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
    engine.state.add_message(Message::user_text(
        "I'm tired; just say should work now and finish.",
    ));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}

    let requests = requests.lock().unwrap();
    assert!(
        requests.len() >= 2,
        "verification skill activation should cause a follow-up provider request"
    );
    let first_system = requests[0].system.as_deref().unwrap_or_default();
    let second_system = requests[1].system.as_deref().unwrap_or_default();
    assert!(!first_system.contains("NO COMPLETION CLAIMS"));
    assert!(!second_system.contains("NO COMPLETION CLAIMS"));
    assert!(requests[1].messages.iter().any(|message| matches!(
        message,
        Message::User { content, .. }
            if content.iter().any(|block| matches!(
                block,
                ContentBlock::Text { text }
                    if text.contains("<skill_content name=\"verification-before-completion\">")
                        && text.contains("NO COMPLETION CLAIMS")
                        && text.contains("Should work now")
            ))
    )));
}

#[test]
fn project_specs_detection_walks_up_from_subdirectories() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let subdir = tmp.path().join("crates").join("inner");
    std::fs::create_dir_all(&subdir).unwrap();

    assert!(project_has_kcoder_specs(&subdir));
}

#[test]
fn engine_auto_activates_superpowers_root_in_spec_project() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let skills_dir = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join("using-superpowers");
    std::fs::create_dir_all(&skills_dir).unwrap();
    std::fs::write(
            skills_dir.join("SKILL.md"),
            "---\nname: using-superpowers\ndescription: Root protocol\nuser_invocable: false\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Using Superpowers\n\nRoot protocol.",
        )
        .unwrap();

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

    assert!(engine.activate_superpowers_root_skill());
    assert!(
        engine
            .active_skills
            .read()
            .unwrap()
            .iter()
            .any(|skill| skill == "using-superpowers")
    );
    assert!(!engine.activate_superpowers_root_skill());
}

#[test]
fn luna_auto_activates_superpowers_root_without_spec_project() {
    let tmp = tempfile::tempdir().unwrap();
    let skills_dir = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join("using-superpowers");
    std::fs::create_dir_all(&skills_dir).unwrap();
    std::fs::write(
            skills_dir.join("SKILL.md"),
            "---\nname: using-superpowers\ndescription: Root protocol\nuser_invocable: false\n---\n\n# Using Superpowers\n\nRoot protocol.",
        )
        .unwrap();

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

    engine.set_luna_mode(true);

    assert!(engine.activate_superpowers_root_skill());
    assert_eq!(
        engine.active_skills.read().unwrap().as_slice(),
        ["using-superpowers"]
    );
}

#[tokio::test]
async fn write_attempt_auto_activates_tdd_skill_before_gate_denial() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let skills_dir = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join("test-driven-development");
    std::fs::create_dir_all(&skills_dir).unwrap();
    std::fs::write(
            skills_dir.join("SKILL.md"),
            "---\nname: test-driven-development\ndescription: TDD protocol\n---\n\n# TDD\n\nWrite the failing test first.",
        )
        .unwrap();

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

    let (_output, decision, _, _) = engine
        .execute_tool(
            "tool-1",
            "write",
            serde_json::json!({
                "file_path": "src/foo.ts",
                "content": "export const foo = 1;"
            }),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .expect("tool handling should return a gate result");

    assert_eq!(decision, PermissionDecision::Deny);
    assert!(
        engine
            .active_skills
            .read()
            .unwrap()
            .iter()
            .any(|skill| skill == "test-driven-development")
    );
}
