use super::*;

#[tokio::test]
async fn role_runner_starts_each_verifier_in_a_fresh_session() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_session_tail = "FIRST_SESSION_PRIVATE_TAIL_SENTINEL";
    let first_verdict = format!(
        "FAIL\nknown rejection gap {}{first_session_tail}",
        "x".repeat(300)
    );
    let provider = Arc::new(MultiRecordingProvider {
        requests: Arc::clone(&requests),
        outputs: Mutex::new(VecDeque::from([
            first_verdict,
            "PASS\nrejection gap fixed".to_string(),
        ])),
    });
    let engine = test_engine(provider, tmp.path());
    let artifact_project_dir = tmp.path().join("artifacts");
    engine
        .state
        .with_session_artifact_project_dir(&artifact_project_dir, "fresh-verifiers");
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );
    // This test validates verifier-session isolation only. Disable evidence gates so the fake provider need not become a tool-protocol stub.
    let mut verifier_selection = kcoder_state::GoalVerifierSelection::default();
    verifier_selection.verification.require_tests = false;
    verifier_selection.verification.require_raw_exit_code = false;
    verifier_selection.verification.allow_workspace_changes = true;
    verifier_selection.verification.isolate_environment = false;
    verifier_selection.verification.allow_dependency_changes = true;
    engine
        .state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "verify the fresh-session contract",
            None,
            None,
            kcoder_state::GoalMode::Strict,
            kcoder_state::GoalVerificationKind::Artifact,
            verifier_selection,
        )
        .unwrap();
    let ctx = kcoder_tools::ToolContext::new(engine.state.clone())
        .with_agent_runner(Arc::new(crate::agent::QueryEngineAgentRunner::new(engine)));

    let first = kcoder_tools::UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();
    assert!(first.is_error);
    let second = kcoder_tools::UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();
    assert!(!second.is_error);

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let first_request = request_preview(&requests[0]);
    let second_request = request_preview(&requests[1]);
    assert!(!first_request.contains("previous_verifier_rejection"));
    assert!(second_request.contains("<previous_verifier_rejection>"));
    assert!(second_request.contains("known rejection gap"));
    assert!(!second_request.contains(first_session_tail));
    drop(requests);

    let subagents_dir = artifact_project_dir
        .join("fresh-verifiers")
        .join("subagents");
    let mut transcript_paths = std::fs::read_dir(&subagents_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("transcript.json"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    transcript_paths.sort();
    assert_eq!(transcript_paths.len(), 2);
    assert_ne!(transcript_paths[0], transcript_paths[1]);

    let transcripts = transcript_paths
        .iter()
        .map(|path| std::fs::read_to_string(path).unwrap())
        .collect::<Vec<_>>();
    assert!(transcripts.iter().any(|text| {
        text.contains(first_session_tail) && !text.contains("<previous_verifier_rejection>")
    }));
    assert!(transcripts.iter().any(|text| {
        text.contains("<previous_verifier_rejection>") && !text.contains(first_session_tail)
    }));
}

#[tokio::test]
async fn forked_agent_uses_parent_current_model() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());

    // Simulate a parent turn that captured a snapshot with specific values.
    let snapshot_model = "snapshot-model".to_string();
    let snapshot_max_tokens = 1024u32;
    let snapshot_skills = vec!["skill-a".to_string()];
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent user")].into(),
            active_skills: snapshot_skills.clone(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: snapshot_model.clone(),
            full_context_compatible: true,
        }
        .into(),
    );

    // Mutate the live settings to prove the fork uses the parent's
    // current model, not a stale cache-safe snapshot.
    let live_model = "minimax-m3".to_string();
    engine.settings.write().unwrap().model = live_model.clone();
    engine.settings.write().unwrap().max_tokens = Some(4096);

    let result = engine
        .run_forked_agent(
            vec![Message::user_text("hello")],
            crate::agent::SubagentContextOverrides::default(),
            10,
        )
        .await
        .unwrap();
    assert_eq!(result.output_text, "hi");

    let req = request
        .lock()
        .unwrap()
        .take()
        .expect("provider did not receive request");
    assert_eq!(req.model, live_model);
    assert_eq!(req.max_tokens, 4096);
    // Active skills are baked into the system prompt via the skill registry;
    // the important invariant is that the fork used the current parent
    // model rather than the stale snapshot model.
    assert_ne!(req.model, snapshot_model);
    assert_ne!(req.max_tokens, snapshot_max_tokens);
}

#[tokio::test]
async fn training_mode_preserves_forked_agents_with_distinct_session_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let mut settings = Settings::default();
    settings.enable_training_mode();
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    let parent_session_id = engine.state.session_id();
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent user")].into(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    let result = engine
        .run_forked_agent(
            vec![Message::user_text("perform delegated work")],
            crate::agent::SubagentContextOverrides::default(),
            10,
        )
        .await
        .unwrap();

    assert_eq!(result.output_text, "hi");
    let request = request
        .lock()
        .unwrap()
        .take()
        .expect("subagent Provider request");
    let child_session_id = request
        .debug_session_id
        .expect("subagent request must expose its session id");
    assert_ne!(child_session_id, parent_session_id);
    assert_eq!(request.trajectory_agent_depth, Some(1));
}

