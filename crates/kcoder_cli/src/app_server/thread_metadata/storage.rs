//! Persisted thread metadata and lifecycle fences, independent of the resident Engine.

use anyhow::{Context, Result};
use fs2::FileExt;
use kcoder_app_protocol::{
    MetadataUpdate, SettingsTemplateBinding, THREAD_METADATA_SCHEMA, ThreadMetadata,
    ThreadMetadataUpdateParams, ThreadParent,
};
use kcoder_workspace_resources::managed_worktrees::validate_thread_id;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_THREAD_METADATA_BYTES: u64 = 64 * 1024;
pub const THREAD_METADATA_FILE: &str = "thread-metadata.json";
const THREAD_LIFECYCLE_LOCK_DIRECTORY: &str = ".thread-lifecycle-locks";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadClientMetadata {
    pub version: u8,
    #[serde(default)]
    pub revision: u64,
    pub thread_id: String,
    pub workspace: String,
    #[serde(default)]
    pub fields: BTreeMap<String, Option<String>>,
    pub updated_at: String,
}

pub fn validate_thread_metadata_patch(params: &ThreadMetadataUpdateParams) -> Result<()> {
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

pub fn validate_metadata_text(
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

pub fn validate_plain_metadata_text(field: &str, value: &str, max_chars: usize) -> Result<()> {
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

pub fn apply_metadata_update(
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

pub fn apply_parent_metadata_update(
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

pub fn canonical_workspace(workspace: &Path) -> Result<String> {
    Ok(dunce::canonicalize(workspace)?
        .to_string_lossy()
        .into_owned())
}

pub fn acquire_thread_lifecycle_locks_at_root(
    root: &Path,
    thread_ids: &[&str],
) -> Result<Vec<std::fs::File>> {
    acquire_thread_lifecycle_locks_with_mode(root, thread_ids, false)
}

pub fn try_acquire_thread_lifecycle_locks_at_root(
    root: &Path,
    thread_ids: &[&str],
) -> Result<Vec<std::fs::File>> {
    acquire_thread_lifecycle_locks_with_mode(root, thread_ids, true)
}

fn acquire_thread_lifecycle_locks_with_mode(
    root: &Path,
    thread_ids: &[&str],
    nonblocking: bool,
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
        if nonblocking {
            lock.try_lock_exclusive()
                .context("CHAT_TASK_LIFECYCLE_BUSY")?;
        } else {
            lock.lock_exclusive().with_context(|| {
                format!("failed to acquire thread lifecycle lock {}", path.display())
            })?;
        }
        locks.push(lock);
    }
    Ok(locks)
}

pub fn ensure_thread_metadata_directory(root: &Path, thread_id: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(root)
        .with_context(|| format!("failed to create client storage root {}", root.display()))?;
    let root = std::fs::canonicalize(root)?;
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

pub fn candidate_thread_metadata_path(root: &Path, thread_id: &str) -> Result<PathBuf> {
    Ok(validated_thread_storage_dir(root, thread_id)?.join(THREAD_METADATA_FILE))
}

pub fn validated_thread_storage_dir(root: &Path, thread_id: &str) -> Result<PathBuf> {
    validate_thread_id(thread_id)?;
    Ok(root.join(thread_id))
}

pub fn read_thread_metadata(
    root: &Path,
    workspace: &Path,
    thread_id: &str,
) -> Result<Option<ThreadClientMetadata>> {
    let path = candidate_thread_metadata_path(root, thread_id)?;
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
    if !same_workspace_form(&metadata.workspace, &canonical_workspace(workspace)?) {
        anyhow::bail!("thread metadata belongs to another workspace")
    }
    Ok(Some(metadata))
}

/// Workspace identity must survive path-form drift: older builds stamped the
/// verbatim (`\\?\`) or otherwise non-canonical form of the same directory, and
/// a plain string comparison then rejected every legacy thread as foreign —
/// each one permanently inflating the history-index issue count.
pub fn same_workspace_form(stored: &str, current: &str) -> bool {
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

pub fn write_thread_metadata(
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

pub fn decorate_thread_snapshot_with_metadata(
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

pub fn unix_millis_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
    use serde_json::json;

    #[test]
    fn legacy_metadata_updates_without_losing_unknown_fields() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let thread_id = "legacy-thread";
        let directory = ensure_thread_metadata_directory(root.path(), thread_id).unwrap();
        let file = candidate_thread_metadata_path(root.path(), thread_id).unwrap();
        std::fs::write(
            &file,
            serde_json::to_vec(&json!({
                "version": 1,
                "thread_id": thread_id,
                "workspace": canonical_workspace(workspace.path()).unwrap(),
                "fields": {"title": "Saved", "futureField": "retained"},
                "updated_at": "1"
            }))
            .unwrap(),
        )
        .unwrap();
        let mut stored = read_thread_metadata(root.path(), workspace.path(), thread_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.revision, 0);
        stored.revision = 1;
        let mut fence =
            JournalFence::try_acquire(root.path(), JournalDomain::ClientMetadata).unwrap();
        write_thread_metadata(&directory, &stored, &mut fence).unwrap();

        let reread = read_thread_metadata(root.path(), workspace.path(), thread_id)
            .unwrap()
            .unwrap();
        assert_eq!(reread.revision, 1);
        assert_eq!(
            reread.fields.get("futureField").and_then(Option::as_deref),
            Some("retained")
        );
        let mut snapshot = json!({"id": thread_id});
        decorate_thread_snapshot_with_metadata(&mut snapshot, Some(&reread), true).unwrap();
        assert_eq!(snapshot["title"], "Saved");
        assert_eq!(snapshot["metadata"]["revision"], 1);
        assert!(read_thread_metadata(root.path(), root.path(), thread_id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn lifecycle_lock_rejects_contention_and_can_be_reacquired() {
        let root = tempfile::tempdir().unwrap();
        let locks = acquire_thread_lifecycle_locks_at_root(root.path(), &["b", "a", "a"]).unwrap();
        assert_eq!(locks.len(), 2);
        let error = try_acquire_thread_lifecycle_locks_at_root(root.path(), &["a"]).unwrap_err();
        assert_eq!(error.to_string(), "CHAT_TASK_LIFECYCLE_BUSY");
        drop(locks);
        assert_eq!(
            try_acquire_thread_lifecycle_locks_at_root(root.path(), &["a"])
                .unwrap()
                .len(),
            1
        );
    }
}

#[path = "../../internal/thread_metadata/goal_batch.rs"]
pub mod goal_batch;
#[path = "../../internal/thread_metadata/presence.rs"]
pub mod presence;

/// History directories to scan for persisted threads: the authoritative one
/// first, then Windows compat roots derived from `project_data_dirs_for_read`
/// (pre-canonicalization builds persisted sessions under verbatim-derived keys).
pub fn history_scan_roots(
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
fn scan_root_can_exist(root: &Path) -> bool {
    !root
        .to_string_lossy()
        .chars()
        .any(|c| matches!(c, '?' | '*' | '<' | '>' | '|' | '"'))
}

#[path = "../history_catalog.rs"]
pub mod history_catalog;
