//! Workspace registry: extracted from the app-server connection boundary.

use super::*;

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
    pub(super) fn new(engine: &QueryEngine) -> Self {
        let base = engine
            .client_storage_root()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| engine.client_storage_root());
        Self {
            state_path: base.join("managed-worktrees.json"),
            lock_path: base.join("managed-worktrees.lock"),
            default_root: base.join("managed-worktrees"),
        }
    }

    pub(super) fn lock(&self) -> Result<std::fs::File> {
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

    pub(super) fn load(&self) -> Result<ClientWorktreeState> {
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
        if state.version > 2 {
            anyhow::bail!(
                "managed worktree registry version {} is newer than supported version 2",
                state.version
            )
        }
        state.version = 2;
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
        Ok(())
    }

    pub(super) fn save(&self, state: &ClientWorktreeState) -> Result<()> {
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

    pub(super) fn open_workspace_runtime_lease(&self, workspace: &Path) -> Result<std::fs::File> {
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

pub(super) fn safe_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path.parent().is_some()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
}

pub(super) fn valid_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn acquire_app_server_workspace_runtime_lease(
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
    pub(super) fn new(engine: &QueryEngine) -> Self {
        let base = engine
            .client_storage_root()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| engine.client_storage_root());
        Self {
            state_path: base.join("client-workspaces.json"),
            lock_path: base.join("client-workspaces.lock"),
        }
    }

    pub(super) fn lock(&self) -> Result<std::fs::File> {
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

    pub(super) fn load(&self) -> ClientWorkspaceState {
        let mut state: ClientWorkspaceState = std::fs::read(&self.state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        state.version = 1;
        state
    }

    pub(super) fn save(&self, state: &ClientWorkspaceState) -> Result<()> {
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

impl Drop for SessionLease {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self._file);
    }
}

impl SessionLease {
    pub(super) fn acquire(session_target: &Path) -> Result<Self> {
        Self::open(session_target, true)
    }

    pub(super) fn open(session_target: &Path, create: bool) -> Result<Self> {
        let lease_path = session_target.with_extension("lease");
        if create && let Some(parent) = lease_path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create session lease directory {}",
                    parent.display()
                )
            })?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(create).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options
            .open(&lease_path)
            .with_context(|| format!("failed to open session lease {}", lease_path.display()))?;
        if !file.metadata()?.is_file() {
            anyhow::bail!(
                "session lease is not a regular file: {}",
                lease_path.display()
            )
        }
        file.try_lock_exclusive().with_context(|| {
            format!(
                "session is already active in another app-server: {}",
                session_target.display()
            )
        })?;
        Ok(Self {
            _file: file,
            session_target: session_target.to_path_buf(),
        })
    }

    pub(super) fn matches_engine(&self, engine: &QueryEngine) -> bool {
        engine.session_lease_target() == self.session_target
    }

    pub(super) fn acquire_existing_history(history_path: &Path) -> Result<Self> {
        let lease_path = history_path.with_extension("lease");
        match std::fs::symlink_metadata(&lease_path) {
            Ok(_) => return Self::open(history_path, false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to inspect session lease {}", lease_path.display())
                });
            }
        }
        let metadata = std::fs::symlink_metadata(history_path)
            .with_context(|| format!("persisted thread not found: {}", history_path.display()))?;
        if !metadata.file_type().is_file() {
            anyhow::bail!(
                "persisted thread is not a regular file: {}",
                history_path.display()
            )
        }
        Self::acquire(history_path)
    }
}
