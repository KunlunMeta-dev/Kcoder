use super::*;

#[tokio::test]
async fn running_subagent_applies_queued_delivery_before_final_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_response_started = Arc::new(Notify::new());
    let release_first_response = Arc::new(Notify::new());
    let provider = Arc::new(GatedSubagentSteerProvider {
        requests: Arc::clone(&requests),
        calls: AtomicUsize::new(0),
        first_response_started: Arc::clone(&first_response_started),
        release_first_response: Arc::clone(&release_first_response),
    });
    let engine = test_engine(provider, tmp.path());
    let agent_id = "live-steer-agent";
    let transcript_path = tmp.path().join("live-steer-transcript.json");
    let mut task = Task::new(agent_id, "General agent: live steering regression");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    engine.state.upsert_task(task);
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let running_engine = engine.clone();
    let running_cache = cache_safe.clone();
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &running_engine,
            &running_cache,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(agent_id.to_string()),
                messages: vec![Message::user_text("start delegated work")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });

    first_response_started.notified().await;
    let receipt = engine
        .state
        .enqueue_subagent_delivery(agent_id, "change course while still running")
        .unwrap()
        .expect("running agent must accept the steer");
    release_first_response.notify_one();

    let result = run.await.unwrap().unwrap();
    assert_eq!(result.output_text, "after steer");
    {
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            2,
            "steer must force a second Provider round"
        );
        assert!(!request_preview(&requests[0]).contains("change course while still running"));
        assert!(request_preview(&requests[1]).contains("change course while still running"));
    }

    let task = engine.state.task(agent_id).unwrap();
    assert!(
        task.message_queue.is_empty(),
        "applied steer must be acknowledged"
    );
    let transcript: Vec<Message> = serde_json::from_slice(
        &tokio::fs::read(&transcript_path)
            .await
            .expect("live steer transcript checkpoint"),
    )
    .unwrap();
    assert_eq!(
        transcript
            .iter()
            .filter(|message| message
                .preview(2_000)
                .contains("change course while still running"))
            .count(),
        1,
        "message {} must be persisted exactly once",
        receipt.message_id
    );
}

#[tokio::test]
async fn child_live_view_exposes_text_before_durable_checkpoint_and_cleans_up() {
    #[derive(Debug)]
    struct StreamingProbe {
        emitted: Arc<Notify>,
        release: Arc<Notify>,
    }
    impl Provider for StreamingProbe {
        fn name(&self) -> &'static str {
            "live-view-probe"
        }
        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
            let emitted = self.emitted.clone();
            let release = self.release.clone();
            Ok(Box::pin(async_stream::stream! {
                yield Ok(StreamEvent::ContentBlockStart { index: 0, content_block: ContentBlock::Text { text: String::new() } });
                yield Ok(StreamEvent::ContentBlockDelta { index: 0, delta: ContentDelta::TextDelta { text: "LIVE_CHILD_SENTINEL".into() } });
                emitted.notify_one();
                release.notified().await;
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            }))
        }
    }
    let tmp = tempfile::tempdir().unwrap();
    let emitted = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let engine = test_engine(
        Arc::new(StreamingProbe {
            emitted: emitted.clone(),
            release: release.clone(),
        }),
        tmp.path(),
    );
    let id = "live-view-child";
    let transcript = tmp.path().join("child.json");
    let mut task = Task::new(id, "General agent: live view");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript.clone());
    engine.state.upsert_task(task);
    let cache = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };
    let worker = engine.clone();
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &worker,
            &cache,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(id.into()),
                messages: vec![Message::user_text("child task")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: Default::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(10), emitted.notified())
        .await
        .unwrap();
    let snapshot = engine
        .subagent_live_snapshot(id, None)
        .expect("live data before MessageStop");
    assert_eq!(snapshot.pending_text, "LIVE_CHILD_SENTINEL");
    assert!(
        !std::fs::read_to_string(&transcript)
            .unwrap()
            .contains("LIVE_CHILD_SENTINEL")
    );
    assert!(
        !engine
            .state
            .messages()
            .iter()
            .any(|m| m.preview(2000).contains("LIVE_CHILD_SENTINEL"))
    );
    assert!(engine.subagent_live_snapshot("sibling", None).is_none());
    release.notify_one();
    run.await.unwrap().unwrap();
    assert!(!engine.has_subagent_live_view(id));
    assert!(
        std::fs::read_to_string(transcript)
            .unwrap()
            .contains("LIVE_CHILD_SENTINEL")
    );
}

