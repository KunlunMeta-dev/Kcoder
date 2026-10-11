#[test]
fn project_instruction_failure_blocks_real_engine_construction_before_side_effects() {
    for (client, invalid_encoding) in [(true, false), (false, false), (true, true)] {
        let workspace = tempfile::tempdir().unwrap();
        let guide = workspace.path().join("AGENTS.md");
        if invalid_encoding {
            std::fs::write(&guide, [0xff]).unwrap();
        } else {
            std::fs::File::create(&guide)
                .unwrap()
                .set_len((kcoder_config::MAX_PROJECT_MD_FILE_BYTES + 1) as u64)
                .unwrap();
        }
        let settings = Settings::default();
        let state = AppState::new(workspace.path());
        let copy = state.clone();
        let result = if client {
            QueryEngine::try_new_for_client(
                Arc::new(EmptyProvider),
                state,
                ToolRegistry::new(),
                PermissionEngine::from_settings(&settings),
                settings,
                MemoryManager::global_only(MemoryStore::empty()),
                SkillRegistry::empty(),
                Arc::new(kcoder_tools::DenyAllUserQuestioner),
                workspace.path().to_path_buf(),
            )
        } else {
            QueryEngine::try_new_with_plugin_snapshot(
                Arc::new(EmptyProvider),
                state,
                ToolRegistry::new(),
                PermissionEngine::from_settings(&settings),
                settings,
                MemoryManager::global_only(MemoryStore::empty()),
                SkillRegistry::empty(),
                Arc::new(kcoder_tools::DenyAllUserQuestioner),
                workspace.path().to_path_buf(),
                kcoder_plugins::EffectivePluginSnapshot::default(),
            )
        };
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("unreadable constraints must not produce an executable Engine"),
        };
        assert!(error.to_string().contains(if invalid_encoding {
            "project_instruction_encoding"
        } else {
            "project_instruction_limit"
        }));
        assert!(copy.messages().is_empty());
        assert!(
            !workspace.path().join(".kcoder").exists(),
            "failed initialization must not create ghost workspace metadata"
        );
    }
}

#[tokio::test]
async fn project_instruction_complete_content_reaches_the_provider_with_local_precedence() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("workspace");
    std::fs::create_dir(&cwd).unwrap();
    std::fs::write(tmp.path().join("KCODER.md"), "PARENT_SHOULD_NOT_APPLY").unwrap();
    std::fs::write(cwd.join("AGENTS.md"), "本地约束\nTAIL_MUST_BE_PRESERVED").unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine_with_settings(
        Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }),
        &cwd,
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine
        .submit_message_stream("hello", &kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    let captured = requests.lock().unwrap();
    assert!(!captured.is_empty());
    let content = serde_json::to_string(&captured[0].messages).unwrap();
    assert!(content.contains("本地约束") && content.contains("TAIL_MUST_BE_PRESERVED"));
    assert!(!content.contains("PARENT_SHOULD_NOT_APPLY"));
}
