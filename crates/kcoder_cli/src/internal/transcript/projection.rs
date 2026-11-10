//! Pure history-to-protocol projection. Persistence stays with the caller.
use super::*;
use kcoder_app_protocol::{
    ApprovalAction, ApprovalDecision, TurnFileChangesCapture, TurnReviewEvidence,
};
use kcoder_types::{ContentBlock, Message};
use std::sync::Arc;

#[cfg(any(test, feature = "test-oracle"))]
#[path = "../../app_server/transcript_context_oracle.rs"]
mod transcript_context_oracle;

#[derive(Clone)]
#[cfg_attr(any(test, feature = "test-oracle"), derive(serde::Serialize))]
pub struct TranscriptToolContext {
    pub(crate) web_sources: Option<kcoder_types::web_sources::WebSourcesV1>,
    pub(crate) entry_index: usize,
    pub(crate) last_reference_index: usize,
    pub(crate) name: String,
    pub(crate) input: Value,
    pub(crate) has_tool_use: bool,
    pub(crate) output_images: Vec<kcoder_app_protocol::ToolOutputImage>,
    pub(crate) images_omitted: bool,
    pub(crate) output: Option<String>,
    pub(crate) is_error: bool,
    pub(crate) started_at_ms: u64,
    pub(crate) completed_at_ms: Option<u64>,
}

impl TranscriptToolContext {
    pub fn observe_start(&mut self, started_at_ms: u64) {
        self.started_at_ms = started_at_ms;
    }

    pub fn fill_unrecorded_input(&mut self, name: &str, input: &Value) {
        if !self.has_tool_use {
            self.name = name.to_owned();
            self.input = input.clone();
        }
    }
}

#[derive(Clone, Hash, PartialEq, Eq)]
pub struct TranscriptToolId(pub(crate) Arc<str>);

pub type TranscriptToolContexts = HashMap<TranscriptToolId, Vec<TranscriptToolContext>>;

pub const TOOL_PREVIEW_BYTES: usize = 64 * 1024;

pub fn input_preview(input: Value) -> (Value, bool, usize) {
    let encoded = serde_json::to_string(&input).expect("tool input serializes");
    let bytes = encoded.len();
    if bytes <= TOOL_PREVIEW_BYTES {
        return (input, false, bytes);
    }
    let (preview, _, _) = truncate_utf8_bytes(encoded, TOOL_PREVIEW_BYTES);
    (
        json!({"_truncated":true,"_preview":preview,"_original_bytes":bytes}),
        true,
        bytes,
    )
}

pub fn approval_action_description(action: &ApprovalAction) -> String {
    match action {
        ApprovalAction::Command { command } => format!("Command: {command}"),
        ApprovalAction::FileChange { path } => format!("File change: {path}"),
        ApprovalAction::Tool { name, input } => {
            let input = serde_json::to_string_pretty(input).unwrap_or_else(|_| "{}".into());
            format!("Tool: {name}\n{input}")
        }
    }
}

pub fn approval_decision_label(decision: &ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::Accept => "Allow once",
        ApprovalDecision::AcceptForSession => "Always allow for this session",
        ApprovalDecision::Decline => "Decline",
        ApprovalDecision::Cancel => "Cancelled",
    }
}

pub fn attach_approval_decision_blocks(
    messages: &mut [ThreadMessage],
    artifacts: Vec<ApprovalDecisionArtifact>,
) {
    for artifact in artifacts {
        let Some(message) = messages.iter_mut().find(|message| {
            message.turn_id.as_deref() == Some(artifact.turn_id.as_str())
                && message.role == "assistant"
        }) else {
            continue;
        };
        let question = [
            artifact.reason.as_str(),
            approval_action_description(&artifact.action).as_str(),
        ]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        let label = approval_decision_label(&artifact.decision);
        let render_payload = json!({
            "kind": "request_user_input",
            "itemId": artifact.approval_id,
            "questions": [{
                "id": artifact.approval_id,
                "header": "Permission request",
                "question": question,
                "options": [
                    {"label": "Allow once", "description": "Allow this operation once."},
                    {"label": "Decline", "description": "Decline this operation."}
                ],
                "isOther": false,
                "multiSelect": false
            }],
            "response": {
                "itemId": artifact.approval_id,
                "answers": {
                    artifact.approval_id.clone(): {"answers": [label]}
                }
            }
        });
        message.blocks.insert(
            0,
            json!({
                "id": format!("approval-history-{}", artifact.artifact_id),
                "type": "tool",
                "tool_name": "request_user_input",
                "toolName": "request_user_input",
                "status": "done",
                "timestamp": artifact.requested_at_ms,
                "completed_at": artifact.resolved_at_ms,
                "tool_output": artifact.resolution_reason,
                "render_payload": render_payload.clone(),
                "renderPayload": render_payload
            }),
        );
    }
}