#[tokio::test]
async fn checkpoint_failure_rolls_back_child_and_requeues_delivery_for_exactly_once_retry() {
    let tmp = tempfile::tempdir().unwrap();
    let parent = test_engine(
        Arc::new(RecordingProvider {
            name: "checkpoint-failure-parent",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    );
    let agent_id = "checkpoint-failure-agent";
    let transcript_path = tmp.path().join("checkpoint-failure-transcript.json");
    let mut task = Task::new(agent_id, "General agent: checkpoint failure");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(parent.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    parent.state.upsert_task(task);
    let receipt = parent
        .state
        .enqueue_subagent_delivery(agent_id, "retry-after-checkpoint-failure")
        .unwrap()
        .unwrap();
    let original = vec![Message::user_text("original child context")];

    let failing_child = with_subagent_checkpoint_writer(
        test_engine(
            Arc::new(RecordingProvider {
                name: "checkpoint-failure-child",
                request: Arc::new(Mutex::new(None)),
            }),
            tmp.path(),
        )
        .with_subagent_runtime_control(
            parent.state.clone(),
            agent_id.to_string(),
            transcript_path.clone(),
        ),
        Arc::new(FailBeforeCheckpointWriter),
    );
    failing_child.state.set_messages(original.clone());

    let error = failing_child
        .apply_pending_subagent_deliveries_at_safe_boundary()
        .await
        .unwrap_err();
    assert!(error.to_string().contains("injected checkpoint failure"));
    assert_eq!(failing_child.state.messages(), original);
    assert!(!transcript_path.exists());
    let queued = parent.state.task(agent_id).unwrap().message_queue;
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].message_id, receipt.message_id);
    assert_eq!(queued[0].status, kcoder_state::AgentMessageStatus::Queued);
    assert!(queued[0].transcript_anchor.is_some());

    let retry_child = test_engine(
        Arc::new(RecordingProvider {
            name: "checkpoint-retry-child",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    )
    .with_subagent_runtime_control(
        parent.state.clone(),
        agent_id.to_string(),
        transcript_path.clone(),
    );
    retry_child.state.set_messages(original);
    let applied = retry_child
        .apply_pending_subagent_deliveries_at_safe_boundary()
        .await
        .unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].message_id, receipt.message_id);
    assert!(
        parent
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );
    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    assert_eq!(
        transcript
            .iter()
            .filter(|message| message
                .preview(2_000)
                .contains("retry-after-checkpoint-failure"))
            .count(),
        1
    );
}

#[tokio::test]
async fn resume_after_checkpoint_before_ack_crash_does_not_duplicate_delivery() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("checkpoint-before-ack.jsonl");
    let parent = test_engine(
        Arc::new(RecordingProvider {
            name: "checkpoint-crash-parent",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    );
    parent.state.with_history_path(&history_path);
    parent
        .state
        .add_message(Message::user_text("persist parent session"));
    parent.state.save_history().unwrap();
    let agent_id = "checkpoint-before-ack-agent";
    let transcript_path = tmp.path().join("checkpoint-before-ack-transcript.json");
    let mut task = Task::new(agent_id, "General agent: checkpoint before ack");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(parent.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    parent.state.upsert_task(task);
    let receipt = parent
        .state
        .enqueue_subagent_delivery(agent_id, "resume-without-duplicate")
        .unwrap()
        .unwrap();
    let original = vec![Message::user_text("original child context")];

    let crashing_child = with_subagent_checkpoint_writer(
        test_engine(
            Arc::new(RecordingProvider {
                name: "checkpoint-crash-child",
                request: Arc::new(Mutex::new(None)),
            }),
            tmp.path(),
        )
        .with_subagent_runtime_control(
            parent.state.clone(),
            agent_id.to_string(),
            transcript_path.clone(),
        ),
        Arc::new(CrashAfterCheckpointWriter),
    );
    crashing_child.state.set_messages(original);
    let crashed = tokio::spawn(async move {
        crashing_child
            .apply_pending_subagent_deliveries_at_safe_boundary()
            .await
    })
    .await;
    assert!(crashed.unwrap_err().is_panic());
    let leased = parent.state.task(agent_id).unwrap().message_queue;
    assert_eq!(leased.len(), 1);
    assert_eq!(leased[0].status, kcoder_state::AgentMessageStatus::Leased);
    assert!(leased[0].transcript_anchor.is_some());

    let resumed_parent = kcoder_state::AppState::new(tmp.path());
    resumed_parent.resume_from_history(&history_path).unwrap();
    let mut resumed_task = resumed_parent.task(agent_id).unwrap();
    resumed_task.accepting_subagent_messages = true;
    resumed_task.parent_session_id = Some(resumed_parent.session_id());
    // A resumed worker needs a newly admitted durable run, not just a status
    // edit on the interrupted run whose command acknowledgements are fenced.
    let resumed_run = resumed_parent
        .start_background_task_run(resumed_task)
        .unwrap();
    assert_eq!(
        resumed_parent
            .background_run_record(&resumed_run)
            .unwrap()
            .status,
        kcoder_state::TaskStatus::Running
    );
    let recovered = resumed_parent.task(agent_id).unwrap();
    assert_eq!(recovered.message_queue.len(), 1);
    assert_eq!(
        recovered.message_queue[0].status,
        kcoder_state::AgentMessageStatus::Queued
    );

    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    let resumed_child = test_engine(
        Arc::new(RecordingProvider {
            name: "checkpoint-resume-child",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    )
    .with_subagent_runtime_control(
        resumed_parent.clone(),
        agent_id.to_string(),
        transcript_path.clone(),
    );
    resumed_child.state.set_messages(transcript);
    let applied = resumed_child
        .apply_pending_subagent_deliveries_at_safe_boundary()
        .await
        .unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].message_id, receipt.message_id);
    assert!(
        resumed_parent
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );
    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    assert_eq!(
        transcript
            .iter()
            .filter(|message| message.preview(2_000).contains("resume-without-duplicate"))
            .count(),
        1
    );
}

#[tokio::test]
async fn running_subagent_waits_for_complete_parallel_tool_batch_before_applying_steer() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let tool_started = Arc::new(Notify::new());
    let release_tool = Arc::new(Notify::new());
    let engine = test_engine(
        Arc::new(ToolThenSteerProvider {
            requests: Arc::clone(&requests),
            calls: AtomicUsize::new(0),
        }),
        tmp.path(),
    );
    let agent_id = "tool-boundary-steer-agent";
    let transcript_path = tmp.path().join("tool-boundary-steer-transcript.json");
    let mut task = Task::new(agent_id, "General agent: tool boundary steering");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    engine.state.upsert_task(task);
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let running_engine = engine.clone();
    let wait_started = Arc::clone(&tool_started);
    let wait_release = Arc::clone(&release_tool);
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &running_engine,
            &cache_safe,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(agent_id.to_string()),
                messages: vec![Message::user_text("run the gated tool")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides {
                    permission_mode_if_parent_asks: Some(PermissionMode::Auto),
                    ..crate::agent::SubagentContextOverrides::default()
                },
                max_turns: 10,
                tools: ToolRegistry::new()
                    .register(GatedSteerTool {
                        started: wait_started,
                        release: wait_release,
                    })
                    .register(FailingSteerTool),
                runtime: None,
            },
        )
        .await
    });

    tool_started.notified().await;
    engine
        .state
        .enqueue_subagent_delivery(agent_id, "steer after the tool result")
        .unwrap()
        .unwrap();
    assert!(!run.is_finished(), "steer must not cancel the active tool");
    release_tool.notify_one();

    let result = run.await.unwrap().unwrap();
    assert_eq!(result.output_text, "after tool steer");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!request_preview(&requests[0]).contains("steer after the tool result"));
    let second = requests[1]
        .messages
        .iter()
        .map(|message| message.preview(4_000))
        .collect::<Vec<_>>();
    let successful_tool_result = second
        .iter()
        .position(|message| message.contains("tool completed before steer"))
        .expect("complete ToolResult must be present");
    let failed_tool_result = requests[1]
        .messages
        .iter()
        .position(|message| {
            matches!(message, Message::User { content, .. } if content.iter().any(|block| {
                matches!(block, ContentBlock::ToolResult { tool_use_id, is_error: Some(true), .. } if tool_use_id == "steer-tool-2")
            }))
        })
        .expect("failed parallel ToolResult must be present");
    let steer = second
        .iter()
        .position(|message| message.contains("steer after the tool result"))
        .expect("steer must be present in the next request");
    assert!(
        successful_tool_result < steer && failed_tool_result < steer,
        "steer must follow every successful and failed ToolResult in the batch"
    );
    assert!(
        engine
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );
}

