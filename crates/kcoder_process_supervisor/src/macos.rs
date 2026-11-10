//! Darwin process observations use kernel exit events, never persisted PID files.
use anyhow::{Context, Result, ensure};
use std::{
    ffi::OsString,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub const INTERNAL_STDIO_OWNER_V1: &str = "--internal-stdio-owner-v1";
static STOP: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub struct ProcessHandle(Arc<OwnedFd>);
impl ProcessHandle {
    /// The caller must hold the live process or its unreaped Child while capturing.
    pub fn capture(pid: u32) -> Result<Self> {
        let fd = unsafe { libc::kqueue() };
        ensure!(fd >= 0, "DARWIN_PROCESS_OBSERVATION_UNAVAILABLE");
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        ensure!(
            unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == 0,
            "DARWIN_PROCESS_OBSERVATION_UNAVAILABLE"
        );
        let event = libc::kevent {
            ident: pid as _,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ENABLE,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        ensure!(
            unsafe {
                libc::kevent(
                    fd.as_raw_fd(),
                    &event,
                    1,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null(),
                )
            } == 0,
            "DARWIN_PROCESS_IDENTITY_UNAVAILABLE"
        );
        Ok(Self(Arc::new(fd)))
    }
    pub fn alive(&self) -> Result<bool> {
        // Do not consume the exit event: all clones must observe the same terminal fact.
        let mut poll = libc::pollfd {
            fd: self.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let count = unsafe { libc::poll(&mut poll, 1, 0) };
        ensure!(
            count >= 0 && poll.revents & libc::POLLNVAL == 0,
            "DARWIN_PROCESS_OBSERVATION_UNAVAILABLE"
        );
        Ok(count == 0)
    }
}

pub struct StdioOwnerGuard {
    process: ProcessHandle,
    pid: u32,
}
impl StdioOwnerGuard {
    pub fn for_child(pid: u32) -> Result<Self> {
        Ok(Self {
            process: ProcessHandle::capture(pid)?,
            pid,
        })
    }
    pub fn exit_handle(&self) -> ProcessHandle {
        self.process.clone()
    }
    pub fn request_stop(&self) {
        if self.process.alive().unwrap_or(false) {
            unsafe {
                libc::kill(self.pid as i32, libc::SIGTERM);
            }
        }
    }
}
impl Drop for StdioOwnerGuard {
    fn drop(&mut self) {
        self.request_stop();
    }
}
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

struct NodeGroup(Option<std::process::Child>);
impl NodeGroup {
    fn finish(&mut self) -> Result<std::process::ExitStatus> {
        let mut child = self.0.take().context("Owned Node already reaped")?;
        // The direct child is still unreaped, so its group leader ID cannot be reused.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        Ok(child.wait()?)
    }
}
impl Drop for NodeGroup {
    fn drop(&mut self) {
        if self.0.is_some() {
            let _ = self.finish();
        }
    }
}

/// The helper retains its direct Node child until its owned process group is stopped.
/// SDKs are separately supervised children; this is not an arbitrary command-tree API.
pub fn entry(args: &[OsString]) -> Result<i32> {
    ensure!(
        args.len() >= 4 && args[1] == INTERNAL_STDIO_OWNER_V1,
        "Invalid Darwin stdio owner invocation"
    );
    let parent: u32 = args[2].to_str().context("Invalid parent")?.parse()?;
    ensure!(
        unsafe { libc::getppid() } as u32 == parent,
        "Owned stdio parent changed"
    );
    let owner = ProcessHandle::capture(parent)?;
    ensure!(
        unsafe { libc::getppid() } as u32 == parent,
        "Owned stdio parent changed"
    );
    let program = Path::new(&args[3]);
    ensure!(
        program.is_absolute(),
        "Owned stdio executable must be absolute"
    );
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = stop as *const () as usize;
        unsafe {
            libc::sigemptyset(&mut action.sa_mask);
        }
        ensure!(
            unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } == 0,
            "Darwin stop handler unavailable"
        );
    }
    let child = Command::new(program)
        .args(&args[4..])
        .process_group(0)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let pid = child.id();
    let mut group = NodeGroup(Some(child));
    let process = ProcessHandle::capture(pid)?;
    while owner.alive()? && process.alive()? && !STOP.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let stopped = STOP.load(Ordering::Relaxed) || !owner.alive()?;
    let status = group.finish()?;
    Ok(if stopped {
        0
    } else {
        status.code().unwrap_or(1)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clones_retain_original_exit_after_reaping() -> Result<()> {
        let mut child = Command::new("/bin/sleep").arg("30").spawn()?;
        let handle = ProcessHandle::capture(child.id())?;
        let peer = handle.clone();
        assert!(handle.alive()?);
        child.kill()?;
        child.wait()?;
        assert!(!handle.alive()?);
        assert!(!peer.alive()?);
        Ok(())
    }
}
