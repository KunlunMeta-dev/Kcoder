use std::collections::{HashMap, HashSet};
use std::mem;

use kcoder_types::{ContentBlock, Message};

pub(crate) fn take_compact_aware_snapshot(raw: &mut Vec<Message>) -> Vec<Message> {
    let start = crate::context::latest_compact_boundary(raw)
        .map(|boundary| boundary.summary_index)
        .unwrap_or(0);
    // Keep only a possible pre-boundary prefix for repair writeback. The normal
    // first-message boundary transfers the existing allocation without copying.
    if start == 0 {
        mem::take(raw)
    } else {
        raw.split_off(start)
    }
}

pub(crate) fn prepare_request_messages(
    mut raw: Vec<Message>,
) -> (Vec<Message>, Option<Vec<Message>>) {
    let visible = take_compact_aware_snapshot(&mut raw);
    let (messages, changed) = repair_tool_message_sequence(visible);
    let writeback = changed.then(|| {
        let mut repaired = raw;
        repaired.extend(messages.clone());
        repaired
    });
    (messages, writeback)
}

pub(crate) fn repair_tool_message_sequence(messages: Vec<Message>) -> (Vec<Message>, bool) {
    if has_canonical_tool_sequence(|index| messages.get(index)) {
        return (messages, false);
    }
    repair_tool_message_sequence_slow(messages)
}

// This is a sufficient, not necessary, fixed-point check. Ambiguous histories
// keep the established repair semantics instead of guessing from IDs or length.
fn has_canonical_tool_sequence<'a>(get: impl Fn(usize) -> Option<&'a Message>) -> bool {
    let mut index = 0;
    while let Some(message) = get(index) {
        match message {
            Message::User { content } => {
                if content.is_empty()
                    || content
                        .iter()
                        .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
                {
                    return false;
                }
            }
            Message::Assistant { content, .. } => {
                let mut ids = content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolUse { id, .. } => Some(id.as_str()),
                        _ => None,
                    })
                    .peekable();
                if ids.peek().is_some() {
                    let Some(Message::User { content: results }) = get(index + 1) else {
                        return false;
                    };
                    let mut seen = HashSet::new();
                    for result in results {
                        let Some(id) = ids.next() else {
                            return false;
                        };
                        if !matches!(result, ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == id)
                            || (results.len() > 1 && !seen.insert(id))
                        {
                            return false;
                        }
                    }
                    if ids.next().is_some() {
                        return false;
                    }
                    index += 1;
                }
            }
        }
        index += 1;
    }
    true
}

pub(crate) fn prepare_shared_request_messages(
    raw: kcoder_types::SharedMessages,
) -> (kcoder_types::SharedMessages, Option<Vec<Message>>) {
    // The compact-aware view keeps the leading summary and never scans later markers.
    // Canonical histories therefore need no payload materialization or state writeback.
    if has_canonical_tool_sequence(|index| raw.get(index)) {
        return (raw, None);
    }
    let (messages, writeback) = prepare_request_messages(raw.into_vec());
    (messages.into(), writeback)
}

fn repair_tool_message_sequence_slow(messages: Vec<Message>) -> (Vec<Message>, bool) {
    let original = messages.clone();
    let mut scratch = messages;
    let mut repaired = Vec::with_capacity(scratch.len());
    let mut index = 0usize;

    while index < scratch.len() {
        match mem::replace(
            &mut scratch[index],
            Message::User {
                content: Vec::new(),
            },
        ) {
            Message::Assistant { content, usage } => {
                let tool_use_ids = tool_use_ids(&content);
                repaired.push(Message::Assistant { content, usage });
                index += 1;

                if !tool_use_ids.is_empty() {
                    let mut collected =
                        take_following_tool_results(&mut scratch, index, &tool_use_ids);
                    let mut result_blocks = Vec::with_capacity(tool_use_ids.len());
                    for id in tool_use_ids {
                        result_blocks.push(
                            collected
                                .remove(&id)
                                .unwrap_or_else(|| interrupted_tool_result(&id)),
                        );
                    }
                    repaired.push(Message::User {
                        content: result_blocks,
                    });
                }
            }
            Message::User { content } => {
                let content = convert_orphan_tool_results(content);
                if !content.is_empty() {
                    repaired.push(Message::User { content });
                }
                index += 1;
            }
        }
    }

    let changed = repaired != original;
    (repaired, changed)
}

fn tool_use_ids(content: &[ContentBlock]) -> Vec<String> {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect()
}

fn take_following_tool_results(
    messages: &mut [Message],
    start: usize,
    tool_use_ids: &[String],
) -> HashMap<String, ContentBlock> {
    let wanted: HashSet<String> = tool_use_ids.iter().cloned().collect();
    let mut found = HashMap::new();

    for message in messages.iter_mut().skip(start) {
        let Message::User { content } = message else {
            break;
        };

        let mut kept = Vec::with_capacity(content.len());
        for block in mem::take(content) {
            match &block {
                ContentBlock::ToolResult { tool_use_id, .. }
                    if wanted.contains(tool_use_id) && !found.contains_key(tool_use_id) =>
                {
                    found.insert(tool_use_id.clone(), block);
                }
                _ => kept.push(block),
            }
        }
        *content = kept;
    }

    found
}

fn convert_orphan_tool_results(content: Vec<ContentBlock>) -> Vec<ContentBlock> {
    content
        .into_iter()
        .map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => ContentBlock::Text {
                text: orphan_tool_result_text(&tool_use_id, &content, is_error),
            },
            other => other,
        })
        .collect()
}