#[tokio::test]
async fn live_steer_drain_is_fifo_and_bounded_per_provider_round() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_response_started = Arc::new(Notify::new());
    let release_first_response = Arc::new(Notify::new());
    let engine = test_engine(
        Arc::new(GatedSubagentSteerProvider {
            requests: Arc::clone(&requests),
            calls: AtomicUsize::new(0),
            first_response_started: Arc::clone(&first_response_started),
            release_first_response: Arc::clone(&release_first_response),
        }),
        tmp.path(),
    );
    let agent_id = "bounded-live-steer-agent";
    let transcript_path = tmp.path().join("bounded-live-steer-transcript.json");
    let mut task = Task::new(agent_id, "General agent: bounded live steering");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    engine.state.upsert_task(task);
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let running_engine = engine.clone();
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &running_engine,
            &cache_safe,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(agent_id.to_string()),
                messages: vec![Message::user_text("start bounded delivery test")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });

    first_response_started.notified().await;
    for index in 0..20 {
        engine
            .state
            .enqueue_subagent_delivery(agent_id, format!("bounded-steer-{index:02}"))
            .unwrap()
            .unwrap();
    }
    release_first_response.notify_one();

    run.await.unwrap().unwrap();
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        let second = request_preview(&requests[1]);
        let third = request_preview(&requests[2]);
        for index in 0..16 {
            assert!(second.contains(&format!("bounded-steer-{index:02}")));
        }
        for index in 16..20 {
            let message = format!("bounded-steer-{index:02}");
            assert!(!second.contains(&message));
            assert!(third.contains(&message));
        }
    }
    assert!(
        engine
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );
    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    let user_text = transcript
        .iter()
        .map(|message| message.preview(4_000))
        .collect::<Vec<_>>();
    for index in 0..20 {
        let message = format!("bounded-steer-{index:02}");
        assert_eq!(
            user_text
                .iter()
                .filter(|candidate| candidate.contains(&message))
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn targeted_live_steer_does_not_reach_sibling_or_parent() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let both_first_requests_started = Arc::new(Notify::new());
    let release_first_requests = Arc::new(Notify::new());
    let engine = test_engine(
        Arc::new(TwoAgentSteerProvider {
            requests: Arc::clone(&requests),
            first_requests_started: AtomicUsize::new(0),
            both_first_requests_started: Arc::clone(&both_first_requests_started),
            release_first_requests: Arc::clone(&release_first_requests),
        }),
        tmp.path(),
    );
    for agent_id in ["agent-a", "agent-b"] {
        let mut task = Task::new(agent_id, format!("General agent: {agent_id}"));
        task.kind = kcoder_state::TaskKind::Subagent;
        task.managed = true;
        task.status = kcoder_state::TaskStatus::Running;
        task.parent_session_id = Some(engine.state.session_id());
        task.transcript_path = Some(tmp.path().join(format!("{agent_id}-transcript.json")));
        engine.state.upsert_task(task);
    }
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let engine_a = engine.clone();
    let cache_a = cache_safe.clone();
    let run_a = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &engine_a,
            &cache_a,
            crate::agent::ForkedAgentRequest {
                agent_id: Some("agent-a".to_string()),
                messages: vec![Message::user_text("agent-a-start")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });
    let engine_b = engine.clone();
    let run_b = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &engine_b,
            &cache_safe,
            crate::agent::ForkedAgentRequest {
                agent_id: Some("agent-b".to_string()),
                messages: vec![Message::user_text("agent-b-start")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });

    both_first_requests_started.notified().await;
    engine
        .state
        .enqueue_subagent_delivery("agent-b", "target-only-steer-sentinel")
        .unwrap()
        .unwrap();
    release_first_requests.notify_waiters();

    let result_a = run_a.await.unwrap().unwrap();
    let result_b = run_b.await.unwrap().unwrap();
    assert_eq!(result_a.output_text, "initial child response");
    assert_eq!(result_b.output_text, "target adjusted");
    let request_previews = requests
        .lock()
        .unwrap()
        .iter()
        .map(request_preview)
        .collect::<Vec<_>>();
    assert_eq!(
        request_previews
            .iter()
            .filter(|request| request.contains("target-only-steer-sentinel"))
            .count(),
        1
    );
    assert!(request_previews.iter().all(|request| {
        !(request.contains("agent-a-start") && request.contains("target-only-steer-sentinel"))
    }));
    assert!(engine.state.messages().iter().all(|message| {
        !message
            .preview(2_000)
            .contains("target-only-steer-sentinel")
    }));
    let transcript_a: Vec<Message> = serde_json::from_slice(
        &tokio::fs::read(tmp.path().join("agent-a-transcript.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(transcript_a.iter().all(|message| {
        !message
            .preview(2_000)
            .contains("target-only-steer-sentinel")
    }));
}

#[tokio::test]
async fn continued_subagent_acknowledges_initial_delivery_before_live_steer() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_response_started = Arc::new(Notify::new());
    let release_first_response = Arc::new(Notify::new());
    let provider = Arc::new(GatedSubagentSteerProvider {
        requests: Arc::clone(&requests),
        calls: AtomicUsize::new(0),
        first_response_started: Arc::clone(&first_response_started),
        release_first_response: Arc::clone(&release_first_response),
    });
    let engine = test_engine(provider, tmp.path());
    let agent_id = "continued-live-steer-agent";
    let transcript_path = tmp.path().join("continued-live-steer-transcript.json");
    let mut task = Task::new(
        agent_id,
        "General agent: continued live steering regression",
    );
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    engine.state.upsert_task(task);

    let mut messages = vec![Message::user_text("original delegated context")];
    let initial_receipt = engine
        .state
        .enqueue_subagent_delivery(agent_id, "initial continuation message")
        .unwrap()
        .unwrap();
    let initial_claim = engine
        .state
        .claim_next_subagent_delivery(agent_id, 120, 8)
        .unwrap();
    let kcoder_state::AgentDeliveryClaimOutcome::Claimed(initial_claim) = initial_claim else {
        panic!("expected the initial continuation claim")
    };
    let baseline_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&messages).unwrap())
    );
    engine
        .state
        .prepare_subagent_delivery(
            agent_id,
            &initial_claim.message_id,
            &initial_claim.lease_id,
            kcoder_state::TranscriptDeliveryAnchor {
                baseline_message_count: messages.len(),
                baseline_sha256,
                body_sha256: format!("{:x}", Sha256::digest(initial_claim.body.as_bytes())),
            },
        )
        .unwrap();
    messages.push(Message::user_text(initial_claim.body.clone()));
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let running_engine = engine.clone();
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &running_engine,
            &cache_safe,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(agent_id.to_string()),
                messages,
                prompt_message_count: 1,
                initial_delivery: Some(kcoder_tools::AgentDeliveryContext {
                    message_id: initial_claim.message_id,
                    lease_id: initial_claim.lease_id,
                }),
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });

    first_response_started.notified().await;
    assert!(
        engine
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty(),
        "initial delivery must be acknowledged before the Provider stream starts"
    );
    let second_receipt = engine
        .state
        .enqueue_subagent_delivery(agent_id, "second message during continuation")
        .unwrap()
        .unwrap();
    release_first_response.notify_one();

    let result = run.await.unwrap().unwrap();
    assert_eq!(result.output_text, "after steer");
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(request_preview(&requests[0]).contains("initial continuation message"));
        assert!(!request_preview(&requests[0]).contains("second message during continuation"));
        assert!(request_preview(&requests[1]).contains("second message during continuation"));
    }
    assert!(
        engine
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );

    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    for (message_id, body) in [
        (initial_receipt.message_id, "initial continuation message"),
        (
            second_receipt.message_id,
            "second message during continuation",
        ),
    ] {
        assert_eq!(
            transcript
                .iter()
                .filter(|message| message.preview(2_000).contains(body))
                .count(),
            1,
            "message {message_id} must be persisted exactly once"
        );
    }
}

