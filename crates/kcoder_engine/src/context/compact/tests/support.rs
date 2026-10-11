use super::*;

pub(super) fn validate_compact_response(raw: &str, source_messages: &[Message]) -> Result<String> {
    validate_compact_response_with_metadata(raw, source_messages, None)
}

#[derive(Debug, Default)]
pub(super) struct RecordingProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for RecordingProvider {
    fn name(&self) -> &'static str {
        "recording"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-recording".to_string(),
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
                    text: "<analysis>scratch</analysis><summary>compact ok</summary>".to_string(),
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
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(super) struct FixedEventsProvider {
    pub(super) events: Vec<StreamEvent>,
}

impl Provider for FixedEventsProvider {
    fn name(&self) -> &'static str {
        "fixed-events"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let events = self.events.clone();
        let stream = async_stream::stream! {
            for event in events {
                yield Ok(event);
            }
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(super) struct PromptTooLongOnceProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
    pub(super) failures: usize,
}

impl Provider for PromptTooLongOnceProvider {
    fn name(&self) -> &'static str {
        "prompt-too-long-once"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let attempt = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request);
            requests.len()
        };
        let failures = self.failures;
        let stream = async_stream::stream! {
            if attempt <= failures {
                yield Ok(StreamEvent::Error {
                    error: StreamApiError {
                        error_type: "invalid_request_error".to_string(),
                        message: "prompt is too long".to_string(),
                    },
                });
            } else {
                for event in complete_text_events(
                    "<analysis>checked</analysis><summary>retry summary</summary>",
                ) {
                    yield Ok(event);
                }
            }
        };
        Ok(Box::pin(stream))
    }
}

pub(super) fn fixed_text_events(text: impl Into<String>) -> Vec<StreamEvent> {
    vec![
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::Text {
                text: String::new(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::TextDelta { text: text.into() },
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: Some("end_turn".to_string()),
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::MessageStop,
    ]
}

pub(super) fn complete_text_events(text: impl Into<String>) -> Vec<StreamEvent> {
    let mut events = fixed_text_events(text);
    events.insert(
        0,
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-complete-text".to_string(),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "test".to_string(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        },
    );
    events
}

pub(super) fn test_compactor(provider: Arc<dyn Provider>) -> ConversationCompactor {
    ConversationCompactor::new(
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
    )
}

pub(super) fn messages_with_summarizable_history() -> Vec<Message> {
    (0..8)
        .map(|i| {
            if i % 2 == 0 {
                Message::user_text(format!("user {i}"))
            } else {
                Message::assistant_text(format!("assistant {i}"))
            }
        })
        .collect()
}

pub(super) fn test_compaction_request(messages: Vec<Message>) -> CompactionRequest {
    CompactionRequest {
        messages,
        model: "main-model".to_string(),
        summary_model: None,
        summary_max_tokens: 20_000,
        custom_instructions: None,
        debug_session_id: Some("compact-regression-test".to_string()),
        prefire: None,
        emergency_split: false,
    }
}

#[derive(Debug)]
pub(super) struct TransportErrorThenSummaryProvider {
    pub(super) attempts: Arc<Mutex<usize>>,
    pub(super) failures: usize,
}

impl Provider for TransportErrorThenSummaryProvider {
    fn name(&self) -> &'static str {
        "transport-error-then-summary"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let attempt = {
            let mut attempts = self.attempts.lock().unwrap();
            let attempt = *attempts;
            *attempts += 1;
            attempt
        };
        let failures = self.failures;
        let stream = async_stream::stream! {
            if attempt < failures {
                yield Err(ApiErrorKind::SseStream {
                    error_type: "sse_stream_error".to_string(),
                    message: "Transport error: error decoding response body".to_string(),
                    kind: kcoder_api::SseErrorKind::Transport(kcoder_api::NonHttpErrorClass::Transient),
                });
            } else {
                for event in complete_text_events(
                    "<analysis>checked</analysis><summary>transport retry summary</summary>",
                ) {
                    yield Ok(event);
                }
            }
        };
        Ok(Box::pin(stream))
    }
}