#[tokio::test]
async fn full_context_rejects_provider_or_model_switch_since_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent user")].into(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: "snapshot-model".to_string(),
            full_context_compatible: true,
        }
        .into(),
    );
    engine.settings.write().unwrap().model = "live-model".to_string();

    let runner = crate::agent::QueryEngineAgentRunner::new(engine);
    let error = runner
        .run_agent_session_with_options(
            "full-incompatible".to_string(),
            "continue exactly".to_string(),
            10,
            kcoder_tools::AgentKind::General,
            kcoder_tools::AgentRunOptions::default()
                .with_context_inheritance(kcoder_tools::SubagentContextMode::Full, 2),
        )
        .await
        .expect_err("full context must reject a model-switched snapshot");

    assert!(error.to_string().contains("context_mode=full"));
    assert!(
        error
            .to_string()
            .contains("use context_mode=semantic or recent")
    );
    assert!(request.lock().unwrap().is_none());
}

#[tokio::test]
async fn moa_turn_marks_snapshot_incompatible_with_full_inheritance() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let mut settings = Settings {
        model: "parent-model".to_string(),
        request_timeout_secs: Some(1),
        provider_no_proxy: true,
        local_base_url: Some("http://127.0.0.1:9/v1".to_string()),
        ..Settings::default()
    };
    settings.moa.enabled = true;
    settings.moa.default_preset = "snapshot-test".to_string();
    settings.moa.presets = std::collections::BTreeMap::from([(
        "snapshot-test".to_string(),
        MoaPresetConfig {
            enabled: true,
            reference_models: vec![MoaModelConfig::new("missing-provider", "reference-model")],
            aggregator: MoaModelConfig::new("local", "aggregator-model"),
            reference_max_tokens: Some(32),
            aggregator_max_tokens: Some(32),
        },
    )]);
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    engine
        .state
        .add_message(Message::user_text("answer through MoA"));
    engine.enable_moa_for_next_turn(Some("snapshot-test".to_string()));

    let turn_engine = engine.clone();
    let turn = tokio::spawn(async move {
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let mut stream = Box::pin(turn_engine.run_turn_stream(&prompt));
        while stream.next().await.is_some() {}
    });

    let params = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(params) = engine.last_cache_safe_params() {
                break params;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("MoA turn should publish cache-safe params before provider completion");

    assert_eq!(params.snapshot_provider, "recording");
    assert_eq!(params.snapshot_model, "parent-model");
    assert_ne!(params.snapshot_model, "aggregator-model");
    assert!(!params.full_context_compatible);

    let runner = crate::agent::QueryEngineAgentRunner::new(engine.clone());
    let error = runner
        .run_agent_session_with_options(
            "moa-full-rejected".to_string(),
            "continue exactly".to_string(),
            10,
            kcoder_tools::AgentKind::General,
            kcoder_tools::AgentRunOptions::default()
                .with_context_inheritance(kcoder_tools::SubagentContextMode::Full, 2),
        )
        .await
        .expect_err("MoA snapshots must reject full inheritance");
    assert!(error.to_string().contains("active MoA aggregator turn"));
    assert!(error.to_string().contains("semantic or recent"));

    engine.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(2), turn).await;
}

#[tokio::test]
async fn forked_agent_does_not_refresh_session_memory() {
    let tmp = tempfile::tempdir().unwrap();
    let session_memory_requests = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(ForkSessionMemoryCountingProvider {
        session_memory_requests: Arc::clone(&session_memory_requests),
    });
    let engine = test_engine(provider, tmp.path());
    {
        let mut settings = engine.settings.write().unwrap();
        settings.session_memory.update_enabled = true;
        settings.session_memory.init_min_tokens = 1;
        settings.session_memory.update_min_token_delta = 1;
    }
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent user")].into(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    let result = engine
        .run_forked_agent(
            vec![Message::user_text("hello")],
            crate::agent::SubagentContextOverrides::default(),
            10,
        )
        .await
        .unwrap();
    assert_eq!(result.output_text, "hi");

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        session_memory_requests.load(Ordering::SeqCst),
        0,
        "forked/subagent turns must not run session-memory maintenance"
    );
}

