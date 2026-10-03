#[derive(Debug)]
struct DelayedTextProvider;

impl Provider for DelayedTextProvider {
    fn name(&self) -> &'static str {
        "delayed-text"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-delayed".to_string(),
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
                delta: ContentDelta::TextDelta { text: "live".to_string() },
            });
            tokio::time::sleep(Duration::from_millis(500)).await;
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct TruncatedToolUseProvider;

impl Provider for TruncatedToolUseProvider {
    fn name(&self) -> &'static str {
        "truncated-tool-use"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::ToolUse {
                    id: "orphan".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::InputJsonDelta {
                    partial_json: r#"{"command":"echo hi"}"#.to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            // Deliberately close without message_stop.
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct ToolUseMissingBlockStopProvider;

impl Provider for ToolUseMissingBlockStopProvider {
    fn name(&self) -> &'static str {
        "tool-use-missing-block-stop"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::ToolUse {
                    id: "open-tool".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::InputJsonDelta {
                    partial_json: r#"{"command":"echo hi"}"#.to_string(),
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct DuplicateMessageStartAfterToolProvider;

impl Provider for DuplicateMessageStartAfterToolProvider {
    fn name(&self) -> &'static str {
        "duplicate-message-start-after-tool"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            for id in ["first", "duplicate"] {
                yield Ok(StreamEvent::MessageStart {
                    message: kcoder_types::StreamingMessage {
                        id: id.to_string(),
                        role: "assistant".to_string(),
                        content: Vec::new(),
                        model: "test".to_string(),
                        stop_reason: None,
                        stop_sequence: None,
                        usage: None,
                    },
                });
                if id == "first" {
                    yield Ok(StreamEvent::ContentBlockStart {
                        index: 0,
                        content_block: ContentBlock::ToolUse {
                            id: "must-not-run".to_string(),
                            name: "bash".to_string(),
                            input: serde_json::json!({}),
                        },
                    });
                    yield Ok(StreamEvent::ContentBlockDelta {
                        index: 0,
                        delta: ContentDelta::InputJsonDelta {
                            partial_json: r#"{"command":"echo unsafe"}"#.to_string(),
                        },
                    });
                    yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                }
            }
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn submit_message_stream_yields_deltas_before_provider_finishes() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(DelayedTextProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.submit_message_stream("hello", &prompt);

    let text = timeout(Duration::from_millis(200), async {
        while let Some(event) = stream.next().await {
            if let EngineEvent::AssistantTextDelta(text) = event {
                return text;
            }
        }
        panic!("stream ended before a text delta");
    })
    .await
    .expect("text delta must be observable before the provider completes");

    assert_eq!(text, "live");
}

#[tokio::test]
async fn submit_message_content_stream_preserves_image_blocks_for_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine_with_settings(
        Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let message = Message::user_content(vec![
        ContentBlock::Text {
            text: "describe this image".into(),
        },
        ContentBlock::Image {
            source: kcoder_types::ImageSource::base64("image/png", "aW1hZ2U="),
        },
    ]);

    engine
        .submit_message_content_stream(message, "describe this image", &prompt)
        .collect::<Vec<_>>()
        .await;

    let requests = requests.lock().unwrap();
    let Some(Message::User { content, .. }) = requests[0].messages.last() else {
        panic!("provider request must end with the user message");
    };
    assert!(content.iter().any(|block| matches!(
        block,
        ContentBlock::Image { source } if source.media_type == "image/png" && source.data == "aW1hZ2U="
    )));
}

#[tokio::test]
async fn provider_response_emits_one_started_and_one_done() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(DelayedTextProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.add_message(Message::user_text("hello"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, EngineEvent::AssistantMessageStarted))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, EngineEvent::AssistantMessageDone))
            .count(),
        1
    );
}

#[tokio::test]
async fn provider_without_message_start_still_emits_one_started() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(TextDraftProvider {
            text: "hello".to_string(),
            requests: Arc::new(Mutex::new(Vec::new())),
            delay: None,
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.add_message(Message::user_text("hello"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, EngineEvent::AssistantMessageStarted))
            .count(),
        1
    );
}

#[tokio::test]
async fn truncated_tool_use_is_neither_persisted_nor_emitted_as_an_orphan() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.max_retries = 0;
    let engine =
        test_engine_with_settings(Arc::new(TruncatedToolUseProvider), tmp.path(), settings);
    engine.state.add_message(Message::user_text("run it"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        EngineEvent::ToolUseStarted { id, .. } if id == "orphan"
    )));
    assert!(!engine.state.messages().iter().any(|message| matches!(
        message,
        Message::Assistant { content, .. }
            if content.iter().any(|block| matches!(
                block,
                ContentBlock::ToolUse { id, .. } if id == "orphan"
            ))
    )));
}

#[tokio::test]
async fn message_stop_with_open_tool_block_is_rejected_without_persistence() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.max_retries = 0;
    let engine = test_engine_with_settings(
        Arc::new(ToolUseMissingBlockStopProvider),
        tmp.path(),
        settings,
    );
    engine.state.add_message(Message::user_text("run it"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::Error(error) | EngineEvent::ProviderFailed { message: error, .. } if error.contains("content_block_stop")
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        EngineEvent::ToolUseStarted { id, .. } if id == "open-tool"
    )));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::AssistantMessageDone))
    );
    assert!(!engine.state.messages().iter().any(|message| matches!(
        message,
        Message::Assistant { content, .. }
            if content.iter().any(|block| matches!(
                block,
                ContentBlock::ToolUse { id, .. } if id == "open-tool"
            ))
    )));
}

