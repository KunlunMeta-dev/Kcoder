use anyhow::{Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Stdio;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::sync::{OnceLock, mpsc::Sender};
use std::thread;
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(55);
const PROJECT_PRECHECK_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_millis(100);
#[cfg(unix)]
const DROP_REAP_DEADLINE: Duration = Duration::from_millis(100);
#[cfg(unix)]
const BACKGROUND_REAP_ERROR_RETRIES: usize = 3;
#[cfg(unix)]
const BACKGROUND_REAP_DEADLINE: Duration = Duration::from_millis(250);
const CLEANUP_RESERVE: Duration = Duration::from_millis(150);
const OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;
const OUTPUT_TRUNCATED_MARKER: &[u8] = b"\n[output truncated]\n";

#[derive(Clone, Copy)]
struct Deadline {
    started: Instant,
    end: Instant,
}

impl Deadline {
    fn after(timeout: Duration) -> Self {
        let started = Instant::now();
        Self {
            started,
            end: started + timeout,
        }
    }

    #[cfg(unix)]
    fn expired(self) -> bool {
        Instant::now() >= self.end
    }

    fn cleanup_due(self) -> bool {
        self.remaining() <= CLEANUP_RESERVE
    }

    fn remaining(self) -> Duration {
        self.end.saturating_duration_since(Instant::now())
    }

    fn elapsed(self) -> Duration {
        Instant::now().saturating_duration_since(self.started)
    }

    fn pause(self) {
        thread::sleep(POLL_INTERVAL.min(self.remaining()));
    }
}

pub(super) fn resolve_program(program: &str) -> Result<PathBuf> {
    which::which(program).with_context(|| format!("failed to locate {}", program))
}

pub(super) fn resolve_shell_program() -> Result<PathBuf> {
    if let Ok(path) = which::which("sh") {
        return Ok(path);
    }
    #[cfg(windows)]
    for candidate in [
        std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .map(|path| path.join("Git").join("bin").join("sh.exe")),
        std::env::var_os("ProgramFiles(x86)")
            .map(PathBuf::from)
            .map(|path| path.join("Git").join("bin").join("sh.exe")),
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("Programs").join("Git").join("bin").join("sh.exe")),
    ]
    .into_iter()
    .flatten()
    {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    anyhow::bail!("failed to locate sh")
}

#[cfg(test)]
fn run_shell_command(cwd: &Path, shell_path: &Path, script: &str) -> Result<Output> {
    run_shell_command_with_timeout(cwd, shell_path, script, COMMAND_TIMEOUT)
}

pub(super) fn run_project_precheck(cwd: &Path, shell_path: &Path, script: &str) -> Result<Output> {
    run_shell_command_with_timeout(cwd, shell_path, script, PROJECT_PRECHECK_TIMEOUT)
}

pub(super) fn run_cargo_precheck(cwd: &Path, cargo_path: &Path) -> Result<Output> {
    run_cargo_command_with_timeout(cwd, cargo_path, &["test"], PROJECT_PRECHECK_TIMEOUT)
}

fn run_shell_command_with_timeout(
    cwd: &Path,
    shell_path: &Path,
    script: &str,
    timeout: Duration,
) -> Result<Output> {
    let deadline = Deadline::after(timeout);
    let mut command = Command::new(shell_path);
    command.args(["-c", script]);
    apply_clean_command_env(&mut command, cwd);
    command.env("KCODER_SPEC_PRECHECK", "1");
    run_owned_command(command, deadline)
        .with_context(|| format!("failed to run {}", shell_path.display()))
}

pub(super) fn run_cargo_command(cwd: &Path, cargo_path: &Path, args: &[&str]) -> Result<Output> {
    run_cargo_command_with_timeout(cwd, cargo_path, args, COMMAND_TIMEOUT)
}

fn run_cargo_command_with_timeout(
    cwd: &Path,
    cargo_path: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Output> {
    let deadline = Deadline::after(timeout);
    let mut command = Command::new(cargo_path);
    command.args(args);
    apply_clean_command_env(&mut command, cwd);
    #[cfg(windows)]
    apply_windows_msvc_environment(&mut command, deadline)?;
    command.env("CARGO_TERM_COLOR", "always");
    run_owned_command(command, deadline)
        .with_context(|| format!("failed to run {}", cargo_path.display()))
}

#[cfg(unix)]
fn spawn_with_executable_busy_retry(
    command: &mut Command,
    deadline: Deadline,
) -> std::io::Result<std::process::Child> {
    const EXECUTABLE_BUSY: i32 = 26;
    const MAX_ATTEMPTS: usize = 3;

    for attempt in 0..MAX_ATTEMPTS {
        if deadline.expired() {
            return Err(timeout_error(deadline));
        }
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error)
                if error.raw_os_error() == Some(EXECUTABLE_BUSY) && attempt + 1 < MAX_ATTEMPTS =>
            {
                deadline.pause();
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("loop returns on success or final error")
}

enum CaptureRead {
    Data(usize),
    Pending,
    Eof,
}

trait CaptureReader: Read + Send + 'static {
    fn prepare(&self) -> std::io::Result<()>;
    fn read_ready(&mut self, buffer: &mut [u8]) -> std::io::Result<CaptureRead>;
}

#[cfg(unix)]
impl<R> CaptureReader for R
where
    R: Read + std::os::fd::AsRawFd + Send + 'static,
{
    fn prepare(&self) -> std::io::Result<()> {
        let descriptor = self.as_raw_fd();
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
        if flags < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn read_ready(&mut self, buffer: &mut [u8]) -> std::io::Result<CaptureRead> {
        match self.read(buffer) {
            Ok(0) => Ok(CaptureRead::Eof),
            Ok(read) => Ok(CaptureRead::Data(read)),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Ok(CaptureRead::Pending)
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                Ok(CaptureRead::Pending)
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(windows)]
impl<R> CaptureReader for R
where
    R: Read + std::os::windows::io::AsRawHandle + Send + 'static,
{
    fn prepare(&self) -> std::io::Result<()> {
        Ok(())
    }

    fn read_ready(&mut self, buffer: &mut [u8]) -> std::io::Result<CaptureRead> {
        use std::ffi::c_void;

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn PeekNamedPipe(
                pipe: *mut c_void,
                buffer: *mut c_void,
                buffer_size: u32,
                bytes_read: *mut u32,
                total_available: *mut u32,
                bytes_left: *mut u32,
            ) -> i32;
        }

        let mut available = 0u32;
        if unsafe {
            PeekNamedPipe(
                self.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } == 0
        {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(109 | 233) => Ok(CaptureRead::Eof),
                _ => Err(error),
            };
        }
        if available == 0 {
            return Ok(CaptureRead::Pending);
        }
        let limit = buffer.len().min(available as usize);
        match self.read(&mut buffer[..limit])? {
            0 => Ok(CaptureRead::Eof),
            read => Ok(CaptureRead::Data(read)),
        }
    }
}

struct CaptureState {
    bytes: Vec<u8>,
    truncated: bool,
    finished: bool,
    error: Option<std::io::Error>,
}

impl CaptureState {
    fn push(&mut self, chunk: &[u8]) {
        let data_limit = OUTPUT_LIMIT_BYTES.saturating_sub(OUTPUT_TRUNCATED_MARKER.len());
        let remaining = data_limit.saturating_sub(self.bytes.len());
        self.bytes
            .extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() > remaining {
            self.truncated = true;
        }
    }
}

struct BoundedCapture {
    state: Arc<Mutex<CaptureState>>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl BoundedCapture {
    fn spawn<R: CaptureReader>(reader: R) -> std::io::Result<Self> {
        reader.prepare()?;
        let state = Arc::new(Mutex::new(CaptureState {
            bytes: Vec::new(),
            truncated: false,
            finished: false,
            error: None,
        }));
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_state = Arc::clone(&state);
        let worker_cancelled = Arc::clone(&cancelled);
        let worker = thread::Builder::new()
            .name("kcoder-specs-output-capture".into())
            .spawn(move || drain_reader(reader, worker_state, worker_cancelled))?;
        Ok(Self {
            state,
            cancelled,
            worker: Some(worker),
        })
    }

    fn poll(&mut self) -> std::io::Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(error) = state.error.take() {
            return Err(error);
        }
        Ok(())
    }

    fn finished(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .finished
    }

    fn into_bytes(mut self) -> Vec<u8> {
        self.stop();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.truncated {
            state.bytes.extend_from_slice(OUTPUT_TRUNCATED_MARKER);
        }
        std::mem::take(&mut state.bytes)
    }

    fn stop(&mut self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
            #[cfg(test)]
            CAPTURE_WORKERS_JOINED.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        }
    }
}

impl Drop for BoundedCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn drain_reader<R: CaptureReader>(
    mut reader: R,
    state: Arc<Mutex<CaptureState>>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
) {
    #[cfg(test)]
    let _worker_guard = CaptureWorkerGuard::new();
    let mut buffer = vec![0; 8192];
    while !cancelled.load(std::sync::atomic::Ordering::Acquire) {
        match reader.read_ready(&mut buffer) {
            Ok(CaptureRead::Data(read)) => {
                state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push(&buffer[..read]);
            }
            Ok(CaptureRead::Pending) => thread::sleep(POLL_INTERVAL),
            Ok(CaptureRead::Eof) => break,
            Err(error) => {
                state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .error = Some(error);
                break;
            }
        }
    }
    state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .finished = true;
}

#[cfg(test)]
static ACTIVE_CAPTURE_WORKERS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]
static CAPTURE_WORKERS_JOINED: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
struct CaptureWorkerGuard;

#[cfg(test)]
impl CaptureWorkerGuard {
    fn new() -> Self {
        ACTIVE_CAPTURE_WORKERS.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Self
    }
}

#[cfg(test)]
impl Drop for CaptureWorkerGuard {
    fn drop(&mut self) {
        ACTIVE_CAPTURE_WORKERS.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

fn poll_captures(stdout: &mut BoundedCapture, stderr: &mut BoundedCapture) -> std::io::Result<()> {
    stdout.poll()?;
    stderr.poll()
}

fn timeout_error(deadline: Deadline) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        format!(
            "command timed out after {} seconds",
            deadline.elapsed().as_secs_f64()
        ),
    )
}

#[cfg(unix)]
struct UnixOwnedProcess {
    child: Option<std::process::Child>,
    process_group: libc::pid_t,
    cleaned: bool,
}

#[cfg(unix)]
impl UnixOwnedProcess {
    fn spawn(command: &mut Command, deadline: Deadline) -> std::io::Result<Self> {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let child = spawn_with_executable_busy_retry(command, deadline)?;
        Ok(Self {
            process_group: child.id() as libc::pid_t,
            child: Some(child),
            cleaned: false,
        })
    }

    fn child_mut(&mut self) -> std::io::Result<&mut std::process::Child> {
        self.child
            .as_mut()
            .ok_or_else(|| std::io::Error::other("child ownership was already released"))
    }

    fn cleanup(&mut self, deadline: Deadline) -> std::io::Result<()> {
        if self.cleaned {
            return Ok(());
        }
        signal_unix_group(self.process_group, libc::SIGTERM)?;
        let no_cleanup_budget = deadline.end <= deadline.started;
        let grace_end = (Instant::now() + TERMINATE_GRACE).min(deadline.end);
        while !no_cleanup_budget
            && unix_group_liveness(self.process_group).is_conservatively_live()
            && Instant::now() < grace_end
        {
            deadline.pause();
        }
        if no_cleanup_budget || unix_group_liveness(self.process_group).is_conservatively_live() {
            signal_unix_group(self.process_group, libc::SIGKILL)?;
            while !no_cleanup_budget
                && unix_group_liveness(self.process_group).is_conservatively_live()
                && !deadline.expired()
            {
                deadline.pause();
            }
        }
        if !self.try_reap_until(deadline)? {
            self.handoff_to_background_reaper(deadline);
        }
        self.cleaned = true;
        Ok(())
    }

    fn wait_after_group_completion(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let status = self.child_mut()?.wait()?;
        self.child = None;
        self.cleaned = true;
        Ok(status)
    }

    fn try_reap_until(&mut self, deadline: Deadline) -> std::io::Result<bool> {
        if force_background_reaper_transfer(self.child_mut()?.id()) {
            return Ok(false);
        }
        loop {
            match self.child_mut()?.try_wait()? {
                Some(_) => {
                    self.child = None;
                    return Ok(true);
                }
                None if deadline.expired() => return Ok(false),
                None => deadline.pause(),
            }
        }
    }

    fn handoff_to_background_reaper(&mut self, deadline: Deadline) {
        if let Some(child) = self.child.take() {
            register_background_reaper(child, deadline);
        }
    }
}

#[cfg(unix)]
impl Drop for UnixOwnedProcess {
    fn drop(&mut self) {
        if self.cleaned {
            return;
        }
        let _ = signal_unix_group(self.process_group, libc::SIGKILL);
        let deadline = Deadline::after(DROP_REAP_DEADLINE);
        match self.try_reap_until(deadline) {
            Ok(true) => {}
            Ok(false) | Err(_) => self.handoff_to_background_reaper(deadline),
        }
        self.cleaned = true;
    }
}

#[cfg(unix)]
fn register_background_reaper(child: std::process::Child, caller_deadline: Deadline) {
    static REAPER: OnceLock<Option<Sender<std::process::Child>>> = OnceLock::new();
    let sender = REAPER.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel::<std::process::Child>();
        match thread::Builder::new()
            .name("kcoder-specs-child-reaper".into())
            .spawn(move || {
                for child in receiver {
                    let _ = reap_background_child(child, Deadline::after(BACKGROUND_REAP_DEADLINE));
                }
            }) {
            Ok(_) => Some(sender),
            Err(error) => {
                tracing::warn!(%error, "failed to start background child reaper; using fallback");
                None
            }
        }
    });
    let child = match sender {
        Some(sender) if !force_background_reaper_channel_failure(child.id()) => {
            match sender.send(child) {
                Ok(()) => return,
                Err(error) => {
                    tracing::warn!("background child reaper channel closed; using fallback");
                    error.0
                }
            }
        }
        Some(_) | None => child,
    };
    if let Err((error, child)) = spawn_background_reaper_fallback(child) {
        tracing::warn!(%error, "failed to start fallback child reaper; attempting bounded synchronous reap");
        // A persistent wait error cannot remove the deadline from the public caller.
        // Attempt exact reaping only within a bound and record no success until the child is reaped.
        let _ = reap_background_child(child, caller_deadline);
    }
}

