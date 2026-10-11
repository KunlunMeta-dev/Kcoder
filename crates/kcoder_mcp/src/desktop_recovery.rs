//! Internal recovery process entry, intentionally before settings, hooks, skills
//! and model initialization. It accepts only the private native bootstrap.
use anyhow::{Result, ensure};
use kcoder_computer_use::{
    recovery_bootstrap::RecoveryBootstrap, windows_pipe::connect_recovery,
    windows_recovery::serve_authorized_recovery,
};
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, io::Read, path::Path};
use zeroize::Zeroizing;

pub async fn run(path: &Path, expected_pipe: &str) -> Result<()> {
    kcoder_computer_use::windows_recovery_task::task_name(expected_pipe)?;
    let result = run_inner(path, expected_pipe).await;
    let registration = kcoder_computer_use::windows_recovery_task::unregister(expected_pipe).await;
    result.and(registration)
}

async fn run_inner(path: &Path, expected_pipe: &str) -> Result<()> {
    ensure!(
        path.is_absolute(),
        "recovery bootstrap requires an absolute path"
    );
    ensure!(
        path.file_name() == Some(OsStr::new("recovery-bootstrap.json")),
        "invalid recovery bootstrap filename"
    );
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing recovery directory"))?;
    ensure!(
        parent
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with("kcoder-desktop-recovery-")),
        "invalid recovery bootstrap directory"
    );
    let directory = PrivateDirectory::open_existing(parent)?;
    let lock = directory
        .try_exclusive_lock(OsStr::new("bootstrap.lock"))?
        .ok_or_else(|| anyhow::anyhow!("recovery bootstrap is already in use"))?;
    let mut bytes = Zeroizing::new(Vec::new());
    directory
        .open_regular_file(OsStr::new("recovery-bootstrap.json"))?
        .take(4097)
        .read_to_end(&mut bytes)?;
    let bootstrap = RecoveryBootstrap::decode(&bytes)?;
    drop(bytes);
    ensure!(
        bootstrap.pipe() == expected_pipe,
        "recovery bootstrap pipe mismatch"
    );
    let (pipe, peer) = connect_recovery(&bootstrap).await?;
    // Only consume the private file after proving the actual parent holds
    // its secret. Do not delete a supplied file on authentication failure.
    directory.remove_regular_file(OsStr::new("recovery-bootstrap.json"))?;
    drop(lock);
    drop(directory);
    drop(bootstrap);
    // The authenticated same-image parent sends fresh DuplicateHandle
    // results via the internal recovery client, never model parameters.
    unsafe { serve_authorized_recovery(pipe, peer).await }
}
