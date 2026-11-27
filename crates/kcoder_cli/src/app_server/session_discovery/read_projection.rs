//! Pure projection from the visible transcript to ReadSession turns. Turn identity
//! follows the Studio transcript (attempt identity, admission binding, else ordinal).
//! Reasoning, runtime/compaction bodies and file or image bytes are never projected.
use kcoder_state::HistoryEntry;
use kcoder_state::turn_attempt_store::TurnAttemptRecord;
use kcoder_tools::session_read::{
    ATTACHMENT_MARKER, IMAGE_MARKER, SessionReadItem, SessionReadItemKind, SessionReadTurn,
    SessionReadTurnStatus,
};
use kcoder_transcript::{KCODER_ATTACHMENTS_OPEN, TurnOutcomeArtifact, validated_history_attempt};
use kcoder_types::{ContentBlock, Message, MessageOrigin, TurnAttemptStatus};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Bound each raw text before the shared caps; the tool keeps the newest 20,000 chars.
const MAX_RAW_ITEM_CHARS: usize = 64 * 1024;

#[derive(Clone, Copy, Default)]
pub(crate) struct Options {
    pub include_outputs: bool,
    pub include_attachments: bool,
}

pub(crate) struct Artifacts<'a> {
    pub thread_id: &'a str,
    pub attempts: &'a [TurnAttemptRecord],
    pub bindings: &'a HashMap<String, String>,
    pub outcomes: &'a HashMap<String, TurnOutcomeArtifact>,
}

fn item(kind: SessionReadItemKind, text: String) -> SessionReadItem {
    let (text, truncated_front) = kcoder_tools::session_read::keep_tail(&text, MAX_RAW_ITEM_CHARS);
    SessionReadItem {
        truncated_front,
        ..SessionReadItem::text(kind, text)
    }
}

fn attachment(name: &str, kind: Option<&str>, size: Option<u64>) -> SessionReadItem {
    let mut text = format!("名称：{name}");
    if let Some(kind) = kind.filter(|kind| !kind.is_empty()) {
        text.push_str(&format!(" · 类型：{kind}"));
    }
    if let Some(size) = size {
        text.push_str(&format!(" · 大小：{size} 字节"));
    }
    item(SessionReadItemKind::Attachment, text)
}

fn image(
    source: &kcoder_types::ImageSource,
    options: Options,
    text: &mut Vec<String>,
) -> Option<SessionReadItem> {
    if options.include_attachments {
        let size = (source.source_type == "base64").then(|| source.data.len() as u64 * 3 / 4);
        Some(attachment("图片", Some(&source.media_type), size))
    } else {
        text.push(IMAGE_MARKER.into());
        None
    }
}

/// Split the host's attachment envelope from user text; paths are never returned.
fn user_text(raw: &str, options: Options, attachments: &mut Vec<SessionReadItem>) -> String {
    let Some(open) = raw.rfind(KCODER_ATTACHMENTS_OPEN) else {
        return raw.to_owned();
    };
    let visible = raw[..open].trim_end();
    if !options.include_attachments {
        return if visible.is_empty() {
            ATTACHMENT_MARKER.into()
        } else {
            format!("{visible}\n{ATTACHMENT_MARKER}")
        };
    }
    for line in raw[open + KCODER_ATTACHMENTS_OPEN.len()..].lines().take(32) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let text = |keys: &[&str]| {
            keys.iter()
                .find_map(|key| record.get(*key).and_then(Value::as_str))
                .map(str::to_owned)
        };
        let size = ["size", "sizeBytes", "bytes"]
            .iter()
            .find_map(|key| record.get(*key).and_then(Value::as_u64));
        let name = text(&["filename", "name"]).unwrap_or_else(|| "附件".into());
        let name = std::path::Path::new(&name)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or(name);
        attachments.push(attachment(
            &name,
            text(&["mimeType", "mime_type", "contentType", "type"]).as_deref(),
            size,
        ));
    }
    visible.to_owned()
}

