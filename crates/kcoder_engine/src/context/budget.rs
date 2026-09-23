use crate::context::tokens::TokenCounter;
use crate::context::truncate_chars_with_dropped_bytes;
use kcoder_config::Settings;
use kcoder_types::{ContentBlock, Message};
use tracing::debug;

/// Token budget for a single API call.
#[derive(Debug, Clone, Copy)]
pub struct ContextBudget {
    /// Total effective input context window for the model.
    pub total: usize,
    /// Reserved tokens for the system prompt.
    pub system: usize,
    /// Reserved tokens for tool definitions.
    pub tools: usize,
    /// Headroom left for the model's own output.
    pub reserved_output: usize,
    /// Token budget available for conversation messages.
    pub messages: usize,
    /// Explicit automatic compaction threshold for model-visible messages.
    pub auto_compact_threshold: Option<usize>,
    /// Explicit hard input limit for a complete request.
    pub hard_input_limit: Option<usize>,
    /// Explicit prefire boundary for a complete request.
    pub prefire_threshold: Option<usize>,
    /// Conservative estimate of ToolResult growth during one cycle.
    pub estimated_tool_growth: usize,
}

impl ContextBudget {
    /// Build a budget from active-provider parameters and session-level overrides.
    pub fn from_settings(settings: &Settings) -> Self {
        let total = settings
            .context_window_tokens
            .expect("激活的 Provider 必须提供 context_window_tokens");
        let system = settings.context_system_tokens.unwrap_or(2_000);
        let tools = settings.context_tools_tokens.unwrap_or(4_000);
        let reserved_output = settings
            .context_output_headroom
            .expect("激活的 Provider 必须提供 output_headroom_tokens");
        let hard_input_limit = settings
            .context_hard_input_tokens
            .unwrap_or_else(|| total.saturating_sub(reserved_output))
            .min(total);
        let auto_compact_threshold = settings.auto_compact_threshold_tokens.or_else(|| {
            let percentage = settings
                .context_compaction
                .auto_threshold
                .percentage_for(total);
            Some(hard_input_limit.saturating_mul(percentage) / 100)
        });
        // Retain `messages` temporarily as a compatibility alias. Every compaction
        // decision compares complete requests, so system/tools must not be deducted again here.
        let messages = total.saturating_sub(reserved_output);
        Self {
            total,
            system,
            tools,
            reserved_output,
            messages,
            auto_compact_threshold,
            hard_input_limit: settings.context_hard_input_tokens,
            prefire_threshold: settings.prefire_threshold_tokens,
            estimated_tool_growth: settings.estimated_tool_growth_tokens.unwrap_or(15_000),
        }
    }

    /// Hard input limit for a complete request; never send a request that exceeds it.
    pub fn hard_input_limit(&self) -> usize {
        self.hard_input_limit
            .unwrap_or_else(|| self.total.saturating_sub(self.reserved_output))
            .min(self.total)
    }

    /// Auto-compact threshold: the point at which we should start compacting
    /// *before* we hit the hard message budget. Leaves a buffer for the current
    /// turn's output and any last-minute tool results.
    pub fn auto_compact_threshold(&self) -> usize {
        if let Some(threshold) = self.auto_compact_threshold {
            return threshold.min(self.hard_input_limit().saturating_sub(1));
        }
        // Tiered by the model context window: small windows compact late
        // (their budget is precious), huge windows compact early (a single
        // summarization covers more ground and the request gets expensive).
        //   <= 256k        -> 95% of the hard input budget
        //   256k ..= 512k  -> 85%
        //   > 512k         -> 75%
        let percentage = kcoder_config::default_auto_compact_percentage(self.total);
        self.hard_input_limit().saturating_mul(percentage) / 100
    }

    /// Derive a dynamic prefire boundary from expected ToolResult growth.
    ///
    /// `max_tokens` is a safety limit for one response, not typical growth for the
    /// next cycle. Output headroom already reserves space for this response, and the
    /// next send rechecks actual tokens after response and tool results enter context.
    /// Do not count the full response limit again as inevitable growth.
    pub fn prefire_threshold(&self) -> usize {
        self.prefire_threshold
            .unwrap_or_else(|| {
                self.auto_compact_threshold()
                    .saturating_sub(self.estimated_tool_growth)
            })
            .min(self.auto_compact_threshold().saturating_sub(1))
    }
}

/// Decides which conversation history to keep and which to compact.
pub struct ContextManager;

impl ContextManager {
    /// Token estimate for a slice of messages.
    ///
    /// Delegates to [`TokenCounter`] so that real API usage is used as an
    /// anchor when available.
    pub fn estimate_tokens(messages: &[Message]) -> usize {
        TokenCounter::count(messages)
    }

    /// Returns true if the message history exceeds the message budget.
    pub fn needs_compaction(messages: &[Message], budget: usize) -> bool {
        let tokens = Self::estimate_tokens(messages);
        debug!("estimated conversation tokens: {} / {}", tokens, budget);
        tokens > budget
    }

