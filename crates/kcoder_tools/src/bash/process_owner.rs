//! Process-group/Windows Job ownership, stopped-process detection, and drop-time reaping.

use super::*;

pub(super) enum ManagedChild {
    Tokio(Child),
    #[cfg(windows)]
    Windows(crate::windows_sandbox::WindowsSandboxChild),
}

impl ManagedChild {
    pub(super) async fn wait(&mut self) -> std::io::Result<ExitStatus> {
        match self {
            Self::Tokio(child) => child.wait().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait().await,
        }
    }

    pub(super) fn start_kill(&mut self) -> std::io::Result<()> {
        match self {
            Self::Tokio(child) => child.start_kill(),
            #[cfg(windows)]
            Self::Windows(child) => {
                child.terminate();
                Ok(())
            }
        }
    }
}

pub(super) enum ChildWaitOutcome {
    Exited(ExitStatus),
    Elapsed,
    Stopped,
}

#[cfg(target_os = "linux")]
pub(super) async fn wait_for_linux_process_stop(pid: u32) {
    loop {
        if linux_process_is_stopped(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(not(target_os = "linux"))]
pub(super) async fn wait_for_linux_process_stop(_pid: u32) {
    std::future::pending::<()>().await;
}

#[cfg(target_os = "linux")]
pub(super) fn linux_process_is_stopped(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    stat.rsplit_once(") ")
        .and_then(|(_, fields)| fields.chars().next())
        .is_some_and(|state| matches!(state, 'T' | 't'))
}

impl Drop for RunningShell {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }
        self.terminator.terminate();
        let Some(mut child) = self.child.take() else {
            return;
        };
        let stdout = self.stdout.take();
        let stderr = self.stderr.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = child.wait().await;
                if let Some(stdout) = stdout {
                    let _ = stdout.await;
                }
                if let Some(stderr) = stderr {
                    let _ = stderr.await;
                }
            });
        } else {
            let _ = child.start_kill();
        }
    }
}

pub(super) struct ProcessGroupTerminator {
    pub(super) pid: u32,
    #[cfg(target_os = "linux")]
    pub(super) process_scope: Option<String>,
    #[cfg(windows)]
    pub(super) native_job: Option<crate::windows_sandbox::WindowsSandboxTerminator>,
    pub(super) terminated: AtomicBool,
    pub(super) cleaned_descendants: AtomicUsize,
}

impl ProcessGroupTerminator {
    pub(super) fn new(pid: u32, _process_scope: Option<String>) -> Self {
        Self {
            pid,
            #[cfg(target_os = "linux")]
            process_scope: _process_scope,
            #[cfg(windows)]
            native_job: None,
            terminated: AtomicBool::new(false),
            cleaned_descendants: AtomicUsize::new(0),
        }
    }

    #[cfg(windows)]
    pub(super) fn new_windows(
        pid: u32,
        native_job: crate::windows_sandbox::WindowsSandboxTerminator,
    ) -> Self {
        Self {
            pid,
            native_job: Some(native_job),
            terminated: AtomicBool::new(false),
            cleaned_descendants: AtomicUsize::new(0),
        }
    }

    pub(super) fn cleaned_descendant_count(&self) -> usize {
        self.cleaned_descendants.load(Ordering::SeqCst)
    }

    pub(super) fn terminate(&self) {
        if self.terminated.swap(true, Ordering::SeqCst) {
            return;
        }
        // Linux invocation scopes also cover descendants that called setsid,
        // double-forked, or otherwise escaped the original process group. Scan
        // before signalling the group so the user-visible result can report
        // how many invocation descendants were actually found and cleaned.
        #[cfg(target_os = "linux")]
        if let Some(scope) = self.process_scope.as_deref() {
            self.cleaned_descendants
                .store(terminate_linux_process_scope(scope), Ordering::SeqCst);
        }
        #[cfg(unix)]
        unsafe {
            let pid = self.pid as libc::pid_t;
            if libc::kill(-pid, libc::SIGKILL) != 0 {
                let _ = libc::kill(pid, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            if let Some(job) = &self.native_job {
                job.terminate();
                return;
            }
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

#[cfg(target_os = "linux")]
pub(super) fn new_process_scope() -> String {
    let sequence = NEXT_PROCESS_SCOPE.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{timestamp}-{sequence}", std::process::id())
}

#[cfg(target_os = "linux")]
pub(super) fn terminate_linux_process_scope(scope: &str) -> usize {
    use std::collections::HashSet;

    let marker = format!("{PROCESS_SCOPE_ENV}={scope}");
    let own_pid = std::process::id();
    let mut cleaned = HashSet::new();

    // A child may call setsid(2), double-fork, and be reparented before the
    // original shell exits. Process-group signalling cannot reach it, but the
    // per-invocation environment marker survives those transitions. Repeat the
    // scan so a descendant racing with the first SIGKILL cannot escape by
    // forking once more before its parent is stopped.
    for _ in 0..3 {
        let mut found = false;
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return cleaned.len();
        };
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            if pid == own_pid {
                continue;
            }
            let Ok(environment) = std::fs::read(entry.path().join("environ")) else {
                continue;
            };
            if !environment
                .split(|byte| *byte == 0)
                .any(|entry| entry == marker.as_bytes())
            {
                continue;
            }
            found = true;
            cleaned.insert(pid);
            unsafe {
                let _ = libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        if !found {
            break;
        }
        std::thread::yield_now();
    }
    cleaned.len()
}

impl Drop for ProcessGroupTerminator {
    fn drop(&mut self) {
        self.terminate();
    }
}