#[cfg(unix)]
fn spawn_background_reaper_fallback(
    child: std::process::Child,
) -> Result<(), (std::io::Error, std::process::Child)> {
    if force_background_reaper_fallback_spawn_failure(child.id()) {
        return Err((
            std::io::Error::other("injected fallback reaper spawn failure"),
            child,
        ));
    }
    let child = Arc::new(Mutex::new(Some(child)));
    let worker_child = Arc::clone(&child);
    match thread::Builder::new()
        .name("kcoder-specs-child-reaper-fallback".into())
        .spawn(move || {
            if let Some(child) = worker_child
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                let _ = reap_background_child(child, Deadline::after(BACKGROUND_REAP_DEADLINE));
            }
        }) {
        Ok(_) => Ok(()),
        Err(error) => Err((
            error,
            child
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
                .expect("failed spawn must leave child ownership with the caller"),
        )),
    }
}

#[cfg(unix)]
fn reap_background_child(mut child: std::process::Child, deadline: Deadline) -> bool {
    let pid = child.id();
    let mut non_interrupt_errors = 0;
    loop {
        let result = injected_background_wait_error(pid).map_or_else(|| child.try_wait(), Err);
        match result {
            Ok(Some(status)) => {
                #[cfg(test)]
                record_background_reap(pid, status);
                #[cfg(not(test))]
                let _ = status;
                return true;
            }
            Ok(None) => {
                if deadline.expired() {
                    tracing::warn!(pid, "bounded background child reap deadline expired");
                    return false;
                }
                deadline.pause();
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                if deadline.expired() {
                    tracing::warn!(pid, %error, "bounded background child reap was interrupted until its deadline");
                    return false;
                }
                deadline.pause();
            }
            Err(error) if error.raw_os_error() == Some(libc::ECHILD) => {
                tracing::warn!(pid, %error, "background child is no longer waitable by this process");
                return false;
            }
            Err(error) => {
                non_interrupt_errors += 1;
                tracing::warn!(pid, %error, attempt = non_interrupt_errors, "background child wait failed");
                if non_interrupt_errors >= BACKGROUND_REAP_ERROR_RETRIES || deadline.expired() {
                    tracing::warn!(
                        pid,
                        "giving up background child reap after bounded wait failures"
                    );
                    return false;
                }
                deadline.pause();
            }
        }
    }
}

#[cfg(all(unix, test))]
static FORCE_BACKGROUND_REAPER_TRANSFER_PID: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);
#[cfg(all(unix, test))]
static BACKGROUND_REAPED_CHILDREN: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(all(unix, test))]
static FORCE_BACKGROUND_REAPER_CHANNEL_FAILURE_PID: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);
#[cfg(all(unix, test))]
static FORCE_BACKGROUND_REAPER_FALLBACK_SPAWN_FAILURE_PID: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);
#[cfg(all(unix, test))]
static FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND: std::sync::atomic::AtomicU8 =
    std::sync::atomic::AtomicU8::new(0);
#[cfg(all(unix, test))]
static FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);

#[cfg(all(unix, test))]
#[derive(Clone, Copy)]
struct BackgroundReapRecord {
    pid: u32,
    status: std::process::ExitStatus,
}
#[cfg(all(unix, test))]
static BACKGROUND_REAP_RECORDS: OnceLock<Mutex<Vec<BackgroundReapRecord>>> = OnceLock::new();

#[cfg(all(unix, test))]
fn record_background_reap(pid: u32, status: std::process::ExitStatus) {
    BACKGROUND_REAP_RECORDS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .push(BackgroundReapRecord { pid, status });
    BACKGROUND_REAPED_CHILDREN.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
}

#[cfg(all(unix, test))]
fn take_background_reap_record(pid: u32) -> Option<BackgroundReapRecord> {
    let mut records = BACKGROUND_REAP_RECORDS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    records
        .iter()
        .position(|record| record.pid == pid)
        .map(|index| records.remove(index))
}

