use super::*;

#[tokio::test]
async fn compaction_provider_attempt_is_persisted_in_profile_usage() {
    let dir = tempfile::tempdir().unwrap();
    let state = kcoder_state::AppState::new(dir.path());
    state.set_usage_history_root(Some(dir.path()));
    let compactor =
        test_compactor(Arc::new(RecordingProvider::default())).with_usage_tracking(state);
    compactor
        .summarize_old_messages(
            &[Message::user_text("old context")],
            "summary-model",
            1024,
            None,
            None,
        )
        .await
        .unwrap();
    let history = kcoder_state::usage_history::read_usage(dir.path())
        .unwrap()
        .unwrap();
    let usage = &history.days.values().next().unwrap()["summary-model"];
    assert_eq!(usage.requests, 1);
    assert_eq!(usage.unreported_requests, 1);
}

#[tokio::test]
async fn compact_succeeds_when_recent_messages_carry_api_usage() {
    let provider = Arc::new(FixedEventsProvider {
        events: complete_text_events(
            "<analysis>checked</analysis><summary>anchor regression</summary>",
        ),
    });
    let compactor = test_compactor(provider);
    let mut messages = messages_with_summarizable_history();
    // Real providers attach API usage to assistant messages. TokenCounter
    // treats the latest usage-bearing message as an anchor for the whole
    // prior conversation — previously that stale anchor made
    // post-compaction counting equal pre-compaction counting and the
    // compaction bailed with "did not reduce context".
    for message in messages.iter_mut() {
        if let Message::Assistant { usage, .. } = message {
            *usage = Some(kcoder_types::Usage {
                input_tokens: 90_000,
                output_tokens: 500,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            });
        }
    }
    let pre_tokens = TokenCounter::count(&messages);
    let result = compactor
        .compact(test_compaction_request(messages), pre_tokens)
        .await
        .expect("compaction with usage-anchored history must succeed");
    assert!(result.did_compact);
    assert!(result.post_compact_tokens < pre_tokens);
    assert!(
        result.messages.iter().all(|message| matches!(
            message,
            Message::Assistant { usage: None, .. } | Message::User { .. }
        )),
        "retained messages must have stale usage stripped"
    );
}

#[tokio::test]
async fn compact_rejects_max_tokens_response() {
    let provider = Arc::new(FixedEventsProvider {
        events: vec![
            StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-max-tokens".to_string(),
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
                content_block: ContentBlock::Text {
                    text: String::new(),
                },
            },
            StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "<analysis>checked</analysis><summary>truncated summary</summary>"
                        .to_string(),
                },
            },
            StreamEvent::ContentBlockStop { index: 0 },
            StreamEvent::MessageDelta {
                delta: MessageDeltaFields {
                    stop_reason: Some("max_tokens".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            },
            StreamEvent::MessageStop,
        ],
    });
    let compactor = test_compactor(provider);

    let error = compactor
        .compact(
            test_compaction_request(messages_with_summarizable_history()),
            50_000,
        )
        .await
        .expect_err("a max_tokens compaction response must not be accepted");

    let message = error.to_string();
    assert!(message.contains("non-terminal stop_reason"), "{error:#}");
    assert!(message.contains("response details withheld"), "{error:#}");
    assert!(!message.contains("truncated summary"));
}

#[tokio::test]
async fn compact_rejects_incomplete_stream_and_illegal_stop_reasons() {
    let valid_text = "<analysis>checked</analysis><summary>must not be accepted</summary>";
    let cases = vec![
        (
            "eof-without-message-stop",
            complete_text_events(valid_text)
                .into_iter()
                .filter(|event| !matches!(event, StreamEvent::MessageStop))
                .collect::<Vec<_>>(),
        ),
        (
            "missing-stop-reason",
            complete_text_events(valid_text)
                .into_iter()
                .filter(|event| !matches!(event, StreamEvent::MessageDelta { .. }))
                .collect::<Vec<_>>(),
        ),
    ];

    for (name, events) in cases {
        let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
        let result = compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await;
        assert!(result.is_err(), "{name} must be rejected");
    }

    for stop_reason in [
        "max_tokens",
        "length",
        "tool_use",
        "pause_turn",
        "SENTINEL_PRIVATE",
    ] {
        let mut events = complete_text_events(valid_text);
        let StreamEvent::MessageDelta { delta } = &mut events[4] else {
            panic!("fixed event fixture must contain MessageDelta");
        };
        delta.stop_reason = Some(stop_reason.to_string());
        let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
        let result = compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await;
        assert!(
            result.is_err(),
            "stop_reason={stop_reason} must be rejected"
        );
        assert!(!format!("{:#}", result.unwrap_err()).contains("SENTINEL_PRIVATE"));
    }
}