    /// Split messages into (to_compact, to_preserve).
    ///
    /// Preserves the most recent messages so the current turn and its tool
    /// context remain intact. Older messages are candidates for summarization.
    pub fn select_messages_to_compact(messages: &[Message]) -> (Vec<Message>, Vec<Message>) {
        // 6 messages ~= 1 user request + 1 assistant (text + tool_use) +
        // 1 tool result + 1 assistant final + safety margin.
        const PRESERVE_RECENT: usize = 8;
        if messages.len() <= PRESERVE_RECENT {
            return (messages.to_vec(), Vec::new());
        }
        let split = messages.len() - PRESERVE_RECENT;
        (messages[..split].to_vec(), messages[split..].to_vec())
    }

    /// Format older messages so a model can summarize them.
    pub fn format_for_summary(messages: &[Message]) -> String {
        messages
            .iter()
            .map(|msg| match msg {
                Message::User { content } => {
                    format!("User: {}", content_blocks_to_string(content))
                }
                Message::Assistant { content, .. } => {
                    format!("Assistant: {}", content_blocks_to_string(content))
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Aggressively truncate very long tool outputs in-place.
    ///
    /// This is the cheapest form of compaction and is applied before asking
    /// the model for a summary.
    pub fn truncate_long_tool_outputs(messages: &mut [Message], max_tool_output_chars: usize) {
        for msg in messages.iter_mut() {
            let content = match msg {
                Message::User { content } | Message::Assistant { content, .. } => content,
            };
            for block in content.iter_mut() {
                if let ContentBlock::ToolResult { content: inner, .. } = block {
                    for inner_block in inner.iter_mut() {
                        if let ContentBlock::Text { text } = inner_block
                            && let Some((truncated, dropped_bytes)) =
                                truncate_chars_with_dropped_bytes(text, max_tool_output_chars)
                        {
                            *text = format!(
                                "{}\n\n[... output truncated after {} characters; {} bytes omitted ...]",
                                truncated, max_tool_output_chars, dropped_bytes
                            );
                        }
                    }
                }
            }
        }
    }
}

fn content_blocks_to_string(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text.clone(),
            ContentBlock::ToolUse { id, name, input } => {
                format!("[Tool use {}: {} with {}]", id, name, input)
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let text = content
                    .iter()
                    .map(|b| match b {
                        ContentBlock::Text { text } => text.clone(),
                        _ => String::new(),
                    })
                    .collect::<String>();
                format!(
                    "[Tool result {}: {}]{}",
                    tool_use_id,
                    if is_error.unwrap_or(false) {
                        "error"
                    } else {
                        "ok"
                    },
                    text
                )
            }
            ContentBlock::Image { source } => format!("[Image: {}]", source.media_type),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::{ApiFormat, ProviderConfig};

    #[test]
    fn estimates_tokens_for_text() {
        let msg = Message::user_text("hello world".to_string());
        let tokens = ContextManager::estimate_tokens(&[msg]);
        assert!(tokens >= 1);
    }

    #[test]
    fn selects_messages_to_compact() {
        let messages: Vec<Message> = (0..12)
            .map(|i| Message::user_text(format!("msg {}", i)))
            .collect();
        let (old, recent) = ContextManager::select_messages_to_compact(&messages);
        assert_eq!(old.len(), 4);
        assert_eq!(recent.len(), 8);
    }

    #[test]
    fn default_minimax_profile_uses_its_config_owned_context_budget() {
        let budget = ContextBudget::from_settings(&Settings::default());
        assert_eq!(budget.total, 1_048_576);
        assert_eq!(budget.system, 2_000);
        assert_eq!(budget.tools, 4_000);
        assert_eq!(budget.reserved_output, 100_000);
        assert_eq!(budget.messages, 948_576);
    }

    #[test]
    fn derived_auto_compact_threshold_tiers_by_context_window() {
        let budget = |total: usize| ContextBudget {
            total,
            system: 2_000,
            tools: 2_000,
            reserved_output: 8_000,
            messages: total.saturating_sub(12_000),
            auto_compact_threshold: None,
            hard_input_limit: None,
            prefire_threshold: None,
            estimated_tool_growth: 15_000,
        };
        // At 256K or below, use 95% of the complete hard-input budget as the soft threshold.
        assert_eq!(budget(131_072).auto_compact_threshold(), 116_918);
        assert_eq!(budget(256_000).auto_compact_threshold(), 235_600);
        // 256k..=512k: 85%
        assert_eq!(budget(256_001).auto_compact_threshold(), 210_800);
        assert_eq!(budget(512_000).auto_compact_threshold(), 428_400);
        // > 512k: 75%
        assert_eq!(budget(512_001).auto_compact_threshold(), 378_000);
        assert_eq!(budget(1_048_576).auto_compact_threshold(), 780_432);
        // An explicit threshold still wins over the tiers.
        let mut explicit = budget(1_048_576);
        explicit.auto_compact_threshold = Some(100_000);
        assert_eq!(explicit.auto_compact_threshold(), 100_000);
    }

    #[test]
    fn configured_large_context_profile_uses_its_own_budget() {
        let mut settings = Settings::default();
        settings.providers.insert(
            "large-context-test".to_string(),
            ProviderConfig {
                reasoning_policy: None,
                chat_protocol: Default::default(),
                authentication: Default::default(),
                credential_env: Vec::new(),
                api_format: ApiFormat::AnthropicMessages,
                endpoint: "http://127.0.0.1:3000".to_string(),
                default_model: "large-context-test-model".to_string(),
                models: Default::default(),
                discover_models: None,
                capabilities: kcoder_config::ModelCapabilities::default(),
                reasoning_effort: None,
                context_window_tokens: 1_048_576,
                auto_compact_threshold_tokens: Some(100_000),
                output_headroom_tokens: 100_000,
                max_output_tokens: 100_000,
                request_timeout_secs: Some(300),
                user_agent: None,
                max_retries: None,
                retry_base_delay_ms: None,
                no_proxy: true,
                extra_body: serde_json::Map::new(),
            },
        );
        settings.apply_provider(Some("large-context-test")).unwrap();
        let budget = ContextBudget::from_settings(&settings);
        assert_eq!(budget.total, 1_048_576);
        assert_eq!(budget.reserved_output, 100_000);
        assert_eq!(budget.messages, 948_576);

        settings.auto_compact_threshold_tokens = Some(100_000);
        let early_compact = ContextBudget::from_settings(&settings);
        assert_eq!(early_compact.total, 1_048_576);
        assert_eq!(early_compact.auto_compact_threshold(), 100_000);

        settings.model = "zai-org/GLM-5.2-FP8".to_string();
        settings.context_window_tokens = Some(512_000);
        settings.context_output_headroom = Some(16_000);
        let overridden = ContextBudget::from_settings(&settings);
        assert_eq!(overridden.total, 512_000);
        assert_eq!(overridden.reserved_output, 16_000);
    }

    #[test]
    fn configured_auto_compact_percentages_override_the_default_tiers() {
        let mut settings = Settings {
            context_window_tokens: Some(1_000_000),
            context_output_headroom: Some(100_000),
            ..Settings::default()
        };
        settings
            .context_compaction
            .auto_threshold
            .large_window_percent = 60;

        let budget = ContextBudget::from_settings(&settings);
        assert_eq!(budget.hard_input_limit(), 900_000);
        assert_eq!(budget.auto_compact_threshold(), 540_000);
        assert_eq!(budget.prefire_threshold(), 525_000);

        settings.auto_compact_threshold_tokens = Some(500_000);
        let explicit = ContextBudget::from_settings(&settings);
        assert_eq!(explicit.auto_compact_threshold(), 500_000);
    }

    #[test]
    fn complete_context_boundaries_do_not_deduct_system_and_tools_twice() {
        let mut settings = Settings {
            context_window_tokens: Some(100_000),
            context_output_headroom: Some(12_000),
            context_system_tokens: Some(30_000),
            context_tools_tokens: Some(20_000),
            max_tokens: Some(2_000),
            estimated_tool_growth_tokens: Some(15_000),
            ..Settings::default()
        };
        let budget = ContextBudget::from_settings(&settings);
        assert_eq!(budget.hard_input_limit(), 88_000);
        assert_eq!(budget.auto_compact_threshold(), 83_600);
        assert_eq!(budget.prefire_threshold(), 68_600);

        settings.context_hard_input_tokens = Some(85_000);
        settings.auto_compact_threshold_tokens = Some(76_000);
        settings.prefire_threshold_tokens = Some(60_000);
        let explicit = ContextBudget::from_settings(&settings);
        assert_eq!(explicit.hard_input_limit(), 85_000);
        assert_eq!(explicit.auto_compact_threshold(), 76_000);
        assert_eq!(explicit.prefire_threshold(), 60_000);
    }

    #[test]
    fn large_response_cap_is_not_treated_as_expected_context_growth() {
        let settings = Settings {
            context_window_tokens: Some(256_000),
            context_output_headroom: Some(100_000),
            estimated_tool_growth_tokens: Some(15_000),
            max_tokens: Some(100_000),
            ..Settings::default()
        };

        let budget = ContextBudget::from_settings(&settings);

        assert_eq!(budget.hard_input_limit(), 156_000);
        assert_eq!(budget.auto_compact_threshold(), 148_200);
        assert_eq!(budget.prefire_threshold(), 133_200);
    }

    #[test]
    fn truncates_long_tool_output() {
        let long = "x".repeat(1000);
        let mut messages = vec![Message::User {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "call_1".to_string(),
                content: vec![ContentBlock::Text { text: long.clone() }],
                is_error: Some(false),
            }],
        }];
        ContextManager::truncate_long_tool_outputs(&mut messages, 100);
        if let Message::User { content } = &messages[0]
            && let ContentBlock::ToolResult { content: inner, .. } = &content[0]
            && let ContentBlock::Text { text } = &inner[0]
        {
            assert!(text.len() < long.len());
            assert!(text.contains("truncated"));
            return;
        }
        panic!("truncation did not apply");
    }
}
