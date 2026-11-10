//! Thread metadata: extracted from the app-server connection boundary.

use super::*;
pub(super) mod access;
pub(super) use kcoder_thread_metadata::{
    MAX_THREAD_METADATA_BYTES, THREAD_METADATA_FILE, ThreadClientMetadata,
    acquire_thread_lifecycle_locks_at_root, apply_metadata_update, apply_parent_metadata_update,
    candidate_thread_metadata_path, decorate_thread_snapshot_with_metadata, same_workspace_form,
    unix_millis_string, validate_metadata_text, validate_plain_metadata_text,
    validate_thread_metadata_patch, validated_thread_storage_dir, write_thread_metadata,
};

pub(super) fn thread_snapshot(engine: &QueryEngine, running: bool) -> Value {
    thread_snapshot_with_metadata_policy(engine, running, false)
        .expect("best-effort thread metadata decoration is infallible")
}

impl ThreadRunProjection {
    pub(super) fn for_thread(
        thread_manager: &thread_runtime::ThreadManager,
        negotiated: bool,
        thread_id: &str,
    ) -> Self {
        Self {
            negotiated,
            facts: thread_manager.thread_run_facts(thread_id),
        }
    }

    /// Facts that must replace the legacy projection, if any.
    pub(super) fn authoritative(self) -> Option<kcoder_app_protocol::ThreadRunFacts> {
        if self.negotiated { self.facts } else { None }
    }

    /// Replaces the legacy projection on a typed thread snapshot.
    pub(super) fn apply_thread(self, thread: &mut kcoder_app_protocol::Thread) {
        let Some(facts) = self.authoritative() else {
            return;
        };
        thread.status = facts.state();
        thread.run_summary = Some(facts.summary());
    }

    pub(super) fn apply(self, snapshot: &mut Value) {
        let Some(facts) = self.authoritative() else {
            return;
        };
        let Some(object) = snapshot.as_object_mut() else {
            return;
        };
        object.insert("status".to_string(), json!(facts.state()));
        object.insert(
            "runSummary".to_string(),
            serde_json::to_value(facts.summary()).expect("run summary serializes"),
        );
    }
}

pub(super) fn thread_snapshot_with_metadata_policy(
    engine: &QueryEngine,
    running: bool,
    strict_metadata: bool,
) -> Result<Value> {
    let (created_at, updated_at) = engine.state.session_timestamps_ms();
    let mut snapshot = json!({
        "id": engine.session_id(),
        "cwd": dunce::simplified(&engine.state.cwd()).to_string_lossy().into_owned(),
        "model": engine.client_model_selector(),
        "modelSelectionMode": engine.state.model_selection_mode(),
        "selectedModel": engine.state.selected_model(),
        "sessionMode": turn_execution::mode(engine),
        "studioWorkMode": engine.state.studio_work_mode(),
        "workflowDefinitionId": engine.state.workflow_definition_id(),
        "agentDefinition": engine.state.agent_definition(),
        "channelTaskSource": engine.state.channel_task_source(),
        "status": if running { "running" } else { "idle" },
        "messageCount": engine.state.message_count(),
        "createdAt": created_at.to_string(),
        "updatedAt": updated_at.to_string(),
    });
    decorate_thread_snapshot(engine, &mut snapshot, strict_metadata)?;
    Ok(snapshot)
}

pub(super) fn update_thread_metadata(
    engine: &QueryEngine,
    params: ThreadMetadataUpdateParams,
    running_thread_ids: &HashSet<String>,
    active_thread_owned: bool,
) -> Result<ThreadMetadataUpdateResult> {
    validate_thread_metadata_patch(&params)?;
    let mut lock_ids = vec![params.thread_id.as_str()];
    if let MetadataUpdate::Set(parent) = &params.parent {
        lock_ids.push(parent.thread_id.as_str());
    }
    let _lifecycle_locks = acquire_thread_lifecycle_locks(engine, &lock_ids)?;

    apply_thread_metadata_while_lifecycle_locked(
        engine,
        params,
        running_thread_ids,
        active_thread_owned,
    )
}