#[tokio::test]
async fn arrangement_implementer_fork_keeps_worker_tool_registry() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());
    engine.state.set_goal_prepared_with_mode(
        "orchestrate implementation",
        None,
        None,
        kcoder_state::GoalMode::Arrangement,
    );
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text("parent user")].into(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };
    let tools = crate::agent::filter_tools_for_agent_kind_in_mode(
        &kcoder_tools::arrangement_subagent_registry(),
        kcoder_tools::AgentKind::Implementer,
        true,
        true,
    );

    let result = crate::agent::continue_forked_agent_with_tools(
        &engine,
        &cache_safe,
        crate::agent::ForkedAgentRequest {
            agent_id: Some("agent-implementer".to_string()),
            messages: vec![Message::user_text("make the scoped edit")],
            prompt_message_count: 1,
            initial_delivery: None,
            overrides: crate::agent::SubagentContextOverrides {
                share_abort_controller: true,
                allowed_write_paths: vec!["src/parser.rs".to_string()],
                arrangement_mode: Some(true),
                ..crate::agent::SubagentContextOverrides::default()
            },
            max_turns: 10,
            tools,
            runtime: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.output_text, "hi");

    let req = request
        .lock()
        .unwrap()
        .take()
        .expect("provider did not receive request");
    let tool_names = req
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<std::collections::HashSet<_>>();
    assert!(tool_names.contains("edit"));
    assert!(tool_names.contains("write"));
    assert!(tool_names.contains(if cfg!(windows) { "PowerShell" } else { "bash" }));
    assert!(!tool_names.contains("PlanAgent"));
    assert!(!tool_names.contains("WriteReport"));
    assert!(!tool_names.contains("EditPlan"));
    assert!(
        !req.system
            .as_deref()
            .unwrap_or_default()
            .contains("main agent is an orchestrator")
    );
}

#[tokio::test]
async fn arrangement_agent_runner_starts_with_worker_prompt_not_parent_goal_context() {
    use kcoder_tools::AgentRunner as _;

    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());
    let project_dir = tmp.path().join("kcoder/projects/_tmp_project");
    engine
        .state
        .with_history_path(project_dir.join("session-1.jsonl"));
    engine.state.set_goal_prepared_with_mode(
        "main orchestrator objective",
        None,
        None,
        kcoder_state::GoalMode::Arrangement,
    );
    *engine.last_cache_safe_params.write().unwrap() = Some(crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text(
            "[system] Continue working toward the active `/ultgoal` objective.\n\nArrangement behavior:\n- The main agent coordinates, decomposes, delegates, reviews, and reports.",
        )].into(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    }.into());

    let runner = crate::agent::QueryEngineAgentRunner::new(engine.clone());
    let output = runner
        .run_agent_session_with_options(
            "agent-verifier".to_string(),
            kcoder_tools::AgentKind::Verifier.build_prompt("Run pytest and report results."),
            10,
            kcoder_tools::AgentKind::Verifier,
            kcoder_tools::AgentRunOptions::default().with_arrangement_mode(true),
        )
        .await
        .unwrap();
    assert_eq!(output, "hi");

    let req = request
        .lock()
        .unwrap()
        .take()
        .expect("provider did not receive request");
    assert!(
        req.messages
            .first()
            .is_some_and(|m| m.preview(2000).contains("Verifier sub-agent")),
        "first message should be the worker role prompt: {:?}",
        req.messages
    );
    assert!(
        req.messages
            .iter()
            .all(|m| !m.preview(2000).contains("main agent coordinates")),
        "arrangement worker request leaked parent orchestrator context: {:?}",
        req.messages
    );
    assert!(
        req.system.as_deref().is_some_and(
            |prompt| prompt.contains("## Sub-agent role") && prompt.contains("Verifier")
        ),
        "verifier identity must be enforced in the system prompt: {:?}",
        req.system
    );

    let transcript_path = engine.state.subagent_transcript_path("agent-verifier");
    assert!(
        transcript_path.exists(),
        "subagent transcript should be written to {:?}",
        transcript_path
    );
    assert_eq!(
        transcript_path,
        project_dir
            .join("session-1")
            .join("subagents")
            .join("agent-verifier")
            .join("transcript.json")
    );

    assert!(
        engine
            .flush_workspace_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    let llm_dir = engine
        .state
        .subagent_llm_request_history_dir("agent-verifier");
    let mut files = std::fs::read_dir(&llm_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(
        files.len(),
        1,
        "subagent raw exchange should be isolated in {:?}",
        llm_dir
    );
    let record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&files[0]).unwrap()).unwrap();
    assert_eq!(record["session_id"], "session-1");
    assert_eq!(
        record["request"]["model"].as_str(),
        Some(req.model.as_str())
    );
}

#[tokio::test]
async fn forked_agent_ignores_parent_unmatched_tool_use() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());

    // Parent live state contains the assistant tool_use that triggered the
    // subagent, but no matching tool_result yet.
    engine
        .state
        .add_message(Message::user_text("parent request"));
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "agent_call_1".to_string(),
            name: "spawn_agent".to_string(),
            input: serde_json::json!({"description": "explore"}),
        }],
        usage: None,
    });

    // The cache-safe snapshot was captured before that assistant message,
    // so it must not include the unmatched tool_use.
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent request")].into(),
            active_skills: vec![],
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    engine
        .run_forked_agent(
            vec![Message::user_text("subagent prompt")],
            crate::agent::SubagentContextOverrides::default(),
            10,
        )
        .await
        .unwrap();

    let req = request
        .lock()
        .unwrap()
        .take()
        .expect("provider did not receive request");
    // The fork must start from the snapshot, not the live parent state.
    assert!(
        req.messages.iter().all(|m| match m {
            Message::Assistant { content, .. } => !content
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. })),
            _ => true,
        }),
        "forked request contains unmatched tool_use from parent state: {:?}",
        req.messages
    );
    assert!(
        req.messages
            .iter()
            .any(|m| m.preview(100).contains("subagent prompt"))
    );
}
