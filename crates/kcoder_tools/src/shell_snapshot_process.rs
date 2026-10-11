//! Bounded snapshot-only capture and ownership; it does not change Bash output policy.
use anyhow::{Context, Result, ensure};
use std::{process::Output, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

pub(super) const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;

struct OwnedGroup {
    #[cfg(unix)]
    pid: u32,
    terminated: bool,
}

impl OwnedGroup {
    fn terminate(&mut self) {
        if self.terminated {
            return;
        }
        self.terminated = true;
        #[cfg(unix)]
        unsafe {
            // The child was created with process_group(0). Never fall back to
            // signalling a positive PID after it may already have been reaped.
            libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL);
        }
    }
}
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn bounded(mut pipe: impl AsyncRead + Unpin, limit: usize, stream: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut pipe)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    ensure!(
        bytes.len() <= limit,
        "shell snapshot {stream} exceeds {limit} byte limit"
    );
    Ok(bytes)
}

pub(super) async fn run(mut command: Command, timeout: Duration, capture: bool) -> Result<Output> {
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command
        .stdout(if capture {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stderr(if capture {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        });
    let mut child = command
        .spawn()
        .context("failed to spawn shell snapshot process")?;
    let mut group = OwnedGroup {
        #[cfg(unix)]
        pid: child.id().context("snapshot process has no PID")?,
        terminated: false,
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let work = async {
        let wait = async {
            let status = child.wait().await?;
            group.terminate();
            Ok::<_, anyhow::Error>(status)
        };
        let output = async {
            match stdout {
                Some(pipe) => bounded(pipe, MAX_SOURCE_BYTES, "stdout").await,
                None => Ok(Vec::new()),
            }
        };
        let diagnostic = async {
            match stderr {
                Some(pipe) => bounded(pipe, MAX_DIAGNOSTIC_BYTES, "stderr").await,
                None => Ok(Vec::new()),
            }
        };
        let (status, stdout, stderr) = tokio::try_join!(wait, output, diagnostic)?;
        Ok::<_, anyhow::Error>(Output {
            status,
            stdout,
            stderr,
        })
    };
    let result = tokio::time::timeout(timeout, work).await;
    group.terminate();
    if !matches!(&result, Ok(Ok(_))) {
        let _ = child.start_kill();
        // Explicitly reap normal timeout/error paths. Drop still kills a native
        // child on task cancellation; Windows/WSL descendant ownership is not claimed.
        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    }
    result.map_err(|_| anyhow::anyhow!("shell snapshot process timed out"))?
}
