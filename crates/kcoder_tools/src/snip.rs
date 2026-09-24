use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use kcoder_types::{ContentBlock, Message};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

/// Snip messages from conversation history to free up context window space.
#[derive(Debug, Default)]
pub struct SnipTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SnipInput {
    /// IDs of the messages to snip from history: `msg-N` or `N`, the 1-based index of the message in the conversation. Snipped messages are replaced with a short summary placeholder.
    pub message_ids: Vec<String>,
    /// Why these messages are being snipped. Used in the summary replacement.
    pub reason: Option<String>,
}

/// Parse `msg-N` or `N` into a zero-based message index.
fn parse_message_index(id: &str) -> Option<usize> {
    let trimmed = id.trim();
    let digits = trimmed
        .strip_prefix("msg-")
        .or_else(|| trimmed.strip_prefix("msg"))
        .unwrap_or(trimmed)
        .trim_start_matches(['-', '#', ' ']);
    let one_based: usize = digits.parse().ok()?;
    one_based.checked_sub(1)
}

fn message_contains_tool_use(message: &Message) -> bool {
    let content = match message {
        Message::User { content, .. } => content,
        Message::Assistant { content, .. } => content,
    };
    content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolUse { .. }))
}

/// Replace a message's content with compact placeholders while preserving the
/// protocol structure: `tool_result` blocks keep their `tool_use_id` wrapper
/// so the tool_use/tool_result pairing invariant survives the snip.
fn snip_message_content(message: &Message, reason: &str) -> Message {
    let placeholder = format!("[snipped: {reason}]");
    match message {
        Message::User { content, origin } => Message::User {
            origin: *origin,
            content: content
                .iter()
                .map(|block| match block {
                    ContentBlock::ToolResult {
                        tool_use_id,
                        is_error,
                        ..
                    } => ContentBlock::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        content: vec![ContentBlock::Text {
                            text: placeholder.clone(),
                        }],
                        is_error: *is_error,
                    },
                    _ => ContentBlock::Text {
                        text: placeholder.clone(),
                    },
                })
                .collect(),
        },
        Message::Assistant { usage, .. } => Message::Assistant {
            content: vec![ContentBlock::Text { text: placeholder }],
            usage: usage.clone(),
        },
    }
}

#[async_trait]
impl Tool for SnipTool {
    fn name(&self) -> String {
        "Snip".to_string()
    }

    fn description(&self) -> String {
        "Snip messages from conversation history to free up context window space. \
         Snipped messages are replaced with a compact summary so you retain \
         awareness of what happened without the full content. Use this when context \
         is getting full, old large tool outputs are no longer needed verbatim, or a long \
         exploration sequence can be compacted into a summary. Only snip messages you are \
         confident you will not need verbatim again; preserve key facts such as file paths, \
         decisions, and errors in the reason. Snipping cannot be undone. \
         Messages are addressed as `msg-N` (or `N`), the 1-based index of the message in \
         the conversation. Messages that contain tool_use blocks cannot be snipped; snip \
         the matching tool_result side instead."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(SnipInput))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    /// Mutates shared conversation state; must run serially.
    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SnipInput = parse_input(&input)?;

        if input.message_ids.is_empty() {
            return Ok(ToolOutput::error(
                "No message_ids provided; nothing to snip.",
            ));
        }

        let reason = input
            .reason
            .unwrap_or_else(|| "content snipped to free context space".to_string());

        let mut indices = Vec::new();
        let mut invalid = Vec::new();
        for id in &input.message_ids {
            match parse_message_index(id) {
                Some(index) => indices.push(index),
                None => invalid.push(id.clone()),
            }
        }
        if !invalid.is_empty() {
            return Ok(ToolOutput::error(format!(
                "Unrecognized message id(s): {}. Use `msg-N` or `N`, the 1-based message index.",
                invalid.join(", ")
            )));
        }

        let mut messages = ctx.state.messages();
        let mut snipped = Vec::new();
        let mut skipped = Vec::new();
        for index in indices {
            let Some(message) = messages.get(index) else {
                skipped.push(format!("msg-{} (out of range)", index + 1));
                continue;
            };
            // Never snip a message carrying tool_use blocks: its tool_use_id
            // is referenced by a later tool_result and rewriting it would
            // break the provider's pairing invariant.
            if message_contains_tool_use(message) {
                skipped.push(format!(
                    "msg-{} (contains tool_use; snip the matching tool_result instead)",
                    index + 1
                ));
                continue;
            }
            messages[index] = snip_message_content(message, &reason);
            snipped.push(format!("msg-{}", index + 1));
        }

