//! Request-local read observations for ordinary, untracked transcript sources.
//! They describe one coherent capture, never a committed projection or event watermark.
use crate::indexed::{
    ReadOutcome, ReadSource, STORAGE_PROJECTION_VERSION, VISIBLE_PROJECTION_VERSION,
};
use anyhow::{Context, Result};
use kcoder_app_protocol::ThreadTranscriptObservationV1;
use kcoder_app_protocol::{ThreadReadParams, ThreadReadResult};
use kcoder_cli_storage::tracked_history_list::candidate_thread_history_path;
use kcoder_state::history_index::TranscriptObservationFence;
use kcoder_state::history_index::journal::{JournalDomain, current_watermark};
use kcoder_thread_metadata::decorate_thread_snapshot_with_metadata;
use kcoder_transcript::transcript_window;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::collections::VecDeque;

const OBSERVATION_VERSION: &str = "kcoder.transcript-observation.v1";
const OBSERVATION_CURSOR_PREFIX: &str = "tp1:ob1-";

#[derive(Debug)]
pub struct TranscriptCursorStale;

impl std::fmt::Display for TranscriptCursorStale {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TRANSCRIPT_CURSOR_STALE")
    }
}

impl std::error::Error for TranscriptCursorStale {}

pub fn is_observed_cursor(cursor: &str) -> bool {
    cursor.starts_with(OBSERVATION_CURSOR_PREFIX)
}

#[derive(Debug)]
pub struct Cursor<'a> {
    observation_id: &'a str,
    before: usize,
}

pub fn parse_cursor(value: &str) -> Result<Cursor<'_>> {
    let invalid = || TranscriptCursorStale;
    let value = value
        .strip_prefix(OBSERVATION_CURSOR_PREFIX)
        .ok_or_else(invalid)?;
    let (observation_id, before) = value.split_once(':').ok_or_else(invalid)?;
    anyhow::ensure!(
        observation_id.len() == 64
            && observation_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && !before.is_empty()
            && before.len() <= 20
            && before.bytes().all(|byte| byte.is_ascii_digit()),
        TranscriptCursorStale
    );
    let before = before.parse::<usize>().map_err(|_| invalid())?;
    anyhow::ensure!(before > 0, TranscriptCursorStale);
    Ok(Cursor {
        observation_id,
        before,
    })
}

