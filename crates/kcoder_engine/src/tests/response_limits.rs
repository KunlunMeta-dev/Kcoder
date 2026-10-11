struct BudgetFixture {
    inner: ProtocolInputProvider,
    limits: kcoder_types::ProviderResponseLimits,
}

impl Provider for BudgetFixture {
    fn name(&self) -> &'static str {
        "response-budget-fixture"
    }
    fn response_limits(&self) -> kcoder_types::ProviderResponseLimits {
        self.limits
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.inner.stream_messages(request)
    }
}

async fn assert_response_limit_stops_before_dispatch(
    source: Vec<StreamEvent>,
    limits: kcoder_types::ProviderResponseLimits,
    resource: &str,
    stopped_at: usize,
) {
    let tmp = tempfile::tempdir().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let polled = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(AtomicUsize::new(0));
    let engine = TestEngineBuilder::new(tmp.path())
        .provider(Arc::new(BudgetFixture {
            inner: ProtocolInputProvider {
                events: source,
                polled: polled.clone(),
                requests: requests.clone(),
            },
            limits,
        }))
        .settings(Settings {
            permission_mode: PermissionMode::Bypass,
            max_retries: 2,
            ..settings_using_main_summary_runtime(Settings::default())
        })
        .tool_registry(ToolRegistry::new().register(InputEchoTool { seen: seen.clone() }))
        .build();
    engine.state.add_message(Message::user_text("run it"));
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert!(
        seen.lock().unwrap().is_empty(),
        "no partial response may execute"
    );
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "permanent limit must not retry"
    );
    assert_eq!(
        polled.load(Ordering::SeqCst),
        stopped_at,
        "stop polling on first excess"
    );
    assert!(
        events.iter().any(|event| matches!(event,
            EngineEvent::ProviderFailed { message, details }
            if !details.retryable && !details.resume_safe && message.contains(resource)
        )),
        "user must see the specific response limit: {events:?}"
    );
    assert!(!events.iter().any(|event| matches!(
        event,
        EngineEvent::ToolUseStarted { .. }
            | EngineEvent::ToolResult { .. }
            | EngineEvent::AssistantMessageDone
    )));
    assert!(
        !engine
            .state
            .messages()
            .iter()
            .any(|message| matches!(message,
                Message::Assistant { content, .. }
                if content.iter().any(|block| matches!(block, ContentBlock::ToolUse { .. }))
            ))
    );
}

fn small_response_limits() -> kcoder_types::ProviderResponseLimits {
    kcoder_types::ProviderResponseLimits {
        total_decoded_bytes: 128,
        tool_arguments_bytes: 64,
        content_blocks: 4,
        active_tool_calls: 2,
    }
}

#[tokio::test]
async fn response_limits_preserve_complete_start_arguments_and_streamed_override() {
    for (initial, fragments, expected) in [
        (
            serde_json::json!({"city":"北京","count":3}),
            None,
            serde_json::json!({"city":"北京","count":3}),
        ),
        (
            serde_json::json!({"city":"initial"}),
            Some("{\"city\":\"streamed\",\"count\":2}"),
            serde_json::json!({"city":"streamed","count":2}),
        ),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut source = vec![StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::ToolUse {
                id: "complete".into(),
                name: "input_echo".into(),
                input: initial,
            },
        }];
        if let Some(fragment) = fragments {
            source.push(protocol_input_delta(0, fragment));
        }
        source.extend([
            StreamEvent::ContentBlockStop { index: 0 },
            StreamEvent::MessageStop,
        ]);
        let engine = TestEngineBuilder::new(tmp.path())
            .provider(Arc::new(BudgetFixture {
                inner: ProtocolInputProvider {
                    events: source,
                    polled: Arc::new(AtomicUsize::new(0)),
                    requests: Arc::new(AtomicUsize::new(0)),
                },
                limits: small_response_limits(),
            }))
            .settings(Settings {
                permission_mode: PermissionMode::Bypass,
                ..settings_using_main_summary_runtime(Settings::default())
            })
            .tool_registry(ToolRegistry::new().register(InputEchoTool { seen: seen.clone() }))
            .build();
        engine.state.add_message(Message::user_text("run it"));
        let events = engine
            .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
            .collect::<Vec<_>>()
            .await;
        assert_eq!(
            *seen.lock().unwrap(),
            vec![expected],
            "complete start arguments must not become empty: {events:?}"
        );
    }
}

#[tokio::test]
async fn response_limits_reject_growing_tool_arguments_before_append() {
    assert_response_limit_stops_before_dispatch(
        vec![
            protocol_input_start(0),
            protocol_input_delta(0, "{\"text\":"),
            protocol_input_delta(0, "\"overflow\"}"),
            StreamEvent::ContentBlockStop { index: 0 },
            StreamEvent::MessageStop,
        ],
        kcoder_types::ProviderResponseLimits {
            tool_arguments_bytes: 12,
            ..small_response_limits()
        },
        "tool_arguments_bytes",
        3,
    )
    .await;
}

#[tokio::test]
async fn response_limits_late_total_failure_discards_already_closed_tool() {
    assert_response_limit_stops_before_dispatch(
        vec![
            protocol_input_start(0),
            protocol_input_delta(0, "{}"),
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
                    text: "文".repeat(40),
                },
            },
            StreamEvent::ContentBlockStop { index: 1 },
            StreamEvent::MessageStop,
        ],
        small_response_limits(),
        "total_decoded_bytes",
        5,
    )
    .await;
}

#[tokio::test]
async fn response_limits_count_closed_blocks_and_active_tool_cardinality() {
    assert_response_limit_stops_before_dispatch(
        vec![
            protocol_input_start(0),
            protocol_input_delta(0, "{}"),
            StreamEvent::ContentBlockStop { index: 0 },
            protocol_input_start(1),
            StreamEvent::MessageStop,
        ],
        kcoder_types::ProviderResponseLimits {
            content_blocks: 1,
            active_tool_calls: 1,
            ..small_response_limits()
        },
        "content_blocks",
        4,
    )
    .await;
    assert_response_limit_stops_before_dispatch(
        vec![
            protocol_input_start(0),
            protocol_input_start(1),
            StreamEvent::MessageStop,
        ],
        kcoder_types::ProviderResponseLimits {
            active_tool_calls: 1,
            ..small_response_limits()
        },
        "active_tool_calls",
        2,
    )
    .await;
}