#[cfg(unix)]
fn force_background_reaper_channel_failure(pid: u32) -> bool {
    #[cfg(test)]
    {
        FORCE_BACKGROUND_REAPER_CHANNEL_FAILURE_PID
            .compare_exchange(
                pid,
                0,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }
    #[cfg(not(test))]
    {
        let _ = pid;
        false
    }
}

#[cfg(unix)]
fn force_background_reaper_fallback_spawn_failure(pid: u32) -> bool {
    #[cfg(test)]
    {
        FORCE_BACKGROUND_REAPER_FALLBACK_SPAWN_FAILURE_PID
            .compare_exchange(
                pid,
                0,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }
    #[cfg(not(test))]
    {
        let _ = pid;
        false
    }
}

#[cfg(unix)]
fn injected_background_wait_error(pid: u32) -> Option<std::io::Error> {
    #[cfg(test)]
    {
        let kind =
            FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND.load(std::sync::atomic::Ordering::Acquire);
        if kind == 3
            && FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.load(std::sync::atomic::Ordering::Acquire)
                == pid
        {
            return Some(std::io::Error::other(
                "injected persistent background wait failure",
            ));
        }
        if kind == 4
            && FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.load(std::sync::atomic::Ordering::Acquire)
                == pid
        {
            return Some(std::io::Error::from(std::io::ErrorKind::Interrupted));
        }
        if kind == 5
            && FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.load(std::sync::atomic::Ordering::Acquire)
                == pid
        {
            FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.store(0, std::sync::atomic::Ordering::Release);
            FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND
                .store(0, std::sync::atomic::Ordering::Release);
            return Some(std::io::Error::from_raw_os_error(libc::ECHILD));
        }
        if FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID
            .compare_exchange(
                pid,
                0,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_err()
        {
            return None;
        }
        match FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND.swap(0, std::sync::atomic::Ordering::AcqRel)
        {
            1 => Some(std::io::Error::from(std::io::ErrorKind::Interrupted)),
            2 => Some(std::io::Error::other("injected background wait failure")),
            _ => None,
        }
    }
    #[cfg(not(test))]
    {
        let _ = pid;
        None
    }
}

#[cfg(unix)]
fn force_background_reaper_transfer(pid: u32) -> bool {
    #[cfg(test)]
    {
        FORCE_BACKGROUND_REAPER_TRANSFER_PID
            .compare_exchange(
                pid,
                0,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }
    #[cfg(not(test))]
    {
        let _ = pid;
        false
    }
}

#[cfg(unix)]
fn run_owned_command(mut command: Command, deadline: Deadline) -> std::io::Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut owner = UnixOwnedProcess::spawn(&mut command, deadline)?;
    let stdout = owner
        .child_mut()?
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("stdout unavailable"))?;
    let stderr = owner
        .child_mut()?
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("stderr unavailable"))?;
    let mut stdout = BoundedCapture::spawn(stdout)?;
    let mut stderr = BoundedCapture::spawn(stderr)?;
    loop {
        poll_captures(&mut stdout, &mut stderr)?;
        if unix_group_liveness(owner.process_group) == ProcessGroupLiveness::NoLiveProcesses
            && stdout.finished()
            && stderr.finished()
        {
            let status = owner.wait_after_group_completion()?;
            return Ok(Output {
                status,
                stdout: stdout.into_bytes(),
                stderr: stderr.into_bytes(),
            });
        }
        if deadline.cleanup_due() {
            owner.cleanup(deadline)?;
            return Err(timeout_error(deadline));
        }
        deadline.pause();
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessGroupLiveness {
    LiveProcesses,
    NoLiveProcesses,
    Indeterminate,
}

#[cfg(unix)]
impl ProcessGroupLiveness {
    fn is_conservatively_live(self) -> bool {
        self != Self::NoLiveProcesses
    }
}

#[cfg(unix)]
fn unix_group_liveness(process_group: libc::pid_t) -> ProcessGroupLiveness {
    match query_unix_group_has_live_processes(process_group) {
        Ok(true) => ProcessGroupLiveness::LiveProcesses,
        Ok(false) => ProcessGroupLiveness::NoLiveProcesses,
        Err(_) => ProcessGroupLiveness::Indeterminate,
    }
}

#[cfg(unix)]
fn signal_unix_group(process_group: libc::pid_t, signal: libc::c_int) -> std::io::Result<()> {
    if unsafe { libc::kill(-process_group, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(target_os = "linux")]
fn query_unix_group_has_live_processes(process_group: libc::pid_t) -> std::io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<libc::pid_t>() else {
            continue;
        };
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let (group, zombie) = parse_linux_process_stat(&stat)?;
        if group == process_group && !zombie {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn parse_linux_process_stat(stat: &str) -> std::io::Result<(libc::pid_t, bool)> {
    let (_, fields) = stat.rsplit_once(") ").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "truncated proc stat")
    })?;
    let mut fields = fields.split_whitespace();
    let state = fields
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "missing state"))?;
    let _parent = fields
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "missing parent"))?;
    let group = fields
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "missing group"))?
        .parse::<libc::pid_t>()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok((group, state == "Z"))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn query_unix_group_has_live_processes(process_group: libc::pid_t) -> std::io::Result<bool> {
    use std::ffi::c_void;
    use std::mem::{MaybeUninit, size_of};

    let mut capacity = 32usize;
    loop {
        let mut pids = vec![MaybeUninit::<libc::pid_t>::uninit(); capacity];
        let byte_capacity = pids
            .len()
            .checked_mul(size_of::<libc::pid_t>())
            .and_then(|bytes| libc::c_int::try_from(bytes).ok())
            .ok_or_else(|| std::io::Error::other("Darwin process snapshot is too large"))?;
        let bytes = unsafe {
            libc::proc_listpgrppids(
                process_group,
                pids.as_mut_ptr() as *mut c_void,
                byte_capacity,
            )
        };
        if bytes < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if bytes == byte_capacity {
            capacity = capacity
                .checked_mul(2)
                .ok_or_else(|| std::io::Error::other("Darwin process snapshot overflow"))?;
            continue;
        }
        let count = checked_record_count(bytes as usize, size_of::<libc::pid_t>(), capacity)?;
        for pid in pids.into_iter().take(count) {
            let pid = unsafe { pid.assume_init() };
            let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
            let expected = size_of::<libc::proc_bsdinfo>();
            let read = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    info.as_mut_ptr() as *mut c_void,
                    expected as libc::c_int,
                )
            };
            if read == 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    continue;
                }
                return Err(error);
            }
            if read != expected as libc::c_int {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Darwin proc_pidinfo returned a short record",
                ));
            }
            let info = unsafe { info.assume_init() };
            if info.pbi_pgid == process_group as u32 && info.pbi_status != libc::SZOMB {
                return Ok(true);
            }
        }
        return Ok(false);
    }
}

#[cfg(any(
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "openbsd",
    target_os = "netbsd"
))]
fn sysctl_process_records<T>(
    mib: &mut [libc::c_int],
    count_index: Option<usize>,
) -> std::io::Result<Vec<T>> {
    use std::ffi::c_void;
    use std::mem::{MaybeUninit, size_of};

    let record_size = size_of::<T>();
    if record_size == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "zero-sized process record",
        ));
    }
    for _ in 0..4 {
        if let Some(index) = count_index {
            mib[index] = 0;
        }
        let mut requested = 0usize;
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                std::ptr::null_mut(),
                &mut requested,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let capacity = requested
            .div_ceil(record_size)
            .checked_add(32)
            .ok_or_else(|| std::io::Error::other("process snapshot capacity overflow"))?;
        if let Some(index) = count_index {
            mib[index] = libc::c_int::try_from(capacity)
                .map_err(|_| std::io::Error::other("process snapshot count overflow"))?;
        }
        let mut records = Vec::<MaybeUninit<T>>::with_capacity(capacity);
        records.resize_with(capacity, MaybeUninit::uninit);
        let mut actual = capacity
            .checked_mul(record_size)
            .ok_or_else(|| std::io::Error::other("process snapshot byte size overflow"))?;
        let result = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                records.as_mut_ptr() as *mut c_void,
                &mut actual,
                std::ptr::null_mut(),
                0,
            )
        };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if snapshot_error_is_growth(&error) {
                continue;
            }
            return Err(error);
        }
        if actual
            == capacity
                .checked_mul(record_size)
                .ok_or_else(|| std::io::Error::other("process snapshot byte size overflow"))?
        {
            continue;
        }
        let count = checked_record_count(actual, record_size, capacity)?;
        let pointer = records.as_mut_ptr() as *mut T;
        let allocation_capacity = records.capacity();
        std::mem::forget(records);
        return Ok(unsafe { Vec::from_raw_parts(pointer, count, allocation_capacity) });
    }
    Err(std::io::Error::other(
        "process snapshot kept growing while being read",
    ))
}

#[cfg(any(
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "openbsd",
    target_os = "netbsd",
    all(test, unix)
))]
fn snapshot_error_is_growth(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::ENOMEM)
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "openbsd",
    target_os = "netbsd",
    all(test, unix)
))]
fn checked_record_count(
    byte_len: usize,
    record_size: usize,
    capacity: usize,
) -> std::io::Result<usize> {
    if record_size == 0 || !byte_len.is_multiple_of(record_size) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "process snapshot contains a truncated record",
        ));
    }
    let count = byte_len / record_size;
    if count > capacity {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "process snapshot exceeded its buffer",
        ));
    }
    Ok(count)
}

#[cfg(target_os = "freebsd")]
fn query_unix_group_has_live_processes(process_group: libc::pid_t) -> std::io::Result<bool> {
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PGRP,
        process_group,
    ];
    let records = sysctl_process_records::<libc::kinfo_proc>(&mut mib, None)?;
    Ok(records
        .iter()
        .any(|record| record.ki_pgid == process_group && record.ki_stat != libc::SZOMB))
}

#[cfg(target_os = "dragonfly")]
fn query_unix_group_has_live_processes(process_group: libc::pid_t) -> std::io::Result<bool> {
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PGRP,
        process_group,
    ];
    let records = sysctl_process_records::<libc::kinfo_proc>(&mut mib, None)?;
    Ok(records
        .iter()
        .any(|record| record.kp_pgid == process_group && record.kp_stat != libc::procstat::SZOMB))
}

#[cfg(target_os = "openbsd")]
fn query_unix_group_has_live_processes(process_group: libc::pid_t) -> std::io::Result<bool> {
    const OPENBSD_SDEAD: i8 = 6;
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PGRP,
        process_group,
        std::mem::size_of::<libc::kinfo_proc>() as libc::c_int,
        0,
    ];
    let records = sysctl_process_records::<libc::kinfo_proc>(&mut mib, Some(5))?;
    Ok(records
        .iter()
        .any(|record| record.p__pgid == process_group && record.p_stat != OPENBSD_SDEAD))
}

#[cfg(target_os = "netbsd")]
fn query_unix_group_has_live_processes(process_group: libc::pid_t) -> std::io::Result<bool> {
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROC2,
        libc::KERN_PROC_PGRP,
        process_group,
        std::mem::size_of::<libc::kinfo_proc2>() as libc::c_int,
        0,
    ];
    let records = sysctl_process_records::<libc::kinfo_proc2>(&mut mib, Some(5))?;
    Ok(records
        .iter()
        .any(|record| record.p__pgid == process_group && record.p_stat != libc::LSZOMB as i8))
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "openbsd",
        target_os = "netbsd"
    ))
))]
fn query_unix_group_has_live_processes(process_group: libc::pid_t) -> std::io::Result<bool> {
    let result = unsafe { libc::kill(-process_group, 0) };
    if result == 0 {
        Ok(true)
    } else {
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(false),
            Some(libc::EPERM) => Ok(true),
            _ => Err(error),
        }
    }
}