/// Failure to prove the entire input is an omitted extension, never a repaired source.
/// The caller must turn any failure while consuming an observed cursor into typed stale.
pub async fn read(
    selected_source: &ReadSource<'_>,
    params: &ThreadReadParams,
    running: &HashSet<String>,
    snapshot_enabled: bool,
    cursor: Option<Cursor<'_>>,
) -> Result<Option<ReadOutcome>> {
    let history_root = &selected_source.history_root;
    let client_root = &selected_source.client_root;
    let workspace = &selected_source.workspace;
    let path = candidate_thread_history_path(history_root, &params.thread_id)?;

    // The full source pass is incremental and never retains either writer fence.
    let mut source = kcoder_state::ProjectedTranscriptReader::open(
        &path,
        128 * 1024 * 1024,
        4 * 1024 * 1024,
        100_000,
    )?;
    let entries = loop {
        let next = source.step(1024 * 1024)?;
        tokio::task::yield_now().await;
        if let Some(entries) = next {
            break entries;
        }
    };
    let projection = source
        .take_projection()
        .context("transcript projection unavailable")?;
    if !projection.observation().has_known_commit_boundary() {
        return Ok(None);
    }

    let (metadata, captured) = {
        let Some(_fence) = TranscriptObservationFence::acquire_existing(history_root, client_root)?
        else {
            return Ok(None);
        };
        let mut budget = crate::CaptureBudget::new();
        source.validate_completed()?;
        budget.check()?;
        // A tracked cursor and a read-only observation are different identity domains.
        // Never retain an observed cursor when both persistent journals have become active.
        if current_watermark(history_root, JournalDomain::History)?.is_some()
            && current_watermark(client_root, JournalDomain::ClientMetadata)?.is_some()
        {
            return Ok(None);
        }
        budget.check()?;
        let metadata = kcoder_state::capture_session_metadata_bounded_with_check(
            &path,
            budget.remaining_bytes().min(1024 * 1024) as u64,
            || budget.check(),
        )?;
        budget.reserve(metadata.bytes_read())?;
        let captured = crate::capture(client_root, &params.thread_id, &mut budget)?;
        source.validate_completed()?;
        budget.check()?;
        (metadata, captured)
    };
    // These owned inputs remain one capture after releasing History -> ClientMetadata.
    // Parsing, projection, whole-input hashing and all async yields happen outside it.
    drop(source);
    let metadata_key = metadata.input_key()?;
    let metadata = metadata.prepare()?;
    anyhow::ensure!(
        dunce::canonicalize(metadata.base_cwd().context("thread workspace is missing")?)?
            == dunce::canonicalize(selected_source.state.cwd())?,
        "thread workspace mismatch"
    );
    let artifacts_key = captured.digest()?;
    let (artifacts, stored) = captured.decode(workspace).await?;
    let (created, updated) = projection.timestamps_ms(&metadata);
    let mut thread = json!({
        "id":params.thread_id,"cwd":workspace,"sessionMode":metadata.session_mode(),"studioWorkMode":metadata.studio_work_mode(),
        "workflowDefinitionId":metadata.workflow_definition_id(),
        "status":if running.contains(&params.thread_id) {"running"} else {"idle"},
        "title":projection.first_prompt().map(|text|text.chars().take(80).collect::<String>()),
        "createdAt":created.to_string(),"updatedAt":updated.to_string()
    });
    decorate_thread_snapshot_with_metadata(&mut thread, stored.as_ref(), true)?;

    let mut associations = transcript_window::TranscriptAssociationScan::new(entries);
    loop {
        let complete = associations.step(128)?;
        tokio::task::yield_now().await;
        if complete {
            break;
        }
    }
    let mut turns = associations.finish(artifacts)?;
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&(
        OBSERVATION_VERSION,
        STORAGE_PROJECTION_VERSION,
        VISIBLE_PROJECTION_VERSION,
        &workspace,
        &params.thread_id,
        &path,
        projection.observation().cache_key(),
        metadata_key,
        artifacts_key,
    ))?);
    let limit = params.limit.unwrap_or(50).clamp(1, 100) as usize;
    let before = cursor.as_ref().map(|cursor| cursor.before);
    let page_budget = selected_source.response_limit - 4096;
    let mut selected = VecDeque::new();
    let mut selected_bytes = 0usize;
    let mut total = 0usize;
    while let Some(messages) = turns.next_turn() {
        for message in messages {
            let bytes = serde_json::to_vec(&message)?;
            hash.update((bytes.len() as u64).to_le_bytes());
            hash.update(&bytes);
            if before.is_none_or(|end| total < end) {
                anyhow::ensure!(
                    bytes.len() <= page_budget,
                    "observed transcript row exceeds response budget"
                );
                while selected.len() == limit || bytes.len() > page_budget - selected_bytes {
                    let (_, size) = selected.pop_front().expect("full page has a row");
                    selected_bytes -= size;
                }
                selected_bytes = selected_bytes
                    .checked_add(bytes.len())
                    .context("page byte overflow")?;
                selected.push_back((message, bytes.len()));
            }
            total += 1;
            if total.is_multiple_of(16) {
                tokio::task::yield_now().await;
            }
        }
        tokio::task::yield_now().await;
    }
    let observation_id = format!("{:x}", hash.finalize());
    if let Some(cursor) = &cursor {
        anyhow::ensure!(
            cursor.observation_id == observation_id && cursor.before <= total,
            TranscriptCursorStale
        );
    }
    let end = before.unwrap_or(total);
    let start = end.saturating_sub(selected.len());
    let page = ThreadReadResult {
        thread: serde_json::from_value(thread)?,
        messages: selected.into_iter().map(|(message, _)| message).collect(),
        range_start: start,
        range_end: end,
        has_more_before: start > 0,
        before_cursor: (start > 0)
            .then(|| format!("{OBSERVATION_CURSOR_PREFIX}{observation_id}:{start}")),
        transcript_snapshot_v1: None,
        transcript_observation_v1: Some(ThreadTranscriptObservationV1 {
            observation_id,
            // Filled from the final Thread/run decoration by ReadOutcome::finish.
            view_key: String::new(),
        }),
    };
    Ok(Some(ReadOutcome::legacy(page, snapshot_enabled)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_observation_cursor_is_opaque_bounded_and_never_numeric_fallback() {
        let valid = format!("tp1:ob1-{}:25", "a".repeat(64));
        let parsed = parse_cursor(&valid).unwrap();
        assert_eq!(parsed.before, 25);
        assert_eq!(parsed.observation_id, "a".repeat(64));
        for invalid in [
            "25".into(),
            "tp1:old:25".into(),
            format!("tp1:ob1-{}:0", "a".repeat(64)),
            format!("tp1:ob1-{}:25", "A".repeat(64)),
            format!("tp1:ob1-{}:1:2", "a".repeat(64)),
            format!("tp1:ob1-{}:{}", "a".repeat(64), "9".repeat(30)),
        ] {
            assert!(
                parse_cursor(&invalid)
                    .unwrap_err()
                    .is::<TranscriptCursorStale>()
            );
        }
    }
}
