use kcoder_types::{ContentBlock, Message, MessagesRequest, Usage};
use serde_json;
use std::hash::{Hash, Hasher};

/// Fixed token estimate for image and document blocks.
///
/// KCoder uses ~2000 tokens as a conservative upper bound for images
/// resized to 2000x2000 and for PDF documents encoded as base64. This avoids
/// massive underestimation that would delay compaction.
const IMAGE_DOCUMENT_TOKEN_ESTIMATE: usize = 2000;

/// Character-to-token multiplier used by the rough estimator.
///
/// KCoder's `roughTokenCountEstimation` is approximately `ceil(chars / 4)`
/// for ASCII text. We use the same factor here.
const CHARS_PER_TOKEN: f64 = 4.0;

/// Conservative padding applied to estimates that are not anchored to real API
/// usage. Matches the 4/3 padding used by the TypeScript micro-compactor.
const ESTIMATE_PADDING: f64 = 4.0 / 3.0;

pub struct TokenCounter;

#[cfg(test)]
thread_local! {
    pub(crate) static STATIC_TOOL_SERIALIZATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn measure_static_tool(
    tool: &kcoder_types::ToolDefinition,
    hasher: &mut std::collections::hash_map::DefaultHasher,
    buffer: &mut Vec<u8>,
) -> usize {
    #[cfg(test)]
    STATIC_TOOL_SERIALIZATIONS.with(|count| count.set(count.get() + 1));
    buffer.clear();
    if serde_json::to_writer(&mut *buffer, tool).is_err() {
        buffer.clear();
    }
    let serialized = std::str::from_utf8(buffer).expect("JSON serialization produces UTF-8");
    serialized.hash(hasher);
    TokenCounter::rough_char_estimate(serialized)
}

/// Request-local scalar measurements; no request data is retained.
pub(crate) struct StaticPrefixMeasurement {
    fingerprint: u64,
    raw_static_tokens: usize,
}

impl StaticPrefixMeasurement {
    pub(crate) fn from_serialized_tools(request: &MessagesRequest, serialized: &[String]) -> Self {
        assert_eq!(request.tools.len(), serialized.len());
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        request.system.hash(&mut hasher);
        let mut raw_static_tokens = request
            .system
            .as_deref()
            .map(TokenCounter::rough_char_estimate)
            .unwrap_or_default();
        for (tool, json) in request.tools.iter().zip(serialized) {
            tool.name.hash(&mut hasher);
            json.hash(&mut hasher);
            raw_static_tokens += TokenCounter::rough_char_estimate(json);
        }
        if request.path_first_tools {
            "kcoder:path-first-tools:v1".hash(&mut hasher);
        }
        Self {
            fingerprint: hasher.finish(),
            raw_static_tokens,
        }
    }

    pub(crate) fn new(request: &MessagesRequest) -> Self {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        request.system.hash(&mut hasher);
        let mut raw_static_tokens = request
            .system
            .as_deref()
            .map(TokenCounter::rough_char_estimate)
            .unwrap_or_default();
        // Reuse only within this measurement; no schema data survives the request.
        let mut buffer = Vec::new();
        for tool in &request.tools {
            tool.name.hash(&mut hasher);
            raw_static_tokens += measure_static_tool(tool, &mut hasher, &mut buffer);
        }
        if request.path_first_tools {
            // Wire ordering changes cache identity, not the estimated token volume.
            "kcoder:path-first-tools:v1".hash(&mut hasher);
        }
        Self {
            fingerprint: hasher.finish(),
            raw_static_tokens,
        }
    }

    pub(crate) fn fingerprint(&self) -> u64 {
        self.fingerprint
    }

    pub(crate) fn padded_tokens(&self) -> usize {
        apply_padding(self.raw_static_tokens)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenCountSource {
    ProviderExact,
    UsageAnchorWithEstimatedDelta,
    FullRequestEstimate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenCount {
    pub tokens: usize,
    pub source: TokenCountSource,
}

impl TokenCounter {
    /// Ignore historical usage anchors and re-estimate messages that will be reordered or replaced.
    pub fn estimate_messages_without_usage(messages: &[Message]) -> usize {
        apply_padding(messages.iter().map(Self::estimate_message).sum())
    }

    /// Estimate tokens in the system/tools static prefix of a complete request.
    pub fn estimate_static_prefix(request: &MessagesRequest) -> usize {
        StaticPrefixMeasurement::new(request).padded_tokens()
    }

    /// Calculate a complete request using the unified local fallback method.
    ///
    /// A usage anchor already includes its system/tools; do not add an unchanged static prefix again.
    pub fn count_request(request: &MessagesRequest, static_prefix_changed: bool) -> TokenCount {
        Self::count_request_with_static_prefix(
            request,
            static_prefix_changed,
            &StaticPrefixMeasurement::new(request),
        )
    }

    /// Reuse a measurement made from this same final request before preflight.
    pub(crate) fn count_request_with_static_prefix(
        request: &MessagesRequest,
        static_prefix_changed: bool,
        measurement: &StaticPrefixMeasurement,
    ) -> TokenCount {
        let has_anchor = request
            .messages
            .iter()
            .any(|message| get_message_usage(message).is_some());
        if has_anchor && !static_prefix_changed {
            return TokenCount {
                tokens: Self::count(&request.messages),
                source: TokenCountSource::UsageAnchorWithEstimatedDelta,
            };
        }
        let raw_messages = request
            .messages
            .iter()
            .map(Self::estimate_message)
            .sum::<usize>();
        TokenCount {
            tokens: apply_padding(raw_messages.saturating_add(measurement.raw_static_tokens)),
            source: TokenCountSource::FullRequestEstimate,
        }
    }
    /// Best-effort token count for a slice of messages.
    ///
    /// If a recent assistant message carries API `usage`, we treat that message
    /// as an anchor: all messages up to and including it are counted from the
    /// usage value, and only messages after it are estimated. This keeps the
    /// running total accurate even when the estimator drifts on long tool
    /// outputs.
    pub fn count<'a>(
        messages: impl IntoIterator<Item = &'a Message, IntoIter: DoubleEndedIterator>,
    ) -> usize {
        let mut estimated_after = 0;
        for message in messages.into_iter().rev() {
            if let Some(usage) = get_message_usage(message) {
                return Self::count_from_usage(usage) + apply_padding(estimated_after);
            }
            estimated_after += Self::estimate_message(message);
        }
        apply_padding(estimated_after)
    }

    /// Sum all components reported by the API for the context window.
    ///
    /// Includes input, output, and both cache token categories. This matches
    /// `getTokenCountFromUsage` in the TypeScript source.
    pub fn count_from_usage(usage: &Usage) -> usize {
        if let Some(total) = usage.total_tokens {
            return total as usize;
        }
        let mut total = (usage.input_tokens + usage.output_tokens) as usize;
        if let Some(v) = usage.cache_creation_input_tokens {
            total += v as usize;
        }
        if let Some(v) = usage.cache_read_input_tokens {
            total += v as usize;
        }
        total
    }

    /// Estimate a single message from its content blocks.
    pub fn estimate_message(message: &Message) -> usize {
        let blocks = match message {
            Message::User { content, .. } => content,
            Message::Assistant { content, .. } => content,
        };
        blocks.iter().map(Self::estimate_block).sum::<usize>() + 4 // small role overhead
    }

    /// Estimate a single message, ignoring any stored API `usage` value.
    ///
    /// `count` treats a usage-bearing message as an anchor for the *entire*
    /// preceding conversation, which is only valid when that message is really
    /// the latest one in the conversation being measured. Callers sizing one
    /// message at a time (e.g. recent-window selection) must use this instead,
    /// or a single assistant message would be mis-measured as the whole
    /// prompt it was once part of.
    pub fn estimate_single_message(message: &Message) -> usize {
        apply_padding(Self::estimate_message(message))
    }

    /// Estimate a single content block.
    pub fn estimate_block(block: &ContentBlock) -> usize {
        match block {
            ContentBlock::Text { text } => Self::rough_char_estimate(text),
            ContentBlock::ToolUse { name, input, .. } => {
                let serialized = match serde_json::to_string(input) {
                    Ok(s) => s,
                    Err(_) => input.to_string(),
                };
                Self::rough_char_estimate(&format!("{name}{serialized}"))
            }
            ContentBlock::ToolResult { content, .. } => {
                content.iter().map(Self::estimate_block).sum()
            }
            ContentBlock::Image { .. } => IMAGE_DOCUMENT_TOKEN_ESTIMATE,
            ContentBlock::Thinking { thinking, .. } => Self::rough_char_estimate(thinking),
            ContentBlock::RedactedThinking { data } => Self::rough_char_estimate(data),
        }
    }

    /// Rough token estimate for a plain string.
    pub fn rough_char_estimate(text: &str) -> usize {
        (text.len() as f64 / CHARS_PER_TOKEN).ceil() as usize
    }
}

fn get_message_usage(message: &Message) -> Option<&Usage> {
    match message {
        Message::Assistant { usage, .. } => usage.as_ref(),
        Message::User { .. } => None,
    }
}

fn apply_padding(raw: usize) -> usize {
    (raw as f64 * ESTIMATE_PADDING).ceil() as usize
}

#[cfg(test)]
mod tests {
    #[test]
    fn path_first_wire_static_identity_changes_without_token_or_serialization_cost() {
        let request = kcoder_types::MessagesRequest::new("model", vec![])
            .with_system("system")
            .with_tools(vec![kcoder_types::ToolDefinition {
                name: "write".into(),
                description: "write".into(),
                input_schema: serde_json::json!({"properties":{"content":{},"file_path":{}}}),
            }]);
        let before = super::StaticPrefixMeasurement::new(&request);
        super::STATIC_TOOL_SERIALIZATIONS.with(|count| count.set(0));
        let enabled_request = request.clone().with_path_first_tools(true);
        let enabled = super::StaticPrefixMeasurement::new(&enabled_request);
        assert_eq!(
            super::STATIC_TOOL_SERIALIZATIONS.with(|count| count.get()),
            1
        );
        assert_ne!(before.fingerprint(), enabled.fingerprint());
        assert_eq!(before.padded_tokens(), enabled.padded_tokens());
        let restored =
            super::StaticPrefixMeasurement::new(&enabled_request.with_path_first_tools(false));
        assert_eq!(before.fingerprint(), restored.fingerprint());
        assert_eq!(before.padded_tokens(), restored.padded_tokens());
    }
    use super::*;
    use kcoder_types::ContentBlock;

    #[test]
    fn static_prefix_measurement_matches_legacy_oracle() {
        // Keep the original hash and estimation algorithm independent of the measurement.
        fn legacy(request: &MessagesRequest, changed: bool) -> (u64, usize, TokenCount) {
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            request.system.hash(&mut hash);
            for tool in &request.tools {
                tool.name.hash(&mut hash);
                serde_json::to_string(tool)
                    .unwrap_or_default()
                    .hash(&mut hash);
            }
            let rough = |text: &str| (text.len() as f64 / 4.0).ceil() as usize;
            let pad = |raw: usize| (raw as f64 * (4.0 / 3.0)).ceil() as usize;
            let raw_static = request.system.as_deref().map(rough).unwrap_or_default()
                + request
                    .tools
                    .iter()
                    .map(|tool| {
                        serde_json::to_string(tool)
                            .map(|json| rough(&json))
                            .unwrap_or_default()
                    })
                    .sum::<usize>();
            let count = if !changed
                && request
                    .messages
                    .iter()
                    .any(|message| get_message_usage(message).is_some())
            {
                TokenCount {
                    tokens: TokenCounter::count(&request.messages),
                    source: TokenCountSource::UsageAnchorWithEstimatedDelta,
                }
            } else {
                TokenCount {
                    tokens: pad(request
                        .messages
                        .iter()
                        .map(TokenCounter::estimate_message)
                        .sum::<usize>()
                        .saturating_add(raw_static)),
                    source: TokenCountSource::FullRequestEstimate,
                }
            };
            (hash.finish(), pad(raw_static), count)
        }

        let first = kcoder_types::ToolDefinition {
            name: "读取".into(),
            description: "Read 🦀".into(),
            input_schema: serde_json::json!({"type": "object", "default": -0.0}),
        };
        let second = kcoder_types::ToolDefinition {
            name: "write".into(),
            description: "Write".into(),
            input_schema: serde_json::json!({"type": "string"}),
        };
        let mut schema_changed = first.clone();
        schema_changed.input_schema["default"] = serde_json::json!(0.0);
        let mut description_changed = first.clone();
        description_changed.description.push_str(" changed");
        let mut chunked = first.clone();
        chunked.description = "中文🦀\n\"\\".repeat(1000);
        let tool_sets = vec![
            vec![],
            vec![first.clone()],
            vec![first.clone(), second.clone()],
            vec![second, first],
            vec![schema_changed],
            vec![description_changed],
            vec![chunked],
        ];
        let mut systems = vec![None, Some(String::new()), Some("中文🦀".into())];
        systems.extend((1..=12).map(|n| Some("x".repeat(n))));
        for system in systems {
            for tools in &tool_sets {
                for messages in [
                    vec![],
                    vec![Message::user_text("a")],
                    vec![
                        Message::Assistant {
                            content: vec![ContentBlock::Text { text: "ok".into() }],
                            usage: Some(Usage {
                                input_tokens: 1000,
                                output_tokens: 20,
                                cache_creation_input_tokens: None,
                                cache_read_input_tokens: None,
                                total_tokens: None,
                                iterations: None,
                            }),
                        },
                        Message::user_text("后续"),
                    ],
                ] {
                    let mut request = MessagesRequest::new("model", messages);
                    request.system = system.clone();
                    request.tools = tools.clone();
                    let measurement = StaticPrefixMeasurement::new(&request);
                    for changed in [false, true] {
                        let (fingerprint, padded, count) = legacy(&request, changed);
                        assert_eq!(measurement.fingerprint(), fingerprint);
                        assert_eq!(measurement.padded_tokens(), padded);
                        assert_eq!(TokenCounter::estimate_static_prefix(&request), padded);
                        assert_eq!(
                            TokenCounter::count_request_with_static_prefix(
                                &request,
                                changed,
                                &measurement
                            ),
                            count
                        );
                        assert_eq!(TokenCounter::count_request(&request, changed), count);
                    }
                }
            }
        }
    }

    #[test]
    fn unchanged_static_prefix_is_not_added_to_usage_anchor_twice() {
        let messages = vec![Message::Assistant {
            content: vec![ContentBlock::Text { text: "ok".into() }],
            usage: Some(Usage {
                input_tokens: 1_000,
                output_tokens: 20,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            }),
        }];
        let request = MessagesRequest::new("model", messages).with_system("x".repeat(40_000));

        let count = TokenCounter::count_request(&request, false);
        assert_eq!(count.tokens, 1_020);
        assert_eq!(
            count.source,
            TokenCountSource::UsageAnchorWithEstimatedDelta
        );
    }

    #[test]
    fn changed_static_prefix_reestimates_the_complete_request() {
        let messages = vec![Message::Assistant {
            content: vec![ContentBlock::Text { text: "ok".into() }],
            usage: Some(Usage {
                input_tokens: 1_000,
                output_tokens: 20,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            }),
        }];
        let request = MessagesRequest::new("model", messages).with_system("x".repeat(40_000));

        let count = TokenCounter::count_request(&request, true);
        assert!(count.tokens > 10_000, "{count:?}");
        assert_eq!(count.source, TokenCountSource::FullRequestEstimate);
    }

    #[test]
    fn rough_estimate_short_text() {
        // 12 chars / 4 = 3 tokens
        assert_eq!(TokenCounter::rough_char_estimate("hello world!"), 3);
    }

    #[test]
    fn estimate_text_block() {
        let block = ContentBlock::Text {
            text: "hello world!".into(),
        };
        assert_eq!(TokenCounter::estimate_block(&block), 3);
    }

    #[test]
    fn estimate_tool_use_counts_name_and_input() {
        let block = ContentBlock::ToolUse {
            id: "call_1".into(),
            name: "bash".into(),
            input: serde_json::json!({"command": "ls -la"}),
        };
        let tokens = TokenCounter::estimate_block(&block);
        assert!(tokens > 0);
    }

    #[test]
    fn estimate_tool_result_sums_inner_blocks() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "call_1".into(),
            content: vec![
                ContentBlock::Text {
                    text: "line one\n".into(),
                },
                ContentBlock::Text {
                    text: "line two".into(),
                },
            ],
            is_error: Some(false),
        };
        let tokens = TokenCounter::estimate_block(&block);
        assert!(tokens > 0);
    }

    #[test]
    fn count_anchors_to_usage() {
        let messages = vec![
            Message::user_text("short"),
            Message::Assistant {
                content: vec![ContentBlock::Text {
                    text: "a".repeat(4000),
                }],
                usage: Some(Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    total_tokens: None,
                    iterations: None,
                }),
            },
            Message::user_text("follow up"),
        ];
        let count = TokenCounter::count(&messages);
        // anchor = 150 tokens + padded estimate for "follow up"
        assert!(count >= 150);
    }

    #[test]
    fn provider_total_avoids_double_counting_cached_input() {
        let usage = Usage {
            input_tokens: 1_200,
            output_tokens: 80,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: Some(1_024),
            total_tokens: Some(1_280),
            iterations: None,
        };

        assert_eq!(TokenCounter::count_from_usage(&usage), 1_280);
    }

    #[test]
    fn count_without_usage_uses_estimation() {
        let messages = vec![
            Message::user_text("hello world!"),
            Message::assistant_text("hi there!"),
        ];
        let count = TokenCounter::count(&messages);
        assert!(count > 0);
    }

    #[test]
    #[ignore = "manual performance benchmark"]
    fn token_estimation_benchmark() {
        let messages = (0..20_000)
            .map(|idx| {
                if idx % 2 == 0 {
                    Message::user_text(format!(
                        "request {idx}: inspect the file and summarize {}",
                        "x".repeat(160)
                    ))
                } else {
                    Message::Assistant {
                        content: vec![
                            ContentBlock::Text {
                                text: format!("answer {idx}: {}", "y".repeat(240)),
                            },
                            ContentBlock::ToolUse {
                                id: format!("tool-{idx}"),
                                name: "bash".to_string(),
                                input: serde_json::json!({
                                    "command": format!("echo {idx}"),
                                    "timeout_s": 30
                                }),
                            },
                        ],
                        usage: None,
                    }
                }
            })
            .collect::<Vec<_>>();

        let started = std::time::Instant::now();
        let tokens = TokenCounter::count(&messages);
        let elapsed = started.elapsed();

        eprintln!(
            "token_estimation_benchmark: {} messages, {} tokens, elapsed={elapsed:?}",
            messages.len(),
            tokens
        );
        assert!(tokens > messages.len());
    }
}
