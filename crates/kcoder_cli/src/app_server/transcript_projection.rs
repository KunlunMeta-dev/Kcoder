//! Transcript projection: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn thread_transcript(
    engine: &QueryEngine,
    params: ThreadReadParams,
    running_thread_ids: &HashSet<String>,
    run_projection: ThreadRunProjection,
) -> Result<ThreadReadResult> {
    let history_path = thread_history_path(engine, &params.thread_id)?;
    let resident = params.thread_id == engine.session_id();
    if resident {
        engine
            .state
            .flush_history()
            .await
            .context("failed to flush resident thread before reading transcript")?;
    }
    // A newly-created resident thread has a lease and session sidecar before its first JSONL
    // entry. Treat that valid pre-turn state as an empty transcript; a reload must not convert
    // this short window into ENOENT and then tear down the recovered task connection.
    let entries = if resident {
        let mut attempts = 0_u8;
        loop {
            match kcoder_state::load_transcript_history(&history_path) {
                Ok(entries) => break entries,
                Err(error) if error_is_not_found(&error) && attempts < 2 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) if error_is_not_found(&error) => break Vec::new(),
                Err(error) => return Err(error),
            }
        }
    } else {
        kcoder_state::load_transcript_history(&history_path)?
    };
    let thread_value = if resident {
        thread_snapshot(engine, running_thread_ids.contains(&params.thread_id))
    } else {
        persisted_thread_value(
            engine,
            &params.thread_id,
            &history_path,
            running_thread_ids.contains(&params.thread_id),
        )?
    };
    let mut thread: Thread = serde_json::from_value(thread_value)?;
    run_projection.apply_thread(&mut thread);
    recent_error::decorate(engine, &mut thread, run_projection.negotiated);
    let transcript_window::Page {
        mut start,
        end,
        mut messages,
    } = transcript_window::project(
        entries,
        transcript_window::Artifacts {
            attempts: turn_attempts::records(engine, &params.thread_id)?,
            turn_ids: turn_admissions::bindings(engine, &params.thread_id)?,
            client_ids: load_turn_client_message_ids(engine, &params.thread_id),
            outcomes: load_turn_outcomes(engine, &params.thread_id),
            approvals: load_approval_decisions(engine, &params.thread_id),
            file_changes: load_turn_file_change_summaries(engine, &params.thread_id),
        },
        params.limit,
        params.before_cursor.as_deref(),
    );
    while messages.len() > 1 && serde_json::to_vec(&messages)?.len() > MAX_TRANSCRIPT_RESPONSE_BYTES
    {
        messages.remove(0);
        start += 1;
    }
    super::transcript_tool_recovery::settle_inactive_tools(
        &thread,
        &mut messages,
        run_projection.facts,
    );
    Ok(ThreadReadResult {
        thread,
        messages,
        range_start: start,
        range_end: end,
        has_more_before: start > 0,
        before_cursor: (start > 0).then(|| start.to_string()),
    })
}

pub(super) fn load_approval_decisions(
    engine: &QueryEngine,
    thread_id: &str,
) -> Vec<ApprovalDecisionArtifact> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("approval-decisions");
    let Ok(entries) = std::fs::read_dir(artifact_dir) else {
        return Vec::new();
    };
    let mut artifacts = entries
        .take(10_000)
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 1024 * 1024 {
                return None;
            }
            let artifact =
                serde_json::from_slice::<ApprovalDecisionArtifact>(&std::fs::read(path).ok()?)
                    .ok()?;
            (artifact.version == 1
                && artifact.thread_id == thread_id
                && valid_artifact_id(&artifact.artifact_id))
            .then_some(artifact)
        })
        .collect::<Vec<_>>();
    artifacts.sort_by_key(|artifact| artifact.requested_at_ms);
    artifacts
}

pub(super) fn approval_action_description(action: &ApprovalAction) -> String {
    match action {
        ApprovalAction::Command { command } => format!("Command: {command}"),
        ApprovalAction::FileChange { path } => format!("File change: {path}"),
        ApprovalAction::Tool { name, input } => {
            let input = serde_json::to_string_pretty(input).unwrap_or_else(|_| "{}".into());
            format!("Tool: {name}\n{input}")
        }
    }
}

pub(super) fn approval_decision_label(decision: &ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::Accept => "Allow once",
        ApprovalDecision::AcceptForSession => "Always allow for this session",
        ApprovalDecision::Decline => "Decline",
        ApprovalDecision::Cancel => "Cancelled",
    }
}

