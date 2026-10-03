use super::*;

#[derive(Debug)]
struct ExpandingCompactionProvider;

impl Provider for ExpandingCompactionProvider {
    fn name(&self) -> &'static str {
        "expanding-compaction"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let text = format!(
            "<analysis>checked</analysis><summary>{}</summary>",
            "summary expansion ".repeat(2_000)
        );
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-expanding-compaction".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta { text },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct MalformedCompactionProvider;

impl Provider for MalformedCompactionProvider {
    fn name(&self) -> &'static str {
        "malformed-compaction"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-malformed-compaction".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "<analysis>missing summary</analysis>".to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct RepairingCompactionProvider {
    requests: Arc<AtomicUsize>,
}

impl Provider for RepairingCompactionProvider {
    fn name(&self) -> &'static str {
        "repairing-compaction"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let request = self.requests.fetch_add(1, Ordering::SeqCst);
        let text = match request {
            0 => "<analysis>checked</analysis><summary>duplicate <summary>tag</summary>",
            1 => "<analysis>repaired</analysis><summary>compact summary</summary>",
            _ => "main response",
        }
        .to_string();
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: format!("msg-repairing-{request}"),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta { text },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct InvalidTerminalCompactionProvider {
    leave_text_block_open: bool,
}

#[derive(Debug)]
struct SummaryInputRecordingProvider {
    prompts: Arc<std::sync::Mutex<Vec<String>>>,
}

impl Provider for SummaryInputRecordingProvider {
    fn name(&self) -> &'static str {
        "summary-input-recording"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.prompts.lock().unwrap().push(
            request
                .messages
                .iter()
                .map(|message| message.preview(100_000))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-summary-input-recording".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "<analysis>checked</analysis><summary>evidence-preserving summary</summary>".to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

impl Provider for InvalidTerminalCompactionProvider {
    fn name(&self) -> &'static str {
        "invalid-terminal-compaction"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let leave_text_block_open = self.leave_text_block_open;
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-invalid-terminal".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "<analysis>checked</analysis><summary>valid text</summary>".to_string(),
                },
            });
            if !leave_text_block_open {
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            }
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some(if leave_text_block_open {
                        "end_turn".to_string()
                    } else {
                        "max_tokens".to_string()
                    }),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn post_compact_attachments_remain_after_summary_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );

    engine.state.set_messages(vec![
        Message::user_text("large older request ".repeat(300)),
        Message::assistant_text("large older response ".repeat(300)),
        Message::user_text("large middle request ".repeat(300)),
        Message::assistant_text("large middle response ".repeat(300)),
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "old file content ".repeat(80)),
        Message::user_text("recent user request"),
        Message::assistant_text("recent assistant response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(
        result.messages[0]
            .preview(20_000)
            .starts_with(crate::context::compact::COMPACT_BOUNDARY_MARKER)
    );
    assert!(result.messages.iter().skip(1).any(|message| {
        message
            .preview(20_000)
            .contains("Recent file read retained after compaction")
    }));
    assert_eq!(
        latest_compact_boundary(&result.messages)
            .unwrap()
            .suffix_start,
        1
    );
}

#[tokio::test]
async fn full_summary_reads_old_tool_evidence_before_it_is_compacted() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("evidence-order.jsonl");
    let prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let engine = test_engine_with_settings(
        Arc::new(SummaryInputRecordingProvider {
            prompts: Arc::clone(&prompts),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.with_history_path(&history_path);
    let read_path = tmp.path().join("old-read.txt");
    let evidence = format!("UNIQUE_OLD_TOOL_EVIDENCE {}", "detail ".repeat(180));
    engine.state.record_read_tool_snapshot(
        read_path.clone(),
        Some(evidence.clone()),
        None,
        None,
        None,
    );
    engine
        .state
        .record_read_tool_call_key("old-read", read_path.clone(), None, None);
    for message in [
        Message::user_text("old request"),
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", evidence),
        Message::assistant_text("old result inspected"),
        Message::user_text("middle request"),
        Message::assistant_text("middle response"),
        Message::user_text("current request"),
    ] {
        engine.state.add_message(message);
    }

    let result = engine.perform_compaction(true).await.unwrap();

    assert!(result.did_compact);
    let prompts = prompts.lock().unwrap();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains("UNIQUE_OLD_TOOL_EVIDENCE"));
    assert!(!prompts[0].contains(crate::context::TOOL_RESULT_CLEARED_MESSAGE));
    drop(prompts);
    let snapshot = engine.state.file_read_snapshot(&read_path).unwrap();
    assert!(!snapshot.from_read_tool);
    assert!(snapshot.anchor_pending);
    assert!(snapshot.full_body_compacted);
    assert!(
        snapshot
            .content
            .as_deref()
            .is_some_and(|content| content.contains("UNIQUE_OLD_TOOL_EVIDENCE"))
    );
    assert!(latest_compact_boundary(&engine.state.messages()).is_some());

    let persisted = std::fs::read_to_string(&history_path).unwrap();
    let evidence_index = persisted.find("UNIQUE_OLD_TOOL_EVIDENCE").unwrap();
    let boundary_index = persisted.find("compact_boundary").unwrap();
    assert!(evidence_index < boundary_index);

    let restored = kcoder_state::AppState::new(tmp.path());
    restored.with_history_path(tmp.path().join("restored-evidence-order.jsonl"));
    restored.resume_from_history(&history_path).unwrap();
    let restored_visible = restored
        .messages()
        .iter()
        .map(|message| message.preview(100_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(restored_visible.contains("evidence-preserving summary"));
    assert!(!restored_visible.contains("UNIQUE_OLD_TOOL_EVIDENCE"));
}

#[tokio::test]
async fn cold_turn_runs_full_summary_before_time_based_tool_cleanup() {
    let tmp = tempfile::tempdir().unwrap();
    let prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    settings.time_based_micro_compact.gap_threshold_minutes = 0;
    settings.time_based_micro_compact.keep_recent = 1;
    let engine = test_engine_with_settings(
        Arc::new(SummaryInputRecordingProvider {
            prompts: Arc::clone(&prompts),
        }),
        tmp.path(),
        settings,
    );
    let evidence = format!("COLD_TURN_RAW_TOOL_EVIDENCE {}", "detail ".repeat(180));
    for message in [
        Message::user_text("large old request ".repeat(100)),
        assistant_tool_use("cold-old-read", "read"),
        user_tool_result("cold-old-read", evidence),
        Message::assistant_text("large old response ".repeat(100)),
        assistant_tool_use("cold-recent-read", "read"),
        user_tool_result("cold-recent-read", "recent tool output".to_string()),
        Message::user_text("current request"),
    ] {
        engine.state.add_message(message);
    }

    let _events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    let prompts = prompts.lock().unwrap();
    assert!(prompts.len() >= 2, "应先完成摘要，再发起主请求");
    assert!(prompts[0].contains("COLD_TURN_RAW_TOOL_EVIDENCE"));
    assert!(!prompts[0].contains(crate::context::TOOL_RESULT_CLEARED_MESSAGE));
}

#[tokio::test]
async fn actual_large_assistant_usage_is_compacted_before_the_next_request() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(256_000),
        context_output_headroom: Some(100_000),
        estimated_tool_growth_tokens: Some(15_000),
        max_tokens: Some(100_000),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text("old request"),
        Message::Assistant {
            content: vec![ContentBlock::Text {
                text: "large assistant response".to_string(),
            }],
            usage: Some(kcoder_types::Usage {
                input_tokens: 80_000,
                output_tokens: 90_000,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            }),
        },
        Message::user_text("current request must remain verbatim"),
    ]);
    let budget = engine.context_budget();
    assert!(TokenCounter::count(&engine.state.messages()) > budget.hard_input_limit());

    assert!(engine.maybe_compact_conversation(1).await);

    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(TokenCounter::count(&engine.state.messages()) < budget.hard_input_limit());
    let visible = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("current request must remain verbatim"));
    assert!(latest_compact_boundary(&engine.state.messages()).is_some());
}

