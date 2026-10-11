use super::*;

#[tokio::test]
async fn compact_uses_summary_model_and_token_budget() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(RecordingProvider {
        requests: Arc::clone(&requests),
    });
    let compactor = ConversationCompactor::new(
        provider,
        ContextBudget {
            total: 100_000,
            system: 1_000,
            tools: 1_000,
            reserved_output: 1_000,
            messages: 97_000,
            auto_compact_threshold: None,
            hard_input_limit: None,
            prefire_threshold: None,
            estimated_tool_growth: 15_000,
        },
    );
    let messages: Vec<Message> = (0..8)
        .map(|i| {
            if i % 2 == 0 {
                Message::user_text(format!("user {i}"))
            } else {
                Message::assistant_text(format!("assistant {i}"))
            }
        })
        .collect();

    let result = compactor
        .compact(
            CompactionRequest {
                messages,
                model: "main-model".to_string(),
                summary_model: Some("summary-small".to_string()),
                summary_max_tokens: 12_345,
                custom_instructions: None,
                debug_session_id: Some("compact-test".to_string()),
                prefire: None,
                emergency_split: false,
            },
            50_000,
        )
        .await
        .unwrap();

    assert_eq!(result.summary, "compact ok");
    assert!(result.did_compact);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].model, "summary-small");
    assert_eq!(requests[0].max_tokens, 12_345);
}

#[tokio::test]
async fn compact_recompresses_and_replaces_prior_summary() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(RecordingProvider {
        requests: Arc::clone(&requests),
    });
    let compactor = ConversationCompactor::new(
        provider,
        ContextBudget {
            total: 100_000,
            system: 1_000,
            tools: 1_000,
            reserved_output: 1_000,
            messages: 97_000,
            auto_compact_threshold: None,
            hard_input_limit: None,
            prefire_threshold: None,
            estimated_tool_growth: 15_000,
        },
    );
    let messages = vec![
        Message::compaction_text(format_compact_summary_message("PRIOR_ONLY summary")),
        Message::user_text("new old user 1"),
        Message::assistant_text("new old assistant 1"),
        Message::user_text("new old user 2"),
        Message::assistant_text("new old assistant 2"),
        Message::user_text("recent user 3"),
        Message::assistant_text("recent assistant 3"),
    ];

    let result = compactor
        .compact(
            CompactionRequest {
                messages,
                model: "main-model".to_string(),
                summary_model: None,
                summary_max_tokens: 20_000,
                custom_instructions: None,
                debug_session_id: Some("compact-test".to_string()),
                prefire: None,
                emergency_split: false,
            },
            50_000,
        )
        .await
        .unwrap();

    assert_eq!(result.summary, "compact ok");
    assert_eq!(result.messages.len(), 5);
    assert!(result.messages[0].preview(20_000).contains("compact ok"));
    assert!(
        !result.messages[0]
            .preview(20_000)
            .contains("PRIOR_ONLY summary")
    );
    assert!(
        !result.messages[0]
            .preview(20_000)
            .contains("stale project instructions")
    );

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let prompt = requests[0].messages[0].preview(20_000);
    assert!(prompt.contains("new old user 1"));
    assert!(prompt.contains("new old assistant 1"));
    assert!(prompt.contains("PRIOR_ONLY summary"));
}

#[tokio::test]
async fn ptl_retry_preserves_latest_boundary_summary_in_retry_prompt() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let compactor = test_compactor(Arc::new(PromptTooLongOnceProvider {
        requests: Arc::clone(&requests),
        failures: 1,
    }));
    let messages = vec![
        Message::compaction_text(format_compact_summary_message(
            "PRIOR_BOUNDARY_FACT that must survive PTL retry",
        )),
        Message::user_text("old user one"),
        Message::assistant_text("old assistant one"),
        Message::user_text("old user two"),
        Message::assistant_text("old assistant two"),
        Message::user_text("old user three"),
        Message::assistant_text("old assistant three"),
        Message::user_text("recent user"),
        Message::assistant_text("recent assistant"),
    ];

    let result = compactor
        .compact(test_compaction_request(messages), 50_000)
        .await
        .expect("the second compaction attempt should succeed");
    assert_eq!(result.summary, "retry summary");

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let first_prompt = requests[0].messages[0].preview(50_000);
    let retry_prompt = requests[1].messages[0].preview(50_000);
    assert!(first_prompt.contains("PRIOR_BOUNDARY_FACT"));
    assert!(
        retry_prompt.contains("PRIOR_BOUNDARY_FACT"),
        "PTL retry must not discard the only representation of pre-boundary history"
    );
}

