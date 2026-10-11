//! Memory accounting for one decoded model response, independent of token limits.
use crate::ApiErrorKind;
use kcoder_types::{ContentBlock, ContentDelta, ProviderResponseLimits, StreamEvent};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, Write};

#[derive(Default)]
pub struct ResponseBudget {
    limits: ProviderResponseLimits,
    decoded_bytes: usize,
    blocks: usize,
    active_tools: HashMap<usize, usize>,
}

impl ResponseBudget {
    pub fn new(limits: ProviderResponseLimits) -> Self {
        Self {
            limits,
            ..Self::default()
        }
    }

    pub fn charge(&mut self, bytes: usize) -> Result<(), ApiErrorKind> {
        self.check_bytes(bytes)?;
        self.decoded_bytes += bytes;
        Ok(())
    }

    fn check_bytes(&self, bytes: usize) -> Result<(), ApiErrorKind> {
        if bytes
            > self
                .limits
                .total_decoded_bytes
                .saturating_sub(self.decoded_bytes)
        {
            return Err(limit_error(
                "total_decoded_bytes",
                self.limits.total_decoded_bytes,
            ));
        }
        Ok(())
    }

    pub fn start(&mut self, index: usize, tool: bool, bytes: usize) -> Result<(), ApiErrorKind> {
        if self.blocks >= self.limits.content_blocks {
            return Err(limit_error("content_blocks", self.limits.content_blocks));
        }
        if tool
            && !self.active_tools.contains_key(&index)
            && self.active_tools.len() >= self.limits.active_tool_calls
        {
            return Err(limit_error(
                "active_tool_calls",
                self.limits.active_tool_calls,
            ));
        }
        self.check_bytes(bytes)?;
        self.blocks += 1;
        self.decoded_bytes += bytes;
        if tool {
            self.active_tools.entry(index).or_default();
        }
        Ok(())
    }

    pub fn tool_arguments(&mut self, index: usize, bytes: usize) -> Result<(), ApiErrorKind> {
        let previous = self
            .active_tools
            .get(&index)
            .copied()
            .ok_or_else(|| ApiErrorKind::Api {
                error_type: "provider_protocol_error".into(),
                message: "Tool input delta has no active tool block".into(),
            })?;
        if bytes > self.limits.tool_arguments_bytes.saturating_sub(previous) {
            return Err(limit_error(
                "tool_arguments_bytes",
                self.limits.tool_arguments_bytes,
            ));
        }
        self.check_bytes(bytes)?;
        self.decoded_bytes += bytes;
        *self
            .active_tools
            .get_mut(&index)
            .expect("active tool checked") = previous + bytes;
        Ok(())
    }

    pub fn finish(&mut self, index: usize) {
        self.active_tools.remove(&index);
    }

