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
        settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings()),
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
        settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings()),
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
        settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings()),
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
        settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings()),
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
    let mut settings = settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings());
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
    let mut settings = settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings());
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
    let mut settings = settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings());
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
struct ProtocolInputProvider {
    events: Vec<StreamEvent>,
    polled: Arc<AtomicUsize>,
    requests: Arc<AtomicUsize>,
}

impl Provider for ProtocolInputProvider {
    fn name(&self) -> &'static str {
        "protocol-input"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        let events = self.events.clone();
        let polled = Arc::clone(&self.polled);
        Ok(Box::pin(async_stream::stream! {
            for event in events {
                polled.fetch_add(1, Ordering::SeqCst);
                yield Ok(event);
            }
        }))
    }
}

fn protocol_input_start(index: usize) -> StreamEvent {
    StreamEvent::ContentBlockStart {
        index,
        content_block: ContentBlock::ToolUse {
            id: format!("input-{index}"),
            name: "input_echo".into(),
            input: serde_json::json!({}),
        },
    }
}

#[tokio::test]
async fn provider_stop_semantics_are_bounded_and_precede_message_completion() {
    for (raw, expected) in [("length", "max_tokens"), ("MAX_TOKENS", "max_tokens"), ("content_filter", "refusal"), ("pause_turn", "pause_turn"), ("private-provider-diagnostic", "unknown")] {
        let root = tempfile::tempdir().unwrap();
        let engine = test_engine_with_settings(
            Arc::new(ProtocolInputProvider {
                events: vec![
                    StreamEvent::ContentBlockStart { index: 0, content_block: ContentBlock::Text { text: "partial response".into() } },
                    StreamEvent::ContentBlockStop { index: 0 },
                    StreamEvent::MessageDelta { delta: kcoder_types::MessageDeltaFields { stop_reason: Some(raw.into()), stop_sequence: None, usage: None } },
                    StreamEvent::MessageStop,
                ],
                polled: Arc::new(AtomicUsize::new(0)),
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            root.path(),
            settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings()),
        );
        let events = engine.submit_message_stream("run", &kcoder_permissions::AutoAllowPrompt).collect::<Vec<_>>().await;
        let stopped = events.iter().position(|event| matches!(event, EngineEvent::AssistantStopReason { reason } if *reason == expected)).expect("normalized stop semantics must reach the host");
        let done = events.iter().position(|event| matches!(event, EngineEvent::AssistantMessageDone)).unwrap();
        assert!(stopped < done);
        assert!(engine.state.messages().iter().any(|message| matches!(message, Message::Assistant {content,..} if content.iter().any(|block| matches!(block, ContentBlock::Text{text} if text == "partial response")))));
    }
}

fn protocol_input_delta(index: usize, partial_json: &str) -> StreamEvent {
    StreamEvent::ContentBlockDelta {
        index,
        delta: ContentDelta::InputJsonDelta {
            partial_json: partial_json.into(),
        },
    }
}

async fn assert_protocol_input_rejected(
    source_events: Vec<StreamEvent>,
    rejected_event_count: usize,
) {
    let tmp = tempfile::tempdir().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let polled = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
        max_retries: 2,
        ..settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings())
    };
    let engine = TestEngineBuilder::new(tmp.path())
        .provider(Arc::new(ProtocolInputProvider {
            events: source_events,
            polled: Arc::clone(&polled),
            requests: Arc::clone(&requests),
        }))
        .settings(settings)
        .tool_registry(ToolRegistry::new().register(InputEchoTool {
            seen: Arc::clone(&seen),
        }))
        .build_with_profile_directory();
    engine.state.add_message(Message::user_text("run the tool"));
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;

    assert!(
        seen.lock().unwrap().is_empty(),
        "invalid input must never execute"
    );
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "protocol errors must not retry"
    );
    assert!(
        events.iter().any(|event| matches!(
            event,
            EngineEvent::ProviderFailed { message, details }
                if details.category == kcoder_types::ProviderFailureCategory::ModelProtocolError
                    && !details.retryable && !details.resume_safe
                    && message.contains("provider protocol error")
                    && !message.contains("SENTINEL_PRIVATE")
        )),
        "expected a typed permanent protocol failure: {events:?}"
    );
    assert_eq!(
        polled.load(Ordering::SeqCst),
        rejected_event_count,
        "reject before reading more input or completing this response"
    );
    assert!(!events.iter().any(|event| matches!(
        event,
        EngineEvent::ToolUseStarted { .. }
            | EngineEvent::ToolResult { .. }
            | EngineEvent::AssistantMessageDone
    )));
    assert_eq!(
        engine.state.messages().len(),
        1,
        "do not persist invalid tool calls"
    );
}

