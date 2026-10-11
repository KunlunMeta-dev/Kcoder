use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_types::{ContentBlock, ContentDelta, MessagesRequest, StreamEvent};

#[derive(Debug)]
pub(crate) struct EmptyProvider;

impl Provider for EmptyProvider {
    fn name(&self) -> &'static str {
        "empty"
    }

    fn stream_messages(&self, _request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(crate) struct TextDraftProvider {
    pub(crate) text: String,
    pub(crate) requests: Arc<Mutex<Vec<MessagesRequest>>>,
    pub(crate) delay: Option<Duration>,
}

impl Provider for TextDraftProvider {
    fn name(&self) -> &'static str {
        "text-draft"
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let text = self.text.clone();
        let delay = self.delay;
        let stream = async_stream::stream! {
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta { text },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(crate) struct SystemPromptRecordingProvider {
    pub(crate) systems: Arc<Mutex<Vec<Option<String>>>>,
}

impl Provider for SystemPromptRecordingProvider {
    fn name(&self) -> &'static str {
        "system-recorder"
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.systems.lock().unwrap().push(request.system.clone());
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(crate) struct RequestRecordingProvider {
    pub(crate) requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for RequestRecordingProvider {
    fn name(&self) -> &'static str {
        "request-recorder"
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-ok".to_string(),
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
                content_block: ContentBlock::Text { text: "ok".to_string() },
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
pub(crate) struct StaticTextProvider {
    pub(crate) requests: Arc<Mutex<Vec<MessagesRequest>>>,
    pub(crate) text: String,
}

impl Provider for StaticTextProvider {
    fn name(&self) -> &'static str {
        "static-text"
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let text = self.text.clone();
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta { text },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(crate) struct SequentialEventsProvider {
    batches: Vec<Vec<StreamEvent>>,
    calls: Arc<Mutex<usize>>,
}

impl SequentialEventsProvider {
    pub(crate) fn new(batches: Vec<Vec<StreamEvent>>) -> (Self, Arc<Mutex<usize>>) {
        let calls = Arc::new(Mutex::new(0));
        (
            Self {
                batches,
                calls: Arc::clone(&calls),
            },
            calls,
        )
    }
}

impl Provider for SequentialEventsProvider {
    fn name(&self) -> &'static str {
        "sequential-events"
    }

    fn stream_messages(&self, _request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let mut calls = self.calls.lock().unwrap();
        let batch = self
            .batches
            .get(*calls)
            .or_else(|| self.batches.last())
            .cloned()
            .unwrap_or_default();
        *calls += 1;
        drop(calls);
        let stream = async_stream::stream! {
            for event in batch {
                yield Ok(event);
            }
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(crate) struct SummaryCountingProvider {
    pub(crate) requests: Arc<AtomicUsize>,
}

impl Provider for SummaryCountingProvider {
    fn name(&self) -> &'static str {
        "summary-counting"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        let is_compaction = request.messages.iter().any(|message| {
            message
                .preview(20_000)
                .contains("Conversation history to summarize")
        });
        let text = if is_compaction {
            "<analysis>checked</analysis><summary>auto compact summary</summary>"
        } else {
            "<summary>auto compact summary</summary>"
        }
        .to_string();
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-summary-counting".to_string(),
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
