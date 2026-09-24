use super::*;
use kcoder_state::history_index::{TranscriptPageStore, TranscriptReadFence};
use std::io::Read;

const STORAGE_PROJECTION_VERSION: &str = "final-transcript-v1";
const VISIBLE_PROJECTION_VERSION: &str = "final-transcript-v5";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_visibility_revision_invalidates_old_rows_without_changing_store_ownership() {
        let root = tempfile::tempdir().unwrap();
        let old_scope =
            serde_json::to_string(&(STORAGE_PROJECTION_VERSION, "workspace", "session")).unwrap();
        let new_scope =
            serde_json::to_string(&(VISIBLE_PROJECTION_VERSION, "workspace", "session")).unwrap();
        // Receipts include the projection scope in their digest. Model that
        // changed proof while retaining the established storage ownership.
        let old_proof = old_scope.as_bytes();
        let new_proof = new_scope.as_bytes();
        let mut store = TranscriptPageStore::open(root.path(), &old_scope, true)
            .unwrap()
            .unwrap();
        let old = store.begin().unwrap();
        store
            .append_with_row_limit(&old, &[json!({"content":"[system] private"})], 4096)
            .unwrap();
        store.publish(&old, old_proof).unwrap();
        drop(store);
        let store = TranscriptPageStore::open_existing_recoverable(root.path(), &old_scope)
            .unwrap()
            .unwrap();
        assert_eq!(
            store.current_generation(old_proof).unwrap().as_deref(),
            Some(old.as_str())
        );
        assert!(store.current_generation(new_proof).unwrap().is_none());
        drop(store);
        let mut store = TranscriptPageStore::open(root.path(), &old_scope, true)
            .unwrap()
            .unwrap();
        let next = store.begin().unwrap();
        store
            .append_with_row_limit(&next, &[json!({"content":"visible user"})], 4096)
            .unwrap();
        store.publish(&next, new_proof).unwrap();
        assert_eq!(
            store.current_generation(new_proof).unwrap().as_deref(),
            Some(next.as_str())
        );
        assert!(store.current_generation(old_proof).unwrap().is_none());
    }
}

pub(super) async fn read(
    engine: &QueryEngine,
    params: ThreadReadParams,
    running: &HashSet<String>,
    run_projection: ThreadRunProjection,
) -> Result<ThreadReadResult> {
    let opaque = params
        .before_cursor
        .as_deref()
        .is_some_and(|cursor| cursor.starts_with("tp1:"));
    if params.before_cursor.is_some() && !opaque {
        return super::thread_transcript(engine, params, running, run_projection).await;
    }
    if params.thread_id == engine.session_id() {
        engine.state.flush_history().await?;
    }
    match try_indexed(engine, &params, running, run_projection).await {
        Ok(Some(mut page)) => {
            if params.thread_id == engine.session_id() {
                page.thread = serde_json::from_value(thread_snapshot(
                    engine,
                    running.contains(&params.thread_id),
                ))?;
            }
            run_projection.apply_thread(&mut page.thread);
            Ok(page)
        }
        _ if opaque => anyhow::bail!("TRANSCRIPT_CURSOR_STALE"),
        // Legacy callers retain their existing tolerant behavior when an index
        // cannot be built. An opaque cursor must never enter this fallback.
        _ => super::thread_transcript(engine, params, running, run_projection).await,
    }
}