/// Publication already owns this session's lifecycle lock; do not acquire it recursively.
pub(super) fn update_historical_thread_metadata(
    engine: &QueryEngine,
    params: ThreadMetadataUpdateParams,
    lease: &kcoder_state::historical_undo::HistoricalUndoLease,
) -> Result<ThreadMetadataUpdateResult> {
    validate_thread_metadata_patch(&params)?;
    anyhow::ensure!(
        params.thread_id == engine.session_id() && params.parent.is_unchanged(),
        "historical_undo_wrong_owner"
    );
    let path = engine
        .state
        .history_path()
        .context("continuation_history_disabled")?;
    lease.verify(&path, &engine.client_storage_root(), &params.thread_id)?;
    apply_thread_metadata_while_lifecycle_locked(engine, params, &HashSet::new(), true)
}

// Every caller retains the lifecycle lock through the full metadata transaction.
fn apply_thread_metadata_while_lifecycle_locked(
    engine: &QueryEngine,
    params: ThreadMetadataUpdateParams,
    running_thread_ids: &HashSet<String>,
    active_thread_owned: bool,
) -> Result<ThreadMetadataUpdateResult> {
    // Reconfirm the entity after locking its stable parent directory. Before the first
    // turn, a historyless active thread is identified by the current connection's
    // session lease and does not require a JSONL file that does not yet exist.
    let history_path = if active_thread_owned {
        engine.state.history_path()
    } else {
        if params.thread_id == engine.session_id() {
            anyhow::bail!("thread is not active in this app-server connection")
        }
        Some(thread_history_path(engine, &params.thread_id)?)
    };
    if let MetadataUpdate::Set(parent) = &params.parent {
        validate_thread_parent(engine, &params.thread_id, parent)?;
    }
    let storage_dir = ensure_thread_metadata_directory(engine, &params.thread_id)?;
    let workspace = canonical_workspace(engine)?;
    {
        use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
        // Activation and all metadata read/modify/write operations share this short fence.
        let mut fence = JournalFence::try_acquire(
            &engine.client_storage_root(),
            JournalDomain::ClientMetadata,
        )?;
        let mut metadata = read_thread_metadata(engine, &params.thread_id)?.unwrap_or_else(|| {
            ThreadClientMetadata {
                version: 1,
                revision: 0,
                thread_id: params.thread_id.clone(),
                workspace: workspace.clone(),
                fields: BTreeMap::new(),
                updated_at: unix_millis_string(),
            }
        });
        let previous_fields = metadata.fields.clone();
        apply_metadata_update(&mut metadata.fields, "title", params.title);
        apply_metadata_update(&mut metadata.fields, "model", params.model);
        apply_metadata_update(&mut metadata.fields, "archivedAt", params.archived_at);
        apply_parent_metadata_update(&mut metadata.fields, params.parent)?;
        if metadata.fields != previous_fields {
            metadata.revision = metadata.revision.saturating_add(1);
            metadata.updated_at = unix_millis_string();
            write_thread_metadata(&storage_dir, &metadata, &mut fence)?;
        }
    }

    let thread_value = if active_thread_owned {
        thread_snapshot(engine, running_thread_ids.contains(&params.thread_id))
    } else {
        let history_path = history_path.context("persisted thread history is missing")?;
        persisted_thread_value(
            engine,
            &params.thread_id,
            &history_path,
            running_thread_ids.contains(&params.thread_id),
        )?
    };
    Ok(ThreadMetadataUpdateResult {
        thread: serde_json::from_value(thread_value)?,
    })
}

