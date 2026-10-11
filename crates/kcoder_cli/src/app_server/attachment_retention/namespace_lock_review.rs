//! Run the fork barrier only after exec into an isolated, single-test helper.
//! The regular parallel test process never deliberately retains inherited FDs.
use super::*;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

const ARM: &str = "KCODER_TEST_NAMESPACE_LOCK_HELPER";
const HELPER: &str = "app_server::attachment_retention::tests::namespace_lock_review::retention_namespace_lock_inherited_fd_helper";
const DEADLINE: Duration = Duration::from_secs(5);

fn readable(fd: &OwnedFd, timeout: Duration) -> Result<bool> {
    let until = Instant::now() + timeout;
    loop {
        let left = until.saturating_duration_since(Instant::now());
        let mut event = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let result =
            unsafe { libc::poll(&mut event, 1, left.as_millis().min(i32::MAX as u128) as i32) };
        if result >= 0 {
            return Ok(result > 0);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted || Instant::now() >= until {
            return Err(error.into());
        }
    }
}

fn pidfd(pid: libc::pid_t) -> Result<OwnedFd> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    anyhow::ensure!(fd >= 0, "pidfd_open: {}", std::io::Error::last_os_error());
    Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
}

struct HelperProcess(Child);
impl Drop for HelperProcess {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[test]
fn retention_namespace_lock_inherited_fd_lifecycle() -> Result<()> {
    let mut child = HelperProcess(
        Command::new(std::env::current_exe()?)
            .args(["--exact", HELPER, "--nocapture", "--test-threads=1"])
            .env(ARM, "namespace-lock-v1")
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    let process = pidfd(child.0.id() as libc::pid_t)?;
    anyhow::ensure!(
        readable(&process, Duration::from_secs(15))?,
        "helper deadline"
    );
    let status = child.0.wait()?;
    anyhow::ensure!(status.success(), "namespace lock helper failed: {status}");
    Ok(())
}

fn pipe() -> Result<(OwnedFd, OwnedFd)> {
    let mut fds = [-1; 2];
    let result = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
    anyhow::ensure!(result == 0, "pipe2: {}", std::io::Error::last_os_error());
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

struct InheritedFdChild {
    pid: libc::pid_t,
    process: OwnedFd,
    release: Option<OwnedFd>,
    reaped: bool,
}
impl InheritedFdChild {
    fn start() -> Result<Self> {
        let (ready_read, ready_write) = pipe()?;
        let (release_read, release_write) = pipe()?;
        let pid = unsafe { libc::fork() };
        anyhow::ensure!(pid >= 0, "fork: {}", std::io::Error::last_os_error());
        if pid == 0 {
            // Only async-signal-safe syscalls after fork: no Rust destructors,
            // allocators, assertions, filesystem operations, or lock access.
            unsafe {
                libc::close(ready_read.as_raw_fd());
                libc::close(release_write.as_raw_fd());
                let byte = 1u8;
                if libc::write(ready_write.as_raw_fd(), (&byte as *const u8).cast(), 1) != 1 {
                    libc::_exit(2);
                }
                libc::close(ready_write.as_raw_fd());
                let mut byte = 0u8;
                loop {
                    let n = libc::read(release_read.as_raw_fd(), (&mut byte as *mut u8).cast(), 1);
                    if n >= 0 {
                        libc::_exit(if n == 0 { 0 } else { 3 });
                    }
                    if *libc::__errno_location() != libc::EINTR {
                        libc::_exit(4);
                    }
                }
            }
        }
        drop(ready_write);
        drop(release_read);
        let process = match pidfd(pid) {
            Ok(process) => process,
            Err(error) => {
                // The just-forked owned child is unreaped, so its PID cannot
                // be reused here. Do not leave it behind on pidfd failure.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                    libc::waitpid(pid, std::ptr::null_mut(), 0);
                }
                return Err(error);
            }
        };
        let child = Self {
            pid,
            process,
            release: Some(release_write),
            reaped: false,
        };
        anyhow::ensure!(readable(&ready_read, DEADLINE)?, "fork ready deadline");
        let mut byte = 0u8;
        let n = unsafe { libc::read(ready_read.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) };
        anyhow::ensure!(n == 1 && byte == 1, "fork ready byte missing");
        anyhow::ensure!(
            !readable(&child.process, Duration::ZERO)?,
            "fork exited before barrier"
        );
        Ok(child)
    }

    fn finish(mut self) -> Result<()> {
        self.release.take();
        anyhow::ensure!(readable(&self.process, DEADLINE)?, "fork exit deadline");
        let mut status = 0;
        let result = unsafe { libc::waitpid(self.pid, &mut status, 0) };
        anyhow::ensure!(result == self.pid, "fork waitpid failed");
        self.reaped = true;
        anyhow::ensure!(
            libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0,
            "fork exit {status}"
        );
        Ok(())
    }
}
impl Drop for InheritedFdChild {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        self.release.take();
        if !readable(&self.process, DEADLINE).unwrap_or(false) {
            // This exact unreaped child still owns this PID.
            unsafe {
                libc::kill(self.pid, libc::SIGKILL);
            }
        }
        loop {
            let result = unsafe { libc::waitpid(self.pid, std::ptr::null_mut(), 0) };
            if result == self.pid
                || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
            {
                break;
            }
        }
        self.reaped = true;
    }
}

fn observer_lock(root: &PrivateDirectory) -> Result<Option<File>> {
    root.try_exclusive_lock(OsStr::new("namespace.lock"))
}

#[test]
fn retention_namespace_lock_inherited_fd_helper() -> Result<()> {
    if std::env::var_os(ARM).as_deref() != Some(OsStr::new("namespace-lock-v1")) {
        return Ok(());
    }
    let (temp, service, _) = fixture(Limits::default());
    let account = PrivateDirectory::open_existing(&temp.path().join("account"))?;
    let root = account.open_verified_child(
        OsStr::new("attachment-retention-v1"),
        &service.store.header.identity,
    )?;
    let mut outcomes = Vec::new();
    for phase in ["drop", "early-error"] {
        let mut child = None;
        let result = (|| -> Result<()> {
            let tx = service.store.transaction()?;
            child = Some(InheritedFdChild::start()?);
            anyhow::ensure!(
                observer_lock(&root)?.is_none(),
                "{phase}: active guard must remain busy"
            );
            if phase == "early-error" {
                Err::<(), _>(anyhow::anyhow!("expected early transaction error"))?;
            }
            drop(tx);
            Ok(())
        })();
        if phase == "early-error" {
            anyhow::ensure!(
                result.unwrap_err().to_string() == "expected early transaction error",
                "wrong early error"
            );
        } else {
            result?;
        }
        let child = child.context("fork child missing")?;
        anyhow::ensure!(
            !readable(&child.process, Duration::ZERO)?,
            "child must still retain inherited fd"
        );
        let acquired = observer_lock(&root)?.is_some();
        eprintln!(
            "namespace inherited-fd phase={phase} active_busy=true after_release_acquired={acquired}"
        );
        outcomes.push((phase, acquired));
        child.finish()?;
        anyhow::ensure!(
            observer_lock(&root)?.is_some(),
            "{phase}: lock must release after child reap"
        );
    }
    anyhow::ensure!(
        outcomes.iter().all(|(_, acquired)| *acquired),
        "inherited FD retained namespace lock: {outcomes:?}"
    );
    Ok(())
}