async fn try_indexed(
    engine: &QueryEngine,
    params: &ThreadReadParams,
    running: &HashSet<String>,
    run_projection: ThreadRunProjection,
) -> Result<Option<ThreadReadResult>> {
    validate_thread_id(&params.thread_id)?;
    let history_path = engine.state.history_path().context("history disabled")?;
    let history_root = history_path.parent().context("history root missing")?;
    let client_root = engine.client_storage_root();
    let workspace = canonical_workspace(engine)?;
    // Keep storage ownership stable while invalidating old projection receipts.
    let storage_scope =
        serde_json::to_string(&(STORAGE_PROJECTION_VERSION, &workspace, &params.thread_id))?;
    let scope =
        serde_json::to_string(&(VISIBLE_PROJECTION_VERSION, &workspace, &params.thread_id))?;
    let Some(receipt) = TranscriptReadFence::acquire(history_root, &client_root, &scope)? else {
        return Ok(None);
    };
    let proof = receipt.proof().to_vec();
    let root = engine.session_storage_dir_for(&params.thread_id);
    let mut store = TranscriptPageStore::open_existing_recoverable(&root, &storage_scope)?;
    let row_limit = MAX_TRANSCRIPT_RESPONSE_BYTES - 4096;
    if store
        .as_ref()
        .map(|store| store.declined_generation(&proof, row_limit))
        .transpose()?
        .flatten()
        .is_some()
    {
        return Ok(None);
    }
    let mut generation = store
        .as_ref()
        .map(|store| store.current_generation(&proof))
        .transpose()?
        .flatten();
    let before = if let Some(cursor) = &params.before_cursor {
        anyhow::ensure!(cursor.len() <= 128, "invalid transcript cursor");
        let fields = cursor.split(':').collect::<Vec<_>>();
        anyhow::ensure!(
            fields.len() == 3 && fields[0] == "tp1" && generation.as_deref() == Some(fields[1]),
            "stale transcript cursor"
        );
        Some(
            fields[2]
                .parse::<usize>()?
                .checked_add(1)
                .context("cursor overflow")?,
        )
    } else {
        None
    };
    if generation.is_none() {
        drop(receipt);
        drop(store.take());
        // Source loading never holds the writer fences. Final publication
        // compares a newly acquired receipt to this pre-load observation.
        let path = candidate_thread_history_path(history_root, &params.thread_id)?;
        let metadata = kcoder_state::prepare_session_metadata_bounded(&path, 1024 * 1024)?;
        anyhow::ensure!(
            std::fs::canonicalize(metadata.base_cwd().context("thread workspace is missing")?)?
                == std::fs::canonicalize(engine.state.cwd())?,
            "thread workspace mismatch"
        );
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
        drop(source);
        let (created, updated) = projection.timestamps_ms(&metadata);
        let mut thread = json!({"id":params.thread_id,"cwd":workspace,"sessionMode":metadata.session_mode(),"workflowDefinitionId":metadata.workflow_definition_id(),"status":"idle",
            "title":projection.first_prompt().map(|text| text.chars().take(80).collect::<String>()),"createdAt":created.to_string(),"updatedAt":updated.to_string()});
        decorate_thread_snapshot(engine, &mut thread, true)?;
        let artifacts = load_artifacts(engine, &params.thread_id).await?;
        let mut associations = transcript_window::TranscriptAssociationScan::new(entries);
        loop {
            let complete = associations.step(128)?;
            tokio::task::yield_now().await;
            if complete {
                break;
            }
        }
        let mut turns = associations.finish(artifacts)?;
        ensure_private_artifact_directory(&root)?;
        let mut build = TranscriptPageStore::open(&root, &storage_scope, true)?
            .context("page store unavailable")?;
        let next = build.begin()?;
        build.append_with_row_limit(&next, &[thread], 1024 * 1024)?;
        let append_rows = |build: &mut TranscriptPageStore, rows: &[Value]| -> Result<()> {
            match build.append_with_row_limit(&next, rows, row_limit) {
                Ok(()) => Ok(()),
                Err(error) => {
                    if error.is::<kcoder_state::history_index::TranscriptRowLimitExceeded>() {
                        // Clear derived rows before reacquiring source fences; only the small
                        // decline header write runs while authority is held.
                        let declined = build.restart_unpublished(&next)?;
                        if let Some(fresh) =
                            TranscriptReadFence::acquire(history_root, &client_root, &scope)?
                            && fresh.proof() == proof
                        {
                            build.decline_row_limit(&declined, fresh.proof(), row_limit)?;
                        }
                    }
                    Err(error)
                }
            }
        };
        let mut batch = Vec::with_capacity(8);
        while let Some(messages) = turns.next_turn() {
            for row in messages {
                batch.push(serde_json::to_value(row)?);
                if batch.len() == 8 {
                    append_rows(&mut build, &batch)?;
                    batch.clear();
                    tokio::task::yield_now().await;
                }
            }
            tokio::task::yield_now().await;
        }
        if !batch.is_empty() {
            append_rows(&mut build, &batch)?;
        }
        let final_receipt = TranscriptReadFence::acquire(history_root, &client_root, &scope)?
            .context("tracking disabled")?;
        anyhow::ensure!(
            final_receipt.proof() == proof,
            "transcript changed during build"
        );
        build.publish(&next, final_receipt.proof())?;
        store = Some(build);
        generation = Some(next);
        return read_page(
            store.as_ref().unwrap(),
            generation.as_deref().unwrap(),
            final_receipt.proof(),
            params,
            before,
            running,
            run_projection,
        )
        .map(Some);
    }
    read_page(
        store.as_ref().unwrap(),
        generation.as_deref().unwrap(),
        receipt.proof(),
        params,
        before,
        running,
        run_projection,
    )
    .map(Some)
}

fn read_page(
    store: &TranscriptPageStore,
    generation: &str,
    proof: &[u8],
    params: &ThreadReadParams,
    before: Option<usize>,
    running: &HashSet<String>,
    run_projection: ThreadRunProjection,
) -> Result<ThreadReadResult> {
    let metadata = store.page(generation, proof, Some(1), 1, 1024 * 1024)?;
    let mut thread: Thread = serde_json::from_value(
        metadata
            .rows
            .into_iter()
            .next()
            .context("thread header missing")?,
    )?;
    anyhow::ensure!(thread.id == params.thread_id, "thread header mismatch");
    thread.status = if running.contains(&params.thread_id) {
        kcoder_app_protocol::ThreadStatus::Running
    } else {
        kcoder_app_protocol::ThreadStatus::Idle
    };
    run_projection.apply_thread(&mut thread);
    let page = store.page(
        generation,
        proof,
        before,
        params.limit.unwrap_or(50).clamp(1, 100) as usize,
        MAX_TRANSCRIPT_RESPONSE_BYTES - 4096,
    )?;
    let start = page.start.saturating_sub(1);
    let end = page.end.saturating_sub(1);
    let messages = page
        .rows
        .into_iter()
        .enumerate()
        .filter(|(index, _)| page.start + index > 0)
        .map(|(_, row)| serde_json::from_value(row))
        .collect::<std::result::Result<Vec<ThreadMessage>, _>>()?;
    Ok(ThreadReadResult {
        thread,
        messages,
        range_start: start,
        range_end: end,
        has_more_before: start > 0,
        before_cursor: (start > 0).then(|| format!("tp1:{generation}:{start}")),
    })
}