pub(super) fn validate_thread_parent(
    engine: &QueryEngine,
    thread_id: &str,
    parent: &ThreadParent,
) -> Result<()> {
    validate_plain_metadata_text("parent.taskId", &parent.task_id, 512)?;
    validate_thread_id(&parent.thread_id).context("thread parent id is invalid")?;
    validate_plain_metadata_text("parent.lastTurnId", &parent.last_turn_id, 64)?;
    if parent.thread_id == thread_id {
        anyhow::bail!("thread parent cannot reference itself")
    }
    let history_path = thread_history_path(engine, &parent.thread_id)
        .context("thread parent does not exist in the active workspace")?;
    let entries = kcoder_state::load_transcript_history(&history_path)?;
    turn_admissions::fork_transcript(
        &entries,
        &turn_admissions::bindings(engine, &parent.thread_id)?,
        &parent.last_turn_id,
    )
    .context("thread parent lastTurnId does not exist")?;
    Ok(())
}

pub(super) fn canonical_workspace(engine: &QueryEngine) -> Result<String> {
    kcoder_thread_metadata::canonical_workspace(&engine.state.cwd())
}

pub(super) fn acquire_thread_lifecycle_locks(
    engine: &QueryEngine,
    thread_ids: &[&str],
) -> Result<Vec<std::fs::File>> {
    acquire_thread_lifecycle_locks_at_root(&engine.client_storage_root(), thread_ids)
}

pub(super) fn try_acquire_thread_lifecycle_locks(
    engine: &QueryEngine,
    thread_ids: &[&str],
) -> Result<Vec<std::fs::File>> {
    kcoder_thread_metadata::try_acquire_thread_lifecycle_locks_at_root(
        &engine.client_storage_root(),
        thread_ids,
    )
}

