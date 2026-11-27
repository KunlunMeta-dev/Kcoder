//! One-shot handoff waits for its actual desktop parent, independently of file leases.
use anyhow::{Result, ensure};
use std::time::Duration;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::time::Instant;

pub(super) struct HandoffParent {
    #[cfg(target_os = "linux")]
    process: std::os::fd::OwnedFd,
    #[cfg(windows)]
    process: std::os::windows::io::OwnedHandle,
    #[cfg(target_os = "macos")]
    process: kcoder_process_supervisor::macos::ProcessHandle,
}

impl HandoffParent {
    /// Capture before readiness while the launching parent is still waiting for us.
    /// The plan cannot supply a PID, and dropping a storage lease is not OS exit.
    pub(super) fn capture() -> Result<Self> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::FromRawFd;
            let pid = unsafe { libc::getppid() };
            ensure!(pid > 1, "STORAGE_HANDOFF_PARENT_UNAVAILABLE");
            // SAFETY: pidfd_open returns a new owned descriptor for this process.
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
            ensure!(fd >= 0, "STORAGE_HANDOFF_PARENT_UNAVAILABLE");
            let process = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as i32) };
            ensure!(
                unsafe { libc::getppid() } == pid,
                "STORAGE_HANDOFF_PARENT_CHANGED"
            );
            Ok(Self { process })
        }
        #[cfg(windows)]
        {
            Ok(Self {
                process:
                    kcoder_host_transport::native_component_parent::capture_current_service_parent(
                    )?,
            })
        }
        #[cfg(target_os = "macos")]
        {
            let pid = unsafe { libc::getppid() };
            ensure!(pid > 1, "STORAGE_HANDOFF_PARENT_UNAVAILABLE");
            let process = kcoder_process_supervisor::macos::ProcessHandle::capture(pid as u32)?;
            ensure!(
                unsafe { libc::getppid() } == pid && process.alive()?,
                "STORAGE_HANDOFF_PARENT_CHANGED"
            );
            Ok(Self { process })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        anyhow::bail!("STORAGE_HANDOFF_PARENT_UNAVAILABLE")
    }

    pub(super) fn wait_exited(&self, wait: Duration) -> Result<()> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let deadline = Instant::now() + wait;
            loop {
                let mut event = libc::pollfd {
                    fd: self.process.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let remaining = deadline.saturating_duration_since(Instant::now());
                let milliseconds = i32::try_from(remaining.as_millis().max(1)).unwrap_or(i32::MAX);
                // SAFETY: the descriptor is held for the complete wait.
                let observed = unsafe { libc::poll(&mut event, 1, milliseconds) };
                if observed < 0 {
                    if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    anyhow::bail!("STORAGE_HANDOFF_PARENT_OBSERVATION_FAILED");
                }
                ensure!(
                    event.revents & libc::POLLNVAL == 0,
                    "STORAGE_HANDOFF_PARENT_OBSERVATION_FAILED"
                );
                if event.revents & libc::POLLIN != 0 {
                    return Ok(());
                }
                ensure!(observed == 0, "STORAGE_HANDOFF_PARENT_OBSERVATION_FAILED");
                ensure!(Instant::now() < deadline, "STORAGE_STOP_TIMEOUT");
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{
                Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::WaitForSingleObject,
            };
            let milliseconds = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX - 1);
            let state =
                unsafe { WaitForSingleObject(self.process.as_raw_handle().cast(), milliseconds) };
            ensure!(state != WAIT_TIMEOUT, "STORAGE_STOP_TIMEOUT");
            ensure!(
                state == WAIT_OBJECT_0,
                "STORAGE_HANDOFF_PARENT_OBSERVATION_FAILED"
            );
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            let deadline = Instant::now() + wait;
            let mut pause = Duration::from_millis(10);
            while self.process.alive()? {
                let remaining = deadline.saturating_duration_since(Instant::now());
                ensure!(!remaining.is_zero(), "STORAGE_STOP_TIMEOUT");
                std::thread::sleep(pause.min(remaining));
                pause = (pause * 2).min(Duration::from_millis(250));
            }
            Ok(())
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        anyhow::bail!("STORAGE_HANDOFF_PARENT_UNAVAILABLE")
    }
}