/// Positional legacy turn labels are display fallback, never attempt evidence.
/// Only the producer-bound row plus this read's exact attempt catalog can prove
/// a modern identity. Admission bindings exist for user UUIDs only.
pub fn validated_history_attempt(
    entry: &kcoder_state::HistoryEntry,
    thread_id: &str,
    admitted: &HashMap<String, String>,
    attempts: &HashSet<kcoder_types::TurnAttemptIdentity>,
) -> Option<kcoder_types::TurnAttemptIdentity> {
    let identity = entry.history_attempt.as_ref()?;
    let uuid = entry.uuid.as_deref()?;
    (identity.validate().is_ok()
        && !uuid.is_empty()
        && uuid.len() <= 128
        && entry.session_id == thread_id
        && identity.thread_id == thread_id
        && attempts.contains(identity)
        && admitted
            .get(uuid)
            .is_none_or(|turn| turn == &identity.turn_id))
    .then(|| identity.clone())
}

pub fn coalesce_assistant_tool_fragments(messages: &mut Vec<ThreadMessage>) {
    let mut coalesced = Vec::<ThreadMessage>::with_capacity(messages.len());
    let mut tail_content_source_id = String::new();
    for mut message in messages.drain(..) {
        let merge_with_previous = coalesced.last().is_some_and(|previous| {
            previous.role == "assistant"
                && message.role == "assistant"
                && match (&previous.attempt_id, &message.attempt_id) {
                    (None, None) => true,
                    (Some(previous_attempt), Some(attempt)) => {
                        previous_attempt == attempt
                            && previous.status.is_none()
                            && message.status.is_none()
                    }
                    _ => false,
                }
                && previous.turn_id.is_some()
                && previous.turn_id == message.turn_id
                && (!previous.blocks.is_empty() || !message.blocks.is_empty())
                && (previous.content.trim().is_empty() || message.content.trim().is_empty())
        });
        if !merge_with_previous {
            tail_content_source_id.clone_from(&message.id);
            coalesced.push(message);
            continue;
        }

        let previous = coalesced.last_mut().expect("previous message exists");
        if !previous.content.trim().is_empty() && !message.blocks.is_empty() {
            // Commentary belongs before the next event, not below the accumulated tools.
            // Each promoted tail retains its source row, rather than the coalesced row's ID.
            previous.blocks.push(json!({
                "id": format!("{tail_content_source_id}-text"),
                "type": "text",
                "content": std::mem::take(&mut previous.content),
                "status": "done",
                "timestamp": previous.timestamp_ms,
                "content_truncated": previous.content_truncated,
                "content_original_chars": previous.content_original_chars,
            }));
            previous.content_truncated = false;
            previous.content_original_chars = None;
        }
        if previous.content.trim().is_empty() && !message.content.trim().is_empty() {
            tail_content_source_id.clone_from(&message.id);
            previous.content = std::mem::take(&mut message.content);
            previous.content_truncated = message.content_truncated;
            previous.content_original_chars = message.content_original_chars;
        }
        previous.blocks.append(&mut message.blocks);
        tool_images::bound_history_blocks(&mut previous.blocks);
        if message.status.is_some() {
            previous.status = message.status;
        }
    }
    let turn_started_at = coalesced
        .iter()
        .filter(|message| message.role == "user")
        .filter_map(|message| {
            message
                .turn_id
                .as_ref()
                .map(|turn_id| (turn_id.clone(), message.timestamp_ms))
        })
        .collect::<HashMap<_, _>>();
    for message in &mut coalesced {
        if message.role != "assistant" || message.blocks.is_empty() {
            continue;
        }
        if let Some(started_at) = message
            .turn_id
            .as_ref()
            .and_then(|turn_id| turn_started_at.get(turn_id))
        {
            message.timestamp_ms = message.timestamp_ms.min(*started_at);
        }
    }
    *messages = coalesced;
}

