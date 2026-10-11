//! Select ready shell snapshots and keep secure private copies alive for the child.

use super::*;

pub(super) const MAX_ISOLATED_SHELL_SNAPSHOT_BYTES: u64 = 1024 * 1024;

pub(super) struct PreparedShellSnapshot {
    pub(super) path: PathBuf,
    pub(super) temporary: Option<tempfile::NamedTempFile>,
}

pub(super) struct ShellSnapshotSelection {
    pub(super) path: Option<PathBuf>,
    pub(super) requires_private_copy: bool,
}

pub(super) fn select_shell_snapshot(
    snapshot: Option<&crate::ShellEnvironmentSnapshot>,
    verifier_isolation: bool,
    os_sandbox: Option<&crate::os_sandbox::OsSandboxSpec>,
) -> Result<ShellSnapshotSelection, ToolError> {
    let Some(snapshot) = snapshot else {
        return Ok(ShellSnapshotSelection {
            path: None,
            requires_private_copy: false,
        });
    };
    if verifier_isolation {
        return Ok(ShellSnapshotSelection {
            path: snapshot.verifier_ready_path(),
            requires_private_copy: false,
        });
    }

    let ready = snapshot.ready_path();
    if !shell_snapshot_is_denied(ready.as_deref(), os_sandbox)? {
        return Ok(ShellSnapshotSelection {
            path: ready,
            requires_private_copy: false,
        });
    }

    let path = snapshot.sandbox_ready_path().ok_or_else(|| {
        ToolError::Execution(
            "full shell snapshot is denied by the OS sandbox but its sanitized task-runtime snapshot is unavailable"
                .to_string(),
        )
    })?;
    Ok(ShellSnapshotSelection {
        path: Some(path),
        requires_private_copy: true,
    })
}

pub(super) fn shell_snapshot_is_denied(
    snapshot_path: Option<&Path>,
    os_sandbox: Option<&crate::os_sandbox::OsSandboxSpec>,
) -> Result<bool, ToolError> {
    let (Some(snapshot_path), Some(os_sandbox)) = (snapshot_path, os_sandbox) else {
        return Ok(false);
    };
    let snapshot_path = snapshot_path.canonicalize().map_err(|error| {
        ToolError::Execution(format!(
            "failed to resolve shell snapshot `{}`: {error}",
            snapshot_path.display()
        ))
    })?;
    Ok(os_sandbox.deny_read.iter().any(|denied| {
        let denied = denied.canonicalize().unwrap_or_else(|_| denied.clone());
        snapshot_path.starts_with(denied)
    }))
}