#[tokio::test]
async fn duplicate_message_start_after_tool_block_is_protocol_error() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.max_retries = 0;
    let engine = test_engine_with_settings(
        Arc::new(DuplicateMessageStartAfterToolProvider),
        tmp.path(),
        settings,
    );
    engine.state.add_message(Message::user_text("run it"));

    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;

    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::Error(error) | EngineEvent::ProviderFailed { message: error, .. } if error.contains("duplicate message_start")
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        EngineEvent::ToolUseStarted { id, .. } if id == "must-not-run"
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        EngineEvent::ToolResult { id, .. } if id == "must-not-run"
    )));
    assert_eq!(engine.state.messages().len(), 1);
}

#[derive(Debug)]
struct ToolThenTextRecordingProvider {
    calls: AtomicUsize,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for ToolThenTextRecordingProvider {
    fn name(&self) -> &'static str {
        "tool-then-text-recording"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let events = if call == 0 {
            vec![
                StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "blocking-call".to_string(),
                        name: "blocking_test_tool".to_string(),
                        input: serde_json::json!({}),
                    },
                },
                StreamEvent::ContentBlockStop { index: 0 },
                StreamEvent::MessageStop,
            ]
        } else {
            simple_text_events("continued after steer")
        };
        let stream = futures::stream::iter(events.into_iter().map(Ok));
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct BlockingSteerTestTool {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

#[async_trait::async_trait]
impl Tool for BlockingSteerTestTool {
    fn name(&self) -> String {
        "blocking_test_tool".to_string()
    }

    fn description(&self) -> String {
        "等待测试释放后返回".to_string()
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })
    }

    async fn call(
        &self,
        _input: Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        self.started.notify_one();
        self.release.notified().await;
        Ok(ToolOutput::text("tool complete"))
    }
}

