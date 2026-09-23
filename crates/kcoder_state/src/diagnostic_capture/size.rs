use kcoder_types::*;
use serde_json::Value;
use std::mem::size_of;

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_NODES: usize = 65_536;
const MAX_DEPTH: usize = 32;

#[derive(Default)]
struct Budget {
    bytes: usize,
    nodes: usize,
}

impl Budget {
    fn add(&mut self, bytes: usize) -> Option<()> {
        self.bytes = self.bytes.saturating_add(bytes);
        (self.bytes <= MAX_BYTES).then_some(())
    }
    fn node(&mut self, depth: usize) -> Option<()> {
        self.nodes = self.nodes.saturating_add(1);
        (depth <= MAX_DEPTH && self.nodes <= MAX_NODES).then_some(())
    }
    fn string(&mut self, text: &String) -> Option<()> {
        self.add(text.capacity())
    }
    fn optional_string(&mut self, text: &Option<String>) -> Option<()> {
        if let Some(text) = text {
            self.string(text)?;
        }
        Some(())
    }
    fn vector<T>(&mut self, values: &Vec<T>) -> Option<()> {
        self.add(values.capacity().saturating_mul(size_of::<T>()))
    }
    fn json(&mut self, value: &Value, depth: usize) -> Option<()> {
        self.node(depth)?;
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
            Value::String(value) => self.string(value)?,
            Value::Array(values) => {
                self.vector(values)?;
                for value in values {
                    self.json(value, depth + 1)?;
                }
            }
            Value::Object(values) => {
                // BTreeMap nodes have spare keys, values and child pointers.
                self.add(values.len().saturating_add(1).saturating_mul(512))?;
                for (key, value) in values {
                    self.string(key)?;
                    self.json(value, depth + 1)?;
                }
            }
        }
        Some(())
    }
    fn usage(&mut self, usage: &Option<Usage>) -> Option<()> {
        if let Some(Usage {
            input_tokens: _,
            output_tokens: _,
            total_tokens: _,
            cache_creation_input_tokens: _,
            cache_read_input_tokens: _,
            iterations,
        }) = usage
        {
            if let Some(iterations) = iterations {
                self.vector(iterations)?;
                self.nodes = self.nodes.saturating_add(iterations.len());
                if self.nodes > MAX_NODES {
                    return None;
                }
            }
        }
        Some(())
    }
    fn blocks(&mut self, blocks: &Vec<ContentBlock>, depth: usize) -> Option<()> {
        self.vector(blocks)?;
        for block in blocks {
            self.block(block, depth)?;
        }
        Some(())
    }
    fn block(&mut self, block: &ContentBlock, depth: usize) -> Option<()> {
        self.node(depth)?;
        match block {
            ContentBlock::Text { text } => self.string(text)?,
            ContentBlock::ToolUse { id, name, input } => {
                self.string(id)?;
                self.string(name)?;
                self.json(input, depth + 1)?;
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error: _,
            } => {
                self.string(tool_use_id)?;
                self.blocks(content, depth + 1)?;
            }
            ContentBlock::Image {
                source:
                    ImageSource {
                        source_type,
                        media_type,
                        data,
                    },
            } => {
                self.string(source_type)?;
                self.string(media_type)?;
                self.string(data)?;
            }
            ContentBlock::Thinking {
                thinking,
                signature,
            } => {
                self.string(thinking)?;
                self.string(signature)?;
            }
            ContentBlock::RedactedThinking { data } => self.string(data)?,
        }
        Some(())
    }
}