pub fn attach_turn_file_change_blocks(
    messages: &mut [ThreadMessage],
    summaries: HashMap<String, Value>,
) {
    for (turn_id, summary) in summaries {
        let target_index = messages
            .iter_mut()
            .rposition(|message| {
                message.turn_id.as_deref() == Some(turn_id.as_str()) && message.role == "assistant"
            })
            .or_else(|| {
                messages
                    .iter()
                    .rposition(|message| message.turn_id.as_deref() == Some(turn_id.as_str()))
            });
        if let Some(index) = target_index {
            let message = &mut messages[index];
            message.blocks.push(json!({
                "id": format!("file-changes-{}", summary["artifact_id"].as_str().unwrap_or("missing")),
                "type": "file_changes",
                "status": "done",
                "fileChanges": summary.clone(),
                "file_changes": summary,
            }));
        }
    }
}

pub fn history_entry_thread_message(
    index: usize,
    entry: kcoder_state::HistoryEntry,
    turn_id: Option<String>,
    tool_contexts: &TranscriptToolContexts,
) -> Option<ThreadMessage> {
    let serialized = serde_json::to_value(&entry.message).ok()?;
    let mut role = serialized.get("role")?.as_str()?.to_owned();
    let content_blocks = serialized.get("content")?.as_array()?;
    let mut text_parts = Vec::new();
    let mut blocks = Vec::new();
    let mut tool_result_only = !content_blocks.is_empty();
    let hidden_runtime_body = role == "user"
        && matches!(
            entry.message.origin(),
            kcoder_types::MessageOrigin::Runtime | kcoder_types::MessageOrigin::Compaction
        );
    for (block_index, block) in content_blocks.iter().enumerate() {
        if hidden_runtime_body
            && !matches!(
                block.get("type").and_then(Value::as_str),
                Some("tool_use" | "tool_result")
            )
        {
            continue;
        }
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    tool_result_only = false;
                    let has_later_activity = role == "assistant"
                        && content_blocks[block_index + 1..].iter().any(|block| {
                            matches!(
                                block.get("type").and_then(Value::as_str),
                                Some("tool_use" | "thinking" | "redacted_thinking")
                            )
                        });
                    if has_later_activity {
                        let (content, truncated, original_chars) =
                            truncate_utf8_bytes(text.to_owned(), MAX_TRANSCRIPT_MESSAGE_BYTES);
                        blocks.push(json!({
                            "id": format!("{}-text-{block_index}", entry.uuid.as_deref().unwrap_or(&entry.session_id)),
                            "type": "text", "content": content, "status": "done",
                            "timestamp": entry.timestamp_ms,
                            "content_truncated": truncated, "content_original_chars": original_chars,
                        }));
                    } else {
                        text_parts.push(text);
                    }
                }
            }
            Some("thinking") => {
                tool_result_only = false;
                let content = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !content.is_empty() {
                    blocks.push(json!({
                        "id": format!("{}-thinking-{block_index}", entry.uuid.as_deref().unwrap_or(&entry.session_id)),
                        "type": "thinking",
                        "content": content,
                        "status": "done",
                        "timestamp": entry.timestamp_ms,
                    }));
                }
            }
            Some("redacted_thinking") => {
                tool_result_only = false;
                blocks.push(json!({
                    "id": format!("{}-thinking-{block_index}", entry.uuid.as_deref().unwrap_or(&entry.session_id)),
                    "type": "thinking",
                    "content": "[redacted thinking]",
                    "status": "done",
                    "timestamp": entry.timestamp_ms,
                }));
            }
            Some("tool_use") => {
                tool_result_only = false;
                let Some(id) = block.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let context = transcript_tool_context(tool_contexts, id, index);
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                blocks.push(transcript_tool_block(
                    id,
                    name,
                    input,
                    context.and_then(|context| context.output.clone()),
                    context.is_some_and(|context| context.is_error),
                    context
                        .map(|context| context.started_at_ms)
                        .unwrap_or(entry.timestamp_ms),
                    context.and_then(|context| context.completed_at_ms),
                ));
                if let (Some(receipt), Some(block)) = (
                    context.and_then(|context| context.web_sources.as_ref()),
                    blocks.last_mut(),
                ) {
                    block["webSources"] = json!(receipt);
                }
                if let (Some(context), Some(block)) = (context, blocks.last_mut())
                    && (!context.output_images.is_empty() || context.images_omitted)
                {
                    block["outputImages"] = json!(context.output_images);
                    block["outputImagesOmitted"] = json!(context.images_omitted);
                }
            }
            Some("tool_result") => {
                let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                    continue;
                };
                let context = transcript_tool_context(tool_contexts, id, index);
                // Completed calls stay at their original call position, even when
                // parallel results arrive out of order. Orphan results remain visible.
                if context.is_some_and(|context| context.has_tool_use) {
                    continue;
                }
                let output = nested_text_content(block.get("content"));
                let is_error = block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                blocks.push(transcript_tool_block(
                    id,
                    context
                        .map(|context| context.name.as_str())
                        .unwrap_or("tool"),
                    context
                        .map(|context| context.input.clone())
                        .unwrap_or_else(|| json!({})),
                    Some(output),
                    is_error,
                    context
                        .map(|context| context.started_at_ms)
                        .unwrap_or(entry.timestamp_ms),
                    context
                        .and_then(|context| context.completed_at_ms)
                        .or(Some(entry.timestamp_ms)),
                ));
                if let (Some(receipt), Some(block)) = (
                    context.and_then(|context| context.web_sources.as_ref()),
                    blocks.last_mut(),
                ) {
                    block["webSources"] = json!(receipt);
                }
                if let (Some(context), Some(block)) = (context, blocks.last_mut())
                    && (!context.output_images.is_empty() || context.images_omitted)
                {
                    block["outputImages"] = json!(context.output_images);
                    block["outputImagesOmitted"] = json!(context.images_omitted);
                }
            }
            Some("image") => {
                tool_result_only = false;
                text_parts.push("[image]");
            }
            _ => tool_result_only = false,
        }
    }
    if role == "user" && tool_result_only && !blocks.is_empty() {
        role = "assistant".to_string();
    }
    let content = text_parts.join("\n");
    let (content, attachment_blocks) = split_history_attachment_envelope(content);
    blocks.extend(attachment_blocks);
    tool_images::bound_history_blocks(&mut blocks);
    if content.trim().is_empty() && blocks.is_empty() {
        return None;
    }
    let (content, content_truncated, content_original_chars) =
        truncate_utf8_bytes(content, MAX_TRANSCRIPT_MESSAGE_BYTES);
    let attempt_id = entry
        .history_attempt
        .as_ref()
        .filter(|identity| {
            identity.validate().is_ok()
                && identity.thread_id == entry.session_id
                && turn_id.as_deref() == Some(identity.turn_id.as_str())
        })
        .map(|identity| identity.attempt_id.clone());
    Some(ThreadMessage {
        file_changes_capture: None,
        review_evidence: None,
        id: entry
            .uuid
            .unwrap_or_else(|| format!("{}-{index}", entry.session_id)),
        client_message_id: None,
        turn_id,
        role,
        content,
        status: None,
        error: None,
        error_type: None,
        provider_failure: None,
        attempt_id,
        continued_by_attempt_id: None,
        blocks,
        timestamp_ms: entry.timestamp_ms,
        content_truncated,
        content_original_chars: content_truncated.then_some(content_original_chars),
    })
}

