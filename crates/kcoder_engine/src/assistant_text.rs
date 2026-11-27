//! Assistant transcript text helpers shared by background maintenance and
//! session-end hooks.
//!
//! Automatic extraction of "remember that ..." lines into project memory was
//! removed: it only matched English phrasing and wrote model output verbatim
//! into durable memory. Durable facts are saved through the explicit
//! `remember` tool instead.

use super::*;

pub(super) fn last_assistant_text(messages: &[Message]) -> Option<String> {
    messages.iter().rev().find_map(|message| match message {
        Message::Assistant { content, .. } => Some(
            content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>(),
        ),
        Message::User { .. } => None,
    })
}