#[tokio::test]
async fn send_message_repairs_legacy_unmatched_tool_use_before_provider_request() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());
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

    let agent_id = "legacy-unmatched-tool";
    let transcript_path = engine.state.subagent_transcript_path(agent_id);
    let legacy_messages = vec![
        Message::user_text("inspect the file"),
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "legacy-tool-use".to_string(),
                name: "read".to_string(),
                input: serde_json::json!({"file_path": "src/lib.rs"}),
            }],
            usage: None,
        },
    ];
    if let Some(parent) = transcript_path.parent() {
        tokio::fs::create_dir_all(parent).await.unwrap();
    }
    tokio::fs::write(
        &transcript_path,
        serde_json::to_vec(&legacy_messages).unwrap(),
    )
    .await
    .unwrap();
    let mut task = Task::new(agent_id, "General agent: legacy transcript");
    task.kind = TaskKind::Subagent;
    task.transcript_path = Some(transcript_path.clone());
    task.agent_provider = Some(engine.provider_name());
    task.agent_model = Some(engine.model_name());
    engine.state.upsert_task(task);

    let runner = crate::agent::QueryEngineAgentRunner::new(engine.clone());
    let output = runner
        .send_message_to_agent_with_options(
            agent_id.to_string(),
            "continue safely".to_string(),
            10,
            kcoder_tools::AgentKind::General,
            kcoder_tools::AgentRunOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(output, "hi");

    let provider_request = request.lock().unwrap().take().unwrap();
    assert!(!repair_tool_message_sequence(provider_request.messages.to_vec()).1);
    assert!(provider_request.messages.iter().any(|message| {
        matches!(
            message,
            Message::User { content, .. }
                if content.iter().any(|block| matches!(
                    block,
                    ContentBlock::ToolResult { tool_use_id, .. }
                        if tool_use_id == "legacy-tool-use"
                ))
        )
    }));
    let persisted: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    assert!(!repair_tool_message_sequence(persisted).1);
}