impl From<&str> for TranscriptToolId {
    fn from(value: &str) -> Self {
        Self(Arc::from(value))
    }
}

impl std::borrow::Borrow<str> for TranscriptToolId {
    fn borrow(&self) -> &str {
        &self.0
    }
}

#[cfg(any(test, feature = "test-oracle"))]
impl serde::Serialize for TranscriptToolId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

#[cfg(any(test, feature = "test-oracle"))]
pub fn transcript_tool_contexts(entries: &[kcoder_state::HistoryEntry]) -> TranscriptToolContexts {
    let mut contexts = TranscriptToolContexts::new();
    transcript_context_oracle::extend(&mut contexts, entries, 0);
    contexts
}

pub fn extend_transcript_tool_contexts(
    contexts: &mut TranscriptToolContexts,
    entries: &[kcoder_state::HistoryEntry],
    offset: usize,
) {
    for (entry_index, entry) in entries.iter().enumerate() {
        let entry_index = offset + entry_index;
        let blocks = match &entry.message {
            Message::User { content, .. } | Message::Assistant { content, .. } => content,
        };
        for block in blocks {
            match block {
                ContentBlock::ToolUse { id, name, input } => {
                    contexts
                        .entry(id.as_str().into())
                        .or_default()
                        .push(TranscriptToolContext {
                            web_sources: None,
                            entry_index,
                            last_reference_index: entry_index,
                            name: name.clone(),
                            input: input.clone(),
                            has_tool_use: true,
                            output_images: Vec::new(),
                            images_omitted: false,
                            output: None,
                            is_error: false,
                            started_at_ms: entry.timestamp_ms,
                            completed_at_ms: None,
                        });
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    let calls = contexts.entry(tool_use_id.as_str().into()).or_default();
                    if calls.is_empty() {
                        calls.push(TranscriptToolContext {
                            web_sources: None,
                            entry_index,
                            last_reference_index: entry_index,
                            name: "tool".to_string(),
                            input: json!({}),
                            has_tool_use: false,
                            output_images: Vec::new(),
                            images_omitted: false,
                            output: None,
                            is_error: false,
                            started_at_ms: entry.timestamp_ms,
                            completed_at_ms: Some(entry.timestamp_ms),
                        });
                    }
                    if let Some(context) = calls.last_mut() {
                        context.last_reference_index = entry_index;
                        context.completed_at_ms = Some(entry.timestamp_ms);
                        context.output = Some(
                            content
                                .iter()
                                .filter_map(|block| match block {
                                    ContentBlock::Text { text } => Some(text.as_str()),
                                    _ => None,
                                })
                                .collect::<Vec<_>>()
                                .join("\n"),
                        );
                        (context.output_images, context.images_omitted) =
                            tool_images::observations(&context.name, content);
                        context.is_error = is_error.unwrap_or(false);
                        context.web_sources = entry
                            .web_sources
                            .iter()
                            .find(|receipt| receipt.matches(&entry.session_id, tool_use_id))
                            .cloned();
                    }
                }
                _ => {}
            }
        }
    }
}