#[cfg(windows)]
fn run_owned_command(command: Command, deadline: Deadline) -> std::io::Result<Output> {
    use kcoder_process_supervisor::client::{
        SpawnSpec, SupervisedChild, locate_supervisor_or_sibling,
    };
    let supervisor = locate_supervisor_or_sibling("KCODER_PROCESS_SUPERVISOR_BIN")
        .map_err(std::io::Error::other)?;
    let spec =
        SpawnSpec::from_command_exact_environment(&command).map_err(std::io::Error::other)?;
    let mut child = SupervisedChild::spawn_with_timeout(spec, &supervisor, deadline.remaining())
        .map_err(std::io::Error::other)?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| std::io::Error::other("supervisor stdout unavailable"))?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| std::io::Error::other("supervisor stderr unavailable"))?;
    let mut stdout = BoundedCapture::spawn(stdout)?;
    let mut stderr = BoundedCapture::spawn(stderr)?;

    loop {
        poll_captures(&mut stdout, &mut stderr)?;
        if let Some(status) = child.try_wait().map_err(std::io::Error::other)?
            && stdout.finished()
            && stderr.finished()
        {
            return Ok(Output {
                status,
                stdout: stdout.into_bytes(),
                stderr: stderr.into_bytes(),
            });
        }
        if deadline.cleanup_due() {
            let reaped = child
                .kill_and_wait(deadline.remaining())
                .map_err(std::io::Error::other)?;
            if reaped.is_none() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Windows supervisor did not reap the process tree before the deadline",
                ));
            }
            return Err(timeout_error(deadline));
        }
        deadline.pause();
    }
}