#[tokio::test]
async fn artifact_requirements_direct_runner_persists_restores_and_rejects_before_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let engine = test_engine(
        Arc::new(RecordingProvider {
            name: "recording",
            request: request.clone(),
        }),
        tmp.path(),
    );
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
    let runner = crate::agent::QueryEngineAgentRunner::new(engine.clone());
    let requirement: kcoder_state::ArtifactRequirement =
        serde_json::from_value(serde_json::json!({"path":"report.md"})).unwrap();
    let options = kcoder_tools::AgentRunOptions::default()
        .with_artifact_requirements(vec![requirement.clone()]);
    let mut invalid = options.clone();
    invalid.artifact_requirements[0].path.clear();
    let error = runner
        .run_agent_session_with_options(
            "invalid-artifact".into(),
            "test".into(),
            1,
            kcoder_tools::AgentKind::General,
            invalid,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("artifact_requirements"));
    assert!(engine.state.task("invalid-artifact").is_none());
    assert!(
        !engine
            .state
            .subagent_transcript_path("invalid-artifact")
            .exists()
    );
    assert!(request.lock().unwrap().is_none());

    let agent_id = "typed-artifact-runner";
    engine
        .state
        .upsert_task(Task::new("empty-artifact-task", "legacy"));
    let error = runner
        .run_agent_session_with_options(
            "empty-artifact-task".into(),
            "test".into(),
            1,
            kcoder_tools::AgentKind::General,
            options.clone(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("conflict with persisted"));
    assert!(
        engine
            .state
            .task("empty-artifact-task")
            .unwrap()
            .artifact_requirements
            .is_empty()
    );
    assert!(request.lock().unwrap().is_none());
    runner
        .run_agent_session_with_options(
            agent_id.into(),
            "produce report.md".into(),
            10,
            kcoder_tools::AgentKind::General,
            options.clone(),
        )
        .await
        .unwrap();
    let task = engine.state.task(agent_id).unwrap();
    assert_eq!(task.artifact_requirements, vec![requirement.clone()]);
    let restored: Task = serde_json::from_value(serde_json::to_value(&task).unwrap()).unwrap();
    engine.state.upsert_task(restored);
    request.lock().unwrap().take();
    let before = tokio::fs::read(engine.state.subagent_transcript_path(agent_id))
        .await
        .unwrap();
    let mut conflicting = options;
    conflicting.artifact_requirements[0].path = "expanded.md".into();
    let error = runner
        .send_message_to_agent_with_options(
            agent_id.into(),
            "continue".into(),
            10,
            kcoder_tools::AgentKind::General,
            conflicting,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("conflict with persisted"));
    assert!(request.lock().unwrap().is_none());
    assert_eq!(
        tokio::fs::read(engine.state.subagent_transcript_path(agent_id))
            .await
            .unwrap(),
        before
    );
    runner
        .send_message_to_agent_with_options(
            agent_id.into(),
            "continue".into(),
            10,
            kcoder_tools::AgentKind::General,
            kcoder_tools::AgentRunOptions::default(),
        )
        .await
        .unwrap();
    assert!(request.lock().unwrap().is_some());
    assert_eq!(
        engine.state.task(agent_id).unwrap().artifact_requirements,
        vec![requirement]
    );
    assert!(!tmp.path().join("report.md").exists());
    engine
        .state
        .with_history_path(tmp.path().join("artifact-durable.jsonl"));
    let sidecar = engine.state.session_state_path().unwrap();
    std::fs::remove_file(&sidecar).unwrap();
    std::fs::create_dir(&sidecar).unwrap();
    request.lock().unwrap().take();
    let options = kcoder_tools::AgentRunOptions::default()
        .with_artifact_requirements(engine.state.task(agent_id).unwrap().artifact_requirements);
    let error = runner
        .run_agent_session_with_options(
            "artifact-write-failure".into(),
            "test".into(),
            1,
            kcoder_tools::AgentKind::General,
            options,
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("failed to bind artifact declarations")
    );
    assert!(request.lock().unwrap().is_none());
    assert!(
        engine
            .state
            .task("artifact-write-failure")
            .unwrap()
            .artifact_requirements
            .is_empty()
    );
    assert!(
        !engine
            .state
            .subagent_transcript_path("artifact-write-failure")
            .exists()
    );
}