#[tokio::test]
async fn training_mode_never_starts_automatic_model_compaction() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.training_mode = true;
    settings.context_window_tokens = Some(10_000);
    settings.context_output_headroom = Some(2_000);
    settings.estimated_tool_growth_tokens = Some(1_000);
    settings.max_tokens = Some(2_000);
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text(format!("old request {}", "history ".repeat(8_000))),
        Message::assistant_text(format!("old response {}", "evidence ".repeat(8_000))),
        Message::user_text("current request"),
    ]);

    assert!(!engine.maybe_compact_conversation(1).await);
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
}

#[tokio::test]
async fn non_reducing_compaction_does_not_persist_boundary_or_summary() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("non-reducing-compaction.jsonl");
    let engine = test_engine_with_settings(
        Arc::new(ExpandingCompactionProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.with_history_path(&history_path);
    let original_messages = vec![
        Message::user_text("old user one"),
        Message::assistant_text("old assistant one"),
        Message::user_text("old user two"),
        Message::assistant_text("old assistant two"),
        Message::user_text("old user three"),
        Message::assistant_text("old assistant three"),
        Message::user_text("recent user"),
        Message::assistant_text("recent assistant"),
    ];
    engine.state.set_messages(original_messages.clone());

    let error = engine
        .perform_compaction(true)
        .await
        .expect_err("an expanding summary must fail before persistence");

    assert!(error.to_string().contains("did not reduce context"));
    assert_eq!(engine.state.messages(), original_messages);
    let transcript = std::fs::read_to_string(&history_path).unwrap_or_default();
    assert!(!transcript.contains("\"subtype\":\"compact_boundary\""));
    assert!(!transcript.contains("\"isCompactSummary\":true"));
}

#[tokio::test]
async fn malformed_compaction_does_not_persist_boundary_or_summary() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("malformed-compaction.jsonl");
    let engine = test_engine_with_settings(
        Arc::new(MalformedCompactionProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.with_history_path(&history_path);
    let original_messages = vec![
        Message::user_text("old user one"),
        Message::assistant_text("old assistant one"),
        Message::user_text("old user two"),
        Message::assistant_text("old assistant two"),
        Message::user_text("old user three"),
        Message::assistant_text("old assistant three"),
        Message::user_text("recent user"),
        Message::assistant_text("recent assistant"),
    ];
    engine.state.set_messages(original_messages.clone());

    let error = engine
        .perform_compaction(true)
        .await
        .expect_err("malformed compaction output must fail before persistence");

    assert!(error.to_string().contains("summary"));
    assert_eq!(engine.state.messages(), original_messages);
    let transcript = std::fs::read_to_string(&history_path).unwrap_or_default();
    assert!(!transcript.contains("\"subtype\":\"compact_boundary\""));
    assert!(!transcript.contains("\"isCompactSummary\":true"));
}

#[tokio::test]
async fn repaired_auto_compaction_emits_recovered_without_failed_event() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(RepairingCompactionProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text("old user one ".repeat(100)),
        Message::assistant_text("old assistant one ".repeat(100)),
        Message::user_text("old user two ".repeat(100)),
        Message::assistant_text("old assistant two ".repeat(100)),
        Message::user_text("recent user three ".repeat(100)),
    ]);

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    let recovered = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CompactionRecovered { details } => Some(details),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].phase, "auto_full");
    assert_eq!(recovered[0].reason, "protocol_tag_count");
    assert_eq!(recovered[0].attempt, 1);
    assert!(recovered[0].will_retry);
    assert!(!recovered[0].state_mutated);
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::CompactionFailed { .. }))
    );
    assert_eq!(requests.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn exhausted_auto_compaction_repair_still_emits_failed_event() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine =
        test_engine_with_settings(Arc::new(MalformedCompactionProvider), tmp.path(), settings);
    engine.state.set_messages(vec![
        Message::user_text("old user one ".repeat(100)),
        Message::assistant_text("old assistant one ".repeat(100)),
        Message::user_text("old user two ".repeat(100)),
        Message::assistant_text("old assistant two ".repeat(100)),
        Message::user_text("recent user three ".repeat(100)),
    ]);

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::CompactionFailed { error, details: Some(details) }
            if error.contains("repair budget exhausted")
                && details.reason == "protocol_tag_count"
                && !details.will_retry
    )));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::CompactionRecovered { .. }))
    );
}

