use kcoder_types::{ContentBlock, MessagesRequest};

pub(crate) struct EmptyProvider;

impl kcoder_api::Provider for EmptyProvider {
    fn name(&self) -> &'static str {
        "empty"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        Ok(Box::pin(futures::stream::empty()))
    }
}

pub(crate) struct CompactSummaryProvider;

impl kcoder_api::Provider for CompactSummaryProvider {
    fn name(&self) -> &'static str {
        "compact-summary"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = futures::stream::iter([
            Ok(kcoder_types::StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "compact-summary-message".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            }),
            Ok(kcoder_types::StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: String::new(),
                },
            }),
            Ok(kcoder_types::StreamEvent::ContentBlockDelta {
                index: 0,
                delta: kcoder_types::ContentDelta::TextDelta {
                    text: "<analysis>checked</analysis><summary>compact ok</summary>".to_string(),
                },
            }),
            Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 }),
            Ok(kcoder_types::StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            }),
            Ok(kcoder_types::StreamEvent::MessageStop),
        ]);
        Ok(Box::pin(stream))
    }
}

pub(crate) struct PendingCompactSummaryProvider;

impl kcoder_api::Provider for PendingCompactSummaryProvider {
    fn name(&self) -> &'static str {
        "pending-compact-summary"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        Ok(Box::pin(futures::stream::pending()))
    }
}
