//! Owned process groups and bounded pipe capture shared by tools and verifier preparation.

use std::io;
use std::process::{ExitStatus, Output, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

const REAP_GRACE: Duration = Duration::from_millis(500);

struct ProcessGroup {
    pid: u32,
    terminated: bool,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}

impl ProcessGroup {
    fn new(pid: u32) -> Self {
        Self {
            pid,
            terminated: false,
            #[cfg(windows)]
            job: None,
        }
    }

    fn terminate(&mut self) {
        if self.terminated {
            return;
        }
        self.terminated = true;
        #[cfg(unix)]
        unsafe {
            // Only signal the group created for this invocation. Its leader may
            // already have been reaped, so never fall back to a positive PID.
            libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if let Some(job) = &self.job {
                unsafe {
                    windows_sys::Win32::System::JobObjects::TerminateJobObject(
                        job.as_raw_handle(),
                        1,
                    );
                }
                return;
            }
            // Retain the tree fallback for shims and platforms refusing Job assignment.
            let mut command = std::process::Command::new("taskkill.exe");
            command
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Ok(mut child) = command.spawn() {
                let deadline = Instant::now() + REAP_GRACE;
                while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                }
                let _ = child.kill();
                let _ = child.try_wait();
            }
        }
    }

    #[cfg(windows)]
    fn attach_job(&mut self, process: std::os::windows::io::RawHandle) {
        use std::ffi::c_void;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return;
            }
            let job = OwnedHandle::from_raw_handle(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of_val(&limits) as u32,
            ) != 0
                && AssignProcessToJobObject(job.as_raw_handle(), process) != 0
            {
                self.job = Some(job);
            }
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// The child and all processes in its invocation group belong to this guard.
/// Pipe work stays in the caller's future; dropping it cannot detach readers.
pub struct OwnedProcess {
    pub child: Child,
    group: ProcessGroup,
}

impl OwnedProcess {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        command.kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let child = command.spawn()?;
        let mut group = ProcessGroup::new(
            child
                .id()
                .ok_or_else(|| io::Error::other("child has no PID"))?,
        );
        #[cfg(windows)]
        if let Some(handle) = child.raw_handle() {
            group.attach_job(handle);
        }
        #[cfg(not(windows))]
        let _ = &mut group;
        Ok(Self { child, group })
    }

    pub fn terminate_group(&mut self) {
        self.group.terminate();
    }

    /// Kill the owned group and wait for the leader with a bounded reap grace.
    pub async fn finish(&mut self) -> io::Result<()> {
        self.terminate_group();
        if self.child.id().is_some() {
            self.child.start_kill()?;
        }
        tokio::time::timeout(REAP_GRACE, self.child.wait())
            .await
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "owned child did not exit during cleanup",
                )
            })??;
        Ok(())
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.group.terminate();
        if self.child.id().is_some() {
            let _ = self.child.start_kill();
        }
    }
}

/// Reject before extending the capture past its cap, including unterminated records.
pub async fn read_bounded(mut pipe: impl AsyncRead + Unpin, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = pipe.read(&mut chunk).await?;
        if read == 0 {
            return Ok(bytes);
        }
        if read > limit.saturating_sub(bytes.len()) {
            return Err(io::Error::other(format!(
                "process output exceeds {limit} byte budget"
            )));
        }
        if bytes.capacity().saturating_sub(bytes.len()) < read {
            let capacity = bytes
                .len()
                .saturating_add(read)
                .checked_next_power_of_two()
                .unwrap_or(limit)
                .min(limit);
            bytes.reserve_exact(capacity - bytes.len());
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}

/// Keep a bounded prefix while continuing to drain the other side of a process.
pub async fn drain_prefix(mut pipe: impl AsyncRead + Unpin, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut omitted = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        let read = pipe.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let keep = read.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&chunk[..keep]);
        omitted = omitted.saturating_add(read - keep);
    }
    if omitted > 0 {
        bytes.extend_from_slice(format!("\n[omitted {omitted} stderr bytes]").as_bytes());
    }
    Ok(bytes)
}