#[tokio::test]
async fn compact_rejects_any_illegal_stop_reason_across_multiple_deltas() {
    for stop_reasons in [
        ["max_tokens", "end_turn"],
        ["end_turn", "max_tokens"],
        ["tool_use", "completed"],
    ] {
        let mut events = complete_text_events(
            "<analysis>checked</analysis><summary>must not be accepted</summary>",
        );
        events.remove(4);
        for (offset, stop_reason) in stop_reasons.into_iter().enumerate() {
            events.insert(
                4 + offset,
                StreamEvent::MessageDelta {
                    delta: MessageDeltaFields {
                        stop_reason: Some(stop_reason.to_string()),
                        stop_sequence: None,
                        usage: None,
                    },
                },
            );
        }
        let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
        let result = compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await;
        assert!(
            result.is_err(),
            "an illegal stop reason must not be overwritten by {:?}",
            stop_reasons
        );
    }
}

#[tokio::test]
async fn events_after_message_stop_do_not_change_validated_response() {
    let mut events = complete_text_events(
        "<analysis>checked</analysis><summary>valid terminal response</summary>",
    );
    events.push(StreamEvent::MessageDelta {
        delta: MessageDeltaFields {
            stop_reason: Some("max_tokens".to_string()),
            stop_sequence: None,
            usage: None,
        },
    });
    events.push(StreamEvent::ContentBlockStart {
        index: 1,
        content_block: ContentBlock::ToolUse {
            id: "call_after_stop".to_string(),
            name: "write".to_string(),
            input: serde_json::json!({}),
        },
    });
    let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));

    let result = compactor
        .compact(
            test_compaction_request(messages_with_summarizable_history()),
            50_000,
        )
        .await
        .expect("events after MessageStop are outside the completed response");

    assert_eq!(result.summary, "valid terminal response");
}

#[tokio::test]
async fn compact_rejects_structured_tool_input_delta_without_start() {
    let mut events = complete_text_events(
        "<analysis>checked</analysis><summary>apparently valid text</summary>",
    );
    events.insert(
        1,
        StreamEvent::ContentBlockDelta {
            index: 1,
            delta: ContentDelta::InputJsonDelta {
                partial_json: "{\"path\":\"src/lib.rs\"}".to_string(),
            },
        },
    );
    let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));

    let result = compactor
        .compact(
            test_compaction_request(messages_with_summarizable_history()),
            50_000,
        )
        .await;

    assert!(
        result.is_err(),
        "tool input deltas must not be ignored merely because the start event is absent"
    );
}

#[tokio::test]
async fn compact_rejects_tool_blocks_embedded_in_message_start_or_other_starts() {
    let tool_use = ContentBlock::ToolUse {
        id: "call_hidden".to_string(),
        name: "write".to_string(),
        input: serde_json::json!({"path": "src/lib.rs"}),
    };
    let tool_result = ContentBlock::ToolResult {
        tool_use_id: "call_hidden".to_string(),
        content: vec![ContentBlock::Text {
            text: "invented write succeeded".to_string(),
        }],
        is_error: Some(false),
    };
    let mut accepted = Vec::new();
    for (name, extra_event) in [
        (
            "message-start-tool-use",
            StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-hidden-use".to_string(),
                    role: "assistant".to_string(),
                    content: vec![tool_use.clone()],
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            },
        ),
        (
            "message-start-tool-result",
            StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-hidden-result".to_string(),
                    role: "assistant".to_string(),
                    content: vec![tool_result.clone()],
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            },
        ),
        (
            "content-block-start-tool-result",
            StreamEvent::ContentBlockStart {
                index: 1,
                content_block: tool_result,
            },
        ),
    ] {
        let is_message_start = matches!(extra_event, StreamEvent::MessageStart { .. });
        let mut events = if is_message_start {
            fixed_text_events(
                "<analysis>checked</analysis><summary>apparently valid text</summary>",
            )
        } else {
            complete_text_events(
                "<analysis>checked</analysis><summary>apparently valid text</summary>",
            )
        };
        events.insert(if is_message_start { 0 } else { 1 }, extra_event);
        let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
        if compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_ok()
        {
            accepted.push(name);
        }
    }
    assert!(
        accepted.is_empty(),
        "structured tool blocks bypassed compaction validation: {accepted:?}"
    );
}