pub fn transcript_tool_context<'a>(
    contexts: &'a TranscriptToolContexts,
    id: &str,
    entry_index: usize,
) -> Option<&'a TranscriptToolContext> {
    // Providers may reuse a call id in a later turn. Bind each result to the
    // preceding occurrence instead of replacing older calls with the latest result.
    let calls = contexts.get(id)?;
    let position = calls.partition_point(|call| call.entry_index <= entry_index);
    calls.get(position.checked_sub(1)?)
}

pub fn nested_text_content(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn transcript_tool_block(
    id: &str,
    name: &str,
    input: Value,
    output: Option<String>,
    is_error: bool,
    started_at_ms: u64,
    completed_at_ms: Option<u64>,
) -> Value {
    let (input, input_truncated, input_bytes) = input_preview(input);
    let mut output_truncated = false;
    let output_bytes = output.as_ref().map_or(0, String::len);
    let output = output.map(|text| {
        let (text, truncated, _) = truncate_utf8_bytes(text, MAX_TRANSCRIPT_MESSAGE_BYTES);
        output_truncated = truncated;
        text
    });
    let render_payload = if name.eq_ignore_ascii_case("AskUserQuestion")
        || name.eq_ignore_ascii_case("ask_user_question")
    {
        let questions = input
            .get("questions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, value)| {
                let mut question = value.clone();
                if let Some(object) = question.as_object_mut() {
                    object
                        .entry("id")
                        .or_insert_with(|| json!(format!("question-{}", index + 1)));
                }
                question
            })
            .collect::<Vec<_>>();
        let response = output
            .as_deref()
            .and_then(|value| transcript_user_question_response(id, &questions, value));
        Some(json!({
            "kind": "request_user_input",
            "itemId": id,
            "questions": questions,
            "response": response,
        }))
    } else {
        None
    };
    json!({
        "id": id,
        "type": "tool",
        "tool_use_id": id,
        "tool_name": name,
        "tool_input": input,
        "tool_input_truncated": input_truncated,
        "tool_input_original_bytes": input_bytes,
        "tool_output": output,
        "tool_output_truncated": output_truncated,
        "tool_output_original_bytes": output_bytes,
        "render_payload": render_payload,
        "status": if output.is_none() { "pending" } else if is_error { "error" } else { "done" },
        "timestamp": started_at_ms,
        "completed_at": completed_at_ms,
    })
}

