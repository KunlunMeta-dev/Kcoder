//! Turn artifacts: extracted from the app-server connection boundary.

use super::*;

pub(super) fn save_turn_outcome(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    status: &str,
    error: Option<&str>,
    provider_failure: Option<&kcoder_types::ProviderFailureDetails>,
) -> Result<()> {
    save_turn_outcome_with_continuation(
        engine,
        thread_id,
        turn_id,
        status,
        error,
        provider_failure,
        false,
    )
}

pub(super) fn save_turn_outcome_with_continuation(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    status: &str,
    error: Option<&str>,
    provider_failure: Option<&kcoder_types::ProviderFailureDetails>,
    allow_continuation: bool,
) -> Result<()> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-outcomes");
    let artifact = TurnOutcomeArtifact {
        version: 1,
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        status: status.to_string(),
        error: error.map(str::to_string),
        provider_failure: provider_failure.cloned(),
        continuation_context_hash: if allow_continuation
            && !engine.state.session_mode().is_orchestrate()
            && status == "failed"
            && provider_failure.is_some()
        {
            failed_turn::context_hash(&engine.state.messages()).ok()
        } else {
            None
        },
        completed_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    };
    let filename = format!("{}.json", hex_sha256(turn_id.as_bytes()));
    transcript_artifact_journal::write(
        &artifact_dir,
        thread_id,
        transcript_artifact_journal::Kind::TurnOutcomes,
        || {
            write_private_artifact_file(
                &artifact_dir.join(filename),
                &serde_json::to_vec_pretty(&artifact)?,
            )
        },
    )
}

pub(super) fn clear_turn_outcome(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
) -> Result<()> {
    let path = engine
        .session_storage_dir_for(thread_id)
        .join("turn-outcomes")
        .join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    transcript_artifact_journal::remove(
        &path,
        thread_id,
        transcript_artifact_journal::Kind::TurnOutcomes,
    )
    .context("failed to clear prior turn outcome")
}

pub(super) fn save_turn_client_message_id(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    client_message_id: Option<&str>,
) -> Result<()> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-client-messages");
    let path = artifact_dir.join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    let Some(client_message_id) = client_message_id.map(str::trim).filter(|id| !id.is_empty())
    else {
        return transcript_artifact_journal::remove(
            &path,
            thread_id,
            transcript_artifact_journal::Kind::TurnClientMessages,
        )
        .context("failed to clear prior client message identity");
    };
    let artifact = TurnClientMessageArtifact {
        version: 1,
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        client_message_id: client_message_id.to_string(),
    };
    transcript_artifact_journal::write(
        &artifact_dir,
        thread_id,
        transcript_artifact_journal::Kind::TurnClientMessages,
        || write_private_artifact_file(&path, &serde_json::to_vec_pretty(&artifact)?),
    )
}

/// Records that this turn already accepted a continuation against `context_hash`.
pub(super) fn save_turn_continuation_receipt(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    context_hash: &str,
    retry_operation_id: Option<&str>,
) -> Result<()> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-continuations");
    let path = artifact_dir.join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    let artifact = TurnContinuationArtifact {
        version: 1,
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        context_hash: context_hash.to_string(),
        retry_operation_id: retry_operation_id.map(str::to_string),
        accepted_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default(),
    };
    transcript_artifact_journal::write(
        &artifact_dir,
        thread_id,
        transcript_artifact_journal::Kind::TurnContinuations,
        || write_private_artifact_file(&path, &serde_json::to_vec_pretty(&artifact)?),
    )
}

pub(super) fn load_turn_continuation_receipt(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
) -> Option<TurnContinuationArtifact> {
    let path = engine
        .session_storage_dir_for(thread_id)
        .join("turn-continuations")
        .join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > 64 * 1024 {
        return None;
    }
    let artifact =
        serde_json::from_slice::<TurnContinuationArtifact>(&std::fs::read(path).ok()?).ok()?;
    (artifact.version == 1 && artifact.thread_id == thread_id && artifact.turn_id == turn_id)
        .then_some(artifact)
}

/// The receipt for a retry operation identity, whichever turn it committed.
///
/// A retry operation names one recovery, so finding it under a different failed
/// turn means the identity is being reused rather than repeated.
pub(super) fn turn_continuation_for_operation(
    engine: &QueryEngine,
    thread_id: &str,
    retry_operation_id: &str,
) -> Option<TurnContinuationArtifact> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-continuations");
    let entries = std::fs::read_dir(artifact_dir).ok()?;
    entries
        .take(10_000)
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 64 * 1024 {
                return None;
            }
            serde_json::from_slice::<TurnContinuationArtifact>(&std::fs::read(path).ok()?).ok()
        })
        .find(|artifact| {
            artifact.version == 1
                && artifact.thread_id == thread_id
                && artifact.retry_operation_id.as_deref() == Some(retry_operation_id)
        })
}

