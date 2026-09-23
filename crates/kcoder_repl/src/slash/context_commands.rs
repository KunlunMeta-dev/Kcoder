use crate::ReplApp;
use kcoder_engine::QueryEngine;
use kcoder_types::{ContentBlock, Message};

use super::{SlashCommand, SlashResult};

#[derive(Default)]
pub(super) struct ContextCommand;

/// Snapshot of token usage for the /context inspector overlay.
#[derive(Debug, Clone)]
pub struct ContextBreakdown {
    pub total_window: usize,
    pub system: usize,
    pub tools: usize,
    pub reserved_output: usize,
    pub message_budget: usize,
    pub messages_used: usize,
    pub user: usize,
    pub assistant: usize,
    pub tool_use: usize,
    pub tool_result: usize,
    pub thinking: usize,
}

impl ContextBreakdown {
    pub fn compute(engine: &QueryEngine) -> Self {
        use kcoder_engine::context::{
            messages_after_latest_compact_boundary, tokens::TokenCounter,
        };

        let budget = engine.context_budget();
        let messages = messages_after_latest_compact_boundary(&engine.state.messages());
        let mut user = 0usize;
        let mut assistant_text = 0usize;
        let mut tool_use = 0usize;
        let mut tool_result = 0usize;
        let mut thinking = 0usize;

        for msg in messages.iter() {
            let blocks = match msg {
                Message::User { content } => content,
                Message::Assistant { content, .. } => content,
            };
            for block in blocks {
                let tokens = TokenCounter::estimate_block(block);
                match msg {
                    Message::User { .. } => match block {
                        ContentBlock::ToolResult { .. } => tool_result += tokens,
                        _ => user += tokens,
                    },
                    Message::Assistant { .. } => match block {
                        ContentBlock::ToolUse { .. } => tool_use += tokens,
                        ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. } => {
                            thinking += tokens
                        }
                        _ => assistant_text += tokens,
                    },
                }
            }
        }

        Self {
            total_window: budget.total,
            system: budget.system,
            tools: budget.tools,
            reserved_output: budget.reserved_output,
            message_budget: budget.messages,
            messages_used: TokenCounter::count(&messages),
            user,
            assistant: assistant_text,
            tool_use,
            tool_result,
            thinking,
        }
    }
}

#[async_trait::async_trait]
impl SlashCommand for ContextCommand {
    fn name(&self) -> &'static str {
        "/context"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/ctx"]
    }
    fn description(&self) -> &'static str {
        "Open the context inspector overlay."
    }
    fn usage(&self) -> &'static str {
        "/context"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let breakdown = ContextBreakdown::compute(engine);
        app.open_context_inspector(breakdown);
        SlashResult::Handled
    }
}