#[tokio::test]
async fn repeated_ptl_retries_preserve_boundary_and_single_marker() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let compactor = test_compactor(Arc::new(PromptTooLongOnceProvider {
        requests: Arc::clone(&requests),
        failures: 3,
    }));
    let mut messages = vec![Message::compaction_text(format_compact_summary_message(
        "BOUNDARY_SURVIVES_ALL_RETRIES",
    ))];
    for index in 0..8 {
        messages.push(Message::user_text(format!("suffix user {index}")));
        messages.push(Message::assistant_text(format!("suffix assistant {index}")));
    }

    let result = compactor
        .compact(test_compaction_request(messages), 100_000)
        .await
        .expect("fourth attempt should succeed after three PTL responses");
    assert_eq!(result.summary, "retry summary");

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    for request in requests.iter() {
        let prompt = request.messages[0].preview(100_000);
        assert!(prompt.contains("BOUNDARY_SURVIVES_ALL_RETRIES"));
        assert!(prompt.matches(PTL_RETRY_MARKER).count() <= 1);
    }
    assert!(
        !requests[1].messages[0]
            .preview(100_000)
            .contains("suffix user 0")
    );
    assert!(
        !requests[2].messages[0]
            .preview(100_000)
            .contains("suffix user 1"),
        "the second PTL retry must drop another real suffix turn, not only recycle the marker"
    );
    assert!(
        !requests[3].messages[0]
            .preview(100_000)
            .contains("suffix user 2"),
        "the third PTL retry must continue making progress through the suffix"
    );
}