pub(super) fn ensure_thread_metadata_directory(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<PathBuf> {
    kcoder_thread_metadata::ensure_thread_metadata_directory(
        &engine.client_storage_root(),
        thread_id,
    )
}

pub(super) fn thread_metadata_path(engine: &QueryEngine, thread_id: &str) -> Result<PathBuf> {
    candidate_thread_metadata_path(&engine.client_storage_root(), thread_id)
}

/// Persist creation policy and its immutable template binding as one metadata revision.
pub(super) fn record_thread_creation_configuration(
    engine: &QueryEngine,
    thread_id: &str,
    permission_mode: kcoder_config::PermissionMode,
    binding: Option<&SettingsTemplateBinding>,
) -> Result<()> {
    let storage_dir = ensure_thread_metadata_directory(engine, thread_id)?;
    let workspace = canonical_workspace(engine)?;
    {
        use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
        let mut fence = JournalFence::try_acquire(
            &engine.client_storage_root(),
            JournalDomain::ClientMetadata,
        )?;
        let mut metadata =
            read_thread_metadata(engine, thread_id)?.unwrap_or_else(|| ThreadClientMetadata {
                version: 1,
                revision: 0,
                thread_id: thread_id.into(),
                workspace: workspace.clone(),
                fields: BTreeMap::new(),
                updated_at: unix_millis_string(),
            });
        let stored_mode = serde_json::to_value(permission_mode)?
            .as_str()
            .map(ToOwned::to_owned)
            .context("permission mode did not serialize as a string")?;
        let mut fields = vec![("permissionModeAtCreation", stored_mode)];
        if let Some(binding) = binding {
            fields.push(("settingsTemplate", serde_json::to_string(binding)?));
        }
        if fields
            .iter()
            .any(|(name, value)| metadata.fields.get(*name) != Some(&Some(value.clone())))
        {
            for (name, value) in fields {
                metadata.fields.insert(name.into(), Some(value));
            }
            metadata.revision = metadata
                .revision
                .checked_add(1)
                .context("thread metadata revision exhausted")?;
            metadata.updated_at = unix_millis_string();
            write_thread_metadata(&storage_dir, &metadata, &mut fence)?;
        }
    }
    Ok(())
}

/// Persists the new session's permission baseline so later target-default changes do not affect it.
#[cfg(test)]
pub(super) fn record_thread_permission_mode_at_creation(
    engine: &QueryEngine,
    permission_mode: kcoder_config::PermissionMode,
) -> Result<()> {
    record_thread_permission_mode_for_thread(engine, &engine.session_id(), permission_mode)
}

#[cfg(test)]
pub(super) fn record_thread_permission_mode_for_thread(
    engine: &QueryEngine,
    thread_id: &str,
    permission_mode: kcoder_config::PermissionMode,
) -> Result<()> {
    record_thread_creation_configuration(engine, thread_id, permission_mode, None)
}

/// Returns a persisted creation-time permission baseline without modifying legacy metadata.
pub(super) fn recorded_thread_permission_mode_at_creation(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<Option<kcoder_config::PermissionMode>> {
    parse_thread_permission_mode_at_creation(read_thread_metadata(engine, thread_id)?)
}

fn parse_thread_permission_mode_at_creation(
    metadata: Option<ThreadClientMetadata>,
) -> Result<Option<kcoder_config::PermissionMode>> {
    let Some(metadata) = metadata else {
        return Ok(None);
    };
    match metadata.fields.get("permissionModeAtCreation") {
        None => Ok(None),
        Some(None) => anyhow::bail!("stored permissionModeAtCreation must not be null"),
        Some(Some(value)) => serde_json::from_value(serde_json::Value::String(value.clone()))
            .context("stored permissionModeAtCreation is invalid")
            .map(Some),
    }
}

/// Read-only display projection; execution uses the checked binding and frozen version below.
pub(super) fn recorded_settings_template_binding(
    engine: &QueryEngine,
    thread_id: &str,
) -> Option<SettingsTemplateBinding> {
    read_thread_metadata(engine, thread_id)
        .ok()
        .flatten()
        .and_then(|metadata| metadata.fields.get("settingsTemplate").cloned().flatten())
        .and_then(|value| serde_json::from_str::<SettingsTemplateBinding>(&value).ok())
}

pub(super) fn recorded_settings_template_path(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<Option<PathBuf>> {
    let Some(binding) = checked_recorded_settings_template_binding(engine, thread_id)? else {
        return Ok(None);
    };
    config_templates::user_template_store()?
        .recorded_session_path(&binding)
        .map(Some)
}

pub(super) fn checked_recorded_settings_template_binding(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<Option<SettingsTemplateBinding>> {
    let Some(metadata) = read_thread_metadata(engine, thread_id)? else {
        return Ok(None);
    };
    let Some(Some(raw)) = metadata.fields.get("settingsTemplate") else {
        return Ok(None);
    };
    serde_json::from_str(raw)
        .map(Some)
        .map_err(|_| anyhow::anyhow!("settings_template_invalid_recorded_binding"))
}

pub(super) fn read_thread_metadata(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<Option<ThreadClientMetadata>> {
    kcoder_thread_metadata::read_thread_metadata(
        &engine.client_storage_root(),
        &engine.state.cwd(),
        thread_id,
    )
}

pub(super) fn decorate_thread_snapshot(
    engine: &QueryEngine,
    snapshot: &mut Value,
    strict: bool,
) -> Result<()> {
    let Some(thread_id) = snapshot
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return Ok(());
    };
    let stored = match read_thread_metadata(engine, &thread_id) {
        Ok(metadata) => metadata,
        Err(error) if strict => return Err(error),
        Err(error) => {
            tracing::warn!(thread_id, %error, "ignoring invalid client thread metadata");
            None
        }
    };
    decorate_thread_snapshot_with_metadata(snapshot, stored.as_ref(), strict)
}

pub(super) async fn ensure_same_workspace(actual: &Path, requested: &Path) -> Result<()> {
    let actual = tokio::fs::canonicalize(actual).await.with_context(|| {
        format!(
            "failed to resolve app-server workspace {}",
            actual.display()
        )
    })?;
    let requested = tokio::fs::canonicalize(requested).await.with_context(|| {
        format!(
            "failed to resolve requested workspace {}",
            requested.display()
        )
    })?;
    if actual != requested {
        anyhow::bail!(
            "requested workspace {} does not match app-server workspace {}",
            requested.display(),
            actual.display()
        );
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn persisted_thread_snapshots(
    engine: &QueryEngine,
    running_thread_ids: &HashSet<String>,
) -> Result<Vec<Value>> {
    Ok(persisted_thread_snapshot_report(engine, running_thread_ids, &HashSet::new())?.threads)
}

pub(super) fn persisted_thread_snapshot_report(
    engine: &QueryEngine,
    running_thread_ids: &HashSet<String>,
    excluded_ids: &HashSet<String>,
) -> Result<PersistedThreadSnapshotReport> {
    match tracked_history_list::TrackedHistoryList::try_list(
        engine,
        running_thread_ids,
        excluded_ids,
        tracked_history_list::ListBudget::default(),
    ) {
        Ok(Some(report)) => return Ok(report),
        Ok(None) => {}
        Err(error) => tracing::debug!(%error, "tracked list unavailable; using authoritative scan"),
    }
    // Full-hash parsing reuse failed the component performance gate and remains test-only.
    persisted_thread_snapshot_report_with_catalog(
        engine,
        running_thread_ids,
        excluded_ids,
        history_catalog::ListCatalog::default(),
    )
}

pub(super) use kcoder_thread_metadata::history_scan_roots;

pub(super) fn scan_history_roots(roots: &[PathBuf]) -> Result<MergedHistoryScan> {
    let mut merged = MergedHistoryScan {
        candidates: Vec::new(),
        issue_count: 0,
    };
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let scan = kcoder_state::recent_session_candidates_report(root)?;
        merged.issue_count = merged.issue_count.saturating_add(scan.issue_count);
        for candidate in scan.candidates {
            if seen.insert(candidate.0.clone()) {
                merged.candidates.push(candidate);
            }
        }
    }
    Ok(merged)
}

pub(super) fn persisted_thread_snapshot_report_with_catalog(
    engine: &QueryEngine,
    running_thread_ids: &HashSet<String>,
    excluded_ids: &HashSet<String>,
    mut catalog: history_catalog::ListCatalog,
) -> Result<PersistedThreadSnapshotReport> {
    let Some(history_path) = engine.state.history_path() else {
        return Ok(PersistedThreadSnapshotReport::default());
    };
    let history_dir = history_path
        .parent()
        .context("session history path has no parent")?;
    // strip 基准取 `project_data_dirs_for_read` 首项（当前项目目录，与 CLI 读路径
    // 候选同源）。默认布局 transcript 平铺在项目目录（main.rs:1386-1392），相对
    // 路径为空 → 兼容根 = 裸 key 目录（正确，旧 build 同样平铺写入）；嵌套/自定义
    // 布局按相对子路径拼接；history_dir 不在基准的祖先链上时 strip 失败、回退单根。
    let roots = match kcoder_config::Settings::project_data_dirs_for_read(engine.state.cwd()) {
        Ok(project_dirs) if !project_dirs.is_empty() => {
            history_scan_roots(history_dir, &project_dirs[0], &project_dirs)
        }
        _ => vec![history_dir.to_path_buf()],
    };
    let root = std::fs::canonicalize(engine.state.cwd())?;
    let scan = scan_history_roots(&roots)?;
    let mut report = PersistedThreadSnapshotReport {
        threads: Vec::new(),
        issue_count: scan.issue_count,
    };
    for (session_id, path, _) in scan.candidates {
        if excluded_ids.contains(&session_id) {
            continue;
        }
        // Explicitly admitted tasks can be durable before their first message. Their
        // original creation metadata distinguishes them from bootstrap placeholders;
        // it is an index fact, never permission to execute or recreate a missing file.
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                if metadata.len() == 0 {
                    match recorded_thread_permission_mode_at_creation(engine, &session_id) {
                        Ok(Some(_)) => {}
                        Ok(None) => continue,
                        Err(_) => {
                            report.issue_count = report.issue_count.saturating_add(1);
                            continue;
                        }
                    }
                }
            }
            Ok(_) => continue,
            Err(_) => {
                report.issue_count = report.issue_count.saturating_add(1);
                continue;
            }
        }
        if validate_thread_id(&session_id).is_err() {
            report.issue_count = report.issue_count.saturating_add(1);
            tracing::warn!(
                session_id,
                "skipping persisted app-server thread with invalid id"
            );
            continue;
        }
        let metadata = match kcoder_state::prepare_session_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                report.issue_count = report.issue_count.saturating_add(1);
                tracing::warn!(
                    session_id,
                    path = %path.display(),
                    %error,
                    "skipping unreadable persisted app-server thread"
                );
                continue;
            }
        };
        let Some(base_cwd) = metadata.base_cwd() else {
            report.issue_count = report.issue_count.saturating_add(1);
            continue;
        };
        let Ok(base_cwd) = std::fs::canonicalize(base_cwd) else {
            // The session's recorded working directory no longer exists (deleted
            // project, removed worktree, cleaned temp dir). It cannot belong to
            // any workspace list; skip it silently — the same treatment as a
            // session that belongs to another directory. Counting it as a
            // listing issue made every project with such a session show a
            // permanent "incomplete (N issues)" banner that no transport-side
            // fix could ever clear.
            tracing::debug!(
                session_id,
                cwd = ?metadata.base_cwd(),
                "skipping persisted thread whose working directory no longer exists"
            );
            continue;
        };
        if base_cwd != root {
            continue;
        }
        let snapshot = catalog.snapshot(
            engine,
            &session_id,
            &path,
            &metadata,
            running_thread_ids.contains(&session_id),
        );
        match snapshot {
            Ok(snapshot) => report.threads.push(snapshot),
            Err(error) => {
                report.issue_count = report.issue_count.saturating_add(1);
                tracing::warn!(
                    session_id,
                    path = %path.display(),
                    %error,
                    "skipping invalid persisted app-server thread"
                );
            }
        }
    }
    catalog.publish();
    Ok(report)
}

#[cfg(test)]
mod permission_mode_metadata_tests {
    use super::*;

    #[test]
    fn missing_creation_mode_keeps_legacy_metadata_unmodified() {
        let legacy: ThreadClientMetadata = serde_json::from_value(serde_json::json!({
            "version": 1,
            "thread_id": "legacy",
            "workspace": "/workspace",
            "updated_at": "1"
        }))
        .unwrap();
        assert_eq!(
            parse_thread_permission_mode_at_creation(Some(legacy)).unwrap(),
            None
        );
        assert_eq!(
            parse_thread_permission_mode_at_creation(None).unwrap(),
            None
        );
    }

    #[test]
    fn malformed_creation_mode_does_not_fall_back_to_the_current_default() {
        let metadata: ThreadClientMetadata = serde_json::from_value(serde_json::json!({
            "version": 1,
            "thread_id": "thread",
            "workspace": "/workspace",
            "updated_at": "1",
            "fields": { "permissionModeAtCreation": "unrecognized" }
        }))
        .unwrap();
        assert!(parse_thread_permission_mode_at_creation(Some(metadata)).is_err());

        let metadata: ThreadClientMetadata = serde_json::from_value(serde_json::json!({
            "version": 1,
            "thread_id": "thread",
            "workspace": "/workspace",
            "updated_at": "1",
            "fields": { "permissionModeAtCreation": null }
        }))
        .unwrap();
        assert!(parse_thread_permission_mode_at_creation(Some(metadata)).is_err());
    }
}