#[tokio::test]
async fn steer_is_injected_after_complete_tool_batch_within_same_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = QueryEngine::new(
        Arc::new(ToolThenTextRecordingProvider {
            calls: AtomicUsize::new(0),
            requests: Arc::clone(&requests),
        }),
        AppState::new(tmp.path()),
        ToolRegistry::new().register(BlockingSteerTestTool {
            started: Arc::clone(&started),
            release: Arc::clone(&release),
        }),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    engine.state.add_message(Message::user_text("run the tool"));

    let running_engine = engine.clone();
    let turn = tokio::spawn(async move {
        running_engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await
    });

    timeout(Duration::from_secs(2), started.notified())
        .await
        .expect("tool should start");
    engine
        .enqueue_turn_steer(7, Message::user_text("use the new constraint"))
        .expect("active regular turn should accept steer input");
    assert_eq!(requests.lock().unwrap().len(), 1);
    release.notify_one();

    let events = timeout(Duration::from_secs(2), turn)
        .await
        .expect("turn should finish")
        .expect("turn task should not panic");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2, "steer should force one same-turn follow-up");
    assert!(
        !requests[0]
            .messages
            .iter()
            .any(|message| message.preview(200).contains("new constraint")),
        "in-flight provider request must not be mutated"
    );
    let second_messages = &requests[1].messages;
    let tool_result_index = second_messages
        .iter()
        .position(|message| {
            matches!(message, Message::User { content, .. } if content.iter().any(|block| {
                matches!(block, ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "blocking-call")
            }))
        })
        .expect("second request should include the complete tool result");
    let steer_index = second_messages
        .iter()
        .position(|message| message.preview(200).contains("new constraint"))
        .expect("second request should include the steer input");
    assert!(tool_result_index < steer_index);

    let tool_result_event = events
        .iter()
        .position(|event| matches!(event, EngineEvent::ToolResult { id, .. } if id == "blocking-call"))
        .expect("tool result event");
    let steer_event = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnSteerApplied { id } if *id == 7))
        .expect("steer applied event");
    assert!(tool_result_event < steer_event);
}

#[derive(Debug)]
struct GatedTextThenTextProvider {
    calls: AtomicUsize,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    first_started: Arc<Notify>,
    release_first: Arc<Notify>,
}

impl Provider for GatedTextThenTextProvider {
    fn name(&self) -> &'static str {
        "gated-text-then-text"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let first_started = Arc::clone(&self.first_started);
        let release_first = Arc::clone(&self.release_first);
        let stream = async_stream::stream! {
            if call == 0 {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text { text: String::new() },
                });
                first_started.notify_one();
                release_first.notified().await;
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta { text: "first answer".to_string() },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            } else {
                for event in simple_text_events("answer after steer") {
                    yield Ok(event);
                }
            }
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn steer_during_text_stream_forces_same_turn_follow_up() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_started = Arc::new(Notify::new());
    let release_first = Arc::new(Notify::new());
    let engine = test_engine_with_settings(
        Arc::new(GatedTextThenTextProvider {
            calls: AtomicUsize::new(0),
            requests: Arc::clone(&requests),
            first_started: Arc::clone(&first_started),
            release_first: Arc::clone(&release_first),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.add_message(Message::user_text("start"));

    let running_engine = engine.clone();
    let turn = tokio::spawn(async move {
        running_engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await
    });
    timeout(Duration::from_secs(2), first_started.notified())
        .await
        .expect("first text response should start");
    engine
        .enqueue_turn_steer(8, Message::user_text("clarification while streaming"))
        .expect("streaming regular turn should accept steer");
    release_first.notify_one();

    let events = timeout(Duration::from_secs(2), turn)
        .await
        .expect("turn should finish")
        .expect("turn task should not panic");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1]
            .messages
            .iter()
            .any(|message| message.preview(200).contains("clarification while streaming"))
    );
    let first_done = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AssistantMessageDone))
        .expect("first assistant message should finish");
    let steer_applied = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnSteerApplied { id } if *id == 8))
        .expect("steer applied event");
    assert!(first_done < steer_applied);
}

#[test]
fn steer_rejects_when_no_regular_turn_is_active() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );

    assert_eq!(
        engine.enqueue_turn_steer(1, Message::user_text("too late")),
        Err(TurnSteerError::NoActiveTurn)
    );
}