#[tokio::test]
async fn repeated_ptl_without_boundary_drops_a_real_turn_each_time() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let compactor = test_compactor(Arc::new(PromptTooLongOnceProvider {
        requests: Arc::clone(&requests),
        failures: 3,
    }));
    let mut messages = Vec::new();
    for index in 0..9 {
        messages.push(Message::user_text(format!("raw user {index}")));
        messages.push(Message::assistant_text(format!("raw assistant {index}")));
    }

    let result = compactor
        .compact(test_compaction_request(messages), 100_000)
        .await
        .expect("fourth attempt should succeed after progressive raw-history trimming");
    assert_eq!(result.summary, "retry summary");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(
        !requests[1].messages[0]
            .preview(100_000)
            .contains("raw user 0")
    );
    assert!(
        !requests[2].messages[0]
            .preview(100_000)
            .contains("raw user 1")
    );
    assert!(
        !requests[3].messages[0]
            .preview(100_000)
            .contains("raw user 2")
    );
    for request in requests.iter().skip(1) {
        assert_eq!(
            request.messages[0]
                .preview(100_000)
                .matches(PTL_RETRY_MARKER)
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn repeated_ptl_stops_safely_when_suffix_becomes_insufficient() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let compactor = test_compactor(Arc::new(PromptTooLongOnceProvider {
        requests: Arc::clone(&requests),
        failures: 3,
    }));
    let messages = vec![
        Message::compaction_text(format_compact_summary_message("BOUNDARY_REMAINS")),
        Message::user_text("droppable suffix one"),
        Message::assistant_text("droppable response one"),
        Message::user_text("droppable suffix two"),
        Message::assistant_text("droppable response two"),
        Message::user_text("preserved suffix three"),
        Message::assistant_text("preserved response three"),
        Message::user_text("recent user"),
        Message::assistant_text("recent response"),
    ];

    let result = compactor
        .compact(test_compaction_request(messages), 50_000)
        .await;
    assert!(
        result.is_err(),
        "PTL must fail once no further suffix group is safe to drop"
    );
    let requests = requests.lock().unwrap();
    assert!(requests.len() >= 2);
    for request in requests.iter() {
        let prompt = request.messages[0].preview(50_000);
        assert!(prompt.contains("BOUNDARY_REMAINS"));
        assert!(prompt.matches(PTL_RETRY_MARKER).count() <= 1);
    }
}

#[tokio::test]
async fn repeated_compactions_keep_exactly_one_replacement_summary() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let compactor = test_compactor(Arc::new(RecordingProvider {
        requests: Arc::clone(&requests),
    }));
    let mut messages = messages_with_summarizable_history();

    for pass in 0..3 {
        let result = compactor
            .compact(test_compaction_request(messages), 50_000)
            .await
            .expect("each compaction pass should succeed");
        assert_eq!(result.summary, "compact ok");
        assert!(
            result.post_compact_tokens < result.pre_compact_tokens,
            "pass {pass} must strictly reduce the reported context"
        );
        assert_eq!(
            result
                .messages
                .iter()
                .filter(|message| compact_summary_text(message).is_some())
                .count(),
            1,
            "pass {pass} must leave exactly one replacement summary"
        );
        assert_eq!(
            result.messages[0]
                .preview(50_000)
                .matches("compact ok")
                .count(),
            1,
            "pass {pass} must not concatenate the previous summary"
        );
        messages = result.messages;
        messages.push(Message::user_text(format!("new suffix user {pass} a")));
        messages.push(Message::assistant_text(format!(
            "new suffix assistant {pass} a"
        )));
        messages.push(Message::user_text(format!("new suffix user {pass} b")));
        messages.push(Message::assistant_text(format!(
            "new suffix assistant {pass} b"
        )));
    }

    assert_eq!(requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn ptl_retry_with_insufficient_suffix_fails_without_dropping_boundary() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let compactor = test_compactor(Arc::new(PromptTooLongOnceProvider {
        requests: Arc::clone(&requests),
        failures: 1,
    }));
    let messages = vec![
        Message::compaction_text(format_compact_summary_message("ONLY_BOUNDARY_COPY")),
        Message::user_text("old suffix"),
        Message::assistant_text("old suffix response"),
        Message::user_text("recent user"),
        Message::assistant_text("recent response"),
    ];

    let result = compactor
        .compact(test_compaction_request(messages), 50_000)
        .await;
    assert!(result.is_err(), "insufficient suffix must fail safely");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].messages[0]
            .preview(50_000)
            .contains("ONLY_BOUNDARY_COPY")
    );
}

#[tokio::test]
async fn compact_rejects_result_that_does_not_reduce_tokens() {
    let oversized_summary = "summary expansion ".repeat(2_000);
    let provider = Arc::new(FixedEventsProvider {
        events: complete_text_events(format!(
            "<analysis>checked</analysis><summary>{oversized_summary}</summary>"
        )),
    });
    let compactor = test_compactor(provider);
    let messages = messages_with_summarizable_history();
    let pre_compact_tokens = TokenCounter::count(&messages);

    let result = compactor
        .compact(test_compaction_request(messages), pre_compact_tokens)
        .await;

    assert!(
        result.is_err(),
        "a non-reducing compaction must not be reported as successful"
    );
}

#[tokio::test]
async fn compact_keeps_prior_summary_when_nothing_after_boundary_can_be_summarized() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(RecordingProvider {
        requests: Arc::clone(&requests),
    });
    let compactor = ConversationCompactor::new(
        provider,
        ContextBudget {
            total: 100_000,
            system: 1_000,
            tools: 1_000,
            reserved_output: 1_000,
            messages: 97_000,
            auto_compact_threshold: None,
            hard_input_limit: None,
            prefire_threshold: None,
            estimated_tool_growth: 15_000,
        },
    );
    let messages = vec![
        Message::compaction_text(format_compact_summary_message("prior summary")),
        Message::user_text("recent user"),
        Message::assistant_text("recent assistant"),
    ];

    let result = compactor
        .compact(
            CompactionRequest {
                messages,
                model: "main-model".to_string(),
                summary_model: None,
                summary_max_tokens: 20_000,
                custom_instructions: None,
                debug_session_id: Some("compact-test".to_string()),
                prefire: None,
                emergency_split: false,
            },
            50_000,
        )
        .await
        .unwrap();

    assert_eq!(requests.lock().unwrap().len(), 0);
    assert_eq!(result.summary, "prior summary");
    assert!(!result.did_compact);
    assert_eq!(result.messages.len(), 3);
    assert!(result.messages[0].preview(20_000).contains("prior summary"));
    assert!(result.messages[1].preview(20_000).contains("recent user"));
    assert!(
        result.messages[2]
            .preview(20_000)
            .contains("recent assistant")
    );
}