pub fn transcript_user_question_response(
    id: &str,
    questions: &[Value],
    output: &str,
) -> Option<Value> {
    let parsed = serde_json::from_str::<Value>(output).ok()?;
    let raw_answers = parsed.get("answers").and_then(Value::as_object)?;
    let answers = questions
        .iter()
        .filter_map(|question| {
            let question_id = question.get("id").and_then(Value::as_str)?;
            let question_text = question.get("question").and_then(Value::as_str);
            let raw_answer = raw_answers
                .get(question_id)
                .or_else(|| question_text.and_then(|text| raw_answers.get(text)))?;
            let answer = match raw_answer {
                Value::String(value) => json!({ "answers": [value] }),
                Value::Array(values) => json!({ "answers": values }),
                Value::Object(object)
                    if object.get("answers").and_then(Value::as_array).is_some() =>
                {
                    raw_answer.clone()
                }
                _ => return None,
            };
            Some((question_id.to_string(), answer))
        })
        .collect::<serde_json::Map<_, _>>();

    Some(json!({
        "itemId": id,
        "answers": answers,
    }))
}

pub fn truncate_utf8_bytes(mut value: String, max_bytes: usize) -> (String, bool, usize) {
    let original_chars = value.chars().count();
    if value.len() <= max_bytes {
        return (value, false, original_chars);
    }
    let mut boundary = max_bytes.min(value.len());
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    (value, true, original_chars)
}

#[cfg(test)]
mod history_attempt_provenance_tests {
    use super::*;
    use kcoder_state::HistoryEntry;
    use kcoder_state::turn_attempt_store::TurnAttemptRecord;
    use kcoder_types::{Message, TurnAttemptIdentity, TurnAttemptStatus};