#[tokio::test]
async fn invalid_terminal_compactions_never_mutate_state_or_persist() {
    for (case, leave_text_block_open) in [("max-tokens", false), ("unclosed-content-block", true)] {
        let tmp = tempfile::tempdir().unwrap();
        let history_path = tmp.path().join(format!("invalid-{case}.jsonl"));
        let engine = test_engine_with_settings(
            Arc::new(InvalidTerminalCompactionProvider {
                leave_text_block_open,
            }),
            tmp.path(),
            settings_using_main_summary_runtime(Settings::default()),
        );
        engine.state.with_history_path(&history_path);
        let original_messages = vec![
            Message::user_text("old user one"),
            Message::assistant_text("old assistant one"),
            Message::user_text("old user two"),
            Message::assistant_text("old assistant two"),
            Message::user_text("old user three"),
            Message::assistant_text("old assistant three"),
            Message::user_text("recent user"),
            Message::assistant_text("recent assistant"),
        ];
        engine.state.set_messages(original_messages.clone());

        assert!(
            engine.perform_compaction(true).await.is_err(),
            "{case} must fail before persistence"
        );
        assert_eq!(engine.state.messages(), original_messages);
        let transcript = std::fs::read_to_string(&history_path).unwrap_or_default();
        assert!(!transcript.contains("\"subtype\":\"compact_boundary\""));
        assert!(!transcript.contains("\"isCompactSummary\":true"));
    }
}