        if !snipped.is_empty() {
            ctx.state.set_messages_preserving_history_ids(messages);
        }

        if snipped.is_empty() {
            return Ok(ToolOutput::error(format!(
                "Nothing was snipped: {}",
                skipped.join("; ")
            )));
        }

        let mut report = format!(
            "Snipped {} message(s) ({}). They have been replaced with compact placeholders.",
            snipped.len(),
            snipped.join(", ")
        );
        if !skipped.is_empty() {
            report.push_str(&format!(" Skipped: {}.", skipped.join("; ")));
        }
        Ok(ToolOutput::text(report))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;

    fn text_message(text: &str) -> Message {
        Message::user_text(text)
    }

    fn tool_result_message(id: &str, output: &str) -> Message {
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown, content: vec![ContentBlock::ToolResult {
                tool_use_id: id.to_string(),
                content: vec![ContentBlock::Text {
                    text: output.to_string(),
                }],
                is_error: Some(false),
            }],
        }
    }

    fn tool_use_message(id: &str) -> Message {
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: id.to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command": "ls"}),
            }],
            usage: None,
        }
    }

    fn snip_input(ids: &[&str]) -> Value {
        serde_json::json!({
            "message_ids": ids,
            "reason": "test cleanup"
        })
    }

    #[tokio::test]
    async fn snip_replaces_plain_and_tool_result_messages() {
        let ctx = ToolContext::new(AppState::new("/tmp"));
        ctx.state.add_message(text_message("first user message"));
        ctx.state.add_message(tool_use_message("call-1"));
        ctx.state
            .add_message(tool_result_message("call-1", "huge tool output"));

        let output = SnipTool
            .call(snip_input(&["msg-1", "3"]), &ctx)
            .await
            .unwrap();

        assert!(!output.is_error, "snip should succeed: {output:?}");
        let messages = ctx.state.messages();
        // Plain user message replaced with the placeholder.
        let Message::User { content, .. } = &messages[0] else {
            panic!("expected user message");
        };
        assert!(matches!(
            &content[0],
            ContentBlock::Text { text } if text.contains("[snipped: test cleanup]")
        ));
        // tool_result keeps its tool_use_id wrapper with replaced content.
        let Message::User { content, .. } = &messages[2] else {
            panic!("expected user message");
        };
        assert!(matches!(
            &content[0],
            ContentBlock::ToolResult { tool_use_id, content, .. }
                if tool_use_id == "call-1"
                    && matches!(&content[0], ContentBlock::Text { text } if text.contains("snipped"))
        ));
        // The tool_use message itself is untouched.
        assert!(message_contains_tool_use(&messages[1]));
    }

    #[tokio::test]
    async fn snip_skips_tool_use_messages_and_reports() {
        let ctx = ToolContext::new(AppState::new("/tmp"));
        ctx.state.add_message(tool_use_message("call-1"));

        let output = SnipTool.call(snip_input(&["1"]), &ctx).await.unwrap();

        assert!(output.is_error);
        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert!(
            text.contains("tool_use"),
            "skip reason must be explained: {text}"
        );
        // State untouched.
        assert!(message_contains_tool_use(&ctx.state.messages()[0]));
    }

    #[tokio::test]
    async fn snip_rejects_bad_ids_and_out_of_range() {
        let ctx = ToolContext::new(AppState::new("/tmp"));
        ctx.state.add_message(text_message("only message"));

        let bad = SnipTool.call(snip_input(&["foo"]), &ctx).await.unwrap();
        assert!(bad.is_error);

        let out_of_range = SnipTool.call(snip_input(&["msg-99"]), &ctx).await.unwrap();
        assert!(out_of_range.is_error);
        // Nothing changed.
        let messages = ctx.state.messages();
        let Message::User { content, .. } = &messages[0] else {
            panic!("expected user message");
        };
        assert!(matches!(
            &content[0],
            ContentBlock::Text { text } if text == "only message"
        ));
    }
}