    fn identity(attempt: &str) -> TurnAttemptIdentity {
        TurnAttemptIdentity {
            thread_id: "session".into(),
            turn_id: "turn-7".into(),
            attempt_id: attempt.into(),
        }
    }
    fn record(identity: TurnAttemptIdentity) -> TurnAttemptRecord {
        TurnAttemptRecord {
            version: 1,
            identity,
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            client_presentation: None,
            status: TurnAttemptStatus::Completed,
            completion: Some(kcoder_state::turn_attempt_store::TurnAttemptCompletion {
                status: TurnAttemptStatus::Completed,
                finished_at_ms: 2,
                error: None,
                provider_failure: None,
                partial_output: String::new(),
                partial_output_truncated: false,
                committed_history_uuid: None,
            }),
        }
    }
    fn entry(id: &str, message: Message, identity: Option<TurnAttemptIdentity>) -> HistoryEntry {
        HistoryEntry {
            web_sources: Vec::new(),
            session_id: "session".into(),
            timestamp_ms: 1,
            uuid: Some(id.into()),
            parent_uuid: None,
            message,
            history_attempt: identity,
        }
    }
    fn artifacts(ids: &[TurnAttemptIdentity]) -> transcript_window::Artifacts {
        transcript_window::Artifacts {
            thread_id: "session".into(),
            attempts: ids.iter().cloned().map(record).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn web_sources_use_native_history_field_and_call_occurrence() {
        let receipt: kcoder_types::web_sources::WebSourcesV1 = serde_json::from_value(serde_json::json!({
            "schemaVersion":1,"identity":{"threadId":"session","turnId":"turn-7","attemptId":"attempt-A"},
            "toolCallId":"reused-call","operation":"search","status":"partial","provider":"exa-public","sources":[{
                "sourceId":"native-source","title":"Page","url":"https://example.com","retrievedAt":"2026-10-31","readStatus":"summary_only"
            }]
        })).unwrap();
        let call = |id: &str| {
            entry(
                id,
                Message::Assistant {
                    usage: None,
                    content: vec![kcoder_types::ContentBlock::ToolUse {
                        id: "reused-call".into(),
                        name: "WebSearch".into(),
                        input: json!({"query":"docs"}),
                    }],
                },
                Some(identity("attempt-A")),
            )
        };
        let result = |id: &str| {
            entry(
                id,
                Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
                    tool_use_id: "reused-call".into(),
                    content: vec![kcoder_types::ContentBlock::Text {
                        text: "{\"webSources\":{\"readStatus\":\"verified\"}}".into(),
                    }],
                    is_error: Some(false),
                }]),
                Some(identity("attempt-A")),
            )
        };
        let mut trusted = result("first-result");
        trusted.web_sources.push(receipt.clone());
        let rows = vec![
            call("first-call"),
            trusted,
            call("second-call"),
            result("second-result"),
        ];
        let contexts = transcript_tool_contexts(&rows);
        assert_eq!(
            transcript_tool_context(&contexts, "reused-call", 0)
                .unwrap()
                .web_sources
                .as_ref(),
            Some(&receipt)
        );
        assert!(
            transcript_tool_context(&contexts, "reused-call", 2)
                .unwrap()
                .web_sources
                .is_none()
        );
        let projected =
            history_entry_thread_message(0, rows[0].clone(), Some("turn-7".into()), &contexts)
                .unwrap();
        assert_eq!(
            projected.blocks[0]["webSources"]["sources"][0]["readStatus"],
            "summary_only"
        );
    }

    #[test]
    fn history_attempt_provenance_projects_each_row_from_exact_persisted_tuple() {
        let a = identity("attempt-A");
        let b = identity("attempt-B");
        let rows = vec![
            entry("user", Message::user_text("request"), Some(a.clone())),
            entry(
                "assistant-A",
                Message::assistant_text("partial"),
                Some(a.clone()),
            ),
            entry(
                "assistant-B",
                Message::assistant_text("retry"),
                Some(b.clone()),
            ),
        ];
        let mut proof = artifacts(&[a, b]);
        proof.turn_ids.insert("user".into(), "turn-7".into());
        let page = transcript_window::project(rows, proof, Some(100), None);
        assert_eq!(page.messages.len(), 3);
        assert!(
            page.messages
                .iter()
                .all(|row| row.turn_id.as_deref() == Some("turn-7"))
        );
        assert_eq!(page.messages[0].attempt_id.as_deref(), Some("attempt-A"));
        assert_eq!(page.messages[1].attempt_id.as_deref(), Some("attempt-A"));
        assert_eq!(page.messages[2].attempt_id.as_deref(), Some("attempt-B"));
        assert_eq!(page.messages[1].id, "assistant-A");
    }

    #[test]
    fn history_attempt_provenance_missing_foreign_or_conflicting_proof_is_unknown() {
        let a = identity("attempt-A");
        for case in ["missing", "foreign", "admission-conflict", "invalid"] {
            let mut tuple = a.clone();
            let mut proof = artifacts(std::slice::from_ref(&a));
            if case == "missing" {
                proof.attempts.clear();
            }
            if case == "foreign" {
                tuple.thread_id = "other".into();
            }
            if case == "invalid" {
                tuple.attempt_id = " ".into();
            }
            if case == "admission-conflict" {
                proof.turn_ids.insert("user".into(), "turn-9".into());
            }
            let page = transcript_window::project(
                vec![entry("user", Message::user_text("body"), Some(tuple))],
                proof,
                Some(100),
                None,
            );
            assert_eq!(page.messages[0].content, "body");
            assert_eq!(page.messages[0].id, "user");
            assert!(page.messages[0].attempt_id.is_none(), "{case}");
        }
    }

    #[test]
    fn history_attempt_provenance_same_attempt_tool_fragments_keep_first_uuid() {
        let a = identity("attempt-A");
        let b = identity("attempt-B");
        let tool = || {
            serde_json::from_value(serde_json::json!({"role":"assistant", "content":[
            {"type":"tool_use", "id":"tool", "name":"bash", "input":{"command":"pwd"}}]}))
            .unwrap()
        };
        let rows = vec![
            entry("first", tool(), Some(a.clone())),
            entry("text", Message::assistant_text("answer"), Some(a.clone())),
            entry("retry", tool(), Some(b.clone())),
        ];
        let page = transcript_window::project(rows, artifacts(&[a, b]), Some(100), None);
        assert_eq!(page.messages.len(), 2);
        assert_eq!(page.messages[0].id, "first");
        assert_eq!(page.messages[0].content, "answer");
        assert!(!page.messages[0].blocks.is_empty());
        assert_eq!(page.messages[0].attempt_id.as_deref(), Some("attempt-A"));
        assert_eq!(page.messages[1].id, "retry");
        assert_eq!(page.messages[1].attempt_id.as_deref(), Some("attempt-B"));
    }
}

