//! A dedicated single-threaded owner for one ephemeral stdio process tree.
//!
//! The caller supplies the private command environment and protocol pipes. This
//! process never reads, decodes or writes the target's stdin/stdout protocol.
use anyhow::{Context, Result, ensure};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const INTERNAL_STDIO_OWNER_V1: &str = "--internal-stdio-owner-v1";
pub const INTERNAL_COMMAND_OWNER_V1: &str = "--internal-command-owner-v1";
pub const INTERNAL_COMMAND_OWNER_RECEIPT_V1: &str = "--internal-command-owner-receipt-v1";
static STOP: AtomicBool = AtomicBool::new(false);

pub fn entry(arguments: &[OsString]) -> Result<i32> {
    ensure!(
        arguments.len() >= 4,
        "Invalid internal stdio owner invocation"
    );
    let parent = arguments[2]
        .to_str()
        .context("Invalid stdio parent identity")?
        .parse::<u32>()?;
    let receipt_mode = arguments[1] == INTERNAL_COMMAND_OWNER_RECEIPT_V1;
    let (program_index, receipt) = if receipt_mode {
        ensure!(
            arguments.len() >= 5,
            "Invalid owned cleanup receipt invocation"
        );
        let fd = arguments[3]
            .to_str()
            .context("Invalid cleanup receipt descriptor")?
            .parse::<i32>()?;
        (4, Some(cleanup_receipt::Writer::from_inherited(fd)?))
    } else {
        (3, None)
    };
    run_mode(
        parent,
        Path::new(&arguments[program_index]),
        &arguments[program_index + 1..],
        arguments[1] == INTERNAL_COMMAND_OWNER_V1 || receipt_mode,
        receipt,
    )
}

extern "C" fn request_stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

fn pidfd(pid: u32) -> Result<OwnedFd> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    ensure!(
        fd >= 0,
        "Owned stdio supervision requires Linux pidfd support"
    );
    // SAFETY: a successful pidfd_open returns a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
}

/// Probe the kernel facilities before opting an application into owned commands.
pub fn command_owner_available() -> bool {
    pidfd(std::process::id()).is_ok() && children().is_ok()
}

fn exited(handle: &OwnedFd) -> bool {
    let mut fd = libc::pollfd {
        fd: handle.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    (unsafe { libc::poll(&mut fd, 1, 0) }) == 1
}

/// The caller must own a fresh unreaped child until this reference is acquired.
pub struct StdioOwnerGuard(Arc<OwnedFd>);
pub struct StdioExitHandle(Arc<OwnedFd>);
impl AsRawFd for StdioExitHandle {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.0.as_raw_fd()
    }
}
impl StdioOwnerGuard {
    pub fn for_child(pid: u32) -> Result<Self> {
        Ok(Self(Arc::new(pidfd(pid)?)))
    }
    pub fn exit_handle(&self) -> StdioExitHandle {
        StdioExitHandle(self.0.clone())
    }
    pub fn request_stop(&self) {
        // The descriptor refers to this exact process even after PID reuse.
        for signal in [libc::SIGTERM, libc::SIGCONT] {
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    self.0.as_raw_fd(),
                    signal,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
        }
    }
}
impl Drop for StdioOwnerGuard {
    fn drop(&mut self) {
        self.request_stop();
    }
}

/// Invoke only in a private single-threaded helper before application startup.
pub fn run(parent: u32, program: &Path, args: &[OsString]) -> Result<i32> {
    run_mode(parent, program, args, false, None)
}

/// The private original owner writes only after its real child and all owned
/// descendants have terminated, independently of the child's successful status.
pub fn run_with_cleanup_receipt(
    parent: u32,
    program: &Path,
    args: &[OsString],
    descriptor: i32,
) -> Result<i32> {
    run_mode(
        parent,
        program,
        args,
        false,
        Some(cleanup_receipt::Writer::from_inherited(descriptor)?),
    )
}

