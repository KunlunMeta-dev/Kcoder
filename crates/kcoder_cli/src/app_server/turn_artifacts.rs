//! Turn artifacts: extracted from the app-server connection boundary.

use crate::{
    failed_turn,
    receipts::{read_records, terminal_status},
};
use anyhow::{Context, Result, ensure};
use kcoder_attachment_retention::acceptance::TurnClientMessageArtifact;
use kcoder_cli_storage::{
    private_files::{hex_sha256, write_private_artifact_file},
    transcript_artifact_journal,
};
use kcoder_engine::QueryEngine;
use kcoder_transcript::TurnOutcomeArtifact;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

/// The attempt that already accepted a continuation of a failed turn (R054, R056).
///
/// A lost response or a repeated click must learn the accepted attempt instead of
/// starting a second one. The receipt is durable and carries the context digest it
/// was accepted against, so a changed recovery boundary refuses it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TurnContinuationArtifact {
    version: u8,
    thread_id: String,
    pub(crate) turn_id: String,
    context_hash: String,
    accepted_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retry_operation_id: Option<String>,
}

pub fn save_turn_outcome(
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

pub struct ForegroundTerminal {
    pub status: &'static str,
    pub error: String,
    pub provider_failure: Option<kcoder_types::ProviderFailureDetails>,
    pub persisted: bool,
}

pub fn persist_foreground_terminal(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    event: &kcoder_engine::EngineEvent,
    cancelled: bool,
    allow_continuation: bool,
) -> Option<ForegroundTerminal> {
    let (status, error) =
        kcoder_app_events::notification_projection::terminal_outcome(event, cancelled)?;
    let provider_failure = match event {
        kcoder_engine::EngineEvent::ProviderFailed { details, .. } => Some(details.clone()),
        _ => None,
    };
    // Persist before projection so an immediate thread read can recover the failure.
    let persisted = match save_turn_outcome_with_continuation(
        engine,
        thread_id,
        turn_id,
        status,
        Some(&error),
        provider_failure.as_ref(),
        allow_continuation,
    ) {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(%error, %turn_id, "failed to persist terminal turn outcome before projection");
            false
        }
    };
    Some(ForegroundTerminal {
        status,
        error,
        provider_failure,
        persisted,
    })
}

pub fn save_turn_outcome_with_continuation(
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

pub fn clear_turn_outcome(engine: &QueryEngine, thread_id: &str, turn_id: &str) -> Result<()> {
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

pub fn save_turn_client_message_id(
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
pub fn save_turn_continuation_receipt(
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

fn load_turn_continuation_receipt(
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
pub(crate) fn turn_continuation_for_operation(
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

/// Legacy receipt scan used by the read-only turn receipt endpoint.
pub fn continuation_turns_for_operation(
    engine: &QueryEngine,
    thread_id: &str,
    operation_id: &str,
) -> Result<Vec<String>> {
    let directory = engine
        .session_storage_dir_for(thread_id)
        .join("turn-continuations");
    let mut turns = Vec::new();
    for record in read_records::<TurnContinuationArtifact>(&directory)? {
        ensure!(
            record.version == 1 && record.thread_id == thread_id,
            "invalid continuation receipt identity"
        );
        if record.retry_operation_id.as_deref() == Some(operation_id) {
            turns.push(record.turn_id);
        }
    }
    Ok(turns)
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
pub fn input_context_hash(messages: &[kcoder_types::Message]) -> Result<String> {
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

pub(crate) fn replay_accepted_continuation(
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
    let status = terminal_status(engine, thread_id, failed_turn_id)
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
pub fn committed_turn_for_client_message(
    committed: &HashMap<String, String>,
    client_message_id: &str,
) -> Option<String> {
    committed
        .iter()
        .find(|(_, value)| value.as_str() == client_message_id)
        .map(|(turn_id, _)| turn_id.clone())
}

pub fn load_turn_client_message_ids(
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

pub fn clone_turn_client_message_ids(
    engine: &QueryEngine,
    source_thread_id: &str,
    target_thread_id: &str,
) -> Result<()> {
    for (turn_id, client_message_id) in load_turn_client_message_ids(engine, source_thread_id) {
        save_turn_client_message_id(engine, target_thread_id, &turn_id, Some(&client_message_id))?;
    }
    Ok(())
}

pub fn load_turn_outcomes(
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
