//! Launch native host commands with a retained process-tree owner.
#[cfg(any(target_os = "linux", windows))]
use anyhow::Context;
use anyhow::{Result, ensure};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", windows))]
use std::{collections::BTreeMap, process::Stdio, time::Duration};
use tokio::process::{Child, Command};

/// Construct only from the native installed runtime/package resolver, never request payload.
#[derive(Clone)]
pub struct NativeConnectivityHostPaths {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub supervisor: PathBuf,
}
pub enum OwnedTree {
    #[cfg(target_os = "linux")]
    Linux(kcoder_process_supervisor::linux_stdio::StdioOwnerGuard),
    #[cfg(windows)]
    Windows(kcoder_process_supervisor::suspended_child::SuspendedChildJob),
}
impl OwnedTree {
    pub fn stop(&self) -> Result<()> {
        match self {
            #[cfg(target_os = "linux")]
            Self::Linux(owner) => {
                owner.request_stop();
                Ok(())
            }
            #[cfg(windows)]
            Self::Windows(job) => job.terminate(),
            #[cfg(not(any(target_os = "linux", windows)))]
            _ => anyhow::bail!("CONNECTIVITY_NATIVE_SUPERVISOR_UNAVAILABLE"),
        }
    }
}
pub fn verify_program_path(path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute(),
        "CONNECTIVITY_NATIVE_RUNTIME_PATH_REQUIRED"
    );
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "CONNECTIVITY_NATIVE_RUNTIME_UNSAFE"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            metadata.mode() & 0o022 == 0,
            "CONNECTIVITY_NATIVE_RUNTIME_UNSAFE"
        );
    }
    Ok(())
}
#[cfg(any(target_os = "linux", windows))]
fn private_environment() -> BTreeMap<std::ffi::OsString, std::ffi::OsString> {
    [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "TZ",
        "SSL_CERT_FILE",
        "NODE_EXTRA_CA_CERTS",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
    ]
    .into_iter()
    .filter_map(|key| std::env::var_os(key).map(|value| (key.into(), value)))
    .collect()
}
#[cfg(not(any(target_os = "linux", windows)))]
pub async fn spawn_owned(
    _paths: &NativeConnectivityHostPaths,
    _data: &Path,
    _configure: &(dyn Fn(&mut Command) -> Result<()> + Sync),
) -> Result<(Child, OwnedTree)> {
    anyhow::bail!("CONNECTIVITY_NATIVE_SUPERVISOR_UNAVAILABLE")
}

#[cfg(any(target_os = "linux", windows))]
pub async fn spawn_owned(
    paths: &NativeConnectivityHostPaths,
    data: &Path,
    configure: &(dyn Fn(&mut Command) -> Result<()> + Sync),
) -> Result<(Child, OwnedTree)> {
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new(&paths.supervisor);
        command
            .arg(kcoder_process_supervisor::linux_stdio::INTERNAL_STDIO_OWNER_V1)
            .arg(std::process::id().to_string())
            .arg(&paths.node);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new(&paths.node);
        command.creation_flags(kcoder_process_supervisor::suspended_child::SUSPENDED_CHILD_FLAGS);
        command
    };
    command
        .arg(&paths.entry)
        .arg("--root")
        .arg(data)
        .env_clear()
        .envs(private_environment())
        // The native resolver verifies the actual executable and runtime fuse.
        // Standalone Node ignores this exact native-owned flag.
        .env("ELECTRON_RUN_AS_NODE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    configure(&mut command)?;
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    let mut job = kcoder_process_supervisor::suspended_child::SuspendedChildJob::new()?;
    let mut child = command.spawn().context("CONNECTIVITY_HOST_SPAWN_FAILED")?;
    #[cfg(target_os = "linux")]
    {
        let pid = child
            .id()
            .context("CONNECTIVITY_HOST_PROCESS_UNAVAILABLE")?;
        match kcoder_process_supervisor::linux_stdio::StdioOwnerGuard::for_child(pid) {
            Ok(owner) => Ok((child, OwnedTree::Linux(owner))),
            Err(error) => {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                };
                let _ = tokio::time::timeout(Duration::from_secs(8), child.wait()).await;
                Err(error)
            }
        }
    }
    #[cfg(windows)]
    {
        let assigned = (|| {
            let process = child
                .raw_handle()
                .context("CONNECTIVITY_PROCESS_HANDLE_UNAVAILABLE")?;
            job.assign_and_resume(unsafe {
                std::os::windows::io::BorrowedHandle::borrow_raw(process)
            })
        })();
        if let Err(error) = assigned {
            let _ = job.terminate();
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(8), child.wait()).await;
            return Err(error);
        }
        Ok((child, OwnedTree::Windows(job)))
    }
}
