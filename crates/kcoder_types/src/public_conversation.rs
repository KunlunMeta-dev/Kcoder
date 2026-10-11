//! Public child conversation projection, shared by recovery and live delivery.
use crate::{ContentBlock, Message, MessageOrigin};

/// Strip private reasoning and synthesized context using provenance, recursively.
/// Unclassified legacy user text is omitted; tool results remain visible.
pub fn public_conversation_message(message: &Message) -> Option<Message> {
    let (blocks, user) = match message {
        Message::User { content, .. } => (content, true),
        Message::Assistant { content, .. } => (content, false),
    };
    let allow_text = !user || message.origin() == MessageOrigin::User;
    let content = blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { .. } if allow_text => Some(block.clone()),
            ContentBlock::ToolUse { .. } => Some(block.clone()),
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => Some(ContentBlock::ToolResult {
                tool_use_id: tool_use_id.clone(),
                content: content
                    .iter()
                    .filter(|block| {
                        matches!(
                            block,
                            ContentBlock::Text { .. } | ContentBlock::Image { .. }
                        )
                    })
                    .cloned()
                    .collect(),
                is_error: *is_error,
            }),
            ContentBlock::Image { .. } if allow_text => Some(block.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if content.is_empty() {
        return None;
    }
    Some(if user {
        Message::User {
            origin: message.origin(),
            content,
        }
    } else {
        Message::Assistant {
            content,
            usage: None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_messages_hide_private_blocks_but_keep_runtime_tool_results() {
        assert!(public_conversation_message(&Message::runtime_text("secret")).is_none());
        assert!(public_conversation_message(&Message::compaction_text("secret")).is_none());
        let message = Message::user_content(vec![ContentBlock::ToolResult {
            tool_use_id: "tool".into(),
            is_error: Some(false),
            content: vec![
                ContentBlock::Text {
                    text: "result".into(),
                },
                ContentBlock::Thinking {
                    thinking: "secret".into(),
                    signature: "signature".into(),
                },
            ],
        }])
        .with_origin(MessageOrigin::Runtime);
        let wire = serde_json::to_string(&public_conversation_message(&message).unwrap()).unwrap();
        assert!(wire.contains("result"));
        assert!(!wire.contains("secret"));
        assert!(!wire.contains("signature"));
    }
}