#[tokio::test]
async fn no_op_manual_compaction_does_not_append_post_compact_attachments() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("AGENTS.md"), "NOOP_INTERNAL_PROJECT_RULE").unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );

    engine.state.set_messages(vec![
        Message::user_text("recent user request"),
        Message::assistant_text("recent assistant response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert!(!result.did_compact);
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert_eq!(result.pre_compact_tokens, result.post_compact_tokens);
    let state_text = engine
        .state
        .messages()
        .into_iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(state_text.contains("recent user request"));
    assert!(!state_text.contains("Project instructions (KCODER.md):"));
    assert!(!state_text.contains("NOOP_INTERNAL_PROJECT_RULE"));
}

#[tokio::test]
async fn compaction_does_not_record_structured_summary_when_memory_store_is_available() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = test_engine_with_memory_manager(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
        memory_manager,
    );

    engine.state.set_messages(vec![
        Message::user_text("large older request ".repeat(300)),
        Message::assistant_text("large older response ".repeat(300)),
        Message::user_text("large middle request ".repeat(300)),
        Message::assistant_text("large middle response ".repeat(300)),
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "old file content ".repeat(80)),
        Message::user_text("recent user request"),
        Message::assistant_text("recent assistant response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert_eq!(result.summary, "auto compact summary");
    let summaries = engine
        .memory_manager
        .structured_summaries_for_session(&engine.session_id(), 10)
        .unwrap();
    assert!(
        summaries.is_empty(),
        "session compaction must not store compacted context as structured SQLite memory"
    );
}

#[tokio::test]
async fn hard_compact_does_not_trust_later_boundary_marker() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(20_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );

    engine.state.set_messages(vec![
        Message::user_text("stale pre-boundary user ".repeat(12_000)),
        Message::assistant_text("stale pre-boundary assistant ".repeat(12_000)),
        Message::user_text("Earlier conversation summary: compacted old work"),
        Message::user_text("recent user request"),
    ]);

    assert!(engine.maybe_compact_conversation(1).await);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let visible = messages_after_latest_compact_boundary(&engine.state.messages())
        .iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("recent user request"));
    assert!(!visible.contains("stale pre-boundary user"));
}

#[tokio::test]
async fn auto_compact_skips_immediate_follow_up_after_success() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );

    engine.state.set_messages(vec![
        Message::user_text("old user one ".repeat(100)),
        Message::assistant_text("old assistant one ".repeat(100)),
        Message::user_text("old user two ".repeat(100)),
        Message::assistant_text("old assistant two ".repeat(100)),
        Message::user_text("recent user three ".repeat(100)),
        Message::assistant_text("recent assistant three ".repeat(100)),
    ]);

    assert!(engine.maybe_compact_conversation(1).await);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let (pre, post) = engine.last_auto_compact_tokens();
    assert!(
        pre > post,
        "a successful compaction must record shrinking token counts, got {pre} -> {post}"
    );

    assert!(!engine.maybe_compact_conversation(2).await);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn auto_compact_cooldown_survives_restarted_turn_counter() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    let oversized = || {
        vec![
            Message::user_text("old user one ".repeat(100)),
            Message::assistant_text("old assistant one ".repeat(100)),
            Message::user_text("old user two ".repeat(100)),
            Message::assistant_text("old assistant two ".repeat(100)),
            Message::user_text("recent user three ".repeat(100)),
            Message::assistant_text("recent assistant three ".repeat(100)),
        ]
    };

    engine.state.set_messages(oversized());
    assert!(engine.maybe_compact_conversation(1).await);

    engine.state.set_messages(oversized());
    assert!(
        !engine.maybe_compact_conversation(1).await,
        "新顶层消息把 turn_count 重置为 1 时，第一轮检查仍应处于 cooldown"
    );
    assert!(
        engine.maybe_compact_conversation(1).await,
        "第二轮检查应结束 cooldown，不能因 turn_count 重置而永久跳过压缩"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn hard_limit_bypasses_cooldown() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(10_000),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    let oversized = || {
        vec![
            Message::user_text("old user ".repeat(1_000)),
            Message::assistant_text("old assistant ".repeat(1_000)),
            Message::user_text("middle user ".repeat(1_000)),
            Message::assistant_text("middle assistant ".repeat(1_000)),
            Message::user_text("current request ".repeat(1_000)),
        ]
    };

    engine.state.set_messages(oversized());
    assert!(engine.maybe_compact_conversation(1).await);
    engine.state.set_messages(oversized());
    assert!(
        engine.maybe_compact_conversation(1).await,
        "超过 hard limit 时不能被 cooldown 放行"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn configured_max_output_does_not_force_compaction_below_soft_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(256_000),
        context_output_headroom: Some(100_000),
        estimated_tool_growth_tokens: Some(15_000),
        max_tokens: Some(100_000),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text("old user"),
        Message::assistant_text("old assistant"),
        Message::user_text("middle user"),
        Message::Assistant {
            content: vec![ContentBlock::Text {
                text: "middle assistant".to_string(),
            }],
            usage: Some(kcoder_types::Usage {
                input_tokens: 41_500,
                output_tokens: 500,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            }),
        },
        Message::user_text("current request"),
    ]);
    let current = TokenCounter::count(&engine.state.messages());
    assert!(
        (41_000..50_000).contains(&current),
        "测试前提：复现 Kimi 静态前缀后的 41–48k 完整上下文，实际 {current}"
    );

    assert!(!engine.maybe_compact_conversation(1).await);
    tokio::task::yield_now().await;
    assert_eq!(requests.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn hard_limit_with_three_messages_compacts_previous_complete_round() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(5_000),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(4_000),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text(format!("OLD_ROUND {}", "old request ".repeat(1_000))),
        Message::assistant_text("OLD_ROUND answer"),
        Message::user_text(format!(
            "CURRENT_REQUEST {}",
            "current request ".repeat(1_000)
        )),
    ]);

    assert!(engine.maybe_compact_conversation(1).await);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let visible = messages_after_latest_compact_boundary(&engine.state.messages())
        .iter()
        .map(|message| message.preview(50_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("CURRENT_REQUEST"));
    assert!(!visible.contains("OLD_ROUND old request"));
}