pub(super) fn attach_approval_decision_blocks(
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

pub(super) fn coalesce_assistant_tool_fragments(messages: &mut Vec<ThreadMessage>) {
    let mut coalesced = Vec::<ThreadMessage>::with_capacity(messages.len());
    for mut message in messages.drain(..) {
        let merge_with_previous = coalesced.last().is_some_and(|previous| {
            previous.role == "assistant"
                && message.role == "assistant"
                && previous.attempt_id.is_none()
                && message.attempt_id.is_none()
                && previous.turn_id.is_some()
                && previous.turn_id == message.turn_id
                && (!previous.blocks.is_empty() || !message.blocks.is_empty())
                && (previous.content.trim().is_empty() || message.content.trim().is_empty())
        });
        if !merge_with_previous {
            coalesced.push(message);
            continue;
        }

        let previous = coalesced.last_mut().expect("previous message exists");
        if !previous.content.trim().is_empty() && !message.blocks.is_empty() {
            // Commentary belongs before the next event, not below the accumulated tools.
            previous.blocks.push(json!({
                "id": format!("{}-text", previous.id),
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

pub(super) fn error_is_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

pub(super) fn load_turn_file_change_summaries(
    engine: &QueryEngine,
    thread_id: &str,
) -> HashMap<String, Value> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-file-changes");
    let Ok(entries) = std::fs::read_dir(&artifact_dir) else {
        return HashMap::new();
    };
    entries
        .take(10_000)
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 1024 * 1024 {
                return None;
            }
            let mut artifact =
                serde_json::from_slice::<TurnFileChangesArtifact>(&std::fs::read(&path).ok()?)
                    .ok()?;
            if artifact.thread_id != thread_id || !valid_artifact_id(&artifact.artifact_id) {
                return None;
            }
            let patch_path = artifact_dir.join(format!("{}.patch", artifact.artifact_id));
            if !std::fs::symlink_metadata(patch_path)
                .ok()
                .is_some_and(|metadata| {
                    metadata.file_type().is_file()
                        && metadata.len() > 0
                        && metadata.len() <= MAX_TURN_FILE_CHANGES_BYTES as u64
                })
            {
                artifact.status = "artifact_missing".into();
            }
            Some((
                artifact.turn_id.clone(),
                turn_file_changes_summary(&artifact),
            ))
        })
        .collect()
}

pub(super) fn attach_turn_file_change_blocks(
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

pub(super) fn client_transcript_turn_count(entries: &[kcoder_state::HistoryEntry]) -> usize {
    entries
        .iter()
        .filter(|entry| kcoder_engine::agent::is_real_user_message(&entry.message))
        .count()
}

pub(super) fn thread_history_path(engine: &QueryEngine, thread_id: &str) -> Result<PathBuf> {
    validate_thread_id(thread_id)?;
    if thread_id == engine.session_id() {
        return engine
            .state
            .history_path()
            .context("session history is disabled");
    }
    let history_path = engine
        .state
        .history_path()
        .context("session history is disabled")?;
    let history_dir = history_path
        .parent()
        .context("session history path has no parent")?;
    let path = candidate_thread_history_path(history_dir, thread_id)?;
    let metadata = std::fs::symlink_metadata(&path)
        .with_context(|| format!("persisted thread not found: {thread_id}"))?;
    if !metadata.file_type().is_file() {
        anyhow::bail!("persisted thread is not a regular file: {thread_id}")
    }
    let expected = std::fs::canonicalize(engine.state.cwd())?;
    let persisted = kcoder_state::history_persisted_base_cwd(&path)?
        .context("persisted thread has no base cwd")?;
    if std::fs::canonicalize(&persisted)? != expected {
        anyhow::bail!("persisted thread belongs to another workspace")
    }
    Ok(path)
}

pub(super) fn candidate_thread_history_path(
    history_dir: &Path,
    thread_id: &str,
) -> Result<PathBuf> {
    validate_thread_id(thread_id)?;
    Ok(history_dir.join(format!("{thread_id}.jsonl")))
}

pub(super) fn validate_thread_id(thread_id: &str) -> Result<()> {
    if !is_valid_external_artifact_id(thread_id) {
        anyhow::bail!("invalid thread id")
    }
    Ok(())
}

pub(super) fn validate_worktree_id(worktree_id: &str) -> Result<()> {
    if !is_valid_external_artifact_id(worktree_id) {
        anyhow::bail!("invalid worktree id")
    }
    Ok(())
}

pub(super) fn is_valid_external_artifact_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        && !is_windows_reserved_basename(id)
}

pub(super) fn is_windows_reserved_basename(value: &str) -> bool {
    let trimmed = value.trim_end_matches(['.', ' ']);
    let basename = trimmed.split('.').next().unwrap_or(trimmed);
    matches!(
        basename.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub(super) fn history_entry_thread_message(
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
    for (block_index, block) in content_blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if role == "user"
                        && matches!(
                            entry.message.origin(),
                            kcoder_types::MessageOrigin::Runtime
                                | kcoder_types::MessageOrigin::Compaction
                        )
                    {
                        continue;
                    }
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
    Some(ThreadMessage {
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
        attempt_id: None,
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

#[cfg(test)]
impl serde::Serialize for TranscriptToolId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

#[cfg(test)]
pub(super) fn transcript_tool_contexts(
    entries: &[kcoder_state::HistoryEntry],
) -> TranscriptToolContexts {
    let mut contexts = TranscriptToolContexts::new();
    transcript_context_oracle::extend(&mut contexts, entries, 0);
    contexts
}

pub(super) fn extend_transcript_tool_contexts(
    contexts: &mut TranscriptToolContexts,
    entries: &[kcoder_state::HistoryEntry],
    offset: usize,
) {
    use kcoder_types::{ContentBlock, Message};
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
                            tool_images::observations(content);
                        context.is_error = is_error.unwrap_or(false);
                    }
                }
                _ => {}
            }
        }
    }
}

pub(super) fn transcript_tool_context<'a>(
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

pub(super) fn nested_text_content(value: Option<&Value>) -> String {
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

pub(super) fn transcript_tool_block(
    id: &str,
    name: &str,
    input: Value,
    output: Option<String>,
    is_error: bool,
    started_at_ms: u64,
    completed_at_ms: Option<u64>,
) -> Value {
    let (input, input_truncated, input_bytes) = notification_projection::input_preview(input);
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

pub(super) fn transcript_user_question_response(
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

pub(super) fn truncate_utf8_bytes(mut value: String, max_bytes: usize) -> (String, bool, usize) {
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

pub(super) fn persisted_thread_value(
    engine: &QueryEngine,
    session_id: &str,
    path: &Path,
    running: bool,
) -> Result<Value> {
    let metadata = kcoder_state::prepare_session_metadata(path)?;
    persisted_thread_value_with_metadata(engine, session_id, &metadata, running, false)
}

pub(super) fn persisted_thread_value_with_metadata(
    engine: &QueryEngine,
    session_id: &str,
    metadata: &kcoder_state::PreparedSessionMetadata,
    running: bool,
    strict_metadata: bool,
) -> Result<Value> {
    let (created_at, updated_at) = metadata.timestamps_ms()?;
    let cwd = metadata
        .base_cwd()
        .map(|base| dunce::simplified(base).to_string_lossy().into_owned());
    let mut snapshot = json!({
        "id": session_id,
        "cwd": cwd,
        "sessionMode": metadata.session_mode(),
        "workflowDefinitionId": metadata.workflow_definition_id(),
        "title": metadata.first_prompt(80),
        "status": if running { "running" } else { "idle" },
        "createdAt": created_at.to_string(),
        "updatedAt": updated_at.to_string(),
    });
    decorate_thread_snapshot(engine, &mut snapshot, strict_metadata)?;
    Ok(snapshot)
}

pub(super) fn prepare_persisted_thread_resume(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<(kcoder_state::PreparedSessionResume, SessionLease, usize)> {
    // Resolve the lease from the validated session id before parsing history. A completed turn's
    // transcript is flushed asynchronously, but its lease already exists; this ordering makes an
    // immediate contender deterministically report "active" instead of racing with persistence.
    let current_history = engine
        .state
        .history_path()
        .context("session history is disabled")?;
    let history_dir = current_history
        .parent()
        .context("session history path has no parent")?;
    let path = candidate_thread_history_path(history_dir, thread_id)?;
    let lease = SessionLease::acquire_existing_history(&path)?;
    let path = thread_history_path(engine, thread_id)?;
    let (prepared, client_turn_count) =
        kcoder_state::prepare_session_resume_real_user_counting(&path)?;
    let expected = std::fs::canonicalize(engine.state.cwd())?;
    let persisted = prepared
        .persisted_base_cwd()
        .context("persisted thread has no base cwd")?;
    if std::fs::canonicalize(persisted)? != expected {
        anyhow::bail!("persisted thread belongs to another workspace")
    }
    Ok((prepared, lease, client_turn_count))
}