pub fn apply_turn_client_message_ids(
    messages: &mut [ThreadMessage],
    client_message_ids: HashMap<String, String>,
) {
    for message in messages {
        if message.role != "user" {
            continue;
        }
        let Some(turn_id) = message.turn_id.as_deref() else {
            continue;
        };
        if let Some(client_message_id) = client_message_ids.get(turn_id) {
            message.client_message_id = Some(client_message_id.clone());
        }
    }
}

pub fn apply_turn_outcomes(
    messages: &mut Vec<ThreadMessage>,
    outcomes: HashMap<String, TurnOutcomeArtifact>,
) {
    for (turn_id, outcome) in outcomes {
        if let Some(message) = messages.iter_mut().rfind(|message| {
            message.turn_id.as_deref() == Some(turn_id.as_str()) && message.role == "assistant"
        }) {
            apply_turn_outcome_to_message(message, &outcome);
            continue;
        }
        let Some(index) = messages
            .iter()
            .rposition(|message| message.turn_id.as_deref() == Some(turn_id.as_str()))
        else {
            continue;
        };
        messages.insert(
            index + 1,
            ThreadMessage {
                file_changes_capture: None,
                review_evidence: None,
                id: format!("turn-outcome-{}", hex_sha256(turn_id.as_bytes())),
                client_message_id: None,
                turn_id: Some(turn_id),
                role: "assistant".into(),
                content: String::new(),
                status: None,
                error: None,
                error_type: None,
                provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
                blocks: Vec::new(),
                timestamp_ms: outcome.completed_at_ms,
                content_truncated: false,
                content_original_chars: None,
            },
        );
        apply_turn_outcome_to_message(&mut messages[index + 1], &outcome);
    }
}

pub fn apply_turn_outcome_to_message(message: &mut ThreadMessage, outcome: &TurnOutcomeArtifact) {
    if outcome.status == "interrupted" {
        message.status = Some("cancelled".into());
        return;
    }
    message.status = Some("failed".into());
    message.error = outcome
        .error
        .clone()
        .or_else(|| Some("Task execution failed".into()));
    message.error_type = Some(
        outcome
            .provider_failure
            .as_ref()
            .map_or("response.failed", |details| details.category.as_str())
            .into(),
    );
    message.provider_failure = outcome.provider_failure.clone();
}

pub fn attach_turn_file_captures(
    messages: &mut [ThreadMessage],
    captures: &mut HashMap<String, TurnFileChangesCapture>,
) {
    for message in messages
        .iter_mut()
        .rev()
        .filter(|message| message.role == "assistant")
    {
        let Some(key) = message.attempt_id.as_deref().or(message.turn_id.as_deref()) else {
            continue;
        };
        if captures
            .get(key)
            .is_some_and(|capture| message.turn_id.as_deref() == Some(capture.turn_id.as_str()))
        {
            message.file_changes_capture = captures.remove(key);
        }
    }
}

pub fn attach_turn_review_evidence(
    messages: &mut [ThreadMessage],
    records: &mut HashMap<String, TurnReviewEvidence>,
) {
    for message in messages.iter_mut().rev().filter(|m| m.role == "assistant") {
        let Some(key) = message.attempt_id.as_deref().or(message.turn_id.as_deref()) else {
            continue;
        };
        if records
            .get(key)
            .is_some_and(|r| Some(r.turn_id.as_str()) == message.turn_id.as_deref())
        {
            message.review_evidence = records.remove(key);
        }
    }
}