#[tokio::test]
async fn cancelling_fork_during_tool_execution_persists_matched_tool_result() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(Arc::new(ToolUseProvider), tmp.path());
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };
    let agent_id = "cancel-during-tool".to_string();
    let cancel = CancellationToken::new();
    let cancel_later = cancel.clone();
    let tool_started = Arc::new(Notify::new());
    let cancel_after_tool_started = Arc::clone(&tool_started);
    tokio::spawn(async move {
        cancel_after_tool_started.notified().await;
        cancel_later.cancel();
    });

    let error = crate::agent::continue_forked_agent_with_tools(
        &engine,
        &cache_safe,
        crate::agent::ForkedAgentRequest {
            agent_id: Some(agent_id.clone()),
            messages: vec![Message::user_text("run the read")],
            prompt_message_count: 1,
            initial_delivery: None,
            overrides: crate::agent::SubagentContextOverrides {
                abort_token: Some(cancel),
                permission_mode_if_parent_asks: Some(PermissionMode::Auto),
                ..crate::agent::SubagentContextOverrides::default()
            },
            max_turns: 10,
            tools: ToolRegistry::new().register(HangingReadTool {
                started: tool_started,
            }),
            runtime: None,
        },
    )
    .await
    .expect_err("cancelled tool execution must return a typed abort");
    assert!(error.to_string().contains("cancelled by user"));

    let transcript_path = engine.state.subagent_transcript_path(&agent_id);
    let messages: Vec<Message> = serde_json::from_slice(
        &tokio::fs::read(&transcript_path)
            .await
            .expect("cancelled transcript checkpoint"),
    )
    .expect("valid transcript JSON");
    let (repaired, changed) = repair_tool_message_sequence(messages.clone());
    assert!(
        !changed,
        "checkpoint still needed tool-protocol repair: {repaired:?}"
    );
    assert!(messages.iter().any(|message| {
        message
            .preview(2_000)
            .contains("Tool call was interrupted by the user")
    }));
}