fn nested_text(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.clone()),
            ContentBlock::Image { .. } => Some(IMAGE_MARKER.into()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[allow(deprecated)]
fn legacy_runtime_text(origin: MessageOrigin, text: &str) -> bool {
    // Only legacy records without provenance fall back to the recognizer; an explicit
    // User origin is always the user's own text.
    origin == MessageOrigin::Unknown && kcoder_types::is_hidden_runtime_user_text(text)
}

fn flush(items: &mut Vec<SessionReadItem>, kind: SessionReadItemKind, text: &mut Vec<String>) {
    let joined = text.join("\n\n");
    text.clear();
    if !joined.trim().is_empty() {
        items.push(item(kind, joined));
    }
}

pub(crate) fn items_for(
    message: &Message,
    options: Options,
    tool_names: &mut HashMap<String, String>,
) -> Vec<SessionReadItem> {
    if message.has_peer_agent_metadata() {
        return message
            .peer_agent_data()
            .map(|(_, text)| vec![item(SessionReadItemKind::PeerMessage, text.to_owned())])
            .unwrap_or_default();
    }
    let mut items = Vec::new();
    let mut text = Vec::new();
    match message {
        Message::User { content, .. } => {
            let origin = message.origin();
            let hidden = matches!(origin, MessageOrigin::Runtime | MessageOrigin::Compaction);
            let mut attachments = Vec::new();
            let mut results = Vec::new();
            for block in content {
                match block {
                    ContentBlock::Text { text: raw }
                        if !hidden && !legacy_runtime_text(origin, raw) =>
                    {
                        text.push(user_text(raw, options, &mut attachments));
                    }
                    ContentBlock::Image { source } if !hidden => {
                        attachments.extend(image(source, options, &mut text));
                    }
                    ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } if options.include_outputs => {
                        let mut result =
                            item(SessionReadItemKind::ToolResult, nested_text(content));
                        result.tool_name = tool_names.get(tool_use_id).cloned();
                        result.is_error = is_error.unwrap_or(false);
                        results.push(result);
                    }
                    _ => {}
                }
            }
            flush(&mut items, SessionReadItemKind::UserMessage, &mut text);
            items.extend(attachments);
            items.extend(results);
        }
        Message::Assistant { content, .. } => {
            for block in content {
                match block {
                    ContentBlock::Text { text: raw } => text.push(raw.clone()),
                    ContentBlock::Image { source } => {
                        if let Some(image) = image(source, options, &mut text) {
                            flush(&mut items, SessionReadItemKind::AssistantMessage, &mut text);
                            items.push(image);
                        }
                    }
                    ContentBlock::ToolUse { id, name, input } => {
                        tool_names.insert(id.clone(), name.clone());
                        if options.include_outputs {
                            flush(&mut items, SessionReadItemKind::AssistantMessage, &mut text);
                            let mut call = item(
                                SessionReadItemKind::ToolCall,
                                serde_json::to_string(input).unwrap_or_default(),
                            );
                            call.tool_name = Some(name.clone());
                            items.push(call);
                        }
                    }
                    _ => {}
                }
            }
            flush(&mut items, SessionReadItemKind::AssistantMessage, &mut text);
        }
    }
    items
}

fn attempt_status(status: &TurnAttemptStatus) -> SessionReadTurnStatus {
    match status {
        TurnAttemptStatus::Completed => SessionReadTurnStatus::Completed,
        TurnAttemptStatus::Failed => SessionReadTurnStatus::Failed,
        TurnAttemptStatus::Interrupted => SessionReadTurnStatus::Interrupted,
        _ => SessionReadTurnStatus::Unknown,
    }
}

fn outcome_status(status: &str) -> SessionReadTurnStatus {
    match status {
        "completed" => SessionReadTurnStatus::Completed,
        "failed" => SessionReadTurnStatus::Failed,
        "interrupted" | "cancelled" => SessionReadTurnStatus::Interrupted,
        _ => SessionReadTurnStatus::Unknown,
    }
}

/// Group visible entries into turns in transcript order and attach recorded outcomes.
pub(crate) fn project_turns(
    entries: Vec<HistoryEntry>,
    artifacts: &Artifacts<'_>,
    options: Options,
) -> Vec<SessionReadTurn> {
    let attempts = artifacts
        .attempts
        .iter()
        .filter(|record| {
            record.validate().is_ok() && record.identity.thread_id == artifacts.thread_id
        })
        .collect::<Vec<_>>();
    let identities = attempts
        .iter()
        .map(|record| record.identity.clone())
        .collect::<HashSet<_>>();
    let mut turns = Vec::<SessionReadTurn>::new();
    let mut positions = HashMap::<String, usize>::new();
    let mut tool_names = HashMap::new();
    let mut ordinal = 0usize;
    let mut active: Option<String> = None;
    for entry in entries {
        let attempt =
            validated_history_attempt(&entry, artifacts.thread_id, artifacts.bindings, &identities);
        let real_user = kcoder_types::is_real_user_message(&entry.message);
        if real_user {
            ordinal = ordinal.saturating_add(1);
        }
        if let Some(identity) = &attempt {
            active = Some(identity.turn_id.clone());
        } else if real_user {
            active = Some(
                entry
                    .uuid
                    .as_ref()
                    .and_then(|uuid| artifacts.bindings.get(uuid))
                    .cloned()
                    .unwrap_or_else(|| format!("turn-{ordinal}")),
            );
        }
        let items = items_for(&entry.message, options, &mut tool_names);
        // Rows before the first turn have no turn identity and are not shown by Studio.
        let Some(turn_id) = active.clone() else {
            continue;
        };
        let position = *positions.entry(turn_id.clone()).or_insert_with(|| {
            turns.push(SessionReadTurn {
                turn_id,
                status: SessionReadTurnStatus::Unknown,
                partial: false,
                started_at_ms: Some(entry.timestamp_ms),
                ended_at_ms: None,
                items: Vec::new(),
                omitted_items: 0,
            });
            turns.len() - 1
        });
        turns[position].items.extend(items);
    }
    for turn in &mut turns {
        let latest = attempts
            .iter()
            .filter(|record| record.identity.turn_id == turn.turn_id)
            .max_by_key(|record| record.accepted_at_ms);
        (turn.status, turn.ended_at_ms) = match latest {
            Some(record) => match &record.completion {
                Some(completion) => (
                    attempt_status(&completion.status),
                    Some(completion.finished_at_ms),
                ),
                None => (SessionReadTurnStatus::Unknown, None),
            },
            None => match artifacts.outcomes.get(&turn.turn_id) {
                Some(outcome) => (
                    outcome_status(&outcome.status),
                    Some(outcome.completed_at_ms),
                ),
                None => (SessionReadTurnStatus::Unknown, None),
            },
        };
    }
    turns
}