pub(super) fn request(request: &MessagesRequest) -> Option<usize> {
    let MessagesRequest {
        path_first_tools: _,
        model,
        max_tokens: _,
        messages,
        stream: _,
        system,
        tools,
        reasoning_effort,
        recovery_disable_reasoning: _,
        response_json_schema,
        debug_session_id,
        trajectory_agent_depth: _,
    } = request;
    let mut budget = Budget::default();
    budget.add(size_of::<MessagesRequest>().saturating_add(2 * size_of::<usize>()))?;
    budget.string(model)?;
    budget.add(messages.retained_shallow_bytes())?;
    for message in messages {
        budget.node(0)?;
        match message {
            Message::User { content } => budget.blocks(content, 0)?,
            Message::Assistant { content, usage } => {
                budget.blocks(content, 0)?;
                budget.usage(usage)?;
            }
        }
    }
    budget.optional_string(system)?;
    budget.vector(tools)?;
    for ToolDefinition {
        name,
        description,
        input_schema,
    } in tools
    {
        budget.node(0)?;
        budget.string(name)?;
        budget.string(description)?;
        budget.json(input_schema, 0)?;
    }
    if let Some(effort) = reasoning_effort {
        match effort {
            ReasoningEffort::Custom(value) => budget.string(value)?,
            ReasoningEffort::None
            | ReasoningEffort::Minimal
            | ReasoningEffort::Low
            | ReasoningEffort::Medium
            | ReasoningEffort::High
            | ReasoningEffort::XHigh => {}
        }
    }
    if let Some(ResponseJsonSchema {
        name,
        description,
        schema,
        strict: _,
    }) = response_json_schema
    {
        budget.string(name)?;
        budget.optional_string(description)?;
        budget.json(schema, 0)?;
    }
    budget.optional_string(debug_session_id)?;
    Some(budget.bytes)
}

