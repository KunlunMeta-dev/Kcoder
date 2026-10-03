use kcoder_types::{ContentBlock, ContentDelta, StreamEvent};

pub(crate) fn thinking_only_events() -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-thinking-only".to_string(),
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
            content_block: ContentBlock::Thinking {
                thinking: String::new(),
                signature: String::new(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::ThinkingDelta {
                thinking: "let me think about this step by step...".to_string(),
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
    ]
}

pub(crate) fn simple_text_events(text: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-text".to_string(),
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
                text: text.to_string(),
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
    ]
}

pub(crate) fn sleep_tool_call_events(seconds: u64) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "msg-sleep-tool".to_string(),
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
                id: "call-sleep".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({}),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::InputJsonDelta {
                partial_json: format!(r#"{{"command":"sleep {seconds}"}}"#),
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
    ]
}
