#[derive(Debug)]
struct BackgroundSkillPatchProvider {
    calls: Arc<AtomicUsize>,
}

impl Provider for BackgroundSkillPatchProvider {
    fn name(&self) -> &'static str {
        "background-skill-patch"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let tool_input = serde_json::json!({
            "action": "patch",
            "name": "demo",
            "old_string": "Use this after repeatable work.",
            "new_string": "Use this after repeatable work. Verify with tests."
        })
        .to_string();
        let stream = async_stream::stream! {
            if call == 0 {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "skill-patch-1".to_string(),
                        name: "skill_manage".to_string(),
                        input: serde_json::json!({}),
                    },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::InputJsonDelta {
                        partial_json: tool_input,
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            } else {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text {
                        text: String::new(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "Patched demo.".to_string(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            }
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct BackgroundSkillCreateProvider {
    calls: Arc<AtomicUsize>,
}

impl Provider for BackgroundSkillCreateProvider {
    fn name(&self) -> &'static str {
        "background-skill-create"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let tool_input = serde_json::json!({
                "action": "create",
                "name": "review-created",
                "content": "---\nname: review-created\ndescription: Review-created workflow\n---\n\n# Review Created\n\nUse this after recurring review feedback."
            })
            .to_string();
        let stream = async_stream::stream! {
            if call == 0 {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "skill-create-1".to_string(),
                        name: "skill_manage".to_string(),
                        input: serde_json::json!({}),
                    },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::InputJsonDelta {
                        partial_json: tool_input,
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            } else {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text {
                        text: String::new(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "Created review-created.".to_string(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            }
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn auto_curator_archives_agent_created_skill_in_background() {
    let tmp = tempfile::tempdir().unwrap();
    let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
    )
    .unwrap();

    let mut settings = Settings::default();
    settings.skills.auto_curator_enabled = true;
    settings.skills.auto_curator_interval_hours = 1;
    settings.skills.auto_curator_min_idle_hours = 0;
    settings.skills.stale_after_days = 0;
    settings.skills.archive_after_days = 0;
    let permissions = PermissionEngine::from_settings(&settings);
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        ToolRegistry::new().register(SkillCuratorTool),
        permissions,
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    kcoder_tools::skill_telemetry::record_skill_created(tmp.path(), "demo");
    kcoder_tools::skill_provenance::record_agent_created(tmp.path(), "demo");
    *engine.auto_curator_last_run.write().unwrap() = Some(UNIX_EPOCH);

    engine.maybe_spawn_auto_curator();

    let archived = tmp.path().join(".kcoder/skills/.archive/demo/SKILL.md");
    for _ in 0..50 {
        if archived.is_file() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    assert!(
        archived.is_file(),
        "auto curator should archive the stale agent-created skill"
    );
    let mut events = Vec::new();
    for _ in 0..500 {
        events.extend(engine.flush_background_jobs());
        if events
            .iter()
            .any(|event| matches!(event, EngineEvent::BackgroundJobCompleted { .. }))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::BackgroundJobCompleted { .. })),
        "automatic curator should complete as a background job"
    );
}

#[tokio::test]
async fn auto_curator_idle_skip_does_not_advance_last_run() {
    let tmp = tempfile::tempdir().unwrap();
    let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
    )
    .unwrap();

    let mut settings = Settings::default();
    settings.skills.auto_curator_enabled = true;
    settings.skills.auto_curator_interval_hours = 1;
    settings.skills.auto_curator_min_idle_hours = 0;
    settings.skills.stale_after_days = 0;
    settings.skills.archive_after_days = 0;
    let permissions = PermissionEngine::from_settings(&settings);
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        ToolRegistry::new().register(SkillCuratorTool),
        permissions,
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    kcoder_tools::skill_telemetry::record_skill_created(tmp.path(), "demo");
    kcoder_tools::skill_provenance::record_agent_created(tmp.path(), "demo");
    let old_last_run = UNIX_EPOCH;
    *engine.auto_curator_last_run.write().unwrap() = Some(old_last_run);
    *engine.auto_curator_last_activity.write().unwrap() =
        SystemTime::now() + Duration::from_secs(60);

    engine.maybe_spawn_auto_curator();

    for _ in 0..50 {
        if !engine.auto_curator_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    assert!(
        !tmp.path()
            .join(".kcoder/skills/.archive/demo/SKILL.md")
            .is_file(),
        "idle-skipped curator should not archive the skill"
    );
    assert_eq!(
        *engine.auto_curator_last_run.read().unwrap(),
        Some(old_last_run),
        "skipped curator attempts should not consume the interval"
    );
    let mut events = Vec::new();
    for _ in 0..100 {
        events.extend(engine.flush_background_jobs());
        if events
            .iter()
            .any(|event| matches!(event, EngineEvent::BackgroundJobCompleted { .. }))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::BackgroundJobCompleted { .. })),
        "idle-skipped automatic curator should still complete the background job"
    );
}

#[test]
fn engine_startup_records_created_usage_for_external_skills() {
    let tmp = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let skill_dir = external.path().join("team-demo");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: team-demo\ndescription: Team demo\n---\n\n# Team Demo",
    )
    .unwrap();

    let mut settings = Settings::default();
    settings.skills.external_dirs = vec![external.path().to_path_buf()];
    let registry =
        SkillRegistry::load_with_external_dirs(tmp.path(), settings.skills.external_dirs.iter())
            .unwrap();
    QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        registry,
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
    let usage = usage.skills.get("team-demo").unwrap();
    assert_eq!(usage.name, "team-demo");
    assert_eq!(usage.use_count, 0);

    let provenance = kcoder_tools::skill_provenance::load_project_provenance(tmp.path()).unwrap();
    let provenance = provenance.skills.get("team-demo").unwrap();
    assert_eq!(
        provenance.origin,
        kcoder_tools::skill_provenance::SkillOrigin::ExternalDir
    );
    assert_eq!(
        provenance.installed_from.as_deref(),
        Some(external.path().to_str().unwrap())
    );
}

#[test]
fn skill_review_runtime_config_accepts_persistent_skills_settings() {
    let mut settings = Settings::default();
    assert_eq!(
        crate::skill_maintenance_runtime::skill_review_runtime_config(&settings),
        (false, 10)
    );

    settings.skills.auto_skill_review_enabled = true;
    settings.skills.auto_skill_review_interval = 3;
    assert_eq!(
        crate::skill_maintenance_runtime::skill_review_runtime_config(&settings),
        (true, 3)
    );

    settings.skills.auto_skill_review_enabled = false;
    settings.auto_skill_review_enabled = true;
    settings.auto_skill_review_interval = 5;
    assert_eq!(
        crate::skill_maintenance_runtime::skill_review_runtime_config(&settings),
        (true, 5)
    );

    settings.training_mode = true;
    assert_eq!(
        crate::skill_maintenance_runtime::skill_review_runtime_config(&settings),
        (false, 5)
    );
}

#[test]
fn background_skill_review_counter_requires_reusable_knowledge_signal() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.skills.auto_skill_review_enabled = true;
    settings.skills.auto_skill_review_interval = 2;
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        ToolRegistry::new().register(kcoder_tools::SkillManageTool),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    engine
        .state
        .add_message(Message::user_text("Please update the README."));
    engine
        .state
        .add_message(Message::assistant_text("Updated."));
    engine.maybe_spawn_skill_review(&["write".to_string()]);
    assert_eq!(*engine.auto_skill_review_counter.read().unwrap(), 0);

    engine.state.add_message(Message::user_text(
        "Next time, always run cargo test before claiming this workflow is complete.",
    ));
    engine
        .state
        .add_message(Message::assistant_text("I will follow that workflow."));
    engine.maybe_spawn_skill_review(&["write".to_string()]);
    assert_eq!(*engine.auto_skill_review_counter.read().unwrap(), 1);
}

#[tokio::test]
async fn background_skill_review_patch_marks_background_write_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(skill_dir.join("SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n\nUse this after repeatable work.").unwrap();
    kcoder_tools::skill_provenance::record_user_created(tmp.path(), "demo");

    let settings = Settings {
        auto_skill_review_enabled: false,
        ..Settings::default()
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = QueryEngine::new(
        Arc::new(BackgroundSkillPatchProvider {
            calls: Arc::clone(&calls),
        }),
        AppState::new(tmp.path()),
        ToolRegistry::new().register(kcoder_tools::SkillManageTool),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text("prior user message")].into(),
        active_skills: vec![],
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let summary = engine
        .run_background_skill_review(
            cache_safe,
            "review skills".to_string(),
            "test-review-job".to_string(),
        )
        .await
        .unwrap();

    assert!(summary.contains("Patched demo."));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let content = std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap();
    assert!(content.contains("Verify with tests."));
    let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
    let usage = usage.skills.get("demo").unwrap();
    assert_eq!(usage.patch_count, 1);
    let provenance = kcoder_tools::skill_provenance::load_project_provenance(tmp.path()).unwrap();
    let provenance = provenance.skills.get("demo").unwrap();
    assert_eq!(
        provenance.origin,
        kcoder_tools::skill_provenance::SkillOrigin::UserCreated
    );
    assert_eq!(provenance.created_by.as_deref(), Some("user"));
    assert_eq!(
        provenance.write_origin.as_deref(),
        Some("background_skill_review")
    );
}

#[tokio::test]
async fn background_skill_review_create_marks_agent_created_provenance() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        auto_skill_review_enabled: false,
        ..Settings::default()
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = QueryEngine::new(
        Arc::new(BackgroundSkillCreateProvider {
            calls: Arc::clone(&calls),
        }),
        AppState::new(tmp.path()),
        ToolRegistry::new().register(kcoder_tools::SkillManageTool),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text("prior user message")].into(),
        active_skills: vec![],
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let summary = engine
        .run_background_skill_review(
            cache_safe,
            "review skills".to_string(),
            "test-review-job".to_string(),
        )
        .await
        .unwrap();

    assert!(summary.contains("Created review-created."));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(
        tmp.path()
            .join(".kcoder/skills/review-created/SKILL.md")
            .is_file()
    );
    assert!(
        engine
            .skill_registry
            .read()
            .unwrap()
            .get("review-created")
            .is_some(),
        "background review should reload the live registry after creation"
    );
    let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
    let usage = usage.skills.get("review-created").unwrap();
    assert_eq!(usage.patch_count, 1);
    assert_eq!(usage.use_count, 0);
    let provenance = kcoder_tools::skill_provenance::load_project_provenance(tmp.path()).unwrap();
    let provenance = provenance.skills.get("review-created").unwrap();
    assert_eq!(
        provenance.origin,
        kcoder_tools::skill_provenance::SkillOrigin::AgentCreated
    );
    assert_eq!(provenance.created_by.as_deref(), Some("agent"));
    assert_eq!(
        provenance.write_origin.as_deref(),
        Some("background_skill_review")
    );
}
