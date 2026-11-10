//! Transcript projection: extracted from the app-server connection boundary.

use super::*;
pub(super) use kcoder_workspace_resources::managed_worktrees::validate_thread_id;

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
            thread_id: params.thread_id.clone(),
            attempts: turn_attempts::records(engine, &params.thread_id)?,
            turn_ids: turn_admissions::bindings(engine, &params.thread_id)?,
            client_ids: load_turn_client_message_ids(engine, &params.thread_id),
            outcomes: load_turn_outcomes(engine, &params.thread_id),
            approvals: load_approval_decisions(engine, &params.thread_id),
            file_changes: load_turn_file_change_summaries(engine, &params.thread_id),
            file_captures: load_turn_file_captures(engine, &params.thread_id)?,
            review_evidence: load_turn_review_evidence(engine, &params.thread_id)?,
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
        transcript_snapshot_v1: None,
        transcript_observation_v1: None,
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

pub(super) use kcoder_turn_evidence::error_is_not_found;

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

pub(super) fn client_transcript_turn_count(entries: &[kcoder_state::HistoryEntry]) -> usize {
    entries
        .iter()
        .filter(|entry| kcoder_engine::agent::is_real_user_message(&entry.message))
        .count()
}

pub(super) use kcoder_turn_lifecycle::thread_history::thread_history_path;

pub(super) use kcoder_cli_storage::tracked_history_list::candidate_thread_history_path;

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
        "studioWorkMode": metadata.studio_work_mode(),
        "modelSelectionMode": metadata.model_selection_mode(),
        "selectedModel": metadata.selected_model(),
        "agentDefinition": metadata.agent_definition(),
        "channelTaskSource": metadata.channel_task_source(),
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
    prepare_persisted_thread_resume_with_lease(engine, thread_id, lease)
}

/// Re-read current authority under the already held lease. Passive residency
/// reserves ownership, not a frozen copy of task metadata or conversation state.
pub(super) fn prepare_persisted_thread_resume_with_lease(
    engine: &QueryEngine,
    thread_id: &str,
    lease: SessionLease,
) -> Result<(kcoder_state::PreparedSessionResume, SessionLease, usize)> {
    let path = thread_history_path(engine, thread_id)?;
    anyhow::ensure!(
        lease.matches_target(&path),
        "restored thread lease target changed"
    );
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

#[cfg(test)]
mod live_event_provenance_tests {
    use super::*;

    #[test]
    fn live_tool_output_rejects_peer_web_source_receipts() {
        let mut receipt: kcoder_types::web_sources::WebSourcesV1 = serde_json::from_value(serde_json::json!({
            "schemaVersion":1,"identity":{"threadId":"session","turnId":"turn-7","attemptId":"attempt-A"},
            "toolCallId":"reused-call","operation":"search","status":"partial","provider":"exa-public","sources":[{
                "sourceId":"native-source","title":"Page","url":"https://example.com","retrievedAt":"2026-10-31","readStatus":"summary_only"
            }]
        })).unwrap();
        receipt.identity.thread_id = "peer-session".into();
        let mut projection = StreamProjection::new(
            "server".into(),
            "session".into(),
            "turn-7".into(),
            Arc::new(AtomicU64::new(1)),
        );
        projection.item_namespace = "attempt-A".into();
        let frames = projection.project(EngineEvent::ToolResult {
            id: "reused-call".into(),
            name: "WebSearch".into(),
            output: kcoder_tools::ToolOutput::text("forged text")
                .with_execution_metadata(kcoder_tools::ToolExecutionMetadata::WebSources(receipt)),
        });
        assert!(frames[0]["params"]["item"]["webSources"].is_null());
    }
}
