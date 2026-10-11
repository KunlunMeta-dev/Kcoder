//! Open workspace paths from a root capability and share writer leases across
//! app-server processes. Client paths are labels; I/O stays relative to handles.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use std::{
    fs::File,
    path::{Component, Path, PathBuf},
};

const WRITER_LOCK: &str = ".kcoder-workspace-write.lock";
pub(super) const PREVIOUS_PREFIX: &str = ".kcoder-previous-";

pub(super) fn internal_name(name: &str) -> bool {
    name == WRITER_LOCK || name.starts_with(PREVIOUS_PREFIX)
}

pub(super) fn validate_name(name: &str) -> Result<()> {
    let path = Path::new(name);
    ensure!(
        !name.trim().is_empty()
            && path.components().count() == 1
            && path.file_name().and_then(|part| part.to_str()) == Some(name)
            && !name
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
            && !internal_name(name),
        "workspace entry name is invalid or reserved"
    );
    Ok(())
}

pub(super) fn parent(root: &Path, requested: &Path) -> Result<(PathBuf, PrivateDirectory)> {
    ensure!(requested.is_absolute(), "workspace path must be absolute");
    let root = super::workspace_fs::canonicalize_for_client(root)?;
    let requested = super::workspace_fs::canonicalize_for_client(requested)?;
    let relative = requested
        .strip_prefix(&root)
        .context("workspace path is outside the configured workspace")?;
    let mut opened = PrivateDirectory::open_existing(&root)?;
    let mut display = root.clone();
    for component in relative.components() {
        match component {
            Component::Normal(name) => {
                opened = opened.open_child(name, false)?;
                display.push(name);
            }
            _ => anyhow::bail!("workspace path contains an unsupported component"),
        }
    }
    Ok((display, opened))
}

/// Resolve permitted in-workspace aliases for compatibility, then open every
/// resolved component from the workspace capability without following new links.
pub(super) fn file(
    root: &Path,
    requested_parent: &Path,
    name: &str,
) -> Result<(PathBuf, PrivateDirectory, std::ffi::OsString, File)> {
    validate_name(name).context("workspace filename is invalid")?;
    ensure!(
        requested_parent.is_absolute(),
        "workspace path must be absolute"
    );
    let path = super::workspace_fs::canonicalize_for_client(&requested_parent.join(name))?;
    let (parent_path, directory) = parent(
        root,
        path.parent().context("workspace file parent is missing")?,
    )?;
    let leaf = path
        .file_name()
        .context("workspace file name is missing")?
        .to_os_string();
    validate_name(&leaf.to_string_lossy())?;
    let opened = directory.open_regular_file(&leaf)?;
    Ok((parent_path.join(&leaf), directory, leaf, opened))
}

/// The leaf remains in place so all participating processes lock one identity.
/// Waiting is bounded and performed only inside blocking worker tasks.
pub(super) fn writer_lock(directory: &PrivateDirectory) -> Result<File> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if let Some(lock) = directory.try_exclusive_lock(WRITER_LOCK.as_ref())? {
            return Ok(lock);
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "workspace writer is busy; retry the operation"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
