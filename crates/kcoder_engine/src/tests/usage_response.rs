#[derive(Debug)]
struct StartAndDeltaUsageProvider;

#[tokio::test]
async fn missing_context_limits_fail_the_turn_without_calling_the_provider() {
    for missing_window in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = test_engine_with_settings(
            Arc::new(RequestRecordingProvider { requests: requests.clone() }),
            tmp.path(), Settings::default(),
        );
        {
            let mut settings = engine.settings.write().unwrap();
            if missing_window { settings.context_window_tokens = None; }
            else { settings.context_output_headroom = None; }
        }
        engine.state.add_message(Message::user_text("hello"));
        let events = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt).collect::<Vec<_>>().await;
        assert!(events.iter().any(|event| matches!(event, EngineEvent::Error(message) if message.contains("context limits"))));
        assert!(requests.lock().unwrap().is_empty());
    }
}

impl Provider for StartAndDeltaUsageProvider {
    fn name(&self) -> &'static str {
        "start-and-delta-usage"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "usage-split".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Some(Usage {
                        input_tokens: 100,
                        output_tokens: 5,
                        cache_creation_input_tokens: Some(20),
                        cache_read_input_tokens: Some(30),
                        total_tokens: None,
                        iterations: None,
                    }),
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta { text: "done".to_string() },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: Some(Usage {
                        input_tokens: 100,
                        output_tokens: 25,
                        cache_creation_input_tokens: Some(20),
                        cache_read_input_tokens: Some(30),
                        total_tokens: None,
                        iterations: None,
                    }),
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn stream_usage_charges_message_start_and_only_delta_increment() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(StartAndDeltaUsageProvider),
        tmp.path(),
        Settings::default(),
    );
    engine.state.add_message(Message::user_text("go"));

    engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    let usage = engine.cumulative_usage();
    assert_eq!(usage.input_tokens, 100);
    assert_eq!(usage.output_tokens, 25);
    assert_eq!(usage.cache_creation_input_tokens, 20);
    assert_eq!(usage.cache_read_input_tokens, 30);
}

#[tokio::test]
async fn thinking_only_response_is_nudged_into_continuing_the_turn() {
    let (provider, calls) =
        SequentialEventsProvider::new(vec![thinking_only_events(), simple_text_events("done")]);
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(Arc::new(provider), tmp.path(), Settings::default());
    engine.state.add_message(Message::user_text("go"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert_eq!(*calls.lock().unwrap(), 2);
    assert!(events.iter().any(|event| {
            matches!(event, EngineEvent::SystemNotice(text) if text.contains("nudging it to continue (1/3)"))
        }));
    assert!(
        engine
            .state
            .messages()
            .iter()
            .any(|message| message.preview(4096).contains("done")),
        "the follow-up text response must be preserved"
    );
    assert!(
        engine.state.messages().iter().any(|message| message
            .preview(4096)
            .contains("no visible text and no tool calls")),
        "the nudge must be recorded in the conversation"
    );
}

#[tokio::test]
async fn consecutive_empty_responses_end_the_turn_after_the_nudge_limit() {
    let (provider, calls) = SequentialEventsProvider::new(vec![thinking_only_events()]);
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(Arc::new(provider), tmp.path(), Settings::default());
    engine.state.add_message(Message::user_text("go"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert_eq!(*calls.lock().unwrap(), 1 + EMPTY_RESPONSE_NUDGE_LIMIT);
    assert!(events.iter().any(|event| {
            matches!(event, EngineEvent::SystemNotice(text) if text.contains("consecutive empty responses"))
        }));
}

#[tokio::test]
async fn tool_call_after_empty_response_resets_the_nudge_budget() {
    let tool_call_events = vec![
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-tool".to_string(),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "test".to_string(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::ToolUse {
                id: "call-1".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({}),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::InputJsonDelta {
                partial_json: r#"{"command":"echo nudge-recovered"}"#.to_string(),
            },
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: Some("end_turn".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::MessageStop,
    ];
    let (provider, calls) = SequentialEventsProvider::new(vec![
        thinking_only_events(),
        tool_call_events,
        thinking_only_events(),
        simple_text_events("done after tools"),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(Arc::new(provider), tmp.path(), Settings::default());
    engine.state.add_message(Message::user_text("go"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert_eq!(*calls.lock().unwrap(), 4);
    // One nudge for the first empty response and one for the post-tool
    // empty response: the tool call must have reset the counter.
    let nudges = events
            .iter()
            .filter(|event| {
                matches!(event, EngineEvent::SystemNotice(text) if text.contains("nudging it to continue (1/3)"))
            })
            .count();
    assert_eq!(nudges, 2);
    assert!(
        engine
            .state
            .messages()
            .iter()
            .any(|message| message.preview(4096).contains("nudge-recovered"))
    );
}