#[tokio::test]
async fn tool_input_protocol_rejects_json_delta_without_block_start() {
    assert_protocol_input_rejected(
        vec![
            protocol_input_delta(17, "SENTINEL_PRIVATE"),
            protocol_input_delta(17, "more orphan input"),
            StreamEvent::ContentBlockStop { index: 17 },
            StreamEvent::MessageStop,
        ],
        1,
    )
    .await;
}

#[tokio::test]
async fn tool_input_protocol_rejects_json_delta_for_text_block() {
    assert_protocol_input_rejected(
        vec![
            StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: String::new(),
                },
            },
            protocol_input_delta(0, "SENTINEL_PRIVATE"),
            StreamEvent::ContentBlockStop { index: 0 },
            StreamEvent::MessageStop,
        ],
        2,
    )
    .await;
}

#[tokio::test]
async fn tool_input_protocol_rejects_json_delta_after_block_stop() {
    assert_protocol_input_rejected(
        vec![
            protocol_input_start(0),
            protocol_input_delta(0, "{}"),
            StreamEvent::ContentBlockStop { index: 0 },
            protocol_input_delta(0, "SENTINEL_PRIVATE"),
            StreamEvent::MessageStop,
        ],
        4,
    )
    .await;
}

#[tokio::test]
async fn tool_input_protocol_rejects_malformed_json_instead_of_executing_empty_input() {
    assert_protocol_input_rejected(
        vec![
            protocol_input_start(0),
            protocol_input_delta(0, r#"{"label":"SENTINEL_PRIVATE""#),
            StreamEvent::ContentBlockStop { index: 0 },
            StreamEvent::MessageStop,
        ],
        3,
    )
    .await;
}

#[derive(Debug)]
struct ToolArgumentRecoveryProvider {
    responses: Vec<Vec<StreamEvent>>,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for ToolArgumentRecoveryProvider {
    fn name(&self) -> &'static str {
        "tool-argument-recovery-fixture"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let index = {
            let mut requests = self.requests.lock().unwrap();
            let index = requests.len();
            requests.push(request);
            index
        };
        let events = self.responses.get(index).cloned().unwrap_or_else(|| {
            panic!("unexpected extra provider request {index}")
        });
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}

fn recoverable_tool_response(partial: &str, include_complete_call: bool) -> Vec<StreamEvent> {
    let mut events = vec![StreamEvent::ContentBlockStart {
        index: 0,
        content_block: ContentBlock::Text { text: "Checking the task.".into() },
    }, StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::ContentBlockStart { index: 1, content_block: ContentBlock::Text { text: String::new() } },
        StreamEvent::ContentBlockStop { index: 1 },
    ];
    if include_complete_call {
        events.extend([
            protocol_input_start(2),
            protocol_input_delta(2, r#"{"label":"queued-but-not-executed"}"#),
            StreamEvent::ContentBlockStop { index: 2 },
        ]);
    } else {
        events.extend([
            StreamEvent::ContentBlockStart { index: 2, content_block: ContentBlock::Text { text: String::new() } },
            StreamEvent::ContentBlockStop { index: 2 },
        ]);
    }
    events.extend([
        protocol_input_start(3),
        protocol_input_delta(3, partial),
        StreamEvent::ContentBlockStop { index: 3 },
        StreamEvent::MessageStop,
    ]);
    events
}

type ToolArgumentRecoveryFixture = (
    QueryEngine,
    Arc<Mutex<Vec<Value>>>,
    Arc<Mutex<Vec<MessagesRequest>>>,
);

fn argument_recovery_engine(
    root: &Path,
    responses: Vec<Vec<StreamEvent>>,
    retries: usize,
) -> ToolArgumentRecoveryFixture {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root)
        .provider(Arc::new(ToolArgumentRecoveryProvider {
            responses,
            requests: Arc::clone(&requests),
        }))
        .settings(Settings {
            permission_mode: PermissionMode::Bypass,
            max_retries: retries,
            ..settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings())
        })
        .tool_registry(ToolRegistry::new().register(InputEchoTool { seen: Arc::clone(&seen) }))
        .build_with_profile_directory();
    engine.state.add_message(Message::user_text("run the tool"));
    (engine, seen, requests)
}

#[tokio::test]
async fn truncated_tool_arguments_regenerate_without_executing_the_rejected_batch() {
    let root = tempfile::tempdir().unwrap();
    let corrected = serde_json::json!({"label":"corrected","nested":{"count":2,"enabled":false,"items":[1,2]}});
    let (engine, seen, requests) = argument_recovery_engine(root.path(), vec![
        recoverable_tool_response(r#"{"label":"SENTINEL_PRIVATE""#, true),
        vec![
            protocol_input_start(0),
            protocol_input_delta(0, &corrected.to_string()),
            StreamEvent::ContentBlockStop { index: 0 },
            StreamEvent::MessageStop,
        ],
        simple_text_events("finished"),
    ], 2);
    let events = engine.run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 3)
        .collect::<Vec<_>>().await;
    assert_eq!(*seen.lock().unwrap(), [corrected]);
    assert!(!events.iter().any(|event| matches!(event, EngineEvent::ProviderFailed { .. })));
    assert!(events.iter().any(|event| matches!(event,
        EngineEvent::ToolResult { id, output, .. }
            if id == "input-2" && output.is_error
    )));
    assert!(!events.iter().any(|event| matches!(event,
        EngineEvent::ToolExecutionStarted { id, .. } if id == "input-2" || id == "input-3"
    )));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    let repair_context = &requests[1].messages;
    assert!(repair_context.iter().any(|message| matches!(message,
        Message::User { content, .. } if content.iter().any(|block| matches!(block,
            ContentBlock::Text { text } if text.contains("No tools in that response were executed")
        ))
    )));
    assert!(!serde_json::to_string(repair_context).unwrap().contains("SENTINEL_PRIVATE"));
    assert!(repair_context.iter().any(|message| matches!(message,
        Message::User { content, .. } if content.iter().any(|block| matches!(block,
            ContentBlock::ToolResult { tool_use_id, is_error: Some(true), .. } if tool_use_id == "input-2"
        ))
    )));
}

#[tokio::test]
async fn truncated_tool_arguments_have_one_regeneration_per_turn() {
    let root = tempfile::tempdir().unwrap();
    let malformed = recoverable_tool_response(r#"{"label":"SENTINEL_PRIVATE""#, false);
    let (engine, seen, requests) = argument_recovery_engine(
        root.path(), vec![malformed.clone(), malformed], 8,
    );
    let events = engine.run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 8)
        .collect::<Vec<_>>().await;
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert_eq!(events.iter().filter(|event| matches!(event, EngineEvent::ProviderFailed { .. })).count(), 1);
    assert!(!serde_json::to_string(&engine.state.messages()).unwrap().contains("SENTINEL_PRIVATE"));
}

#[tokio::test]
async fn truncated_tool_arguments_do_not_regenerate_when_retries_are_disabled() {
    let root = tempfile::tempdir().unwrap();
    let (engine, seen, requests) = argument_recovery_engine(root.path(), vec![
        recoverable_tool_response(r#"{"label":"SENTINEL_PRIVATE""#, false),
    ], 0);
    let events = engine.run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 3)
        .collect::<Vec<_>>().await;
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert!(events.iter().any(|event| matches!(event, EngineEvent::ProviderFailed { .. })));
}

#[tokio::test]
async fn malformed_nontruncated_tool_arguments_remain_permanent_protocol_errors() {
    let root = tempfile::tempdir().unwrap();
    let (engine, seen, requests) = argument_recovery_engine(root.path(), vec![
        recoverable_tool_response(r#"{"label":not_json}"#, false),
    ], 2);
    let events = engine.run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 3)
        .collect::<Vec<_>>().await;
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert!(events.iter().any(|event| matches!(event, EngineEvent::ProviderFailed { .. })));
}

#[tokio::test]
async fn cancelling_tool_argument_regeneration_does_not_start_another_request() {
    let root = tempfile::tempdir().unwrap();
    let (engine, seen, requests) = argument_recovery_engine(root.path(), vec![
        recoverable_tool_response(r#"{"label":"SENTINEL_PRIVATE""#, false),
    ], 2);
    let cancel = CancellationToken::new();
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream_with_cancel_and_max_turns(
        &prompt, cancel.clone(), 3, None, None,
    );
    let mut saw_regeneration = false;
    while let Some(event) = stream.next().await {
        if matches!(event, EngineEvent::SystemNotice(ref text) if text.contains("regenerating")) {
            saw_regeneration = true;
            cancel.cancel();
        }
    }
    assert!(saw_regeneration);
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn tool_argument_regeneration_preserves_previously_executed_results() {
    let root = tempfile::tempdir().unwrap();
    let called = |label: &str| vec![
        protocol_input_start(0),
        protocol_input_delta(0, &serde_json::json!({"label":label}).to_string()),
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageStop,
    ];
    let (engine, seen, requests) = argument_recovery_engine(root.path(), vec![
        called("earlier-executed-call"),
        recoverable_tool_response(r#"{"label":"SENTINEL_PRIVATE""#, false),
        called("new-corrected-call"),
        simple_text_events("finished"),
    ], 2);
    let events = engine.run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 4)
        .collect::<Vec<_>>().await;
    assert_eq!(*seen.lock().unwrap(), [
        serde_json::json!({"label":"earlier-executed-call"}),
        serde_json::json!({"label":"new-corrected-call"}),
    ]);
    assert!(!events.iter().any(|event| matches!(event, EngineEvent::ProviderFailed { .. })));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(requests[2].messages.iter().any(|message| matches!(message,
        Message::User { content, .. } if content.iter().any(|block| matches!(block,
            ContentBlock::ToolResult { content, is_error: Some(false), .. }
                if serde_json::to_string(content).unwrap().contains("earlier-executed-call")
        ))
    )));
}

#[tokio::test]
async fn tool_argument_regeneration_does_not_replay_a_widget_preview() {
    let root = tempfile::tempdir().unwrap();
    let mut malformed = recoverable_tool_response(r#"{"label":"SENTINEL_PRIVATE""#, false);
    malformed[0] = StreamEvent::ContentBlockStart {
        index: 0,
        content_block: ContentBlock::ToolUse {
            id: "live-widget".into(), name: "show_widget".into(),
            input: serde_json::json!({}),
        },
    };
    let (engine, seen, requests) = argument_recovery_engine(root.path(), vec![malformed], 2);
    let events = engine.run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 3)
        .collect::<Vec<_>>().await;
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert!(events.iter().any(|event| matches!(event, EngineEvent::ProviderFailed { .. })));
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
        ..settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings())
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
        settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings()),
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
        settings_using_main_summary_runtime(crate::test_support::engine_builder::fixture_settings()),
    );

    assert_eq!(
        engine.enqueue_turn_steer(1, Message::user_text("too late")),
        Err(TurnSteerError::NoActiveTurn)
    );
}