#[tokio::test]
async fn compact_consumes_initial_text_from_message_start_and_allows_thinking() {
    let events = vec![
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-initial-text".to_string(),
                role: "assistant".to_string(),
                content: vec![
                    ContentBlock::Thinking {
                        thinking: "private reasoning".to_string(),
                        signature: "sig".to_string(),
                    },
                    ContentBlock::Text {
                        text: "<analysis>checked</analysis><summary>initial summary</summary>"
                            .to_string(),
                    },
                ],
                model: "test".to_string(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: Some("end_turn".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::MessageStop,
    ];
    let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));

    let result = compactor
        .compact(
            test_compaction_request(messages_with_summarizable_history()),
            50_000,
        )
        .await
        .expect("initial MessageStart text is part of the legal assistant response");

    assert_eq!(result.summary, "initial summary");
}

#[tokio::test]
async fn compact_requires_exactly_one_message_start_before_response_events() {
    let message_start = || StreamEvent::MessageStart {
        message: kcoder_types::StreamingMessage {
            id: "msg-start-order".to_string(),
            role: "assistant".to_string(),
            content: Vec::new(),
            model: "test".to_string(),
            stop_reason: None,
            stop_sequence: None,
            usage: None,
        },
    };
    let valid_text = "<analysis>checked</analysis><summary>valid summary</summary>";
    let missing_start = fixed_text_events(valid_text);
    let mut duplicate_start = fixed_text_events(valid_text);
    duplicate_start.insert(0, message_start());
    duplicate_start.insert(1, message_start());
    let mut start_after_content = fixed_text_events(valid_text);
    start_after_content.insert(1, message_start());
    let mut start_after_delta = fixed_text_events(valid_text);
    let reason = start_after_delta.remove(3);
    start_after_delta.insert(0, reason);
    start_after_delta.insert(1, message_start());

    let mut accepted = Vec::new();
    for (name, events) in [
        ("missing-message-start", missing_start),
        ("duplicate-message-start", duplicate_start),
        ("message-start-after-content", start_after_content),
        ("message-start-after-message-delta", start_after_delta),
    ] {
        let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
        if compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_ok()
        {
            accepted.push(name);
        }
    }
    assert!(
        accepted.is_empty(),
        "malformed MessageStart lifecycle was accepted: {accepted:?}"
    );
}

#[tokio::test]
async fn compact_rejects_image_in_message_start_and_content_start_blocks() {
    let image = ContentBlock::Image {
        source: kcoder_types::ImageSource::base64("image/png", "AAAA"),
    };
    let mut accepted = Vec::new();
    for (name, extra_event) in [
        (
            "message-start-image",
            StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-image".to_string(),
                    role: "assistant".to_string(),
                    content: vec![image.clone()],
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            },
        ),
        (
            "content-start-image",
            StreamEvent::ContentBlockStart {
                index: 7,
                content_block: image,
            },
        ),
    ] {
        let is_started_block = matches!(extra_event, StreamEvent::ContentBlockStart { .. });
        let mut events = if is_started_block {
            complete_text_events("<analysis>checked</analysis><summary>valid text</summary>")
        } else {
            fixed_text_events("<analysis>checked</analysis><summary>valid text</summary>")
        };
        if is_started_block {
            events.insert(1, extra_event);
            events.insert(2, StreamEvent::ContentBlockStop { index: 7 });
        } else {
            events.insert(0, extra_event);
        }
        let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
        if compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_ok()
        {
            accepted.push(name);
        }
    }
    assert!(
        accepted.is_empty(),
        "non-text content violated TEXT ONLY but was accepted: {accepted:?}"
    );
}