mod cleanup_receipt;
pub use cleanup_receipt::CLEANUP_CONFIRMED_BYTES;
pub use cleanup_receipt::OwnedCleanupReceipt;
fn run_mode(
    parent: u32,
    program: &Path,
    args: &[OsString],
    command: bool,
    mut receipt: Option<cleanup_receipt::Writer>,
) -> Result<i32> {
    ensure!(
        parent > 0 && unsafe { libc::getppid() } as u32 == parent,
        "Owned stdio parent identity changed"
    );
    ensure!(
        program.is_absolute(),
        "Owned stdio executable must be absolute"
    );
    let parent_handle = pidfd(parent)?;
    ensure!(
        unsafe { libc::getppid() } as u32 == parent,
        "Owned stdio parent identity changed"
    );
    ensure!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0,
        "Cannot establish owned stdio subreaper"
    );
    let mut child_action: libc::sigaction = unsafe { std::mem::zeroed() };
    child_action.sa_sigaction = libc::SIG_DFL;
    unsafe {
        libc::sigemptyset(&mut child_action.sa_mask);
    }
    ensure!(
        unsafe { libc::sigaction(libc::SIGCHLD, &child_action, std::ptr::null_mut()) } == 0,
        "Cannot retain owned child wait identities"
    );
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = request_stop as *const () as usize;
        action.sa_flags = libc::SA_RESTART;
        unsafe {
            libc::sigemptyset(&mut action.sa_mask);
        }
        ensure!(
            unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } == 0,
            "Cannot install owned stdio stop handler"
        );
    }
    let mut controls: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut controls);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGCHLD] {
            libc::sigaddset(&mut controls, signal);
        }
    }
    ensure!(
        unsafe { libc::sigprocmask(libc::SIG_UNBLOCK, &controls, std::ptr::null_mut()) } == 0,
        "Cannot unblock owned stdio control signals"
    );
    // Check procfs before creating a child; never fall back to unowned launch.
    let _ = children()?;
    if STOP.load(Ordering::Relaxed) || exited(&parent_handle) {
        if let Some(receipt) = &mut receipt {
            receipt.confirm()?;
        }
        return Ok(0);
    }
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .context("Cannot launch owned stdio child")?;
    let child_handle = match pidfd(child.id()) {
        Ok(handle) => handle,
        Err(error) => {
            cleanup_until_stopped(&mut child, None);
            return Err(error);
        }
    };
    loop {
        let observed = match child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                cleanup_until_stopped(&mut child, None);
                return Err(error.into());
            }
        };
        if let Some(status) = observed {
            cleanup_until_stopped(&mut child, Some(status));
            if let Some(receipt) = &mut receipt {
                receipt.confirm()?;
            }
            if command {
                use std::os::unix::process::ExitStatusExt;
                if let Some(signal) = status.signal() {
                    propagate_signal(signal);
                }
            }
            return Ok(status.code().unwrap_or(1));
        }
        if STOP.load(Ordering::Relaxed) || exited(&parent_handle) {
            cleanup_until_stopped(&mut child, None);
            if let Some(receipt) = &mut receipt {
                receipt.confirm()?;
            }
            if command {
                propagate_signal(libc::SIGTERM);
            }
            return Ok(0);
        }
        if command && child_stopped(child.id()) {
            // Keep the host's existing stopped-process detector working. A stop
            // request resumes only the owner so it can clean the stopped target.
            unsafe {
                libc::raise(libc::SIGSTOP);
            }
            if !STOP.load(Ordering::Relaxed) && !exited(&parent_handle) {
                unsafe {
                    libc::kill(child.id() as i32, libc::SIGCONT);
                }
            }
        }
        // Exit and parent loss wake immediately; the short ceiling still checks stops.
        let mut handles = [
            libc::pollfd {
                fd: child_handle.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: parent_handle.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        unsafe {
            libc::poll(handles.as_mut_ptr(), handles.len() as libc::nfds_t, 10);
        }
    }
}

fn propagate_signal(signal: i32) {
    // Cleanup is complete. Preserve the target's actual signal outcome for the host.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = libc::SIG_DFL;
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(signal, &action, std::ptr::null_mut());
        let mut unblocked: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut unblocked);
        libc::sigaddset(&mut unblocked, signal);
        libc::sigprocmask(libc::SIG_UNBLOCK, &unblocked, std::ptr::null_mut());
        libc::raise(signal);
    }
}

fn child_stopped(pid: u32) -> bool {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WSTOPPED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    result == 0 && unsafe { info.si_pid() } == pid as i32
}

fn children() -> Result<Vec<i32>> {
    let file = std::fs::File::open("/proc/thread-self/children")
        .context("Owned stdio procfs unavailable")?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 1024 * 1024,
        "Owned stdio child enumeration exceeded its budget"
    );
    let text = std::str::from_utf8(&bytes)?;
    text.split_whitespace()
        .map(|pid| {
            let pid = pid.parse::<i32>()?;
            ensure!(pid > 1, "Owned stdio child identity invalid");
            Ok(pid)
        })
        .collect()
}

fn cleanup_until_stopped(root: &mut Child, mut status: Option<ExitStatus>) {
    let mut reported = false;
    let started = Instant::now();
    loop {
        if status.is_none() {
            // Stop the known unreaped root even if procfs is temporarily unreadable.
            let _ = root.kill();
        }
        if let Ok(child_pids) = children() {
            for child in &child_pids {
                // This helper has one waiter and never ignores SIGCHLD. Every
                // listed direct child retains its PID until we reap it below.
                unsafe {
                    libc::kill(*child, libc::SIGKILL);
                }
            }
            if status.is_none() {
                status = root.try_wait().ok().flatten();
            }
            for child in child_pids {
                if status.is_none() && child as u32 == root.id() {
                    continue;
                }
                unsafe {
                    libc::waitpid(child, std::ptr::null_mut(), libc::WNOHANG);
                }
            }
            if status.is_some() && children().is_ok_and(|children| children.is_empty()) {
                return;
            }
        }
        if !reported && started.elapsed() > Duration::from_secs(4) {
            // Retain the owner if the kernel has not stopped a child. The host's
            // bounded wait reports cleanup as unconfirmed instead of orphaning it.
            let _ = writeln!(std::io::stderr(), "Owned stdio cleanup is still pending");
            reported = true;
        }
        std::thread::sleep(if reported {
            Duration::from_millis(100)
        } else {
            Duration::from_millis(10)
        });
    }
}
