//! Windows stdio child atomically assigned to a kill-on-close Job at creation.
//! No shell interpolation, detached startup, or post-spawn assignment window.
use anyhow::{Result, ensure};
use std::{
    ffi::OsStr,
    fs::File,
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    },
    process::Command,
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation},
    Security::SECURITY_ATTRIBUTES,
    System::{
        JobObjects::*,
        Pipes::CreatePipe,
        SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE},
        Threading::*,
    },
};

pub struct JobChild {
    job: OwnedHandle,
    process: OwnedHandle,
    pub pid: u32,
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub stderr: Option<File>,
}
impl JobChild {
    /// The command must be constructed by launch::worker_command from verified
    /// resources. Host preflight, permission and lease checks precede this call.
    pub fn spawn(command: &Command) -> Result<Self> {
        Self::spawn_inner(command, None)
    }

    /// A stable per-desktop Job name detects descendants still exiting after a
    /// crashed owner's reservation handle has disappeared.
    pub fn spawn_for_desktop(
        command: &Command,
        reservation: &crate::windows_exclusive::DesktopReservation,
    ) -> Result<Self> {
        Self::spawn_inner(command, Some(reservation.job_name()))
    }

    fn spawn_inner(command: &Command, job_name: Option<&str>) -> Result<Self> {
        ensure!(
            std::path::Path::new(command.get_program()).is_absolute(),
            "absolute executable required"
        );
        let name = job_name.map(|name| wide(OsStr::new(name))).transpose()?;
        let job =
            unsafe { CreateJobObjectW(null(), name.as_ref().map_or(null(), |name| name.as_ptr())) };
        let existed = unsafe { windows_sys::Win32::Foundation::GetLastError() }
            == windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS;
        ensure!(
            !job.is_null(),
            "CreateJobObject: {}",
            std::io::Error::last_os_error()
        );
        let job = unsafe { OwnedHandle::from_raw_handle(job) };
        if existed {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            ensure!(
                unsafe {
                    QueryInformationJobObject(
                        job.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                        size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                        null_mut(),
                    )
                } != 0,
                "cannot verify previous desktop job state"
            );
            ensure!(
                accounting.ActiveProcesses == 0,
                "desktop_busy: previous desktop process tree has not exited"
            );
            // Terminated Job objects cannot accept new processes. The previous
            // host must close its final handle before this name is reused.
            anyhow::bail!("desktop_busy: previous desktop Job has not been retired");
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        ensure!(
            unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } != 0,
            "configure job: {}",
            std::io::Error::last_os_error()
        );
        let (child_in, parent_in) = pipe(false)?;
        let (parent_out, child_out) = pipe(true)?;
        let (parent_err, child_err) = pipe(true)?;
        let handles = [
            child_in.as_raw_handle(),
            child_out.as_raw_handle(),
            child_err.as_raw_handle(),
        ];
        let jobs = [job.as_raw_handle()];
        let attributes = Attributes::new(&handles, &jobs)?;
        let program = wide(command.get_program())?;
        let mut command_line = Vec::new();
        for value in std::iter::once(command.get_program()).chain(command.get_args()) {
            if !command_line.is_empty() {
                command_line.push(32);
            }
            command_line.extend(quote(value)?);
        }
        command_line.push(0);
        let cwd = wide(
            command
                .get_current_dir()
                .ok_or_else(|| anyhow::anyhow!("explicit cwd required"))?
                .as_os_str(),
        )?;
        let mut environment = Vec::new();
        let mut vars = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect::<Vec<_>>();
        vars.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
        for (key, value) in vars {
            let mut key = wide(key)?;
            key.pop();
            ensure!(!key.contains(&61), "invalid environment key");
            environment.extend(key);
            environment.push(61);
            environment.extend(wide(value)?);
        }
        if environment.is_empty() {
            environment.push(0);
        }
        environment.push(0);
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = attributes.pointer;
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        ensure!(
            unsafe {
                CreateProcessW(
                    program.as_ptr(),
                    command_line.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    environment.as_ptr().cast(),
                    cwd.as_ptr(),
                    &startup.StartupInfo,
                    &mut info,
                )
            } != 0,
            "CreateProcess: {}",
            std::io::Error::last_os_error()
        );
        let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
        drop(unsafe { OwnedHandle::from_raw_handle(info.hThread) });
        Ok(Self {
            job,
            process,
            pid: info.dwProcessId,
            stdin: Some(File::from(parent_in)),
            stdout: Some(File::from(parent_out)),
            stderr: Some(File::from(parent_err)),
        })
    }
    /// Success requires the entire job to be empty, not just its lead process.
    pub fn terminate_and_wait(&mut self, timeout: Duration) -> Result<()> {
        self.stdin.take();
        terminate_job_and_wait(&self.job, &self.process, timeout)
    }
    /// Retain supervision independently of this child/stdio owner. The receiver
    /// must explicitly terminate on owner loss: any retained Job handle postpones
    /// Windows kill-on-last-close until that handle is also closed.
    pub fn cleanup_handle(&self) -> Result<CleanupJob> {
        Ok(CleanupJob {
            job: self.job.try_clone()?,
            process: self.process.try_clone()?,
        })
    }
    /// Duplicates only the cleanup rights into an OS-verified recovery process.
    /// After sending these values, the recipient owns them; an ambiguous reply
    /// must close the channel, never remotely close possibly adopted handles.
    pub(crate) fn transfer_cleanup_to(
        &self,
        peer: &crate::windows_peer::VerifiedPeer,
    ) -> Result<(u64, u64)> {
        let job = peer
            .duplicate_into(
                self.job.as_handle(),
                JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE,
            )
            .map_err(|_| anyhow::anyhow!("cannot transfer cleanup Job"))?;
        match peer.duplicate_into(
            self.process.as_handle(),
            PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE,
        ) {
            Ok(process) => Ok((job as u64, process as u64)),
            Err(_) => {
                peer.undo_unsent_duplicate(job);
                anyhow::bail!("cannot transfer cleanup worker handle");
            }
        }
    }
    /// Check the retained owned process handle, never a potentially reused PID.
    pub fn is_running(&self) -> Result<bool> {
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
            windows_sys::Win32::Foundation::WAIT_TIMEOUT => Ok(true),
            windows_sys::Win32::Foundation::WAIT_OBJECT_0 => Ok(false),
            _ => anyhow::bail!("desktop worker process liveness could not be verified"),
        }
    }
    pub fn process_handle(&self) -> &OwnedHandle {
        &self.process
    }
}
/// A cleanup owner holds no stdio or lead-process ownership. Its retained Job
/// object covers descendants even after the original host has disappeared.
pub struct CleanupJob {
    job: OwnedHandle,
    process: OwnedHandle,
}