pub(super) fn event(event: &StreamEvent) -> Option<usize> {
    let mut budget = Budget::default();
    budget.add(size_of::<StreamEvent>())?;
    match event {
        StreamEvent::MessageStart {
            message:
                StreamingMessage {
                    id,
                    role,
                    content,
                    model,
                    stop_reason,
                    stop_sequence,
                    usage,
                },
        } => {
            budget.string(id)?;
            budget.string(role)?;
            budget.blocks(content, 0)?;
            budget.string(model)?;
            budget.optional_string(stop_reason)?;
            budget.optional_string(stop_sequence)?;
            budget.usage(usage)?;
        }
        StreamEvent::ContentBlockStart {
            index: _,
            content_block,
        } => budget.block(content_block, 0)?,
        StreamEvent::ContentBlockDelta { index: _, delta } => match delta {
            ContentDelta::TextDelta { text } => budget.string(text)?,
            ContentDelta::ThinkingDelta { thinking } => budget.string(thinking)?,
            ContentDelta::SignatureDelta { signature } => budget.string(signature)?,
            ContentDelta::InputJsonDelta { partial_json } => budget.string(partial_json)?,
        },
        StreamEvent::MessageDelta {
            delta:
                MessageDeltaFields {
                    stop_reason,
                    stop_sequence,
                    usage,
                },
        } => {
            budget.optional_string(stop_reason)?;
            budget.optional_string(stop_sequence)?;
            budget.usage(usage)?;
        }
        StreamEvent::Error {
            error: ApiError {
                error_type,
                message,
            },
        } => {
            budget.string(error_type)?;
            budget.string(message)?;
        }
        StreamEvent::ContentBlockStop { index: _ }
        | StreamEvent::MessageStop
        | StreamEvent::Ping => {}
    }
    Some(budget.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_accounts_for_capacity_and_skipped_provider_fields() {
        let mut value = MessagesRequest::new("model", Vec::new());
        let base = request(&value).unwrap();
        value.system = Some(String::with_capacity(4096));
        value.debug_session_id = Some(String::with_capacity(8192));
        value.reasoning_effort = Some(ReasoningEffort::Custom(String::with_capacity(16384)));
        value.response_json_schema = Some(
            ResponseJsonSchema::new("schema", Value::String(String::with_capacity(32768)))
                .with_description("description"),
        );
        assert!(request(&value).unwrap() >= base + 4096 + 8192 + 16384 + 32768);
        value.messages.reserve(10);
        assert!(
            request(&value).unwrap()
                >= base + value.messages.capacity() * size_of::<std::sync::Arc<Message>>()
        );
    }

    #[test]
    fn depth_and_node_limits_reject_json_content_and_usage_iterations() {
        let mut schema = Value::Null;
        for _ in 0..1000 {
            schema = Value::Array(vec![schema]);
        }
        let value = MessagesRequest::new("model", Vec::new())
            .with_response_json_schema(ResponseJsonSchema::new("deep", schema));
        assert!(request(&value).is_none());
        let mut block = ContentBlock::Text {
            text: "leaf".into(),
        };
        for _ in 0..100 {
            block = ContentBlock::ToolResult {
                tool_use_id: "id".into(),
                content: vec![block],
                is_error: None,
            };
        }
        assert!(
            event(&StreamEvent::ContentBlockStart {
                index: 0,
                content_block: block
            })
            .is_none()
        );
        let schema = Value::Array(vec![Value::Null; MAX_NODES + 1]);
        assert!(
            request(
                &MessagesRequest::new("model", Vec::new())
                    .with_response_json_schema(ResponseJsonSchema::new("wide", schema))
            )
            .is_none()
        );
        let usage = Usage {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            iterations: Some(vec![
                UsageIteration {
                    input_tokens: 1,
                    output_tokens: 1
                };
                MAX_NODES + 1
            ]),
        };
        assert!(
            event(&StreamEvent::MessageDelta {
                delta: MessageDeltaFields {
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Some(usage)
                }
            })
            .is_none()
        );
    }

    #[test]
    fn oversized_image_and_saturated_arithmetic_are_rejected() {
        let value = MessagesRequest::new(
            "model",
            vec![Message::user_content(vec![ContentBlock::Image {
                source: ImageSource::base64("image/png", String::with_capacity(MAX_BYTES + 1)),
            }])],
        );
        assert!(request(&value).is_none());
        let mut budget = Budget {
            bytes: usize::MAX - 1,
            nodes: usize::MAX,
        };
        assert!(budget.add(10).is_none());
        assert_eq!(budget.bytes, usize::MAX);
        assert!(budget.node(0).is_none());
        assert_eq!(budget.nodes, usize::MAX);
    }

    #[test]
    fn every_event_variant_and_content_payload_is_accounted() {
        let text = || "x".repeat(1024);
        let blocks = vec![
            ContentBlock::Text { text: text() },
            ContentBlock::ToolUse {
                id: text(),
                name: text(),
                input: serde_json::json!({"payload": text()}),
            },
            ContentBlock::ToolResult {
                tool_use_id: text(),
                content: vec![ContentBlock::Text { text: text() }],
                is_error: Some(false),
            },
            ContentBlock::Image {
                source: ImageSource {
                    source_type: text(),
                    media_type: text(),
                    data: text(),
                },
            },
            ContentBlock::Thinking {
                thinking: text(),
                signature: text(),
            },
            ContentBlock::RedactedThinking { data: text() },
        ];
        for block in blocks {
            assert!(
                event(&StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: block
                })
                .unwrap()
                    >= 1024
            );
        }
        for delta in [
            ContentDelta::TextDelta { text: text() },
            ContentDelta::ThinkingDelta { thinking: text() },
            ContentDelta::SignatureDelta { signature: text() },
            ContentDelta::InputJsonDelta {
                partial_json: text(),
            },
        ] {
            assert!(event(&StreamEvent::ContentBlockDelta { index: 0, delta }).unwrap() >= 1024);
        }
        for event_value in [
            StreamEvent::Ping,
            StreamEvent::MessageStop,
            StreamEvent::ContentBlockStop { index: 0 },
        ] {
            assert!(event(&event_value).unwrap() >= size_of::<StreamEvent>());
        }
        assert!(
            event(&StreamEvent::Error {
                error: ApiError {
                    error_type: text(),
                    message: text()
                }
            })
            .unwrap()
                >= 2048
        );
        let start = StreamEvent::MessageStart {
            message: StreamingMessage {
                id: text(),
                role: text(),
                content: Vec::new(),
                model: text(),
                stop_reason: Some(text()),
                stop_sequence: Some(text()),
                usage: None,
            },
        };
        assert!(event(&start).unwrap() >= 5120);
    }
}