#[tokio::test]
async fn projection_review_stale_v2_survives_new_private_checkpoint() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(
        Arc::new(RecordingProvider {
            name: "projection-review",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    );
    let id = "projection-review-stale";
    let mut task = Task::new(id, "projection review fixture");
    task.kind = TaskKind::Subagent;
    task.parent_session_id = Some(engine.session_id());
    engine.state.upsert_task(task);
    let path = engine.state.subagent_transcript_path(id);
    let previous = vec![Message::user_text("old public checkpoint")];
    crate::agent::write_transcript_checkpoint(&path, &previous)
        .await
        .unwrap();
    let newer = vec![Message::user_text("new private checkpoint")];
    // The owned private write completed, but its async owner was cancelled
    // before the dependent public projection (or that projection failed).
    drop(
        crate::managed_artifacts::write(&path, serde_json::to_vec_pretty(&newer).unwrap())
            .await
            .unwrap(),
    );
    engine.ensure_public_subagent_transcript(id).unwrap();
    let actual = std::fs::read(path.with_extension("public.txt")).unwrap();
    assert_eq!(
        actual,
        crate::subagent_boundary_runtime::public_subagent_transcript(&newer).unwrap(),
        "a format-current public file still needs freshness recovery"
    );
}

#[tokio::test]
async fn projection_review_keeps_live_public_ahead_of_private() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(
        Arc::new(RecordingProvider {
            name: "projection-review",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    );
    let id = "projection-review-ahead";
    let mut task = Task::new(id, "projection review fixture");
    task.kind = TaskKind::Subagent;
    task.parent_session_id = Some(engine.session_id());
    engine.state.upsert_task(task);
    let path = engine.state.subagent_transcript_path(id);
    let checkpoint = vec![Message::user_text("checkpoint baseline")];
    crate::agent::write_transcript_checkpoint(&path, &checkpoint)
        .await
        .unwrap();
    let mut live = checkpoint;
    live.push(Message::user_text("completed safe-boundary live progress"));
    crate::subagent_boundary_runtime::write_public_subagent_transcript(&path, &live).unwrap();
    let expected = std::fs::read(path.with_extension("public.txt")).unwrap();
    engine.ensure_public_subagent_transcript(id).unwrap();
    assert_eq!(
        std::fs::read(path.with_extension("public.txt")).unwrap(),
        expected,
        "a direct safe-boundary projection must not regress to its private baseline"
    );
}

#[tokio::test]
async fn projection_review_keeps_live_extension_after_partial_private_advance() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(
        Arc::new(RecordingProvider {
            name: "projection-review",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    );
    let id = "projection-review-partial-advance";
    let mut task = Task::new(id, "projection review fixture");
    task.kind = TaskKind::Subagent;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(engine.session_id());
    engine.state.upsert_task(task);
    let path = engine.state.subagent_transcript_path(id);
    let checkpoint = vec![Message::user_text("checkpoint baseline")];
    crate::agent::write_transcript_checkpoint(&path, &checkpoint)
        .await
        .unwrap();
    let mut advanced = checkpoint;
    advanced.push(Message::user_text("next completed message"));
    let mut live = advanced.clone();
    live.push(Message::user_text(
        "latest completed safe-boundary progress",
    ));
    crate::subagent_boundary_runtime::write_public_subagent_transcript(&path, &live).unwrap();
    let expected = std::fs::read(path.with_extension("public.txt")).unwrap();
    drop(
        crate::managed_artifacts::write(&path, serde_json::to_vec_pretty(&advanced).unwrap())
            .await
            .unwrap(),
    );
    engine.ensure_public_subagent_transcript(id).unwrap();
    assert_eq!(
        std::fs::read(path.with_extension("public.txt")).unwrap(),
        expected
    );
    engine
        .state
        .update_task(id, |task| task.status = kcoder_state::TaskStatus::Completed);
    engine.ensure_public_subagent_transcript(id).unwrap();
    assert_eq!(
        std::fs::read(path.with_extension("public.txt")).unwrap(),
        crate::subagent_boundary_runtime::public_subagent_transcript(&advanced).unwrap()
    );
}

#[tokio::test]
async fn projection_review_running_empty_visible_checkpoint_does_not_keep_old_progress() {
    for newer in [
        Vec::new(),
        vec![Message::runtime_text("private runtime only")],
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(
            Arc::new(RecordingProvider {
                name: "projection-review",
                request: Arc::new(Mutex::new(None)),
            }),
            tmp.path(),
        );
        let id = "projection-review-empty";
        let mut task = Task::new(id, "projection review fixture");
        task.kind = TaskKind::Subagent;
        task.status = kcoder_state::TaskStatus::Running;
        task.parent_session_id = Some(engine.session_id());
        engine.state.upsert_task(task);
        let path = engine.state.subagent_transcript_path(id);
        crate::agent::write_transcript_checkpoint(
            &path,
            &[Message::user_text("old visible progress")],
        )
        .await
        .unwrap();
        drop(
            crate::managed_artifacts::write(&path, serde_json::to_vec_pretty(&newer).unwrap())
                .await
                .unwrap(),
        );
        engine.ensure_public_subagent_transcript(id).unwrap();
        assert_eq!(
            std::fs::read(path.with_extension("public.txt")).unwrap(),
            crate::subagent_boundary_runtime::PUBLIC_TRANSCRIPT_HEADER
        );
    }
}