/// Keep the named desktop Job occupied until every recovery step has finished.
/// On an unconfirmed cleanup, retain it until this dedicated process exits;
/// otherwise another host could start while a clipboard thread is still exiting.
pub struct RecoveryRetirement {
    job: Option<OwnedHandle>,
}
impl RecoveryRetirement {
    pub fn release_after_cleanup(mut self) {
        self.job.take();
    }
}
impl Drop for RecoveryRetirement {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            unsafe {
                TerminateJobObject(job.as_raw_handle(), 1);
            }
            // The dedicated recovery process returns immediately to its exit
            // path on failure. OS process teardown closes this retained handle.
            std::mem::forget(job);
        }
    }
}
impl CleanupJob {
    pub fn retirement_barrier(&self) -> Result<RecoveryRetirement> {
        Ok(RecoveryRetirement {
            job: Some(self.job.try_clone()?),
        })
    }
    /// Accept only handles delivered by the authenticated recovery channel.
    /// Validate their relationship before granting the ability to terminate a
    /// tree. A numeric PID/name supplied by a model is never a substitute.
    pub fn from_owned_handles(
        job: OwnedHandle,
        process: OwnedHandle,
        expected_session: u32,
    ) -> Result<Self> {
        use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
        let process_id = unsafe { GetProcessId(process.as_raw_handle()) };
        ensure!(
            process_id != 0,
            "cleanup transfer has no valid worker process"
        );
        let mut worker_session = 0;
        let mut local_session = 0;
        ensure!(
            unsafe { ProcessIdToSessionId(process_id, &mut worker_session) } != 0
                && unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut local_session) } != 0,
            "cleanup transfer session could not be verified"
        );
        ensure!(
            worker_session == expected_session && local_session == expected_session,
            "cleanup transfer belongs to another Windows session"
        );
        let mut member = 0;
        ensure!(
            unsafe { IsProcessInJob(process.as_raw_handle(), job.as_raw_handle(), &mut member) }
                != 0
                && member != 0,
            "cleanup worker does not belong to the supplied Job"
        );
        // Querying also rejects an invalid/wrong object handle before any
        // TerminateJobObject call can occur.
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        ensure!(
            unsafe {
                QueryInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                )
            } != 0,
            "cleanup transfer Job cannot be inspected"
        );
        Ok(Self { job, process })
    }

    pub fn terminate_and_wait(&mut self, timeout: Duration) -> Result<()> {
        terminate_job_and_wait(&self.job, &self.process, timeout)
    }
    pub fn handle(&self) -> &OwnedHandle {
        &self.job
    }
}