pub(super) fn interrupted_tool_result(tool_use_id: &str) -> ContentBlock {
    ContentBlock::ToolResult {
        tool_use_id: tool_use_id.to_string(),
        content: vec![ContentBlock::Text {
            text: "Tool call was interrupted before KCoder recorded a result.".to_string(),
        }],
        is_error: Some(true),
    }
}

fn orphan_tool_result_text(
    tool_use_id: &str,
    content: &[ContentBlock],
    is_error: Option<bool>,
) -> String {
    let status = if is_error.unwrap_or(false) {
        "error"
    } else {
        "ok"
    };
    let text = content_blocks_plain_text(content);
    if text.is_empty() {
        format!("[orphaned tool result {tool_use_id}: {status}]")
    } else {
        format!("[orphaned tool result {tool_use_id}: {status}] {text}")
    }
}

pub(super) fn content_blocks_plain_text(content: &[ContentBlock]) -> String {
    content
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text.clone(),
            ContentBlock::Thinking { thinking, .. } => thinking.clone(),
            ContentBlock::RedactedThinking { .. } => "[redacted thinking]".to_string(),
            ContentBlock::ToolUse { id, name, input } => {
                format!("[tool use {id}: {name} {input}]")
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => orphan_tool_result_text(tool_use_id, content, *is_error),
            ContentBlock::Image { source } => format!("[image: {}]", source.media_type),
        })
        .collect::<Vec<_>>()
        .join("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_request_preparation_keeps_canonical_payloads_shared() {
        let raw =
            kcoder_types::SharedMessages::from(vec![Message::user_text("large".repeat(8192))]);
        let snapshot = raw.clone();
        let (prepared, writeback) = prepare_shared_request_messages(raw);
        assert!(writeback.is_none());
        assert!(std::ptr::eq(
            prepared.get(0).unwrap(),
            snapshot.get(0).unwrap()
        ));
    }

    #[test]
    fn request_preparation_reuses_owned_snapshot_without_writeback() {
        let raw = vec![Message::user_text("large context".repeat(8192))];
        let pointer = raw.as_ptr();
        let expected = raw.clone();
        let (visible, writeback) = prepare_request_messages(raw);
        assert_eq!(visible, expected);
        assert!(writeback.is_none());
        assert_eq!(visible.as_ptr(), pointer);
    }

    #[test]
    fn request_preparation_preserves_summary_and_repairs_writeback() {
        for summary in [None, Some("Earlier conversation summary: retained context")] {
            let mut raw = summary
                .into_iter()
                .map(Message::user_text)
                .collect::<Vec<_>>();
            raw.push(Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "pending".into(),
                    name: "Read".into(),
                    input: serde_json::json!({}),
                }],
                usage: None,
            });
            raw.push(Message::user_text("follow-up"));
            let (expected, changed) = repair_tool_message_sequence_slow(
                crate::context::messages_after_latest_compact_boundary(&raw),
            );
            assert!(changed);
            let (visible, writeback) = prepare_request_messages(raw);
            assert_eq!(visible, expected);
            assert_eq!(writeback, Some(expected));
        }
    }

    #[test]
    fn canonical_preflight_matches_original_repair_for_short_sequences() {
        let tool = |id: &str| ContentBlock::ToolUse {
            id: id.into(),
            name: "Read".into(),
            input: serde_json::json!({"path":"中文.txt"}),
        };
        let result = |id: &str| interrupted_tool_result(id);
        let variants = vec![
            Message::user_text("request"),
            Message::User { content: vec![] },
            Message::Assistant {
                content: vec![],
                usage: None,
            },
            Message::Assistant {
                content: vec![tool("a")],
                usage: None,
            },
            Message::Assistant {
                content: vec![tool("a"), tool("b")],
                usage: None,
            },
            Message::Assistant {
                content: vec![tool("a"), tool("a")],
                usage: None,
            },
            Message::User {
                content: vec![result("a")],
            },
            Message::User {
                content: vec![result("a"), result("b")],
            },
            Message::User {
                content: vec![result("b"), result("a")],
            },
            Message::User {
                content: vec![
                    result("a"),
                    ContentBlock::Text {
                        text: "mixed".into(),
                    },
                ],
            },
        ];
        for len in 0..=4u32 {
            for mut code in 0..variants.len().pow(len) {
                let messages: Vec<_> = (0..len)
                    .map(|_| {
                        let message = variants[code % variants.len()].clone();
                        code /= variants.len();
                        message
                    })
                    .collect();
                let expected = repair_tool_message_sequence_slow(messages.clone());
                assert_eq!(repair_tool_message_sequence(messages.clone()), expected);
                let (shared, writeback) = prepare_shared_request_messages(messages.into());
                assert_eq!(shared.to_vec(), expected.0);
                assert_eq!(writeback, expected.1.then_some(expected.0));
            }
        }
    }

    #[test]
    fn preserves_owned_text_payload_address_when_no_repair_is_needed() {
        let text = "context".repeat(8192);
        let pointer = text.as_ptr() as usize;
        let messages = vec![Message::Assistant {
            content: vec![ContentBlock::Text { text }],
            usage: None,
        }];
        let expected = messages.clone();
        let vector_pointer = messages.as_ptr();

        let (repaired, changed) = repair_tool_message_sequence(messages);

        assert_eq!(repaired, expected);
        assert!(!changed);
        assert_eq!(repaired.as_ptr(), vector_pointer);
        let Message::Assistant { content, .. } = &repaired[0] else {
            panic!("expected an assistant message");
        };
        let ContentBlock::Text { text } = &content[0] else {
            panic!("expected a text content block");
        };
        assert_eq!(text.as_ptr() as usize, pointer);
    }
}
