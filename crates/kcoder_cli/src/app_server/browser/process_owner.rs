//! Linux browsers reuse the original pidfd/subreaper command owner.
use super::*;
use kcoder_process_supervisor::linux_stdio::{
    INTERNAL_COMMAND_OWNER_RECEIPT_V1, INTERNAL_COMMAND_OWNER_V1, StdioOwnerGuard,
};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

fn owner_program() -> Result<PathBuf> {
    #[cfg(test)]
    {
        let program = std::env::var_os("KCODER_TEST_BROWSER_OWNER_BIN")
            .context("explicit current browser owner binary required")?;
        let path = PathBuf::from(program);
        anyhow::ensure!(
            path.is_absolute() && path.is_file(),
            "browser owner binary unavailable"
        );
        Ok(path)
    }
    #[cfg(not(test))]
    {
        std::env::current_exe().context("browser owner binary unavailable")
    }
}

pub(super) async fn spawn(
    chromium: &Path,
    args: &[String],
    receipt: Option<std::fs::File>,
) -> Result<OwnedChromiumProcess> {
    let mut command = Command::new(owner_program()?);
    command
        .arg(if receipt.is_some() {
            INTERNAL_COMMAND_OWNER_RECEIPT_V1
        } else {
            INTERNAL_COMMAND_OWNER_V1
        })
        .arg(std::process::id().to_string());
    if let Some(file) = &receipt {
        let fd = file.as_raw_fd();
        command.arg(fd.to_string());
        // SAFETY: only this explicit owned descriptor is made inheritable in the child.
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command
        .arg(chromium)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(false);
    let child = command
        .spawn()
        .context("failed to start owned Chromium supervisor")?;
    drop(receipt);
    let mut process = OwnedChromiumProcess::new(child);
    let pid = process
        .child
        .id()
        .context("Chromium owner identity unavailable")?;
    match StdioOwnerGuard::for_child(pid) {
        Ok(owner) => process.linux_owner = Some(owner),
        Err(error) => {
            // This fresh child remains unreaped, so this exact PID cannot be reused.
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
                libc::kill(pid as i32, libc::SIGCONT);
            }
            tokio::time::timeout(BROWSER_PROCESS_SHUTDOWN_TIMEOUT, process.child.wait())
                .await
                .context("Chromium owner cleanup unconfirmed")??;
            process.terminated = true;
            return Err(error);
        }
    }
    Ok(process)
}