#[derive(Debug)]
struct PromptTooLongThenSummaryProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    attempts: Arc<Mutex<usize>>,
}

impl Provider for PromptTooLongThenSummaryProvider {
    fn name(&self) -> &'static str {
        "ptl-then-summary"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let attempt = {
            let mut attempts = self.attempts.lock().unwrap();
            let attempt = *attempts;
            *attempts += 1;
            attempt
        };
        let stream = async_stream::stream! {
            if attempt == 0 {
                yield Ok(StreamEvent::Error {
                    error: StreamApiError {
                        error_type: "invalid_request_error".to_string(),
                        message: "prompt is too long".to_string(),
                    },
                });
            } else {
                yield Ok(StreamEvent::MessageStart {
                    message: kcoder_types::StreamingMessage {
                        id: "msg-ptl-retry".to_string(),
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
                        text: "<analysis>checked retry</analysis><summary>retry compact ok</summary>".to_string(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageDelta {
                    delta: MessageDeltaFields {
                        stop_reason: Some("end_turn".to_string()),
                        stop_sequence: None,
                        usage: None,
                    },
                });
                yield Ok(StreamEvent::MessageStop);
            }
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn compact_retries_prompt_too_long_with_truncated_history() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(PromptTooLongThenSummaryProvider {
        requests: Arc::clone(&requests),
        attempts: Arc::new(Mutex::new(0)),
    });
    let compactor = ConversationCompactor::new(
        provider,
        ContextBudget {
            total: 100_000,
            system: 1_000,
            tools: 1_000,
            reserved_output: 1_000,
            messages: 97_000,
            auto_compact_threshold: None,
            hard_input_limit: None,
            prefire_threshold: None,
            estimated_tool_growth: 15_000,
        },
    );
    let messages: Vec<Message> = (0..10)
        .map(|i| {
            if i % 2 == 0 {
                Message::user_text(format!("user {i}"))
            } else {
                Message::assistant_text(format!("assistant {i}"))
            }
        })
        .collect();

    let result = compactor
        .compact(
            CompactionRequest {
                messages,
                model: "main-model".to_string(),
                summary_model: None,
                summary_max_tokens: 20_000,
                custom_instructions: None,
                debug_session_id: Some("compact-test".to_string()),
                prefire: None,
                emergency_split: false,
            },
            50_000,
        )
        .await
        .unwrap();

    assert_eq!(result.summary, "retry compact ok");
    assert!(result.did_compact);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let retry_prompt = requests[1].messages[0].preview(20_000);
    assert!(retry_prompt.contains(PTL_RETRY_MARKER));
    assert!(!retry_prompt.contains("user 0"));
    assert!(!retry_prompt.contains("assistant 1"));
    assert!(retry_prompt.contains("user 2"));
}

struct TypedSummaryFailureProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    error: Mutex<std::collections::VecDeque<ApiErrorKind>>,
    at_start: bool,
}

#[tokio::test]
async fn compact_accepts_valid_summary_starting_with_prompt_too_long() {
    struct SummaryProvider(Arc<Mutex<usize>>);
    impl Provider for SummaryProvider {
        fn name(&self) -> &'static str {
            "summary-prefix"
        }
        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> std::result::Result<kcoder_api::ProviderStream, ApiErrorKind> {
            *self.0.lock().unwrap() += 1;
            Ok(Box::pin(futures::stream::iter(
                complete_text_events(
                    "<summary>prompt is too long was the error investigated by the user</summary>",
                )
                .into_iter()
                .map(Ok),
            )))
        }
    }
    let calls = Arc::new(Mutex::new(0));
    let compactor = test_compactor(Arc::new(SummaryProvider(calls.clone())));
    let result = compactor
        .compact(
            test_compaction_request(messages_with_summarizable_history()),
            50_000,
        )
        .await;
    assert_eq!(*calls.lock().unwrap(), 1);
    assert_eq!(
        result.unwrap().summary,
        "prompt is too long was the error investigated by the user"
    );
}

impl Provider for TypedSummaryFailureProvider {
    fn name(&self) -> &'static str {
        "typed-summary-failure"
    }
    fn supports_response_json_schema(&self) -> bool {
        true
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, ApiErrorKind> {
        let structured = request.response_json_schema.is_some();
        self.requests.lock().unwrap().push(request);
        let error = self.error.lock().unwrap().pop_front();
        if self.at_start {
            if let Some(error) = error {
                return Err(error);
            }
        } else if let Some(error) = error {
            return Ok(Box::pin(futures::stream::iter(vec![Err(error)])));
        }
        Ok(Box::pin(futures::stream::iter(
            complete_text_events(if structured {
                r#"{"summary":"typed recovery"}"#
            } else {
                "<summary>typed recovery</summary>"
            })
            .into_iter()
            .map(Ok),
        )))
    }
}

fn typed_summary_http(status: u16, message: &str) -> ApiErrorKind {
    ApiErrorKind::Http {
        error_type: "api_error".into(),
        message: message.into(),
        metadata: kcoder_api::HttpErrorMetadata {
            status,
            provider_code: None,
            provider_type: None,
            rejected_reasoning_parameter: None,
            retry_after: None,
        },
    }
}

#[test]
fn provider_error_summary_compaction_unknown_reference_and_stop_reason_are_private() {
    let error = validate_compact_response_with_metadata(
        "<summary>[Tool use SENTINEL_PRIVATE: private]</summary>",
        &[],
        Some("SENTINEL_PRIVATE"),
    )
    .unwrap_err();
    assert!(!format!("{error:#} {error:?}").contains("SENTINEL_PRIVATE"));
    let details = compaction_protocol_details(&error).unwrap();
    assert_eq!(details.reason, "invalid_tool_reference");
    assert_eq!(details.opening_summary_tags, 1);
    assert!(!details.response_fingerprint.is_empty());
    assert_eq!(details.stop_reason, None);
}

#[tokio::test]
async fn compact_typed_context_and_transient_budgets_remain_finite() {
    for at_start in [true, false] {
        for status in [400, 503] {
            let requests = Arc::new(Mutex::new(Vec::new()));
            let errors = (0..10)
                .map(|_| {
                    let mut error = typed_summary_http(status, "opaque");
                    if let ApiErrorKind::Http { metadata, .. } = &mut error {
                        metadata.retry_after = Some(std::time::Duration::ZERO);
                        if status == 400 {
                            metadata.provider_code = Some("context_length_exceeded".into());
                        }
                    }
                    error
                })
                .collect();
            let compactor = test_compactor(Arc::new(TypedSummaryFailureProvider {
                requests: requests.clone(),
                error: Mutex::new(errors),
                at_start,
            }));
            let messages = (0..30)
                .map(|i| {
                    if i % 2 == 0 {
                        Message::user_text(format!("user {i}"))
                    } else {
                        Message::assistant_text(format!("assistant {i}"))
                    }
                })
                .collect();
            let result = compactor
                .compact(test_compaction_request(messages), 50_000)
                .await;
            assert!(result.is_err());
            assert_eq!(
                requests.lock().unwrap().len(),
                1 + if status == 400 {
                    MAX_PTL_RETRIES
                } else {
                    MAX_TRANSPORT_RETRIES
                }
            );
        }
    }
}

#[tokio::test]
async fn compact_typed_retry_wait_can_be_cancelled_by_dropping_future() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut error = typed_summary_http(429, "opaque");
    if let ApiErrorKind::Http { metadata, .. } = &mut error {
        metadata.retry_after = Some(std::time::Duration::from_secs(10));
    }
    let compactor = test_compactor(Arc::new(TypedSummaryFailureProvider {
        requests: requests.clone(),
        error: Mutex::new([error].into()),
        at_start: false,
    }));
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(20),
            compactor.compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
        )
        .await
        .is_err()
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn compact_typed_unknown_parameter_cannot_enable_schema_fallback() {
    for (at_start, code) in [
        (true, Some("unknown_parameter")),
        (false, Some("unknown_parameter")),
        (true, Some("unsupported_parameter")),
        (false, Some("unsupported_parameter")),
        (true, None),
        (false, None),
    ] {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut error = typed_summary_http(400, "response_format unsupported timeout");
        if let ApiErrorKind::Http { metadata, .. } = &mut error {
            metadata.provider_code = code.map(str::to_owned);
            metadata.provider_type = Some("invalid_request_error".into());
        }
        let compactor = test_compactor(Arc::new(TypedSummaryFailureProvider {
            requests: requests.clone(),
            error: Mutex::new([error].into()),
            at_start,
        }));
        let result = compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await;
        let requests = requests.lock().unwrap();
        if code.is_some() {
            assert!(result.is_err());
            assert_eq!(requests.len(), 1);
        } else {
            assert_eq!(result.unwrap().summary, "typed recovery");
            assert_eq!(requests.len(), 2);
            assert!(requests[0].response_json_schema.is_some());
            assert!(requests[1].response_json_schema.is_none());
        }
    }
}

#[tokio::test]
async fn compact_typed_zero_retry_after_differs_from_default_backoff() {
    for hint in [Some(std::time::Duration::ZERO), None] {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut error = typed_summary_http(429, "opaque");
        if let ApiErrorKind::Http { metadata, .. } = &mut error {
            metadata.retry_after = hint;
        }
        let compactor = test_compactor(Arc::new(TypedSummaryFailureProvider {
            requests,
            error: Mutex::new([error].into()),
            at_start: true,
        }));
        let start = std::time::Instant::now();
        let result = compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
            .unwrap();
        let delay = result.provider_retries[0].retry_after_ms;
        if hint.is_some() {
            assert_eq!(delay, 0);
        } else {
            assert!((100..125).contains(&delay));
        }
        assert!(start.elapsed() >= std::time::Duration::from_millis(delay));
    }
}

#[tokio::test]
async fn compact_typed_permanent_errors_do_not_retry_or_truncate() {
    for at_start in [true, false] {
        for (status, text) in [
            (401, "timeout"),
            (403, "prompt is too long"),
            (404, "response_format unsupported"),
            (418, "timeout"),
            (400, "prompt is too long response_format unsupported"),
        ] {
            let requests = Arc::new(Mutex::new(Vec::new()));
            let compactor = test_compactor(Arc::new(TypedSummaryFailureProvider {
                requests: requests.clone(),
                error: Mutex::new(
                    [{
                        let mut error = typed_summary_http(status, text);
                        if status == 400
                            && let ApiErrorKind::Http { metadata, .. } = &mut error
                        {
                            metadata.provider_code = Some("unsupported_parameter".into());
                            metadata.rejected_reasoning_parameter =
                                Some(kcoder_api::RejectedReasoningParameter::Thinking);
                        }
                        error
                    }]
                    .into(),
                ),
                at_start,
            }));
            let result = compactor
                .compact(
                    test_compaction_request(messages_with_summarizable_history()),
                    50_000,
                )
                .await;
            assert!(result.is_err(), "{status} at_start={at_start}");
            assert_eq!(
                requests.lock().unwrap().len(),
                1,
                "{status} at_start={at_start}"
            );
        }
    }
}

#[tokio::test]
async fn compact_typed_opaque_transient_recovers_and_waits() {
    for at_start in [true, false] {
        for (status, message) in [(503, "opaque"), (429, "opaque"), (503, "opaque timeout")] {
            let requests = Arc::new(Mutex::new(Vec::new()));
            let mut error = typed_summary_http(status, message);
            if let ApiErrorKind::Http { metadata, .. } = &mut error {
                metadata.retry_after = Some(std::time::Duration::from_millis(30));
            }
            let compactor = test_compactor(Arc::new(TypedSummaryFailureProvider {
                requests: requests.clone(),
                error: Mutex::new([error].into()),
                at_start,
            }));
            let start = std::time::Instant::now();
            let result = compactor
                .compact(
                    test_compaction_request(messages_with_summarizable_history()),
                    50_000,
                )
                .await
                .unwrap();
            assert!(start.elapsed() >= std::time::Duration::from_millis(30));
            assert_eq!(result.provider_retries[0].retry_after_ms, 30);
            assert_eq!(result.provider_retries[0].timeout_kind, None);
            assert_eq!(requests.lock().unwrap().len(), 2);
        }
    }
}

#[tokio::test]
async fn compact_typed_context_code_truncates_and_unknown_api_stops() {
    for at_start in [true, false] {
        for context_error in [true, false] {
            let requests = Arc::new(Mutex::new(Vec::new()));
            let error = if context_error {
                let mut error = typed_summary_http(400, "opaque");
                if let ApiErrorKind::Http { metadata, .. } = &mut error {
                    metadata.provider_code = Some("context_length_exceeded".into());
                }
                error
            } else {
                ApiErrorKind::Api {
                    error_type: "unknown".into(),
                    message: "timeout prompt is too long response_format unsupported".into(),
                }
            };
            let compactor = test_compactor(Arc::new(TypedSummaryFailureProvider {
                requests: requests.clone(),
                error: Mutex::new([error].into()),
                at_start,
            }));
            let result = compactor
                .compact(
                    test_compaction_request(messages_with_summarizable_history()),
                    50_000,
                )
                .await;
            let requests = requests.lock().unwrap();
            if context_error {
                assert!(result.is_ok(), "{result:?}");
                assert_eq!(requests.len(), 2);
                assert!(
                    requests[1].messages[0]
                        .preview(usize::MAX)
                        .contains(PTL_RETRY_MARKER)
                );
            } else {
                assert!(result.is_err());
                assert_eq!(requests.len(), 1);
            }
        }
    }
}

fn compact_with_transport_failures(
    failures: usize,
) -> (
    tokio::task::JoinHandle<Result<CompactionResult>>,
    Arc<Mutex<usize>>,
) {
    let attempts = Arc::new(Mutex::new(0));
    let provider = Arc::new(TransportErrorThenSummaryProvider {
        attempts: Arc::clone(&attempts),
        failures,
    });
    let compactor = test_compactor(provider);
    let handle = tokio::spawn(async move {
        compactor
            .compact(
                test_compaction_request(messages_with_summarizable_history()),
                50_000,
            )
            .await
    });
    (handle, attempts)
}

#[tokio::test]
async fn compact_retries_transient_transport_errors_within_budget() {
    let (handle, attempts) = compact_with_transport_failures(MAX_TRANSPORT_RETRIES);
    let result = handle
        .await
        .unwrap()
        .expect("transport blips within the retry budget must not fail compaction");
    assert!(result.did_compact);
    assert_eq!(result.summary, "transport retry summary");
    assert_eq!(*attempts.lock().unwrap(), 1 + MAX_TRANSPORT_RETRIES);
    assert_eq!(result.provider_retries.len(), MAX_TRANSPORT_RETRIES);
    assert!(result.provider_retries.iter().all(|retry| {
        retry.request_kind == "summary"
            && retry.attempt >= 1
            && retry.attempt <= MAX_TRANSPORT_RETRIES
    }));
}

#[test]
fn compaction_stream_idle_is_a_retryable_transport_failure() {
    let error = anyhow::Error::new(ApiErrorKind::Api {
        error_type: "stream_idle_timeout".into(),
        message: "stream idle for more than 180s".into(),
    })
    .context("stream error during compaction");

    assert!(is_transient_compaction_transport_error(&error));
}

#[tokio::test]
async fn compact_gives_up_after_transport_retry_budget() {
    let (handle, attempts) = compact_with_transport_failures(MAX_TRANSPORT_RETRIES + 1);
    let error = handle
        .await
        .unwrap()
        .expect_err("persistent transport failures must exhaust the retry budget");
    assert!(format!("{error:#}").contains("sse_stream_error"));
    assert_eq!(*attempts.lock().unwrap(), 1 + MAX_TRANSPORT_RETRIES);
}