    /// Count only logical output, never adapter snapshots or request/context data.
    pub fn observe(&mut self, event: &StreamEvent) -> Result<(), ApiErrorKind> {
        if !self.limits.valid() {
            return Err(limit_error("invalid_response_limits", 0));
        }
        match event {
            StreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                let (tool, bytes) = match content_block {
                    ContentBlock::Text { text } => (false, text.len()),
                    ContentBlock::Thinking {
                        thinking,
                        signature,
                    } => (false, thinking.len() + signature.len()),
                    ContentBlock::RedactedThinking { data } => (false, data.len()),
                    ContentBlock::ToolUse { id, name, .. } => (true, id.len() + name.len()),
                    ContentBlock::Image { source } => {
                        (false, source.data.len() + source.media_type.len())
                    }
                    _ => (
                        false,
                        json_bytes(content_block, self.limits.total_decoded_bytes)?,
                    ),
                };
                self.start(*index, tool, bytes)?;
                if let ContentBlock::ToolUse { input, .. } = content_block
                    && !matches!(input, Value::Object(object) if object.is_empty())
                {
                    self.tool_arguments(
                        *index,
                        json_bytes(input, self.limits.tool_arguments_bytes)?,
                    )?;
                }
                Ok(())
            }
            StreamEvent::ContentBlockDelta { index, delta } => match delta {
                ContentDelta::TextDelta { text } => self.charge(text.len()),
                ContentDelta::ThinkingDelta { thinking } => self.charge(thinking.len()),
                ContentDelta::SignatureDelta { signature } => self.charge(signature.len()),
                ContentDelta::InputJsonDelta { partial_json } => {
                    self.tool_arguments(*index, partial_json.len())
                }
            },
            StreamEvent::ContentBlockStop { index } => {
                self.finish(*index);
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "providers/response_limit_tests.rs"]
mod stream_tests;

pub(crate) fn limit_error(resource: &'static str, limit: usize) -> ApiErrorKind {
    ApiErrorKind::ResponseLimit { resource, limit }
}

/// Measure serialized arguments without allocating an extra full JSON string.
pub(crate) fn json_bytes(
    value: &impl serde::Serialize,
    limit: usize,
) -> Result<usize, ApiErrorKind> {
    struct Counter {
        bytes: usize,
        limit: usize,
    }
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes) {
                return Err(io::Error::other("response budget exceeded"));
            }
            self.bytes += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value)
        .map_err(|_| limit_error("tool_arguments_bytes", limit))?;
    Ok(counter.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_bytes_and_finished_content_remain_charged() {
        let mut budget = ResponseBudget::new(ProviderResponseLimits {
            total_decoded_bytes: 6,
            tool_arguments_bytes: 6,
            content_blocks: 2,
            active_tool_calls: 1,
        });
        budget.start(1, true, 1).unwrap();
        budget.tool_arguments(1, 2).unwrap();
        budget.finish(1);
        budget.start(900000, false, 0).unwrap();
        budget.charge("文".len()).unwrap();
        assert!(matches!(
            budget.charge(1),
            Err(ApiErrorKind::ResponseLimit {
                resource: "total_decoded_bytes",
                limit: 6
            })
        ));
        assert_eq!(budget.decoded_bytes, 6);
        assert!(budget.active_tools.is_empty());
        assert!(
            budget.start(900001, false, 0).is_err(),
            "finished blocks are not refunded"
        );
    }

    #[test]
    fn sparse_tool_indices_count_cardinality_and_argument_growth_is_checked_first() {
        let mut budget = ResponseBudget::new(ProviderResponseLimits {
            total_decoded_bytes: 100,
            tool_arguments_bytes: 3,
            content_blocks: 4,
            active_tool_calls: 2,
        });
        budget.start(1, true, 1).unwrap();
        budget.start(900000, true, 1).unwrap();
        assert!(budget.start(2, true, 1).is_err());
        assert_eq!(budget.active_tools.len(), 2);
        budget.tool_arguments(1, 3).unwrap();
        let bytes = budget.decoded_bytes;
        assert!(budget.tool_arguments(1, 1).is_err());
        assert_eq!(budget.decoded_bytes, bytes);
        assert_eq!(budget.active_tools[&1], 3);
        budget.finish(1);
        budget.start(2, true, 1).unwrap();
    }

    #[test]
    fn request_context_and_output_tokens_are_independent_of_decoded_output_limits() {
        let request = kcoder_types::MessagesRequest::new(
            "model",
            vec![kcoder_types::Message::user_text("文".repeat(1024))],
        )
        .with_max_tokens(256000)
        .with_response_limits(ProviderResponseLimits {
            total_decoded_bytes: 4,
            tool_arguments_bytes: 4,
            content_blocks: 2,
            active_tool_calls: 1,
        });
        let wire = serde_json::to_value(&request).unwrap();
        assert_eq!(wire["max_tokens"], 256000);
        assert!(wire.get("response_limits").is_none());
        let mut budget = ResponseBudget::new(request.response_limits);
        budget.start(0, false, 0).unwrap();
        budget.charge("文!".len()).unwrap();
        assert!(budget.charge(1).is_err());
    }
}