#[cfg(windows)]
fn apply_windows_msvc_environment(command: &mut Command, deadline: Deadline) -> Result<()> {
    use std::os::windows::process::CommandExt;

    let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
        .map(PathBuf::from)
        .context("ProgramFiles(x86) is unavailable while locating Visual Studio")?;
    let vswhere = program_files_x86
        .join("Microsoft Visual Studio")
        .join("Installer")
        .join("vswhere.exe");
    if !vswhere.is_file() {
        anyhow::bail!("vswhere.exe was not found at {}", vswhere.display());
    }

    let mut locate = Command::new(&vswhere);
    locate.args([
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
    ]);
    apply_clean_command_env(&mut locate, Path::new(r"C:\"));
    let locate_output = run_owned_command(locate, deadline)
        .with_context(|| format!("failed to run {}", vswhere.display()))?;
    if !locate_output.status.success() {
        anyhow::bail!(
            "vswhere.exe failed while locating MSVC Build Tools: {}",
            String::from_utf8_lossy(&locate_output.stderr)
        );
    }
    let installation_output = String::from_utf8_lossy(&locate_output.stdout);
    let installation = installation_output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .context("MSVC Build Tools were not found")?;
    let dev_cmd = Path::new(installation)
        .join("Common7")
        .join("Tools")
        .join("VsDevCmd.bat");
    if !dev_cmd.is_file() {
        anyhow::bail!("VsDevCmd.bat was not found at {}", dev_cmd.display());
    }

    let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let script = format!(
        "call \"{}\" -arch=x64 -host_arch=x64 >nul && set",
        dev_cmd.display()
    );
    let mut capture = Command::new(comspec);
    capture.args(["/d", "/c"]);
    capture.raw_arg(&script);
    apply_clean_command_env(&mut capture, Path::new(r"C:\"));
    let capture_output = run_owned_command(capture, deadline)
        .with_context(|| format!("failed to initialize MSVC through {}", dev_cmd.display()))?;
    if !capture_output.status.success() {
        anyhow::bail!(
            "VsDevCmd.bat failed: {}",
            String::from_utf8_lossy(&capture_output.stderr)
        );
    }
    for (name, value) in parse_windows_environment_block(&capture_output.stdout) {
        command.env(name, value);
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn parse_windows_environment_block(output: &[u8]) -> Vec<(String, String)> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let (name, value) = line.trim_end_matches('\r').split_once('=')?;
            (!name.is_empty()).then(|| (name.to_string(), value.to_string()))
        })
        .collect()
}

pub(super) fn run_git_command(cwd: &Path, git_path: &Path, args: &[&str]) -> Result<Output> {
    let deadline = Deadline::after(COMMAND_TIMEOUT);
    let mut command = Command::new(git_path);
    command.args(args);
    apply_clean_command_env(&mut command, cwd);
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "");
    run_owned_command(command, deadline)
        .with_context(|| format!("failed to run {}", git_path.display()))
}

fn apply_clean_command_env(command: &mut Command, cwd: &Path) {
    command.current_dir(cwd).env_clear().env("PWD", cwd);
    #[cfg(not(windows))]
    {
        let mut paths = Vec::new();
        for program in ["cargo", "rustc"] {
            if let Ok(executable) = resolve_program(program)
                && executable.is_absolute()
                && let Some(parent) = executable.parent()
                && !paths.iter().any(|path| path == parent)
            {
                paths.push(parent.to_path_buf());
            }
        }
        paths.extend(std::env::split_paths(std::ffi::OsStr::new(
            "/usr/local/bin:/usr/bin:/bin",
        )));
        if let Ok(path) = std::env::join_paths(paths) {
            command.env("PATH", path);
        }
        command.env("TERM", "xterm-256color");
        // Preserve only toolchain locations, not HOME or the caller's full environment.
        for (name, fallback) in [("CARGO_HOME", ".cargo"), ("RUSTUP_HOME", ".rustup")] {
            let path = std::env::var_os(name).map(PathBuf::from).or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(fallback))
            });
            if let Some(path) = path.filter(|path| path.is_absolute()) {
                command.env(name, path);
            }
        }
        for name in ["CARGO_TARGET_DIR", "RUSTUP_TOOLCHAIN"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
    #[cfg(windows)]
    for name in [
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
        "PATH",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
        "ALLUSERSPROFILE",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "CommonProgramW6432",
        "LOCALAPPDATA",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "CARGO_TARGET_DIR",
        "RUSTUP_TOOLCHAIN",
        "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
        "RUSTDOCFLAGS",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    const ESCAPED_PIPE_HELPER_DIRECTORY: &str = "KCODER_TEST_ESCAPED_PIPE_DIRECTORY";
    #[cfg(unix)]
    static BACKGROUND_REAPER_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(unix)]
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct EscapedProcessPids {
        coordinator: libc::pid_t,
        holder: libc::pid_t,
    }

    #[cfg(unix)]
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct ReapedProcessStatus {
        pid: libc::pid_t,
        status: libc::c_int,
    }

    #[cfg(unix)]
    struct EscapedFixtureGuard {
        ready: PathBuf,
        stop: PathBuf,
        pids: Option<EscapedProcessPids>,
        finished: bool,
    }

    #[cfg(unix)]
    impl EscapedFixtureGuard {
        fn new(directory: &Path) -> Self {
            Self {
                ready: directory.join("ready"),
                stop: directory.join("stop"),
                pids: None,
                finished: false,
            }
        }

        fn read_pids(&mut self) -> EscapedProcessPids {
            let deadline = Instant::now() + Duration::from_secs(1);
            while fs::metadata(&self.ready)
                .map(|metadata| metadata.len() < std::mem::size_of::<EscapedProcessPids>() as u64)
                .unwrap_or(true)
                && Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(5));
            }
            let bytes = fs::read(&self.ready).expect("escaped helper must record both PIDs");
            assert_eq!(bytes.len(), std::mem::size_of::<EscapedProcessPids>());
            let mut pids = EscapedProcessPids::default();
            unsafe {
                std::ptr::copy_nonoverlapping(
                    bytes.as_ptr(),
                    (&mut pids as *mut EscapedProcessPids).cast(),
                    bytes.len(),
                );
            }
            self.pids = Some(pids);
            pids
        }

        fn finish(mut self, status_path: &Path) -> ReapedProcessStatus {
            let pids = self.pids.unwrap_or_else(|| self.read_pids());
            fs::write(&self.stop, b"reap").unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while fs::metadata(status_path)
                .map(|metadata| metadata.len() < std::mem::size_of::<ReapedProcessStatus>() as u64)
                .unwrap_or(true)
                && Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(5));
            }
            let bytes = fs::read(status_path).expect("coordinator must report exact wait status");
            assert_eq!(bytes.len(), std::mem::size_of::<ReapedProcessStatus>());
            let mut record = ReapedProcessStatus::default();
            unsafe {
                std::ptr::copy_nonoverlapping(
                    bytes.as_ptr(),
                    (&mut record as *mut ReapedProcessStatus).cast(),
                    bytes.len(),
                );
            }
            wait_for_fixture_pid_exit(pids.holder, deadline);
            wait_for_fixture_pid_exit(pids.coordinator, deadline);
            assert!(
                !unix_pid_is_live(pids.holder),
                "holder must reach terminal state"
            );
            assert!(
                !unix_pid_is_live(pids.coordinator),
                "coordinator must reach terminal state"
            );
            self.finished = true;
            record
        }
    }

    #[cfg(unix)]
    impl Drop for EscapedFixtureGuard {
        fn drop(&mut self) {
            if self.finished {
                return;
            }
            let _ = fs::write(&self.stop, b"cleanup");
            let ready_deadline = Instant::now() + Duration::from_secs(1);
            let pids = self.pids.or_else(|| {
                loop {
                    if let Some(pids) = read_escaped_pids(&self.ready) {
                        break Some(pids);
                    }
                    if Instant::now() >= ready_deadline {
                        break None;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
            });
            let Some(pids) = pids else {
                return;
            };
            let grace = Instant::now() + Duration::from_millis(250);
            wait_for_fixture_pid_exit(pids.holder, grace);
            wait_for_fixture_pid_exit(pids.coordinator, grace);
            for pid in [pids.holder, pids.coordinator] {
                if unix_pid_is_live(pid) {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
            let deadline = Instant::now() + Duration::from_secs(1);
            wait_for_fixture_pid_exit(pids.holder, deadline);
            wait_for_fixture_pid_exit(pids.coordinator, deadline);
        }
    }

    #[cfg(unix)]
    fn read_escaped_pids(path: &Path) -> Option<EscapedProcessPids> {
        let bytes = fs::read(path).ok()?;
        if bytes.len() != std::mem::size_of::<EscapedProcessPids>() {
            return None;
        }
        let mut pids = EscapedProcessPids::default();
        unsafe {
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                (&mut pids as *mut EscapedProcessPids).cast(),
                bytes.len(),
            );
        }
        Some(pids)
    }

    #[cfg(unix)]
    fn wait_for_fixture_pid_exit(pid: libc::pid_t, deadline: Instant) {
        while unix_pid_is_live(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    fn wait_for_background_reap(pid: u32) -> BackgroundReapRecord {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(record) = take_background_reap_record(pid) {
                return record;
            }
            assert!(
                Instant::now() < deadline,
                "background reaper did not report exact child {pid}"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    fn waitpid_exact(pid: u32) -> libc::c_int {
        let mut status = 0;
        let waited = loop {
            let waited = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, 0) };
            if waited < 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
                continue;
            }
            break waited;
        };
        assert_eq!(waited, pid as libc::pid_t);
        status
    }

    #[cfg(unix)]
    fn background_reaper_test_owner() -> (UnixOwnedProcess, u32, tempfile::TempDir) {
        let directory = tmp_dir();
        let ready = directory.path().join("ready");
        let ready_arg = ready.to_string_lossy().into_owned();
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "trap '' TERM; printf ready > \"$1\"; exec sleep 30",
            "sh",
            &ready_arg,
        ]);
        let owner =
            UnixOwnedProcess::spawn(&mut command, Deadline::after(Duration::from_secs(1))).unwrap();
        let pid = owner.child.as_ref().unwrap().id();
        let deadline = Instant::now() + Duration::from_secs(1);
        while !ready.is_file() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            ready.is_file(),
            "test child did not install its signal policy"
        );
        (owner, pid, directory)
    }

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[cfg(windows)]
    fn windows_powershell() -> PathBuf {
        PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot must be set"))
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
    }

    #[cfg(windows)]
    fn windows_command(script: &str, extra_env: &[(&str, &Path)]) -> Command {
        let mut command = Command::new(windows_powershell());
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ])
            .current_dir(std::env::current_dir().unwrap())
            .env_clear();
        for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        for (name, value) in extra_env {
            command.env(name, value);
        }
        command
    }

    #[cfg(windows)]
    fn windows_process_has_exited(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
        const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
        let handle = unsafe { OpenProcess(SYNCHRONIZE_ACCESS, 0, pid) };
        if handle.is_null() {
            return true;
        }
        let exited = unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
        unsafe { CloseHandle(handle) };
        exited
    }

    #[cfg(windows)]
    fn windows_recorded_pids(path: &Path) -> Vec<u32> {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| line.trim().parse().unwrap())
            .collect()
    }

    #[cfg(unix)]
    fn make_executable(path: &Path, content: &str) {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, content).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn escaped_pipe_process_helper() {
        use std::os::unix::ffi::OsStrExt;

        let Some(directory) = std::env::var_os(ESCAPED_PIPE_HELPER_DIRECTORY) else {
            return;
        };
        let directory = PathBuf::from(directory);
        let ready = std::ffi::CString::new(directory.join("ready").as_os_str().as_bytes()).unwrap();
        let stop = std::ffi::CString::new(directory.join("stop").as_os_str().as_bytes()).unwrap();
        let status_path =
            std::ffi::CString::new(directory.join("status").as_os_str().as_bytes()).unwrap();
        let ready_descriptor = unsafe {
            libc::open(
                ready.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
        };
        let status_descriptor = unsafe {
            libc::open(
                status_path.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
        };
        assert!(ready_descriptor >= 0 && status_descriptor >= 0);
        let coordinator = unsafe { libc::fork() };
        assert!(coordinator >= 0);
        if coordinator == 0 {
            unsafe {
                if libc::setsid() < 0 {
                    libc::_exit(90);
                }
                let holder = libc::fork();
                if holder < 0 {
                    libc::_exit(91);
                }
                if holder == 0 {
                    libc::close(ready_descriptor);
                    libc::close(status_descriptor);
                    loop {
                        libc::pause();
                    }
                }
                libc::close(libc::STDOUT_FILENO);
                libc::close(libc::STDERR_FILENO);
                let pids = EscapedProcessPids {
                    coordinator: libc::getpid(),
                    holder,
                };
                if libc::write(
                    ready_descriptor,
                    (&pids as *const EscapedProcessPids).cast(),
                    std::mem::size_of::<EscapedProcessPids>(),
                ) != std::mem::size_of::<EscapedProcessPids>() as isize
                {
                    libc::kill(holder, libc::SIGKILL);
                    let mut status = 0;
                    while libc::waitpid(holder, &mut status, 0) < 0
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR)
                    {
                    }
                    libc::_exit(92);
                }
                libc::close(ready_descriptor);
                while libc::access(stop.as_ptr(), libc::F_OK) != 0 {
                    libc::usleep(5_000);
                }
                libc::kill(holder, libc::SIGKILL);
                let mut status = 0;
                let waited = loop {
                    let waited = libc::waitpid(holder, &mut status, 0);
                    if waited < 0
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR)
                    {
                        continue;
                    }
                    break waited;
                };
                if waited != holder {
                    libc::_exit(93);
                }
                let record = ReapedProcessStatus {
                    pid: holder,
                    status,
                };
                let written = libc::write(
                    status_descriptor,
                    (&record as *const ReapedProcessStatus).cast(),
                    std::mem::size_of::<ReapedProcessStatus>(),
                );
                libc::close(status_descriptor);
                libc::_exit(
                    if written == std::mem::size_of::<ReapedProcessStatus>() as isize {
                        0
                    } else {
                        94
                    },
                );
            }
        }
        unsafe {
            libc::close(ready_descriptor);
            libc::close(status_descriptor);
        }
    }

    #[cfg(unix)]
    #[test]
    fn escaped_group_descendant_holding_pipe_has_a_bounded_failure() {
        let dir = tmp_dir();
        let status_path = dir.path().join("status");
        let mut fixture = EscapedFixtureGuard::new(dir.path());
        let joined_workers = CAPTURE_WORKERS_JOINED.load(std::sync::atomic::Ordering::Acquire);
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process::tests::escaped_pipe_process_helper",
                "--nocapture",
            ])
            .env(ESCAPED_PIPE_HELPER_DIRECTORY, dir.path());
        let started = Instant::now();
        let error = run_owned_command(command, Deadline::after(Duration::from_millis(500)))
            .expect_err("escaped descendant holding stdout must force a bounded timeout");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(
            CAPTURE_WORKERS_JOINED.load(std::sync::atomic::Ordering::Acquire) >= joined_workers + 2,
            "public return must join both capture workers"
        );
        let pids = fixture.read_pids();
        #[cfg(target_os = "linux")]
        assert_no_local_descriptor_for_holder_pipe(pids.holder);
        let record = fixture.finish(&status_path);
        assert_eq!(record.pid, pids.holder);
        assert!(libc::WIFSIGNALED(record.status));
        assert_eq!(libc::WTERMSIG(record.status), libc::SIGKILL);
        assert!(!unix_pid_is_live(pids.holder));
        assert!(!unix_pid_is_live(pids.coordinator));
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_hands_an_unreaped_child_to_the_background_reaper_within_deadline() {
        let _guard = BACKGROUND_REAPER_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let baseline = BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire);
        let (mut owner, pid, _directory) = background_reaper_test_owner();
        FORCE_BACKGROUND_REAPER_TRANSFER_PID.store(pid, std::sync::atomic::Ordering::Release);
        let started = Instant::now();

        owner
            .cleanup(Deadline::after(Duration::from_millis(300)))
            .unwrap();

        assert!(started.elapsed() < Duration::from_secs(1));
        let record = wait_for_background_reap(pid);
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(record.status.signal(), Some(libc::SIGKILL));
        assert_eq!(
            BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire),
            baseline + 1
        );
        assert!(!unix_pid_exists(pid as libc::pid_t));
    }

    #[cfg(unix)]
    #[test]
    fn drop_hands_an_unreaped_child_to_the_background_reaper_without_blocking() {
        let _guard = BACKGROUND_REAPER_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let baseline = BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire);
        let (owner, pid, _directory) = background_reaper_test_owner();
        FORCE_BACKGROUND_REAPER_TRANSFER_PID.store(pid, std::sync::atomic::Ordering::Release);
        let started = Instant::now();

        drop(owner);

        assert!(started.elapsed() < Duration::from_millis(500));
        let record = wait_for_background_reap(pid);
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(record.status.signal(), Some(libc::SIGKILL));
        assert_eq!(
            BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire),
            baseline + 1
        );
        assert!(!unix_pid_exists(pid as libc::pid_t));
    }

    #[cfg(unix)]
    #[test]
    fn background_reaper_faults_still_reap_exact_child_once() {
        let _guard = BACKGROUND_REAPER_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        use std::os::unix::process::ExitStatusExt;

        for (channel_failure, fallback_failure, wait_failure) in [
            (true, false, 0),
            (true, true, 0),
            (false, false, 1),
            (false, false, 2),
        ] {
            let baseline = BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire);
            let (owner, pid, _directory) = background_reaper_test_owner();
            FORCE_BACKGROUND_REAPER_TRANSFER_PID.store(pid, std::sync::atomic::Ordering::Release);
            FORCE_BACKGROUND_REAPER_CHANNEL_FAILURE_PID.store(
                if channel_failure { pid } else { 0 },
                std::sync::atomic::Ordering::Release,
            );
            FORCE_BACKGROUND_REAPER_FALLBACK_SPAWN_FAILURE_PID.store(
                if fallback_failure { pid } else { 0 },
                std::sync::atomic::Ordering::Release,
            );
            FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND
                .store(wait_failure, std::sync::atomic::Ordering::Release);
            FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.store(
                if wait_failure == 0 { 0 } else { pid },
                std::sync::atomic::Ordering::Release,
            );

            drop(owner);

            let record = wait_for_background_reap(pid);
            assert_eq!(record.pid, pid);
            assert_eq!(record.status.signal(), Some(libc::SIGKILL));
            assert_eq!(
                BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire),
                baseline + 1,
                "failed wait must not be counted as a successful reap"
            );
            assert!(!unix_pid_exists(pid as libc::pid_t));
        }
    }

    #[cfg(unix)]
    #[test]
    fn persistent_wait_error_and_double_handoff_failure_return_without_false_reap() {
        let _guard = BACKGROUND_REAPER_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let baseline = BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire);
        let (owner, pid, _directory) = background_reaper_test_owner();
        FORCE_BACKGROUND_REAPER_TRANSFER_PID.store(pid, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_CHANNEL_FAILURE_PID
            .store(pid, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_FALLBACK_SPAWN_FAILURE_PID
            .store(pid, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND.store(3, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.store(pid, std::sync::atomic::Ordering::Release);
        let started = Instant::now();

        drop(owner);

        assert!(
            started.elapsed() < Duration::from_millis(500),
            "channel/fallback 双失败不应让公共线程超出 deadline"
        );
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND.store(0, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.store(0, std::sync::atomic::Ordering::Release);
        assert!(
            take_background_reap_record(pid).is_none(),
            "持久 wait 错误不能被记录为成功回收"
        );
        assert_eq!(
            BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire),
            baseline
        );

        let mut status = 0;
        let waited = loop {
            let waited = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, 0) };
            if waited < 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
                continue;
            }
            break waited;
        };
        assert_eq!(waited, pid as libc::pid_t);
        assert!(libc::WIFSIGNALED(status));
        assert_eq!(libc::WTERMSIG(status), libc::SIGKILL);
        assert!(!unix_pid_exists(pid as libc::pid_t));
    }

    #[cfg(unix)]
    #[test]
    fn persistent_interrupted_wait_does_not_starve_the_next_queued_child() {
        let _guard = BACKGROUND_REAPER_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let baseline = BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire);
        let (first, first_pid, _first_directory) = background_reaper_test_owner();
        FORCE_BACKGROUND_REAPER_TRANSFER_PID.store(first_pid, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND.store(4, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID
            .store(first_pid, std::sync::atomic::Ordering::Release);
        drop(first);

        let (second, second_pid, _second_directory) = background_reaper_test_owner();
        FORCE_BACKGROUND_REAPER_TRANSFER_PID
            .store(second_pid, std::sync::atomic::Ordering::Release);
        let started = Instant::now();
        drop(second);

        let second_record = wait_for_background_reap(second_pid);
        assert!(started.elapsed() < Duration::from_secs(1));
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(second_record.status.signal(), Some(libc::SIGKILL));
        assert!(
            take_background_reap_record(first_pid).is_none(),
            "持续 EINTR 不能被虚报为成功回收"
        );
        assert_eq!(
            BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire),
            baseline + 1
        );

        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND.store(0, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.store(0, std::sync::atomic::Ordering::Release);
        let status = waitpid_exact(first_pid);
        assert!(libc::WIFSIGNALED(status));
        assert_eq!(libc::WTERMSIG(status), libc::SIGKILL);
        assert!(!unix_pid_exists(first_pid as libc::pid_t));
        assert!(!unix_pid_exists(second_pid as libc::pid_t));
    }

    #[cfg(unix)]
    #[test]
    fn echild_stops_reaping_immediately_without_recording_success() {
        let _guard = BACKGROUND_REAPER_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let baseline = BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire);
        let (mut owner, pid, _directory) = background_reaper_test_owner();
        let mut child = owner.child.take().unwrap();
        owner.cleaned = true;
        child.kill().unwrap();
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND.store(5, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.store(pid, std::sync::atomic::Ordering::Release);
        let started = Instant::now();

        assert!(!reap_background_child(
            child,
            Deadline::after(Duration::from_secs(1))
        ));

        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(take_background_reap_record(pid).is_none());
        assert_eq!(
            BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire),
            baseline
        );
        let status = waitpid_exact(pid);
        assert!(libc::WIFSIGNALED(status));
        assert_eq!(libc::WTERMSIG(status), libc::SIGKILL);
    }

    #[cfg(unix)]
    #[test]
    fn exhausted_cleanup_deadline_makes_double_handoff_failure_return_immediately() {
        let _guard = BACKGROUND_REAPER_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let baseline = BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire);
        let (mut owner, pid, _directory) = background_reaper_test_owner();
        FORCE_BACKGROUND_REAPER_TRANSFER_PID.store(pid, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_CHANNEL_FAILURE_PID
            .store(pid, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_FALLBACK_SPAWN_FAILURE_PID
            .store(pid, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND.store(3, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.store(pid, std::sync::atomic::Ordering::Release);
        let started = Instant::now();

        owner.cleanup(Deadline::after(Duration::ZERO)).unwrap();

        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(take_background_reap_record(pid).is_none());
        assert_eq!(
            BACKGROUND_REAPED_CHILDREN.load(std::sync::atomic::Ordering::Acquire),
            baseline
        );
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_KIND.store(0, std::sync::atomic::Ordering::Release);
        FORCE_BACKGROUND_REAPER_WAIT_FAILURE_PID.store(0, std::sync::atomic::Ordering::Release);
        let status = waitpid_exact(pid);
        assert!(libc::WIFSIGNALED(status));
        assert_eq!(libc::WTERMSIG(status), libc::SIGKILL);
    }

    #[cfg(unix)]
    #[test]
    fn process_snapshot_parsers_reject_truncation_and_classify_growth_errors() {
        assert_eq!(
            parse_linux_process_stat("9 (worker) R 1 77 0").unwrap(),
            (77, false)
        );
        assert_eq!(
            parse_linux_process_stat("9 (worker) Z 1 77 0").unwrap(),
            (77, true)
        );
        assert!(parse_linux_process_stat("truncated").is_err());
        assert_eq!(checked_record_count(16, 8, 2).unwrap(), 2);
        assert!(checked_record_count(15, 8, 2).is_err());
        assert!(checked_record_count(24, 8, 2).is_err());
        assert!(snapshot_error_is_growth(
            &std::io::Error::from_raw_os_error(libc::ENOMEM)
        ));
        assert!(!snapshot_error_is_growth(
            &std::io::Error::from_raw_os_error(libc::EPERM)
        ));
        assert!(ProcessGroupLiveness::Indeterminate.is_conservatively_live());
    }

    #[cfg(unix)]
    fn run_native_snapshot_in_subprocess(test: &str) -> bool {
        use std::io::Write;

        const FIXTURE: &str = "KCODER_TEST_NATIVE_SNAPSHOT_FIXTURE";
        if std::env::var(FIXTURE).as_deref() == Ok(test) {
            let mut ready = [0];
            std::io::stdin().read_exact(&mut ready).unwrap();
            return false;
        }

        // A raw fork in the parallel harness can retain another test's writable
        // script descriptor indefinitely. Exec first to close CLOEXEC descriptors.
        let probe_dir = tmp_dir();
        let probe = probe_dir.path().join("probe");
        let completed = probe_dir.path().join("completed");
        make_executable(&probe, "#!/bin/sh\nexit 0\n");
        let writer = fs::OpenOptions::new().write(true).open(&probe).unwrap();
        let deadline = Deadline::after(Duration::from_secs(5));
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", test, "--nocapture"])
            .env(FIXTURE, test)
            .env("KCODER_TEST_NATIVE_SNAPSHOT_PROBE", &probe)
            .env("KCODER_TEST_NATIVE_SNAPSHOT_COMPLETED", &completed)
            .stdin(Stdio::piped());
        let mut owner = UnixOwnedProcess::spawn(&mut command, deadline).unwrap();
        drop(writer);
        owner
            .child_mut()
            .unwrap()
            .stdin
            .take()
            .unwrap()
            .write_all(&[1])
            .unwrap();
        let status = loop {
            if let Some(status) = owner.child_mut().unwrap().try_wait().unwrap() {
                break status;
            }
            if deadline.cleanup_due() {
                owner.cleanup(deadline).unwrap();
                panic!("fixture {test} timed out");
            }
            deadline.pause();
        };
        owner.cleanup(deadline).unwrap();
        assert!(status.success(), "fixture {test} failed: {status}");
        assert!(
            completed.is_file(),
            "fixture {test} did not complete its leaf"
        );
        assert_eq!(fs::read_to_string(completed).unwrap(), test);
        true
    }

    #[cfg(unix)]
    fn complete_native_snapshot_fixture() {
        fs::write(
            std::env::var_os("KCODER_TEST_NATIVE_SNAPSHOT_COMPLETED").unwrap(),
            std::env::var("KCODER_TEST_NATIVE_SNAPSHOT_FIXTURE").unwrap(),
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    #[should_panic(expected = "did not complete its leaf")]
    fn native_snapshot_fixture_rejects_empty_test_selection() {
        run_native_snapshot_in_subprocess("process::tests::nonexistent_snapshot_fixture");
    }

    #[cfg(unix)]
    #[test]
    fn native_snapshot_reports_a_reapable_group_leader_as_zombie_only() {
        if run_native_snapshot_in_subprocess(
            "process::tests::native_snapshot_reports_a_reapable_group_leader_as_zombie_only",
        ) {
            return;
        }
        let mut ready = [0; 2];
        assert_eq!(unsafe { libc::pipe(ready.as_mut_ptr()) }, 0);
        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            unsafe {
                libc::close(ready[0]);
                if libc::setsid() < 0 {
                    libc::_exit(90);
                }
                let byte = [1u8];
                libc::write(ready[1], byte.as_ptr().cast(), 1);
                libc::_exit(0);
            }
        }
        unsafe { libc::close(ready[1]) };
        let mut byte = [0u8];
        assert_eq!(
            unsafe { libc::read(ready[0], byte.as_mut_ptr().cast(), 1) },
            1
        );
        unsafe { libc::close(ready[0]) };
        let deadline = Instant::now() + Duration::from_secs(1);
        let state = loop {
            let state = unix_group_liveness(child);
            if state == ProcessGroupLiveness::NoLiveProcesses || Instant::now() >= deadline {
                break state;
            }
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(state, ProcessGroupLiveness::NoLiveProcesses);
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
        assert!(libc::WIFEXITED(status));
        complete_native_snapshot_fixture();
    }

    #[cfg(unix)]
    #[test]
    fn native_snapshot_keeps_a_live_descendant_after_its_leader_exits() {
        if run_native_snapshot_in_subprocess(
            "process::tests::native_snapshot_keeps_a_live_descendant_after_its_leader_exits",
        ) {
            return;
        }
        let mut ready = [0; 2];
        assert_eq!(unsafe { libc::pipe(ready.as_mut_ptr()) }, 0);
        let leader = unsafe { libc::fork() };
        assert!(leader >= 0);
        if leader == 0 {
            unsafe {
                libc::close(ready[0]);
                if libc::setsid() < 0 {
                    libc::_exit(90);
                }
                let descendant = libc::fork();
                if descendant < 0 {
                    libc::_exit(91);
                }
                if descendant == 0 {
                    loop {
                        libc::pause();
                    }
                }
                libc::write(
                    ready[1],
                    (&descendant as *const libc::pid_t).cast(),
                    std::mem::size_of::<libc::pid_t>(),
                );
                libc::_exit(0);
            }
        }
        unsafe { libc::close(ready[1]) };
        let mut descendant = 0;
        assert_eq!(
            unsafe {
                libc::read(
                    ready[0],
                    (&mut descendant as *mut libc::pid_t).cast(),
                    std::mem::size_of::<libc::pid_t>(),
                )
            },
            std::mem::size_of::<libc::pid_t>() as isize
        );
        unsafe { libc::close(ready[0]) };
        let probe_result =
            Command::new(std::env::var_os("KCODER_TEST_NATIVE_SNAPSHOT_PROBE").unwrap()).status();
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if unix_group_liveness(leader) == ProcessGroupLiveness::LiveProcesses {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "live descendant was not observed"
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(unsafe { libc::kill(-leader, libc::SIGKILL) }, 0);
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(leader, &mut status, 0) }, leader);
        let cleanup_deadline = Instant::now() + Duration::from_secs(1);
        while unix_pid_is_live(descendant) && Instant::now() < cleanup_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(!unix_pid_is_live(descendant));
        assert!(probe_result.unwrap().success());
        complete_native_snapshot_fixture();
    }

    #[cfg(unix)]
    #[test]
    fn shell_precheck_uses_clean_environment_and_cwd() {
        let dir = tmp_dir();
        let fake_shell = dir.path().join("sh");
        make_executable(
            &fake_shell,
            "#!/bin/sh\nif [ \"${HOME-unset}\" != \"unset\" ]; then exit 2; fi\nif [ \"$KCODER_SPEC_PRECHECK\" != \"1\" ]; then exit 3; fi\nprintf '%s\\n' \"$PWD\"\n",
        );

        let output = run_shell_command(dir.path(), &fake_shell, "echo ignored").unwrap();

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            dir.path().to_string_lossy().as_ref()
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_precheck_can_resolve_the_selected_rust_toolchain_without_home() {
        let dir = tmp_dir();
        let shell = resolve_shell_program().unwrap();
        let output = run_shell_command(
            dir.path(),
            &shell,
            "test -z \"${HOME+x}\" && cargo --version && rustc --version",
        )
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("cargo "), "{stdout}");
        assert!(stdout.contains("rustc "), "{stdout}");
    }

    #[cfg(unix)]
    #[test]
    fn project_precheck_has_a_separate_bounded_deadline() {
        assert_eq!(COMMAND_TIMEOUT, Duration::from_secs(55));
        assert_eq!(PROJECT_PRECHECK_TIMEOUT, Duration::from_secs(1800));
        let dir = tmp_dir();
        let shell = resolve_shell_program().unwrap();
        let short = run_shell_command_with_timeout(
            dir.path(),
            &shell,
            "sleep 1",
            Duration::from_millis(30),
        );
        assert!(short.is_err());
        let completed =
            run_project_precheck(dir.path(), &shell, "printf precheck-completed").unwrap();
        assert!(completed.status.success());
        assert_eq!(completed.stdout, b"precheck-completed");
    }

    #[cfg(windows)]
    #[test]
    fn shell_precheck_keeps_windows_runtime_environment_and_cwd() {
        let dir = tmp_dir();
        let shell = resolve_shell_program().unwrap();
        let output = run_shell_command(
            dir.path(),
            &shell,
            "printf 'root=%s\\nmanifest=%s\\nprecheck=%s\\n' \"${SystemRoot-${SYSTEMROOT-unset}}\" \"${CARGO_MANIFEST_DIR-unset}\" \"$KCODER_SPEC_PRECHECK\"; printf cwd-ok > shell-cwd.txt",
        )
        .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success(), "{stdout}");
        assert!(!stdout.contains("root=unset"), "{stdout}");
        assert!(stdout.contains("manifest=unset"), "{stdout}");
        assert!(stdout.contains("precheck=1"), "{stdout}");
        assert_eq!(
            fs::read_to_string(dir.path().join("shell-cwd.txt")).unwrap(),
            "cwd-ok"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cargo_precheck_uses_clean_environment_and_cwd() {
        let dir = tmp_dir();
        let fake_cargo = dir.path().join("cargo");
        make_executable(
            &fake_cargo,
            "#!/bin/sh\nif [ \"${HOME-unset}\" != \"unset\" ]; then exit 2; fi\nif [ \"$CARGO_TERM_COLOR\" != \"always\" ]; then exit 3; fi\nprintf 'pwd=%s\\nargs=%s\\n' \"$PWD\" \"$*\"\n",
        );

        let output = run_cargo_command(dir.path(), &fake_cargo, &["test", "--quiet"]).unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success());
        assert!(stdout.contains(&format!("pwd={}", dir.path().display())));
        assert!(stdout.contains("args=test --quiet"));
    }

    #[cfg(unix)]
    #[test]
    fn cargo_timeout_kills_its_process_group_and_reaps_the_leader() {
        let dir = tmp_dir();
        let fake_cargo = dir.path().join("cargo");
        let marker = dir.path().join("pids");
        make_executable(
            &fake_cargo,
            "#!/bin/sh\ntrap '' TERM\n(trap '' TERM; while :; do :; done) &\ndescendant=$!\nprintf '%s %s\\n' \"$$\" \"$descendant\" > \"$1\"\nblock='abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789'\nwhile :; do printf '%s%s%s%s%s%s%s%s\\n' \"$block\" \"$block\" \"$block\" \"$block\" \"$block\" \"$block\" \"$block\" \"$block\"; done\n",
        );
        let marker_arg = marker.to_string_lossy().into_owned();

        let error = run_cargo_command_with_timeout(
            dir.path(),
            &fake_cargo,
            &[&marker_arg],
            Duration::from_millis(300),
        )
        .expect_err("挂起的 cargo 进程树必须超时");

        assert!(format!("{error:#}").contains("timed out"));
        let pids = fs::read_to_string(marker).expect("fake cargo 应记录 PID");
        let mut pids = pids
            .split_whitespace()
            .map(|pid| pid.parse::<libc::pid_t>().expect("marker 中必须是合法 PID"));
        let leader = pids.next().expect("应记录 leader PID");
        let descendant = pids.next().expect("应记录 descendant PID");
        assert!(!unix_pid_exists(leader), "leader 必须由 owner 回收");
        assert!(!unix_pid_is_live(descendant), "descendant 必须被终止");
    }

    #[cfg(unix)]
    #[test]
    fn cargo_timeout_owns_descendants_after_the_leader_exits() {
        let dir = tmp_dir();
        let fake_cargo = dir.path().join("cargo");
        let marker = dir.path().join("pids");
        make_executable(
            &fake_cargo,
            "#!/bin/sh\n(trap '' TERM; while :; do :; done) &\ndescendant=$!\nprintf '%s %s\\n' \"$$\" \"$descendant\" > \"$1\"\nexit 0\n",
        );
        let marker_arg = marker.to_string_lossy().into_owned();

        let error = run_cargo_command_with_timeout(
            dir.path(),
            &fake_cargo,
            &[&marker_arg],
            Duration::from_millis(300),
        )
        .expect_err("leader 退出后仍持有管道的 descendant 必须触发超时清理");

        assert!(format!("{error:#}").contains("timed out"));
        let pids = fs::read_to_string(marker).expect("fake cargo 应记录 PID");
        let descendant = pids
            .split_whitespace()
            .nth(1)
            .expect("应记录 descendant PID")
            .parse::<libc::pid_t>()
            .expect("marker 中必须是合法 PID");
        assert!(!unix_pid_is_live(descendant), "descendant 必须被终止");
    }

    #[cfg(windows)]
    #[test]
    fn windows_adapter_timeout_kills_running_leader_and_descendant() {
        let dir = tmp_dir();
        let marker = dir.path().join("running-tree.pids");
        let script = "$nested = Start-Process (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Set-Content -LiteralPath $env:KCODER_PID_MARKER -Value @($PID,$nested.Id); Start-Sleep -Seconds 60";
        let command = windows_command(script, &[("KCODER_PID_MARKER", marker.as_path())]);
        let error = run_owned_command(command, Deadline::after(Duration::from_millis(700)))
            .expect_err("Windows leader and descendant must time out");
        assert!(error.to_string().contains("timed out"));
        let pids = windows_recorded_pids(&marker);
        assert_eq!(pids.len(), 2);
        assert!(pids.into_iter().all(windows_process_has_exited));
    }

    #[cfg(windows)]
    #[test]
    fn windows_adapter_does_not_finish_when_leader_exits_before_descendant() {
        let dir = tmp_dir();
        let marker = dir.path().join("leader-first.pids");
        let script = "$nested = Start-Process (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Set-Content -LiteralPath $env:KCODER_PID_MARKER -Value @($PID,$nested.Id)";
        let command = windows_command(script, &[("KCODER_PID_MARKER", marker.as_path())]);
        let error = run_owned_command(command, Deadline::after(Duration::from_millis(700)))
            .expect_err("surviving descendant must keep the adapter active until timeout cleanup");
        assert!(error.to_string().contains("timed out"));
        let pids = windows_recorded_pids(&marker);
        assert_eq!(pids.len(), 2);
        assert!(pids.into_iter().all(windows_process_has_exited));
    }

    #[cfg(windows)]
    #[test]
    fn windows_adapter_drains_and_bounds_stdout_and_stderr() {
        let script =
            "[Console]::Out.Write(('o' * 1500000)); [Console]::Error.Write(('e' * 1500000))";
        let command = windows_command(script, &[]);
        let output = run_owned_command(command, Deadline::after(Duration::from_secs(15))).unwrap();
        assert!(output.status.success());
        assert!(output.stdout.len() <= OUTPUT_LIMIT_BYTES);
        assert!(output.stderr.len() <= OUTPUT_LIMIT_BYTES);
        assert!(output.stdout.ends_with(OUTPUT_TRUNCATED_MARKER));
        assert!(output.stderr.ends_with(OUTPUT_TRUNCATED_MARKER));
    }

    #[cfg(unix)]
    #[test]
    fn command_output_is_bounded_and_marks_truncation() {
        let dir = tmp_dir();
        let fake_cargo = dir.path().join("cargo");
        make_executable(
            &fake_cargo,
            "#!/bin/sh\nblock='abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789'\ni=0\nwhile [ \"$i\" -lt 20000 ]; do printf '%s%s%s%s\\n' \"$block\" \"$block\" \"$block\" \"$block\"; i=$((i + 1)); done\n",
        );

        let output =
            run_cargo_command_with_timeout(dir.path(), &fake_cargo, &[], Duration::from_secs(5))
                .expect("大输出命令应持续 drain 并正常结束");

        assert!(output.status.success());
        assert!(output.stdout.len() <= OUTPUT_LIMIT_BYTES);
        assert!(output.stdout.ends_with(OUTPUT_TRUNCATED_MARKER));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn escaped_descendant_holding_pipe_cannot_block_timeout_return() {
        let dir = tmp_dir();
        let fake_cargo = dir.path().join("cargo");
        let marker = dir.path().join("escaped-pid");
        make_executable(
            &fake_cargo,
            "#!/bin/sh\nsetsid sh -c 'trap \"\" TERM; while :; do :; done' &\nprintf '%s\\n' \"$!\" > \"$1\"\nexit 0\n",
        );
        let marker_arg = marker.to_string_lossy().into_owned();
        let started = Instant::now();

        let error = run_cargo_command_with_timeout(
            dir.path(),
            &fake_cargo,
            &[&marker_arg],
            Duration::from_millis(300),
        )
        .expect_err("逃离 PGID 且持有 pipe 的后代必须触发有界返回");

        assert!(format!("{error:#}").contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
        let escaped = fs::read_to_string(marker)
            .expect("应记录逃逸 PID")
            .trim()
            .parse::<libc::pid_t>()
            .expect("逃逸 PID 应合法");
        let result = unsafe { libc::kill(escaped, libc::SIGKILL) };
        assert!(result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH));
        let cleanup_deadline = Instant::now() + Duration::from_millis(500);
        while unix_pid_is_live(escaped) && Instant::now() < cleanup_deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!unix_pid_is_live(escaped), "测试不得遗留逃逸后代");
    }

    #[cfg(unix)]
    #[test]
    fn zombie_only_process_group_finishes_without_waiting_for_timeout() {
        let dir = tmp_dir();
        let fake_cargo = dir.path().join("cargo");
        make_executable(&fake_cargo, "#!/bin/sh\n(exit 0) &\nexit 0\n");
        let started = Instant::now();

        let output =
            run_cargo_command_with_timeout(dir.path(), &fake_cargo, &[], Duration::from_secs(2))
                .expect("仅剩 zombie 不应被当作活后代");

        assert!(output.status.success());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    fn unix_pid_exists(pid: libc::pid_t) -> bool {
        (unsafe { libc::kill(pid, 0) }) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(target_os = "linux")]
    fn assert_no_local_descriptor_for_holder_pipe(holder: libc::pid_t) {
        let pipe = fs::read_link(format!("/proc/{holder}/fd/1"))
            .expect("escaped holder must retain the captured stdout pipe");
        let leaked = fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .any(|target| target == pipe);
        assert!(
            !leaked,
            "public return must close its local capture pipe fds"
        );
    }

    #[cfg(target_os = "linux")]
    fn unix_pid_is_live(pid: libc::pid_t) -> bool {
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        stat.rsplit_once(") ")
            .and_then(|(_, rest)| rest.chars().next())
            .is_some_and(|state| state != 'Z')
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    fn unix_pid_is_live(pid: libc::pid_t) -> bool {
        unix_pid_exists(pid)
    }

    #[cfg(windows)]
    #[test]
    fn cargo_precheck_keeps_windows_toolchain_and_user_environment() {
        let dir = tmp_dir();
        let fake_cargo = dir.path().join("cargo.cmd");
        fs::write(
            &fake_cargo,
            "@echo off\r\necho cargo_home=%CARGO_HOME%\r\necho rustup_home=%RUSTUP_HOME%\r\necho target_dir=%CARGO_TARGET_DIR%\r\necho appdata=%APPDATA%\r\necho userprofile=%USERPROFILE%\r\n",
        )
        .unwrap();

        let output = run_cargo_command(dir.path(), &fake_cargo, &["test", "--quiet"]).unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);

        for (label, name) in [
            ("cargo_home", "CARGO_HOME"),
            ("rustup_home", "RUSTUP_HOME"),
            ("target_dir", "CARGO_TARGET_DIR"),
            ("appdata", "APPDATA"),
            ("userprofile", "USERPROFILE"),
        ] {
            if let Ok(value) = std::env::var(name) {
                assert!(stdout.contains(&format!("{label}={value}")), "{stdout}");
            }
        }
        assert!(std::env::var_os("APPDATA").is_some());
        assert!(std::env::var_os("USERPROFILE").is_some());
    }

    #[cfg(windows)]
    #[test]
    fn cargo_precheck_can_compile_with_the_isolated_windows_toolchain() {
        let dir = tmp_dir();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"kcoder-spec-windows-precheck\"\nversion = \"0.0.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("src/lib.rs"),
            "#[test]\nfn windows_spec_precheck_compiles() { assert_eq!(2 + 2, 4); }\n",
        )
        .unwrap();
        let cargo = resolve_program("cargo").unwrap();

        let output = run_cargo_command(dir.path(), &cargo, &["test", "--quiet"]).unwrap();

        assert!(
            output.status.success(),
            "stdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn parses_windows_environment_block_without_losing_equals_in_values() {
        let parsed = parse_windows_environment_block(
            b"Path=C:\\VS\\bin;C:\\Windows\r\nLIB=C:\\SDK\\lib\r\nEMPTY=\r\nTOKEN=a=b=c\r\n",
        );

        assert_eq!(
            parsed,
            vec![
                ("Path".to_string(), r"C:\VS\bin;C:\Windows".to_string()),
                ("LIB".to_string(), r"C:\SDK\lib".to_string()),
                ("EMPTY".to_string(), String::new()),
                ("TOKEN".to_string(), "a=b=c".to_string()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn git_review_helpers_use_clean_environment_and_disable_prompts() {
        let dir = tmp_dir();
        let fake_git = dir.path().join("git");
        make_executable(
            &fake_git,
            "#!/bin/sh\nif [ \"${HOME-unset}\" != \"unset\" ]; then exit 2; fi\nif [ \"$GIT_TERMINAL_PROMPT\" != \"0\" ]; then exit 3; fi\nif [ \"${GIT_ASKPASS-unset}\" != \"\" ]; then exit 4; fi\nprintf 'pwd=%s\\nargs=%s\\n' \"$PWD\" \"$*\"\n",
        );

        let output = run_git_command(dir.path(), &fake_git, &["rev-parse", "HEAD"]).unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success());
        assert!(stdout.contains(&format!("pwd={}", dir.path().display())));
        assert!(stdout.contains("args=rev-parse HEAD"));
    }

    #[cfg(windows)]
    #[test]
    fn git_review_helpers_keep_windows_runtime_environment_and_disable_prompts() {
        let dir = tmp_dir();
        let fake_git = dir.path().join("git.cmd");
        fs::write(
            &fake_git,
            "@echo off\r\necho root=%SystemRoot%\r\necho manifest=%CARGO_MANIFEST_DIR%\r\necho prompt=%GIT_TERMINAL_PROMPT%\r\necho askpass=%GIT_ASKPASS%\r\necho cwd=%CD%\r\necho args=%*\r\n",
        )
        .unwrap();

        let output = run_git_command(dir.path(), &fake_git, &["rev-parse", "HEAD"]).unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success(), "{stdout}");
        assert!(!stdout.contains("root=\r"), "{stdout}");
        assert!(stdout.contains("manifest=\r"), "{stdout}");
        assert!(stdout.contains("prompt=0"), "{stdout}");
        assert!(stdout.contains("askpass=\r"), "{stdout}");
        assert!(
            stdout
                .to_ascii_lowercase()
                .contains(&format!("cwd={}", dir.path().display()).to_ascii_lowercase()),
            "{stdout}"
        );
        assert!(stdout.contains("args=rev-parse HEAD"), "{stdout}");
    }
}