#[tokio::test]
async fn redacted_thinking_is_ignored_without_losing_streamed_text() {
    for extra_event in [
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-redacted".to_string(),
                role: "assistant".to_string(),
                content: vec![ContentBlock::RedactedThinking {
                    data: "opaque".to_string(),
                }],
                model: "test".to_string(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::ContentBlockStart {
            index: 7,
            content_block: ContentBlock::RedactedThinking {
                data: "opaque".to_string(),
            },
        },
    ] {
        let is_started_block = matches!(extra_event, StreamEvent::ContentBlockStart { .. });
        let mut events = if is_started_block {
            complete_text_events(
                "<analysis>checked</analysis><summary>visible summary survives</summary>",
            )
        } else {
            fixed_text_events(
                "<analysis>checked</analysis><summary>visible summary survives</summary>",
            )
        };
        if is_started_block {
            events.insert(1, extra_event);
            events.insert(2, StreamEvent::ContentBlockStop { index: 7 });
        } else {
            events.insert(0, extra_event);
        }
        let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
        let result = compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .expect("redacted reasoning may be ignored when visible text is complete");
        assert_eq!(result.summary, "visible summary survives");
    }
}

#[tokio::test]
async fn compact_rejects_illegal_stop_reason_from_message_start() {
    let mut events =
        fixed_text_events("<analysis>checked</analysis><summary>apparently valid text</summary>");
    events.insert(
        0,
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-truncated".to_string(),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "test".to_string(),
                stop_reason: Some("max_tokens".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
    );
    let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
    let result = compactor
        .compact(
            test_compaction_request(messages_with_summarizable_history()),
            50_000,
        )
        .await;
    assert!(
        result.is_err(),
        "an illegal MessageStart stop reason must not be washed out by end_turn"
    );
}

#[tokio::test]
async fn compact_handles_blank_and_mixed_start_delta_stop_reasons_safely() {
    let valid_text = "<analysis>checked</analysis><summary>valid summary</summary>";

    let mut blank_then_normal = fixed_text_events(valid_text);
    blank_then_normal.insert(
        0,
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-blank-start".to_string(),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "test".to_string(),
                stop_reason: Some("  \t".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
    );
    let compactor = test_compactor(Arc::new(FixedEventsProvider {
        events: blank_then_normal,
    }));
    assert!(
        compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_ok(),
        "blank start reason may be ignored when a later normal reason exists"
    );

    let mut blank_only = fixed_text_events(valid_text);
    blank_only.remove(3);
    blank_only.insert(
        3,
        StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: Some(" \n ".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
    );
    let compactor = test_compactor(Arc::new(FixedEventsProvider { events: blank_only }));
    assert!(
        compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_err(),
        "blank reasons alone do not establish successful termination"
    );

    let mut normal_start_then_illegal_delta = fixed_text_events(valid_text);
    normal_start_then_illegal_delta.insert(
        0,
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-normal-start".to_string(),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "test".to_string(),
                stop_reason: Some("end_turn".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
    );
    normal_start_then_illegal_delta.insert(
        5,
        StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: Some("max_tokens".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
    );
    let compactor = test_compactor(Arc::new(FixedEventsProvider {
        events: normal_start_then_illegal_delta,
    }));
    assert!(
        compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_err(),
        "a normal start reason must not wash out a later illegal delta reason"
    );
}

#[tokio::test]
async fn compact_rejects_unbalanced_or_duplicate_content_block_stops() {
    let valid_text = "<analysis>checked</analysis><summary>valid text</summary>";
    let without_stop = complete_text_events(valid_text)
        .into_iter()
        .filter(|event| !matches!(event, StreamEvent::ContentBlockStop { .. }))
        .collect::<Vec<_>>();
    let mut duplicate_stop = complete_text_events(valid_text);
    duplicate_stop.insert(3, StreamEvent::ContentBlockStop { index: 0 });
    let mut accepted = Vec::new();
    for (name, events) in [
        ("missing-content-block-stop", without_stop),
        ("duplicate-content-block-stop", duplicate_stop),
    ] {
        let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
        if compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_ok()
        {
            accepted.push(name);
        }
    }
    assert!(
        accepted.is_empty(),
        "malformed content block lifecycle was accepted: {accepted:?}"
    );
}

#[tokio::test]
async fn reordered_normal_delta_is_accepted_but_error_after_text_is_not() {
    let valid_text = "<analysis>checked</analysis><summary>valid text</summary>";
    let mut reason_before_text = complete_text_events(valid_text);
    let reason = reason_before_text.remove(4);
    reason_before_text.insert(1, reason);
    let compactor = test_compactor(Arc::new(FixedEventsProvider {
        events: reason_before_text,
    }));
    assert!(
        compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_ok(),
        "a normal stop delta arriving before text should remain valid"
    );

    let mut error_after_text = complete_text_events(valid_text);
    error_after_text.insert(
        3,
        StreamEvent::Error {
            error: StreamApiError {
                error_type: "stream_error".to_string(),
                message: "connection failed after text".to_string(),
            },
        },
    );
    let compactor = test_compactor(Arc::new(FixedEventsProvider {
        events: error_after_text,
    }));
    assert!(
        compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_err(),
        "an Error before MessageStop must invalidate already streamed text"
    );
}

#[tokio::test]
async fn legal_multiblock_stream_allows_index_jumps_thinking_and_signature() {
    let events = vec![
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-legal-multiblock".to_string(),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "test".to_string(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::ContentBlockStart {
            index: 4,
            content_block: ContentBlock::Thinking {
                thinking: "seed".to_string(),
                signature: String::new(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 4,
            delta: ContentDelta::ThinkingDelta {
                thinking: " reasoning".to_string(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 4,
            delta: ContentDelta::SignatureDelta {
                signature: "signed".to_string(),
            },
        },
        StreamEvent::ContentBlockStop { index: 4 },
        StreamEvent::ContentBlockStart {
            index: 9,
            content_block: ContentBlock::Text {
                text: "<analysis>".to_string(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 9,
            delta: ContentDelta::TextDelta {
                text: "checked</analysis>".to_string(),
            },
        },
        StreamEvent::ContentBlockStop { index: 9 },
        StreamEvent::ContentBlockStart {
            index: 2,
            content_block: ContentBlock::Text {
                text: "<summary>".to_string(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 2,
            delta: ContentDelta::TextDelta {
                text: "multi block summary</summary>".to_string(),
            },
        },
        StreamEvent::ContentBlockStop { index: 2 },
        StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: Some("end_turn".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::MessageStop,
    ];
    let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
    let result = compactor
        .compact(
            test_compaction_request(messages_with_summarizable_history()),
            50_000,
        )
        .await
        .expect("legal multi-block stream should be accepted");
    assert_eq!(result.summary, "multi block summary");
}

#[tokio::test]
async fn genai_style_stream_and_keepalive_pings_remain_compatible() {
    let events = vec![
        StreamEvent::Ping,
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: String::new(),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "genai-test".to_string(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::Thinking {
                thinking: String::new(),
                signature: String::new(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::ThinkingDelta {
                thinking: "checked history".to_string(),
            },
        },
        StreamEvent::Ping,
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::ContentBlockStart {
            index: 1,
            content_block: ContentBlock::Text {
                text: String::new(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 1,
            delta: ContentDelta::TextDelta {
                text: "<analysis>checked</analysis><summary>genai compatible</summary>".to_string(),
            },
        },
        StreamEvent::ContentBlockStop { index: 1 },
        StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: Some("end_turn".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::MessageStop,
    ];
    let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
    let result = compactor
        .compact(
            test_compaction_request(messages_with_summarizable_history()),
            50_000,
        )
        .await
        .expect("genai-style stream with keepalive pings should remain valid");
    assert_eq!(result.summary, "genai compatible");
}

#[tokio::test]
async fn compact_rejects_delta_kind_mismatches_and_delta_after_stop() {
    let mut accepted = Vec::new();
    let cases = vec![
        (
            "thinking-delta-on-text",
            ContentBlock::Text {
                text: String::new(),
            },
            ContentDelta::ThinkingDelta {
                thinking: "wrong".to_string(),
            },
            false,
        ),
        (
            "signature-delta-on-text",
            ContentBlock::Text {
                text: String::new(),
            },
            ContentDelta::SignatureDelta {
                signature: "wrong".to_string(),
            },
            false,
        ),
        (
            "text-delta-on-thinking",
            ContentBlock::Thinking {
                thinking: String::new(),
                signature: String::new(),
            },
            ContentDelta::TextDelta {
                text: "wrong".to_string(),
            },
            false,
        ),
        (
            "delta-after-stop",
            ContentBlock::Text {
                text: String::new(),
            },
            ContentDelta::TextDelta {
                text: "late".to_string(),
            },
            true,
        ),
    ];
    for (name, block, delta, stop_before_delta) in cases {
        let mut events = vec![StreamEvent::ContentBlockStart {
            index: 3,
            content_block: block,
        }];
        if stop_before_delta {
            events.push(StreamEvent::ContentBlockStop { index: 3 });
        }
        events.push(StreamEvent::ContentBlockDelta { index: 3, delta });
        if !stop_before_delta {
            events.push(StreamEvent::ContentBlockStop { index: 3 });
        }
        events.push(StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: Some("end_turn".to_string()),
                stop_sequence: None,
                usage: None,
            },
        });
        events.push(StreamEvent::MessageStop);
        let compactor = test_compactor(Arc::new(FixedEventsProvider { events }));
        if compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .is_ok()
        {
            accepted.push(name);
        }
    }
    assert!(
        accepted.is_empty(),
        "delta/state mismatches accepted: {accepted:?}"
    );
}
