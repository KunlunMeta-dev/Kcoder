use super::*;
use fs2::FileExt;
use std::{io::Write, path::Component};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ClientWorktreeSettings {
    pub worktree_root: String,
    pub resolved_worktree_root: String,
    pub auto_cleanup_enabled: bool,
    pub keep_count: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClientManagedWorktree {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comparison: Option<kcoder_app_protocol::TaskComparisonBinding>,
    pub worktree_id: String,
    pub path: String,
    pub repository_name: String,
    pub source_path: Option<String>,
    pub permanent: bool,
    pub revision: u64,
    pub base_commit: Option<String>,
    pub lease_key: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub snapshot_ref: Option<String>,
    pub snapshot_commit: Option<String>,
    pub snapshot_at: Option<u64>,
    pub git_common_dir: Option<String>,
    pub archived_conversations: Vec<ClientWorktreeConversation>,
    pub state: String,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClientWorktreeConversation {
    pub device_id: String,
    pub task_id: String,
    pub thread_id: String,
    pub workspace_path: String,
    pub title: String,
    pub model: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

pub(crate) struct ClientWorktreeSnapshot {
    pub(crate) reference: String,
    pub(crate) commit: String,
    pub(crate) git_common_dir: String,
    pub(crate) created_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientWorktreeArchivePreview {
    pub(crate) path: String,
    pub(crate) state: String,
    pub(crate) revision: u64,
    pub(crate) content_token: Option<String>,
    pub(crate) dirty: bool,
    pub(crate) untracked_file_count: usize,
    pub(crate) ignored_entry_count: usize,
    pub(crate) dirty_submodule_count: usize,
    pub(crate) nested_repository_count: usize,
    pub(crate) baseline_known: bool,
    pub(crate) commits_since_creation: Option<u64>,
    pub(crate) requires_confirmation: bool,
    pub(crate) archive_allowed: bool,
    pub(crate) blocking_reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClientWorktreeState {
    pub version: u64,
    pub(crate) settings: ClientWorktreeSettings,
    pub records: BTreeMap<String, ClientManagedWorktree>,
}

pub struct ClientWorktreeStore {
    pub(crate) state_path: PathBuf,
    pub(crate) lock_path: PathBuf,
    pub(crate) default_root: PathBuf,
}

/// The app-server holds a shared workspace lease for its full lifetime. Worktree
/// archival must first obtain an exclusive lease on the same path so one process
/// cannot delete a working directory still used by another client.
pub struct WorkspaceRuntimeLease {
    pub(crate) _file: std::fs::File,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClientWorkspaceRecord {
    pub workspace_path: String,
    pub label: String,
    pub project_key: String,
    pub roots: Vec<String>,
    pub pinned: bool,
    pub pinned_order: Option<usize>,
    pub appearance: Value,
    pub active: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClientWorkspaceState {
    pub version: u64,
    pub root_project_pinned: Option<bool>,
    pub project_order: Vec<String>,
    pub records: BTreeMap<String, ClientWorkspaceRecord>,
    pub pinned_tasks: Vec<String>,
    pub task_orders: BTreeMap<String, Vec<String>>,
}

pub struct ClientWorkspaceStore {
    pub(crate) state_path: PathBuf,
    pub(crate) lock_path: PathBuf,
}

impl Default for ClientWorktreeSettings {
    fn default() -> Self {
        Self {
            worktree_root: String::new(),
            resolved_worktree_root: String::new(),
            auto_cleanup_enabled: true,
            keep_count: 15,
        }
    }
}

impl ClientWorktreeStore {
    pub fn from_client_storage_root(root: PathBuf, durable: bool) -> Self {
        // Ephemeral owners must not share their parent's durable registry.
        let base = if durable {
            root.parent().map(Path::to_path_buf).unwrap_or(root)
        } else {
            root.join("client-registry")
        };
        Self {
            state_path: base.join("managed-worktrees.json"),
            lock_path: base.join("managed-worktrees.lock"),
            default_root: base.join("managed-worktrees"),
        }
    }

    pub fn lock(&self) -> Result<std::fs::File> {
        if let Some(parent) = self.lock_path.parent() {
            std::fs::create_dir_all(parent).context("failed to create worktree state directory")?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options
            .open(&self.lock_path)
            .context("failed to open worktree state lock file")?;
        if !file
            .metadata()
            .context("failed to inspect worktree state lock file")?
            .is_file()
        {
            anyhow::bail!("worktree state lock is not a regular file")
        }
        file.try_lock_exclusive()
            .context("worktree state is busy in another app-server")?;
        Ok(file)
    }

    pub fn load(&self) -> Result<ClientWorktreeState> {
        match std::fs::symlink_metadata(&self.state_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                anyhow::bail!("managed worktree registry is not a regular file")
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("failed to inspect managed worktree registry"),
        }
        let mut state: ClientWorktreeState = match std::fs::read(&self.state_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| {
                format!(
                    "managed worktree registry is invalid: {}",
                    self.state_path.display()
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "failed to read managed worktree registry {}",
                        self.state_path.display()
                    )
                });
            }
        };
        if state.version > 3 {
            anyhow::bail!(
                "managed worktree registry version {} is newer than supported version 3",
                state.version
            )
        }
        state.version = if state.version == 3
            || state
                .records
                .values()
                .any(|record| record.comparison.is_some())
        {
            3
        } else {
            2
        };
        if state.settings.resolved_worktree_root.is_empty() {
            state.settings.resolved_worktree_root =
                self.default_root.to_string_lossy().into_owned();
        }
        self.validate_state(&mut state)?;
        Ok(state)
    }

    pub(super) fn validate_state(&self, state: &mut ClientWorktreeState) -> Result<()> {
        let root = Path::new(&state.settings.resolved_worktree_root);
        if !safe_absolute_path(root) {
            anyhow::bail!("managed worktree registry has an unsafe root")
        }
        for (key, record) in &mut state.records {
            if key != &record.path {
                anyhow::bail!("managed worktree registry key does not match its path")
            }
            let path = Path::new(&record.path);
            if !safe_absolute_path(path) || !path.starts_with(root) || path == root {
                anyhow::bail!("managed worktree registry contains a path outside its managed root")
            }
            validate_worktree_id(&record.worktree_id)
                .context("managed worktree registry contains an invalid worktree id")?;
            let expected_lease_key = hex_sha256(record.path.as_bytes());
            if record.lease_key.is_empty() {
                record.lease_key = expected_lease_key.clone();
            } else if record.lease_key != expected_lease_key {
                anyhow::bail!("managed worktree registry contains an invalid lease key")
            }
            let expected_snapshot_ref = format!(
                "refs/kcoder/worktree-snapshots/{}",
                hex_sha256(record.path.as_bytes())
            );
            if record
                .snapshot_ref
                .as_deref()
                .is_some_and(|reference| reference != expected_snapshot_ref)
            {
                anyhow::bail!("managed worktree registry contains an invalid snapshot ref")
            }
            if record
                .snapshot_commit
                .as_deref()
                .is_some_and(|commit| !valid_git_object_id(commit))
                || record
                    .base_commit
                    .as_deref()
                    .is_some_and(|commit| !valid_git_object_id(commit))
            {
                anyhow::bail!("managed worktree registry contains an invalid Git object id")
            }
            if record
                .source_path
                .as_deref()
                .is_some_and(|source| !safe_absolute_path(Path::new(source)))
                || record
                    .git_common_dir
                    .as_deref()
                    .is_some_and(|common| !safe_absolute_path(Path::new(common)))
            {
                anyhow::bail!("managed worktree registry contains an unsafe repository path")
            }
            if !matches!(
                record.state.as_str(),
                "active" | "snapshot_ready" | "restorable" | "restoring" | "missing" | "deleted"
            ) {
                anyhow::bail!("managed worktree registry contains an invalid lifecycle state")
            }
            if matches!(
                record.state.as_str(),
                "snapshot_ready" | "restorable" | "restoring"
            ) && (record.snapshot_ref.is_none()
                || record.snapshot_commit.is_none()
                || record.git_common_dir.is_none()
                || record.source_path.is_none())
            {
                anyhow::bail!("managed worktree registry contains an incomplete snapshot state")
            }
            if record
                .archived_conversations
                .iter()
                .any(|conversation| conversation.workspace_path != record.path)
            {
                anyhow::bail!("managed worktree registry contains a mismatched conversation")
            }
        }
        crate::managed_worktrees::comparison::validate_comparison_registry(state)?;
        Ok(())
    }

    pub fn save(&self, state: &ClientWorktreeState) -> Result<()> {
        (|| -> Result<()> {
            let parent = self
                .state_path
                .parent()
                .context("worktree state directory is missing")?;
            std::fs::create_dir_all(parent).context("failed to create worktree state directory")?;
            // Use an exclusive temporary file and clean it up if replacement fails.
            let mut temporary = tempfile::Builder::new()
                .prefix("managed-worktrees-")
                .suffix(".tmp")
                .tempfile_in(parent)
                .context("failed to create temporary worktree state file")?;
            temporary
                .write_all(&serde_json::to_vec_pretty(state)?)
                .context("failed to write worktree state file")?;
            temporary
                .as_file()
                .sync_all()
                .context("failed to flush worktree state file")?;
            let persisted = temporary
                .persist(&self.state_path)
                .map_err(|error| error.error)
                .context("failed to replace worktree state file")?;
            drop(persisted);
            // Windows cannot open directories as ordinary files or fsync them.
            // Keep the directory durability barrier on Unix without changing ACLs.
            #[cfg(unix)]
            std::fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .context("failed to flush worktree state directory")?;
            Ok(())
        })()
        .context("failed to save worktree state")
    }

    pub(super) fn workspace_runtime_lease_path(&self, workspace: &Path) -> Result<PathBuf> {
        let canonical = std::fs::canonicalize(workspace).with_context(|| {
            format!(
                "failed to resolve workspace runtime lease path {}",
                workspace.display()
            )
        })?;
        self.workspace_runtime_lease_path_for_key(&hex_sha256(
            canonical.to_string_lossy().as_bytes(),
        ))
    }

    pub(super) fn workspace_runtime_lease_path_for_key(&self, lease_key: &str) -> Result<PathBuf> {
        if lease_key.len() != 64 || !lease_key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            anyhow::bail!("managed worktree lease key is invalid")
        }
        Ok(kcoder_config::Settings::config_dir()?
            .join("workspace-runtime-leases")
            .join(format!("{lease_key}.lock")))
    }

    pub fn open_workspace_runtime_lease(&self, workspace: &Path) -> Result<std::fs::File> {
        let path = self.workspace_runtime_lease_path(workspace)?;
        std::fs::create_dir_all(
            path.parent()
                .context("workspace lease directory is missing")?,
        )?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options.open(&path)?;
        if !file.metadata()?.is_file() {
            anyhow::bail!("workspace runtime lease is not a regular file")
        }
        Ok(file)
    }

    pub(super) fn acquire_workspace_archive_lease(
        &self,
        workspace: &Path,
    ) -> Result<std::fs::File> {
        let file = self.open_workspace_runtime_lease(workspace)?;
        FileExt::try_lock_exclusive(&file).with_context(|| {
            format!(
                "workspace is active in another app-server: {}",
                workspace.display()
            )
        })?;
        Ok(file)
    }

    pub(super) fn acquire_workspace_archive_lease_by_key(
        &self,
        lease_key: &str,
    ) -> Result<std::fs::File> {
        let path = self.workspace_runtime_lease_path_for_key(lease_key)?;
        std::fs::create_dir_all(
            path.parent()
                .context("workspace lease directory is missing")?,
        )?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options.open(&path)?;
        if !file.metadata()?.is_file() {
            anyhow::bail!("workspace runtime lease is not a regular file")
        }
        FileExt::try_lock_exclusive(&file).context("workspace is active in another app-server")?;
        Ok(file)
    }
}

pub fn safe_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path.parent().is_some()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
}

pub fn valid_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn acquire_app_server_workspace_runtime_lease(
    workspace: &Path,
) -> Result<WorkspaceRuntimeLease> {
    let canonical = std::fs::canonicalize(workspace).with_context(|| {
        format!(
            "failed to resolve app-server workspace {}",
            workspace.display()
        )
    })?;
    let directory = kcoder_config::Settings::config_dir()?.join("workspace-runtime-leases");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!(
        "{}.lock",
        hex_sha256(canonical.to_string_lossy().as_bytes())
    ));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(&path)?;
    if !file.metadata()?.is_file() {
        anyhow::bail!("workspace runtime lease is not a regular file")
    }
    FileExt::try_lock_shared(&file)
        .with_context(|| format!("workspace is being archived: {}", workspace.display()))?;
    Ok(WorkspaceRuntimeLease { _file: file })
}

impl ClientWorkspaceStore {
    pub fn storage_path(&self) -> &Path {
        &self.state_path
    }

    pub fn from_client_storage_root(root: PathBuf) -> Self {
        let base = root.parent().map(Path::to_path_buf).unwrap_or(root);
        Self {
            state_path: base.join("client-workspaces.json"),
            lock_path: base.join("client-workspaces.lock"),
        }
    }

    pub fn lock(&self) -> Result<std::fs::File> {
        if let Some(parent) = self.lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options.open(&self.lock_path)?;
        if !file.metadata()?.is_file() {
            anyhow::bail!("workspace state lock is not a regular file")
        }
        // Brief cross-process writes (or a fork before exec closes inherited handles)
        // must not turn an ordinary sidebar update into a spurious failure.
        let deadline = std::time::Instant::now() + Duration::from_millis(100);
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => break,
                Err(error)
                    if error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(error) => {
                    return Err(error).context("workspace state is busy in another app-server");
                }
            }
        }
        Ok(file)
    }

    pub fn load(&self) -> ClientWorkspaceState {
        let mut state: ClientWorkspaceState = std::fs::read(&self.state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        state.version = 1;
        state
    }

    pub fn save(&self, state: &ClientWorkspaceState) -> Result<()> {
        let parent = self
            .state_path
            .parent()
            .context("workspace state directory is missing")?;
        std::fs::create_dir_all(parent)?;
        let temporary = parent.join(format!("client-workspaces-{}.tmp", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(state)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &self.state_path)?;
        Ok(())
    }
}