fn terminate_job_and_wait(
    job: &OwnedHandle,
    process: &OwnedHandle,
    timeout: Duration,
) -> Result<()> {
    ensure!(
        unsafe { TerminateJobObject(job.as_raw_handle(), 1) } != 0,
        "TerminateJobObject: {}",
        std::io::Error::last_os_error()
    );
    let deadline = Instant::now() + timeout;
    loop {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        ensure!(
            unsafe {
                QueryInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                )
            } != 0,
            "query job failed"
        );
        let process_state = unsafe { WaitForSingleObject(process.as_raw_handle(), 0) };
        ensure!(
            process_state != windows_sys::Win32::Foundation::WAIT_FAILED,
            "cannot verify worker process exit"
        );
        if accounting.ActiveProcesses == 0
            && process_state == windows_sys::Win32::Foundation::WAIT_OBJECT_0
        {
            return Ok(());
        }
        ensure!(Instant::now() < deadline, "worker job did not become empty");
        std::thread::sleep(Duration::from_millis(10));
    }
}

// Closing job kills all descendants; explicit terminate_and_wait is required to
// produce a successful shutdown receipt before another lease can be granted.

fn pipe(parent_reads: bool) -> Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write) = (null_mut(), null_mut());
    ensure!(
        unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } != 0,
        "CreatePipe failed"
    );
    let read = unsafe { OwnedHandle::from_raw_handle(read) };
    let write = unsafe { OwnedHandle::from_raw_handle(write) };
    let parent = if parent_reads {
        read.as_raw_handle()
    } else {
        write.as_raw_handle()
    };
    ensure!(
        unsafe { SetHandleInformation(parent, HANDLE_FLAG_INHERIT, 0) } != 0,
        "pipe inheritance failed"
    );
    Ok((read, write))
}
struct Attributes {
    _storage: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new(handles: &[HANDLE], jobs: &[HANDLE]) -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
        }
        ensure!(bytes > 0, "attribute size unavailable");
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let pointer = storage.as_mut_ptr().cast();
        ensure!(
            unsafe { InitializeProcThreadAttributeList(pointer, 2, 0, &mut bytes) } != 0,
            "attribute init failed"
        );
        let result = Self {
            _storage: storage,
            pointer,
        };
        for (kind, values) in [
            (PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles),
            (PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs),
        ] {
            ensure!(
                unsafe {
                    UpdateProcThreadAttribute(
                        pointer,
                        0,
                        kind as usize,
                        values.as_ptr().cast(),
                        std::mem::size_of_val(values),
                        null_mut(),
                        null(),
                    )
                } != 0,
                "attribute update failed: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok(result)
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}
fn wide(value: &OsStr) -> Result<Vec<u16>> {
    let mut out: Vec<_> = value.encode_wide().collect();
    ensure!(!out.contains(&0), "NUL in process argument");
    out.push(0);
    Ok(out)
}
fn quote(value: &OsStr) -> Result<Vec<u16>> {
    let mut value = wide(value)?;
    value.pop();
    let mut out = vec![34];
    let mut slashes = 0;
    for ch in value {
        if ch == 92 {
            slashes += 1;
        } else {
            out.extend(std::iter::repeat_n(
                92,
                if ch == 34 { slashes * 2 + 1 } else { slashes },
            ));
            slashes = 0;
            out.push(ch);
        }
    }
    out.extend(std::iter::repeat_n(92, slashes * 2));
    out.push(34);
    Ok(out)
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;

    #[test]
    fn retained_cleanup_handle_can_reap_after_original_owner_is_dropped() {
        use std::io::BufRead;
        let system_root = std::env::var_os("SystemRoot").unwrap();
        let executable = std::path::PathBuf::from(&system_root)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let directory = tempfile::tempdir().unwrap();
        let mut command = Command::new(executable);
        command
            .current_dir(directory.path())
            .env_clear()
            .env("SystemRoot", system_root);
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.WriteLine('ready'); [Threading.Thread]::Sleep(20000)",
        ]);
        let mut child = JobChild::spawn(&command).unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        let process = child.process_handle().try_clone().unwrap();
        let mut cleanup = child.cleanup_handle().unwrap();
        drop(child);
        // A retained Job handle keeps the Job alive. Owner death alone is not a
        // cleanup receipt: the independent owner must explicitly reap the tree.
        let before = unsafe { WaitForSingleObject(process.as_raw_handle(), 0) };
        let result = cleanup.terminate_and_wait(Duration::from_secs(5));
        assert_eq!(before, windows_sys::Win32::Foundation::WAIT_TIMEOUT);
        result.unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
            windows_sys::Win32::Foundation::WAIT_OBJECT_0
        );
    }

    #[test]
    fn retirement_blocks_replacement_until_non_process_cleanup_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let system = std::env::var_os("SystemRoot").unwrap();
        let mut command = Command::new(
            std::path::PathBuf::from(&system)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command
            .current_dir(directory.path())
            .env_clear()
            .env("SystemRoot", system)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Threading.Thread]::Sleep(20000)",
            ]);
        let reservation = crate::windows_exclusive::DesktopReservation::acquire().unwrap();
        let mut original = JobChild::spawn_for_desktop(&command, &reservation).unwrap();
        let cleanup = original.cleanup_handle().unwrap();
        let retirement = cleanup.retirement_barrier().unwrap();
        original.terminate_and_wait(Duration::from_secs(5)).unwrap();
        drop(original);
        drop(cleanup);
        drop(reservation); // Simulate loss of the original host's reservation.
        let next = crate::windows_exclusive::DesktopReservation::acquire().unwrap();
        let rejected = JobChild::spawn_for_desktop(&command, &next)
            .err()
            .expect("replacement started before clipboard recovery finished");
        assert!(rejected.to_string().contains("not been retired"));
        retirement.release_after_cleanup();
        let mut replacement = JobChild::spawn_for_desktop(&command, &next).unwrap();
        replacement
            .terminate_and_wait(Duration::from_secs(5))
            .unwrap();
    }

    #[test]
    fn cleanup_transfer_rejects_cross_job_and_cross_session_handles() {
        use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
        let directory = tempfile::tempdir().unwrap();
        let system_root = std::env::var_os("SystemRoot").unwrap();
        let mut command = Command::new(
            std::path::PathBuf::from(&system_root)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command
            .current_dir(directory.path())
            .env_clear()
            .env("SystemRoot", system_root)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Threading.Thread]::Sleep(20000)",
            ]);
        let mut first = JobChild::spawn(&command).unwrap();
        let mut second = JobChild::spawn(&command).unwrap();
        let mut session = 0;
        assert_ne!(
            unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) },
            0
        );
        let wrong_job = CleanupJob::from_owned_handles(
            first.job.try_clone().unwrap(),
            second.process.try_clone().unwrap(),
            session,
        );
        let wrong_session = CleanupJob::from_owned_handles(
            first.job.try_clone().unwrap(),
            first.process.try_clone().unwrap(),
            session + 1,
        );
        let valid = CleanupJob::from_owned_handles(
            first.job.try_clone().unwrap(),
            first.process.try_clone().unwrap(),
            session,
        );
        // Always reap both fixtures before evaluating the rejection assertions.
        first.terminate_and_wait(Duration::from_secs(5)).unwrap();
        second.terminate_and_wait(Duration::from_secs(5)).unwrap();
        assert!(wrong_job.is_err());
        assert!(wrong_session.is_err());
        assert!(valid.is_ok());
    }
}