pub(super) fn ordinary_shell_snapshot_copy_root(
    copy_required: bool,
    cwd: &Path,
    os_sandbox: Option<&crate::os_sandbox::OsSandboxSpec>,
    temp_root: Option<&OsStr>,
) -> Result<Option<PathBuf>, ToolError> {
    if !copy_required {
        return Ok(None);
    }
    let os_sandbox = os_sandbox.ok_or_else(|| {
        ToolError::Execution(
            "private shell snapshot copy requested without an OS sandbox".to_string(),
        )
    })?;

    let declared_temp_root = temp_root.map(PathBuf::from).ok_or_else(|| {
        ToolError::Execution(
            "shell snapshot is denied by the OS sandbox and no private TMPDIR is available"
                .to_string(),
        )
    })?;
    if !declared_temp_root.is_absolute() {
        return Err(ToolError::Execution(
            "private shell snapshot TMPDIR must be absolute".to_string(),
        ));
    }
    let metadata = std::fs::symlink_metadata(&declared_temp_root).map_err(|error| {
        ToolError::Execution(format!(
            "failed to inspect private shell snapshot directory `{}`: {error}",
            declared_temp_root.display()
        ))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ToolError::Execution(format!(
            "private shell snapshot directory must be an ordinary directory: `{}`",
            declared_temp_root.display()
        )));
    }
    let temp_root = declared_temp_root.canonicalize().map_err(|error| {
        ToolError::Execution(format!(
            "failed to resolve private shell snapshot directory: {error}"
        ))
    })?;
    if temp_root != declared_temp_root {
        return Err(ToolError::Execution(format!(
            "private shell snapshot directory must not contain symlinked or non-canonical components: `{}`",
            declared_temp_root.display()
        )));
    }
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    if temp_root.starts_with(&cwd) || cwd.starts_with(&temp_root) {
        return Err(ToolError::Execution(
            "private shell snapshot directory must be disjoint from the workspace".to_string(),
        ));
    }
    let explicitly_writable = os_sandbox.rw_paths.iter().any(|path| {
        path.canonicalize()
            .is_ok_and(|resolved| resolved == temp_root)
    });
    if !explicitly_writable {
        return Err(ToolError::Execution(format!(
            "private shell snapshot directory is not an explicit sandbox write root: `{}`",
            temp_root.display()
        )));
    }
    let inaccessible = os_sandbox
        .deny_read
        .iter()
        .chain(&os_sandbox.readonly_paths)
        .any(|path| {
            let path = path.canonicalize().unwrap_or_else(|_| path.clone());
            temp_root.starts_with(path)
        });
    if inaccessible {
        return Err(ToolError::Execution(format!(
            "private shell snapshot directory is denied or read-only: `{}`",
            temp_root.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(ToolError::Execution(format!(
                "private shell snapshot directory must be owned by the current user and user-only: `{}`",
                temp_root.display()
            )));
        }
    }
    Ok(Some(temp_root))
}

pub(super) fn shell_snapshot_for_spawn(
    snapshot_path: Option<&Path>,
    isolation_root: Option<&Path>,
) -> Result<Option<PreparedShellSnapshot>, ToolError> {
    let Some(snapshot_path) = snapshot_path else {
        return Ok(None);
    };
    let Some(copy_root) = isolation_root else {
        return Ok(Some(PreparedShellSnapshot {
            path: snapshot_path.to_path_buf(),
            temporary: None,
        }));
    };

    let metadata = std::fs::symlink_metadata(snapshot_path).map_err(|error| {
        ToolError::Execution(format!(
            "failed to inspect shell snapshot `{}`: {error}",
            snapshot_path.display()
        ))
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ToolError::Execution(format!(
            "shell snapshot must be a regular non-symlink file: `{}`",
            snapshot_path.display()
        )));
    }
    if metadata.len() > MAX_ISOLATED_SHELL_SNAPSHOT_BYTES {
        return Err(ToolError::Execution(format!(
            "shell snapshot exceeds {} bytes: `{}`",
            MAX_ISOLATED_SHELL_SNAPSHOT_BYTES,
            snapshot_path.display()
        )));
    }

    // A Landlock deny list may cover the configuration directory containing the
    // snapshot. Before applying the sandbox, copy it to a randomized O_EXCL tempfile
    // under the trusted private runtime root. Every invocation receives a new copy,
    // so a child that modifies its copy cannot contaminate later shells.
    let mut source = std::fs::File::open(snapshot_path).map_err(|error| {
        ToolError::Execution(format!(
            "failed to open shell snapshot `{}`: {error}",
            snapshot_path.display()
        ))
    })?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".kcoder-shell-")
        .suffix(".sh")
        .tempfile_in(copy_root)
        .map_err(|error| {
            ToolError::Execution(format!(
                "failed to create private shell snapshot in `{}`: {error}",
                copy_root.display()
            ))
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        temporary
            .as_file_mut()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                ToolError::Execution(format!(
                    "failed to secure private shell snapshot `{}`: {error}",
                    temporary.path().display()
                ))
            })?;
    }
    std::io::copy(&mut source, temporary.as_file_mut()).map_err(|error| {
        ToolError::Execution(format!(
            "failed to copy shell snapshot `{}` into `{}`: {error}",
            snapshot_path.display(),
            temporary.path().display()
        ))
    })?;
    temporary.as_file_mut().sync_all().map_err(|error| {
        ToolError::Execution(format!(
            "failed to flush private shell snapshot `{}`: {error}",
            temporary.path().display()
        ))
    })?;
    Ok(Some(PreparedShellSnapshot {
        path: temporary.path().to_path_buf(),
        temporary: Some(temporary),
    }))
}