async fn load_artifacts(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<transcript_window::Artifacts> {
    let mut result = transcript_window::Artifacts::default();
    let mut total = 0usize;
    for kind in [
        "turn-attempts",
        "turn-admissions",
        "turn-client-messages",
        "turn-outcomes",
        "approval-decisions",
        "turn-file-changes",
    ] {
        let path = engine.session_storage_dir_for(thread_id).join(kind);
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let directory = kcoder_config::PrivateDirectory::open_existing(&path)?;
        for (index, entry) in entries.enumerate() {
            if index % 32 == 0 {
                tokio::task::yield_now().await;
            }
            anyhow::ensure!(index < 10_000, "artifact enumeration exceeds budget");
            let entry = entry?;
            if kind == "turn-attempts" && !entry.file_name().to_string_lossy().ends_with(".attempt.json") { continue; }
            if entry.path().extension().and_then(|name| name.to_str()) != Some("json") {
                continue;
            }
            let limit = if matches!(kind, "turn-client-messages" | "turn-outcomes" | "turn-admissions") {
                64 * 1024
            } else {
                1024 * 1024
            };
            let mut bytes = Vec::new();
            directory
                .open_regular_file(&entry.file_name())?
                .take(limit + 1)
                .read_to_end(&mut bytes)?;
            total += bytes.len();
            anyhow::ensure!(
                bytes.len() as u64 <= limit && total <= 64 * 1024 * 1024,
                "artifact input exceeds budget"
            );
            match kind {
                "turn-attempts" => {
                    let record: kcoder_state::turn_attempt_store::TurnAttemptRecord = serde_json::from_slice(&bytes)?;
                    record.validate()?;
                    anyhow::ensure!(record.identity.thread_id == thread_id, "attempt belongs to another thread");
                    anyhow::ensure!(entry.file_name() == std::ffi::OsString::from(format!("{}.attempt.json", hex_sha256(record.identity.attempt_id.as_bytes()))), "attempt artifact filename mismatch");
                    result.attempts.push(record);
                }
                "turn-admissions" => {
                    let binding: super::turn_admissions::Binding = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(binding.version == 1 && binding.thread_id == thread_id && !binding.user_message_uuid.is_empty(), "invalid turn admission binding");
                    anyhow::ensure!(result.turn_ids.insert(binding.user_message_uuid, binding.turn_id).is_none(), "duplicate turn admission binding");
                }
                "turn-client-messages" => {
                    let artifact: TurnClientMessageArtifact = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        artifact.version == 1
                            && artifact.thread_id == thread_id
                            && !artifact.client_message_id.trim().is_empty(),
                        "invalid client message artifact"
                    );
                    result
                        .client_ids
                        .insert(artifact.turn_id, artifact.client_message_id);
                }
                "turn-outcomes" => {
                    let artifact: TurnOutcomeArtifact = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        artifact.version == 1 && artifact.thread_id == thread_id,
                        "invalid turn outcome"
                    );
                    if matches!(artifact.status.as_str(), "interrupted" | "failed") {
                        result.outcomes.insert(artifact.turn_id.clone(), artifact);
                    }
                }
                "approval-decisions" => {
                    let artifact: ApprovalDecisionArtifact = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        artifact.version == 1
                            && artifact.thread_id == thread_id
                            && valid_artifact_id(&artifact.artifact_id),
                        "invalid approval artifact"
                    );
                    result.approvals.push(artifact);
                }
                _ => {
                    let mut artifact: TurnFileChangesArtifact = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        artifact.thread_id == thread_id && valid_artifact_id(&artifact.artifact_id),
                        "invalid file changes artifact"
                    );
                    if !std::fs::symlink_metadata(
                        path.join(format!("{}.patch", artifact.artifact_id)),
                    )
                    .ok()
                    .is_some_and(|m| {
                        m.file_type().is_file()
                            && m.len() > 0
                            && m.len() <= MAX_TURN_FILE_CHANGES_BYTES as u64
                    }) {
                        artifact.status = "artifact_missing".into();
                    }
                    result.file_changes.insert(
                        artifact.turn_id.clone(),
                        turn_file_changes_summary(&artifact),
                    );
                }
            }
        }
    }
    result
        .approvals
        .sort_by_key(|artifact| artifact.requested_at_ms);
    result.attempts = super::turn_attempts::validate_records(result.attempts)?;
    Ok(result)
}