/// Deadline covers stdin, both pipe drains, and process completion; cleanup is
/// awaited with its own fixed grace before returning any normal-path error.
pub async fn output(
    command: &mut Command,
    stdin_bytes: Option<&[u8]>,
    stdout_limit: usize,
    stderr_limit: usize,
    timeout: Duration,
    cancel: Option<&CancellationToken>,
) -> io::Result<Output> {
    command
        .stdin(if stdin_bytes.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut owned = OwnedProcess::spawn(command)?;
    let stdout = owned
        .child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("stdout unavailable"))?;
    let stderr = owned
        .child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("stderr unavailable"))?;
    let stdin = owned.child.stdin.take();
    let work = async {
        let write = async {
            if let (Some(mut stdin), Some(bytes)) = (stdin, stdin_bytes) {
                stdin.write_all(bytes).await?;
                stdin.shutdown().await?;
            }
            Ok::<_, io::Error>(())
        };
        let wait = async {
            let status = owned.child.wait().await?;
            owned.terminate_group();
            Ok::<_, io::Error>(status)
        };
        let (status, stdout, stderr, ()) = tokio::try_join!(
            wait,
            read_bounded(stdout, stdout_limit),
            drain_prefix(stderr, stderr_limit),
            write
        )?;
        Ok::<_, io::Error>(Output {
            status,
            stdout,
            stderr,
        })
    };
    let result = tokio::select! {
        result = tokio::time::timeout(timeout, work) => result.unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "owned process operation timed out"))),
        _ = async { match cancel { Some(cancel) => cancel.cancelled().await, None => std::future::pending::<()>().await } } => Err(io::Error::new(io::ErrorKind::Interrupted, "owned process operation cancelled")),
    };
    owned.finish().await?;
    result
}

/// Drop-time fallback for synchronous owners. No wait/status or detached task
/// may extend this deadline; unsuccessful cleanup remains an explicit error.
pub fn bounded_status(
    command: &mut std::process::Command,
    timeout: Duration,
) -> io::Result<ExitStatus> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    let mut group = ProcessGroup::new(child.id());
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        group.attach_job(child.as_raw_handle());
    }
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait()? {
            Some(status) => {
                group.terminate();
                return Ok(status);
            }
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            None => break,
        }
    }
    group.terminate();
    let _ = child.kill();
    let reap_deadline = Instant::now() + Duration::from_millis(100);
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < reap_deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "owned process cleanup timed out",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounded_reader_stops_before_retaining_the_extra_chunk() {
        let bytes = vec![b'x'; 32768];
        let error = read_bounded(&bytes[..], 1024).await.unwrap_err();
        assert!(error.to_string().contains("1024 byte budget"));
        let retained = drain_prefix(&bytes[..], 1024).await.unwrap();
        assert!(retained.len() < 1100);
        assert!(String::from_utf8_lossy(&retained).contains("omitted 31744"));
    }

    #[cfg(unix)]
    fn running(pid: u32) -> bool {
        #[cfg(target_os = "linux")]
        {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|s| {
                    s.rsplit_once(") ")
                        .map(|(_, fields)| !fields.starts_with('Z'))
                })
                .unwrap_or(false)
        }
        #[cfg(not(target_os = "linux"))]
        unsafe {
            libc::kill(pid as libc::pid_t, 0) == 0
        }
    }

    #[cfg(unix)]
    async fn assert_stopped(pid: u32) {
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            while running(pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if result.is_err() {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        assert!(result.is_ok(), "owned descendant {pid} survived");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_output_drains_stderr_while_writing_stdin_and_cleans_inherited_pipes() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_path = tmp.path().join("pid");
        let mut command = Command::new("sh");
        command.arg("-c").arg("sleep 60 & echo $! > \"$1\"; head -c 1048576 /dev/zero >&2; cat >/dev/null; printf result").arg("fixture").arg(&pid_path);
        let result = output(
            &mut command,
            Some(&vec![b'x'; 1024 * 1024]),
            1024,
            1024,
            Duration::from_secs(2),
            None,
        )
        .await;
        let pid = std::fs::read_to_string(pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_stopped(pid).await;
        let captured = result.unwrap();
        assert_eq!(captured.stdout, b"result");
        assert!(captured.stderr.len() < 1100);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_cancel_terminates_group_without_detached_readers() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_path = tmp.path().join("pid");
        let token = CancellationToken::new();
        let cancel = token.clone();
        let path = pid_path.clone();
        let task = tokio::spawn(async move {
            let mut command = Command::new("sh");
            command
                .arg("-c")
                .arg("sleep 60 & echo $! > \"$1\"; wait")
                .arg("fixture")
                .arg(path);
            output(
                &mut command,
                None,
                1024,
                1024,
                Duration::from_secs(30),
                Some(&cancel),
            )
            .await
        });
        let pid = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(text) = tokio::fs::read_to_string(&pid_path).await
                    && let Ok(pid) = text.trim().parse()
                {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        token.cancel();
        let result = task.await.unwrap();
        assert_stopped(pid).await;
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
    }

    #[cfg(unix)]
    #[test]
    fn synchronous_cleanup_has_a_deadline_and_kills_the_group() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("pid");
        let mut command = std::process::Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 60 & echo $! > \"$1\"; wait")
            .arg("fixture")
            .arg(&path);
        let start = Instant::now();
        let result = bounded_status(&mut command, Duration::from_millis(100));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        let pid = std::fs::read_to_string(path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(1);
        while running(pid) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        if running(pid) {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        assert!(!running(pid));
    }
}