/// Answers a repeated continuation with the attempt that was already accepted.
///
/// The receipt only applies while the committed context still matches the
/// boundary it was accepted against and the failed turn is still the latest one;
/// otherwise the caller falls through to the normal validation, which refuses.
/// Digest of the committed *user inputs* only.
///
/// The accepted attempt appends assistant output and tool results of its own, so
/// the full-context digest of `failed_turn` cannot be used to recognise a replay.
/// Inputs are what a rollback, a compaction or a newer turn changes, and they are
/// never rewritten by the attempt itself.
pub(super) fn input_context_hash(messages: &[kcoder_types::Message]) -> Result<String> {
    use kcoder_types::{ContentBlock, Message};
    let inputs = messages
        .iter()
        .filter(|message| match message {
            Message::User { content, .. } => content.iter().any(|block| {
                matches!(
                    block,
                    ContentBlock::Text { .. } | ContentBlock::Image { .. }
                )
            }),
            Message::Assistant { .. } => false,
        })
        .collect::<Vec<_>>();
    ensure!(!inputs.is_empty(), "No committed input to continue");
    Ok(hex_sha256(&serde_json::to_vec(&inputs)?))
}

pub(super) fn replay_accepted_continuation(
    engine: &QueryEngine,
    thread_id: &str,
    failed_turn_id: &str,
    latest_turn: usize,
) -> Result<Option<Value>> {
    let Some(receipt) = load_turn_continuation_receipt(engine, thread_id, failed_turn_id) else {
        return Ok(None);
    };
    if failed_turn_id != format!("turn-{latest_turn}") {
        return Ok(None);
    }
    if input_context_hash(&engine.state.messages())? != receipt.context_hash {
        return Ok(None);
    }
    // The caller owns a fresh registration guard, so its running flag describes
    // this lookup, not the already accepted attempt. Read durable terminal evidence.
    let status = turn_receipts::terminal_status(engine, thread_id, failed_turn_id)
        .context("accepted continuation has no verifiable terminal status; inspect the existing attempt before retrying")?;
    Ok(Some(json!({
        "turn": { "id": failed_turn_id, "status": status, "threadId": thread_id }
    })))
}

/// The turn that already committed this client message identity, if any (S2/R034, S5/R045).
///
/// A commit is durable: the receipt is the per-turn artifact written when the
/// turn starts, so a retry after an unknown outcome finds it even across a
/// restart.
pub(super) fn committed_turn_for_client_message(
    committed: &HashMap<String, String>,
    client_message_id: &str,
) -> Option<String> {
    committed
        .iter()
        .find(|(_, value)| value.as_str() == client_message_id)
        .map(|(turn_id, _)| turn_id.clone())
}

pub(super) fn load_turn_client_message_ids(
    engine: &QueryEngine,
    thread_id: &str,
) -> HashMap<String, String> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-client-messages");
    let Ok(entries) = std::fs::read_dir(artifact_dir) else {
        return HashMap::new();
    };
    entries
        .take(10_000)
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 64 * 1024 {
                return None;
            }
            let artifact =
                serde_json::from_slice::<TurnClientMessageArtifact>(&std::fs::read(path).ok()?)
                    .ok()?;
            (artifact.version == 1
                && artifact.thread_id == thread_id
                && !artifact.client_message_id.trim().is_empty())
            .then_some((artifact.turn_id, artifact.client_message_id))
        })
        .collect()
}

pub(super) fn apply_turn_client_message_ids(
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

pub(super) fn clone_turn_client_message_ids(
    engine: &QueryEngine,
    source_thread_id: &str,
    target_thread_id: &str,
) -> Result<()> {
    for (turn_id, client_message_id) in load_turn_client_message_ids(engine, source_thread_id) {
        save_turn_client_message_id(engine, target_thread_id, &turn_id, Some(&client_message_id))?;
    }
    Ok(())
}

pub(super) fn load_turn_outcomes(
    engine: &QueryEngine,
    thread_id: &str,
) -> HashMap<String, TurnOutcomeArtifact> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-outcomes");
    let Ok(entries) = std::fs::read_dir(artifact_dir) else {
        return HashMap::new();
    };
    entries
        .take(10_000)
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 64 * 1024 {
                return None;
            }
            let artifact =
                serde_json::from_slice::<TurnOutcomeArtifact>(&std::fs::read(path).ok()?).ok()?;
            (artifact.version == 1
                && artifact.thread_id == thread_id
                && matches!(artifact.status.as_str(), "interrupted" | "failed"))
            .then_some((artifact.turn_id.clone(), artifact))
        })
        .collect()
}

pub(super) fn apply_turn_outcomes(
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

pub(super) fn apply_turn_outcome_to_message(
    message: &mut ThreadMessage,
    outcome: &TurnOutcomeArtifact,
) {
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
