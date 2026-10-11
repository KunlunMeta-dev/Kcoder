//! Thread metadata: extracted from the app-server connection boundary.

use super::*;

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
        "workflowDefinitionId": engine.state.workflow_definition_id(),
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

pub(super) fn validate_thread_metadata_patch(params: &ThreadMetadataUpdateParams) -> Result<()> {
    if params.title.is_unchanged()
        && params.model.is_unchanged()
        && params.archived_at.is_unchanged()
        && params.parent.is_unchanged()
    {
        anyhow::bail!("thread metadata update contains no changes")
    }
    validate_metadata_text("title", &params.title, 200)?;
    validate_metadata_text("model", &params.model, 256)?;
    validate_metadata_text("archivedAt", &params.archived_at, 128)?;
    Ok(())
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

pub(super) fn validate_metadata_text(
    field: &str,
    update: &MetadataUpdate<String>,
    max_chars: usize,
) -> Result<()> {
    let MetadataUpdate::Set(value) = update else {
        return Ok(());
    };
    if value.trim().is_empty() {
        anyhow::bail!("thread metadata {field} must not be empty; use null to clear it")
    }
    if value.chars().count() > max_chars {
        anyhow::bail!("thread metadata {field} exceeds {max_chars} characters")
    }
    if value.chars().any(char::is_control) {
        anyhow::bail!("thread metadata {field} contains control characters")
    }
    Ok(())
}

pub(super) fn validate_plain_metadata_text(
    field: &str,
    value: &str,
    max_chars: usize,
) -> Result<()> {
    if value.trim().is_empty() {
        anyhow::bail!("thread metadata {field} must not be empty")
    }
    if value.chars().count() > max_chars {
        anyhow::bail!("thread metadata {field} exceeds {max_chars} characters")
    }
    if value.chars().any(char::is_control) {
        anyhow::bail!("thread metadata {field} contains control characters")
    }
    Ok(())
}

pub(super) fn apply_metadata_update(
    fields: &mut BTreeMap<String, Option<String>>,
    field: &str,
    update: MetadataUpdate<String>,
) {
    match update {
        MetadataUpdate::Unchanged => {}
        MetadataUpdate::Set(value) => {
            fields.insert(field.to_string(), Some(value));
        }
        MetadataUpdate::Clear => {
            fields.insert(field.to_string(), None);
        }
    }
}

pub(super) fn apply_parent_metadata_update(
    fields: &mut BTreeMap<String, Option<String>>,
    update: MetadataUpdate<ThreadParent>,
) -> Result<()> {
    match update {
        MetadataUpdate::Unchanged => {}
        MetadataUpdate::Set(parent) => {
            fields.insert("parent".into(), Some(serde_json::to_string(&parent)?));
        }
        MetadataUpdate::Clear => {
            fields.insert("parent".into(), None);
        }
    }
    Ok(())
}

pub(super) fn canonical_workspace(engine: &QueryEngine) -> Result<String> {
    Ok(dunce::canonicalize(engine.state.cwd())?
        .to_string_lossy()
        .into_owned())
}

pub(super) fn acquire_thread_lifecycle_locks(
    engine: &QueryEngine,
    thread_ids: &[&str],
) -> Result<Vec<std::fs::File>> {
    acquire_thread_lifecycle_locks_at_root(&engine.client_storage_root(), thread_ids)
}

pub(super) fn acquire_thread_lifecycle_locks_at_root(
    root: &Path,
    thread_ids: &[&str],
) -> Result<Vec<std::fs::File>> {
    let mut thread_ids = thread_ids.to_vec();
    thread_ids.sort_unstable();
    thread_ids.dedup();
    for thread_id in &thread_ids {
        validate_thread_id(thread_id)?;
    }

    std::fs::create_dir_all(root)
        .with_context(|| format!("failed to create client storage root {}", root.display()))?;
    let root = std::fs::canonicalize(root)?;
    let lock_directory = root.join(THREAD_LIFECYCLE_LOCK_DIRECTORY);
    match std::fs::symlink_metadata(&lock_directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => anyhow::bail!(
            "thread lifecycle lock path is not a real directory: {}",
            lock_directory.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(&lock_directory) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(
                            &lock_directory,
                            std::fs::Permissions::from_mode(0o700),
                        )?;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    }
    let lock_directory = std::fs::canonicalize(&lock_directory)?;
    if lock_directory.parent() != Some(root.as_path()) {
        anyhow::bail!("thread lifecycle lock directory escapes the client storage root")
    }

    let mut locks = Vec::with_capacity(thread_ids.len());
    for thread_id in thread_ids {
        let path = lock_directory.join(format!("{thread_id}.lock"));
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let lock = options
            .open(&path)
            .with_context(|| format!("failed to open thread lifecycle lock {}", path.display()))?;
        if !lock.metadata()?.is_file() {
            anyhow::bail!(
                "thread lifecycle lock is not a regular file: {}",
                path.display()
            )
        }
        lock.lock_exclusive().with_context(|| {
            format!("failed to acquire thread lifecycle lock {}", path.display())
        })?;
        locks.push(lock);
    }
    Ok(locks)
}

pub(super) fn ensure_thread_metadata_directory(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<PathBuf> {
    let root = engine.client_storage_root();
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create client storage root {}", root.display()))?;
    let root = std::fs::canonicalize(&root)?;
    let directory = validated_thread_storage_dir(&root, thread_id)?;
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => anyhow::bail!(
            "thread metadata path is not a real directory: {}",
            directory.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(&directory) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(
                            &directory,
                            std::fs::Permissions::from_mode(0o700),
                        )?;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.file_type().is_dir() {
        anyhow::bail!(
            "thread metadata path is not a real directory: {}",
            directory.display()
        )
    }
    let resolved = std::fs::canonicalize(&directory)?;
    if resolved.parent() != Some(root.as_path()) {
        anyhow::bail!("thread metadata path escapes the client storage root")
    }
    Ok(resolved)
}

pub(super) fn thread_metadata_path(engine: &QueryEngine, thread_id: &str) -> Result<PathBuf> {
    candidate_thread_metadata_path(&engine.client_storage_root(), thread_id)
}

pub(super) fn candidate_thread_metadata_path(root: &Path, thread_id: &str) -> Result<PathBuf> {
    Ok(validated_thread_storage_dir(root, thread_id)?.join(THREAD_METADATA_FILE))
}

pub(super) fn validated_thread_storage_dir(root: &Path, thread_id: &str) -> Result<PathBuf> {
    validate_thread_id(thread_id)?;
    Ok(root.join(thread_id))
}

/// Persists the frozen session template binding into client thread metadata.
pub(super) fn record_thread_settings_template(
    engine: &QueryEngine,
    binding: &SettingsTemplateBinding,
) -> Result<()> {
    let thread_id = engine.session_id();
    let storage_dir = ensure_thread_metadata_directory(engine, &thread_id)?;
    let workspace = canonical_workspace(engine)?;
    {
        use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
        let mut fence = JournalFence::try_acquire(
            &engine.client_storage_root(),
            JournalDomain::ClientMetadata,
        )?;
        let mut metadata =
            read_thread_metadata(engine, &thread_id)?.unwrap_or_else(|| ThreadClientMetadata {
                version: 1,
                revision: 0,
                thread_id: thread_id.clone(),
                workspace: workspace.clone(),
                fields: BTreeMap::new(),
                updated_at: unix_millis_string(),
            });
        let encoded = serde_json::to_string(binding)?;
        if metadata.fields.get("settingsTemplate") != Some(&Some(encoded.clone())) {
            metadata
                .fields
                .insert("settingsTemplate".into(), Some(encoded));
            metadata.revision = metadata.revision.saturating_add(1);
            metadata.updated_at = unix_millis_string();
            write_thread_metadata(&storage_dir, &metadata, &mut fence)?;
        }
    }
    Ok(())
}

/// Overlay path for a thread's recorded settings template.
///
/// A deleted or unreadable template keeps the baseline settings so resume is
/// never blocked; the binding stays reported for drift/missing diagnostics.
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
) -> Option<PathBuf> {
    let binding = recorded_settings_template_binding(engine, thread_id)?;
    match config_templates::resolve_session_template(&binding.id) {
        Ok((path, _)) => Some(path),
        Err(error) => {
            tracing::warn!(
                thread_id,
                template = %binding.id,
                %error,
                "recorded settings template is unavailable; resuming with baseline settings"
            );
            None
        }
    }
}

pub(super) fn read_thread_metadata(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<Option<ThreadClientMetadata>> {
    let path = thread_metadata_path(engine, thread_id)?;
    let file_metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !file_metadata.file_type().is_file() || file_metadata.len() > MAX_THREAD_METADATA_BYTES {
        anyhow::bail!("thread metadata file is invalid: {}", path.display())
    }
    let metadata: ThreadClientMetadata = serde_json::from_slice(&std::fs::read(&path)?)?;
    if metadata.version != 1 || metadata.thread_id != thread_id {
        anyhow::bail!("thread metadata identity does not match its session")
    }
    if !same_workspace_form(&metadata.workspace, &canonical_workspace(engine)?) {
        anyhow::bail!("thread metadata belongs to another workspace")
    }
    Ok(Some(metadata))
}

/// Workspace identity must survive path-form drift: older builds stamped the
/// verbatim (`\\?\`) or otherwise non-canonical form of the same directory, and
/// a plain string comparison then rejected every legacy thread as foreign —
/// each one permanently inflating the history-index issue count.
pub(super) fn same_workspace_form(stored: &str, current: &str) -> bool {
    if stored == current {
        return true;
    }
    match (
        dunce::canonicalize(Path::new(stored)),
        dunce::canonicalize(Path::new(current)),
    ) {
        (Ok(stored), Ok(current)) => stored == current,
        _ => false,
    }
}

pub(super) fn write_thread_metadata(
    directory: &Path,
    metadata: &ThreadClientMetadata,
    fence: &mut kcoder_state::history_index::journal::JournalFence,
) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(metadata)?;
    if bytes.len() as u64 > MAX_THREAD_METADATA_BYTES {
        anyhow::bail!("thread metadata exceeds 64 KiB")
    }
    let target = directory.join(THREAD_METADATA_FILE);
    if let Ok(existing) = std::fs::symlink_metadata(&target)
        && !existing.file_type().is_file()
    {
        anyhow::bail!("thread metadata target is not a regular file")
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(&bytes)?;
    temporary.as_file_mut().sync_all()?;
    let mutation = fence.begin(&metadata.thread_id)?;
    temporary.persist(&target).map_err(|error| error.error)?;
    // Authority is already committed; a failed tracking receipt must never replay it.
    if let Err(error) = mutation.finish() {
        tracing::warn!(%error, thread_id = %metadata.thread_id, "client metadata committed but journal completion failed");
    }
    Ok(())
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

pub(super) fn decorate_thread_snapshot_with_metadata(
    snapshot: &mut Value,
    stored: Option<&ThreadClientMetadata>,
    strict: bool,
) -> Result<()> {
    let thread_id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let Some(object) = snapshot.as_object_mut() else {
        return Ok(());
    };
    if let Some(metadata) = stored.as_ref() {
        for field in ["title", "model", "archivedAt"] {
            let Some(value) = metadata.fields.get(field) else {
                continue;
            };
            match value {
                Some(value) => {
                    object.insert(field.to_string(), Value::String(value.clone()));
                }
                None => {
                    object.remove(field);
                }
            }
        }
        if let Some(value) = metadata.fields.get("settingsTemplate") {
            match value {
                Some(value) => match serde_json::from_str::<SettingsTemplateBinding>(value) {
                    Ok(binding) => {
                        object.insert(
                            "settingsTemplate".into(),
                            serde_json::to_value(binding)
                                .expect("settings template binding serializes"),
                        );
                    }
                    Err(error) if strict => return Err(error.into()),
                    Err(error) => {
                        tracing::warn!(
                            thread_id,
                            %error,
                            "ignoring invalid stored settings template binding"
                        );
                        object.remove("settingsTemplate");
                    }
                },
                None => {
                    object.remove("settingsTemplate");
                }
            }
        }
        if let Some(value) = metadata.fields.get("parent") {
            match value {
                Some(value) => match serde_json::from_str::<ThreadParent>(value) {
                    Ok(parent) => {
                        object.insert("parent".into(), serde_json::to_value(parent).unwrap());
                    }
                    Err(error) if strict => return Err(error.into()),
                    Err(error) => {
                        tracing::warn!(thread_id, %error, "ignoring invalid stored thread parent");
                        object.remove("parent");
                    }
                },
                None => {
                    object.remove("parent");
                }
            }
        }
        let should_update = object
            .get("updatedAt")
            .and_then(Value::as_str)
            .is_none_or(|current| {
                metadata.updated_at.parse::<u64>().unwrap_or_default()
                    > current.parse::<u64>().unwrap_or_default()
            });
        if should_update {
            object.insert(
                "updatedAt".into(),
                Value::String(metadata.updated_at.clone()),
            );
        }
    }
    let authoritative = ThreadMetadata {
        workflow_definition_id: object
            .get("workflowDefinitionId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        schema: THREAD_METADATA_SCHEMA.into(),
        version: 1,
        revision: stored.as_ref().map_or(0, |metadata| metadata.revision),
        title: object
            .get("title")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        model: object
            .get("model")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        archived_at: object
            .get("archivedAt")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        parent: object
            .get("parent")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
    };
    object.insert(
        "metadata".into(),
        serde_json::to_value(authoritative).expect("thread metadata serializes"),
    );
    Ok(())
}

pub(super) fn unix_millis_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
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

/// History directories to scan for persisted threads: the authoritative one
/// first, then Windows compat roots derived from `project_data_dirs_for_read`
/// (pre-canonicalization builds persisted sessions under verbatim-derived keys).
pub(super) fn history_scan_roots(
    history_dir: &Path,
    project_dir: &Path,
    compat_project_dirs: &[PathBuf],
) -> Vec<PathBuf> {
    let mut roots = vec![history_dir.to_path_buf()];
    let Ok(relative) = history_dir.strip_prefix(project_dir) else {
        return roots;
    };
    for candidate in compat_project_dirs {
        // The legacy verbatim-derived key keeps its `?` after the separator
        // replacement; such a name can never be a real Windows directory, and
        // scanning it fails with ERROR_INVALID_NAME (os error 123) instead of
        // NotFound. Skip roots that cannot exist on any filesystem.
        if !scan_root_can_exist(candidate) {
            continue;
        }
        let dir = candidate.join(relative);
        if !roots.contains(&dir) {
            roots.push(dir);
        }
    }
    roots
}

/// True when the path could name a real directory: Windows path components
/// cannot contain `? * < > | "`, and no KCoder-generated key form embeds them
/// elsewhere.
pub(super) fn scan_root_can_exist(root: &Path) -> bool {
    !root
        .to_string_lossy()
        .chars()
        .any(|c| matches!(c, '?' | '*' | '<' | '>' | '|' | '"'))
}

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
        // Empty files are pre-transcript placeholders, not persisted conversations.
        // Do not infer visibility from the possibly compacted model message count.
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
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
