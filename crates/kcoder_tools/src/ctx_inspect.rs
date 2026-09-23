use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use kcoder_types::Message;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

/// Inspect the current conversation context, token usage, and active state.
#[derive(Debug, Default)]
pub struct CtxInspectTool;

const COMPACT_SUMMARY_PREFIX: &str = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
const LEGACY_COMPACT_SUMMARY_PREFIX: &str = "Earlier conversation summary:";

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CtxInspectInput {
    /// Optional query to filter context entries. If omitted, returns a summary of all context.
    pub query: Option<String>,
}

#[async_trait]
impl Tool for CtxInspectTool {
    fn name(&self) -> String {
        "CtxInspect".to_string()
    }

    fn description(&self) -> String {
        "Inspect the current context window contents and token usage. \
         Shows estimated token usage, message count, model context, prompt caching, \
         session memory, and context compaction boundary state. Use this to understand \
         your context budget before deciding whether to compact, snip, or adjust your approach."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(CtxInspectInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CtxInspectInput = parse_input(&input)?;

        let messages = ctx.state.messages();
        let query = input
            .query
            .as_deref()
            .map(|q| q.trim())
            .filter(|q| !q.is_empty());

        let visible_messages: Vec<&Message> = match query {
            Some(q) => messages
                .iter()
                .filter(|m| m.preview(10_000).to_lowercase().contains(&q.to_lowercase()))
                .collect(),
            None => messages.iter().collect(),
        };

        let total_tokens = estimate_tokens(&messages);
        let message_count = messages.len();
        let model = std::env::var("KCODER_MODEL")
            .or_else(|_| std::env::var("ANTHROPIC_MODEL"))
            .unwrap_or_else(|_| "unknown".to_string());

        // Prompt caching is an API-level feature controlled by the provider.
        // Report as enabled for providers known to support Anthropic-style
        // prompt caching (first-party, Bedrock, Vertex).
        let prompt_caching_enabled = model != "unknown"
            && !model.starts_with("openai/")
            && !model.starts_with("grok/")
            && !model.starts_with("gemini/");

        let session_memory_enabled = ctx.memory_store.is_some();
        let collapse_stats = collapse_stats(&messages);
        let context_collapse_enabled = true;

        let mut summary_parts = Vec::new();
        if let Some(q) = query {
            summary_parts.push(format!("Focus: {}", q));
        } else {
            summary_parts.push("Overall context summary".to_string());
        }
        summary_parts.push(format!("Model context: {}", model));
        summary_parts.push(format!(
            "Prompt caching: {}",
            if prompt_caching_enabled {
                "enabled"
            } else {
                "disabled"
            }
        ));
        summary_parts.push(format!(
            "Session memory: {}",
            if session_memory_enabled {
                "enabled"
            } else {
                "disabled"
            }
        ));
        summary_parts.push(format!(
            "Context collapse: {}",
            if context_collapse_enabled {
                "enabled"
            } else {
                "disabled"
            }
        ));
        if context_collapse_enabled {
            summary_parts.push(format!(
                "Collapse spans: {} committed, {} staged, {} messages summarized",
                collapse_stats.committed_spans,
                collapse_stats.staged_spans,
                collapse_stats.collapsed_messages
            ));
        }

        if query.is_some() {
            summary_parts.push(format!(
                "Matching messages: {} of {}",
                visible_messages.len(),
                message_count
            ));
        }

        let summary = summary_parts.join("\n");
        let text = format!(
            "Context: {} tokens, {} messages\n{}\n\nToken count is an estimate. \
             {} session memory is {}.",
            total_tokens,
            message_count,
            summary,
            if session_memory_enabled {
                "Long-term"
            } else {
                "No"
            },
            if session_memory_enabled {
                "active"
            } else {
                "initialized"
            }
        );

        Ok(ToolOutput::text(text))
    }
}

/// Rough token estimation: ~4 characters per token plus a small per-message overhead.
fn estimate_tokens(messages: &[Message]) -> usize {
    let text_len: usize = messages
        .iter()
        .map(|m| m.preview(10_000).chars().count())
        .sum();
    let char_tokens = text_len / 4;
    let overhead = messages.len() * 64;
    char_tokens + overhead
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CollapseStats {
    committed_spans: usize,
    staged_spans: usize,
    collapsed_messages: usize,
}

fn collapse_stats(messages: &[Message]) -> CollapseStats {
    let mut committed_spans = 0usize;
    let mut latest_summary_index = None;

    for (index, message) in messages.iter().enumerate() {
        if compact_summary(message).is_some() {
            committed_spans += 1;
            latest_summary_index = Some(index);
        }
    }

    CollapseStats {
        committed_spans,
        // The Rust engine currently commits compacted summaries directly into
        // AppState does not expose staged compaction counts to tools, so report only committed ranges visible in state.
        staged_spans: 0,
        collapsed_messages: latest_summary_index.unwrap_or(0),
    }
}

fn compact_summary(message: &Message) -> Option<String> {
    let preview = message.preview(10_000);
    let trimmed = preview.trim_start();
    let summary = trimmed
        .strip_prefix(COMPACT_SUMMARY_PREFIX)
        .or_else(|| trimmed.strip_prefix(LEGACY_COMPACT_SUMMARY_PREFIX))?;
    Some(summary.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Tool, ToolContext};
    use kcoder_state::AppState;

    #[tokio::test]
    async fn ctx_inspect_reports_context_collapse_enabled_and_boundary_stats() {
        let state = AppState::with_messages(
            ".",
            vec![
                Message::user_text("old"),
                Message::assistant_text("older"),
                Message::user_text(format!("{COMPACT_SUMMARY_PREFIX}\n\ncompacted old work")),
                Message::user_text("new"),
            ],
        );
        let ctx = ToolContext::new(state);

        let output = CtxInspectTool
            .call(serde_json::json!({}), &ctx)
            .await
            .unwrap();

        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();

        assert!(text.contains("Context collapse: enabled"));
        assert!(text.contains("Collapse spans: 1 committed, 0 staged, 2 messages summarized"));
    }

    #[test]
    fn collapse_stats_uses_latest_visible_summary_boundary() {
        let messages = vec![
            Message::user_text(format!("{COMPACT_SUMMARY_PREFIX}\n\nfirst")),
            Message::user_text("middle"),
            Message::user_text(format!("{COMPACT_SUMMARY_PREFIX}\n\nsecond")),
            Message::assistant_text("recent"),
        ];

        assert_eq!(
            collapse_stats(&messages),
            CollapseStats {
                committed_spans: 2,
                staged_spans: 0,
                collapsed_messages: 2,
            }
        );
    }
}
