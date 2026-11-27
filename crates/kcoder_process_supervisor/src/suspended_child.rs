//! Own an async host's suspended child without taking over its protocol pipes.
use anyhow::{Context, Result, ensure};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::ptr::null;
use std::sync::Arc;
use windows_sys::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, ERROR_NO_MORE_FILES, GetLastError, INVALID_HANDLE_VALUE, LocalFree,
    SetLastError,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, OpenJobObjectW,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::SystemServices::JOB_OBJECT_QUERY;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, GetCurrentProcessId, GetProcessId, GetProcessIdOfThread,
    OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

/// Pass to the host command before spawn; no child code runs before assignment.
pub const SUSPENDED_CHILD_FLAGS: u32 = CREATE_SUSPENDED | CREATE_NO_WINDOW;

/// A private, non-inheritable Job. Closing it terminates all owned descendants.
///
/// The host retains stdin/stdout and is responsible for awaiting its direct child.
/// This Job allows neither breakaway nor inheritance of its own handle.
pub struct SuspendedChildJob {
    handle: Arc<OwnedHandle>,
    assigned: bool,
}

impl SuspendedChildJob {
    pub fn new() -> Result<Self> {
        // Null security attributes create a non-inheritable, unnamed handle.
        let raw = unsafe { CreateJobObjectW(null(), null()) };
        ensure!(!raw.is_null(), "Cannot create private child Job");
        // SAFETY: CreateJobObjectW returned a new valid owned handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        Self::configure(handle)
    }

    /// A stable private name also fences a lost owner while its original
    /// processes still retain the kernel Job. An existing Job is never adopted
    /// or terminated by this constructor, even after its launcher disappears.
    pub fn new_named(name: &str, security_descriptor: &str) -> Result<Self> {
        use windows_sys::Win32::Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            SECURITY_ATTRIBUTES,
        };
        ensure!(
            !name.is_empty() && name.len() <= 240 && !name.contains('\0'),
            "Invalid private Job name"
        );
        let wide_name: Vec<u16> = std::ffi::OsStr::new(name)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let wide_security: Vec<u16> = std::ffi::OsStr::new(security_descriptor)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut descriptor = std::ptr::null_mut();
        ensure!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide_security.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            } != 0,
            "Cannot build private Job security"
        );
        struct Security(*mut std::ffi::c_void);
        impl Drop for Security {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
        let descriptor = Security(descriptor);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        unsafe {
            SetLastError(0);
        }
        let raw = unsafe { CreateJobObjectW(&attributes, wide_name.as_ptr()) };
        let observed = unsafe { GetLastError() };
        ensure!(!raw.is_null(), "Cannot create private scope Job");
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        ensure!(
            observed != ERROR_ALREADY_EXISTS,
            "Original private scope Job still exists"
        );
        Self::configure(handle)
    }
    fn configure(handle: OwnedHandle) -> Result<Self> {
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        ensure!(
            unsafe {
                SetInformationJobObject(
                    handle.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } != 0,
            "Cannot configure private child Job"
        );
        Ok(Self {
            handle: Arc::new(handle),
            assigned: false,
        })
    }

    /// Assign a freshly spawned suspended child, then resume its primary thread.
    ///
    /// The caller must use SUSPENDED_CHILD_FLAGS and kill/reap the direct child
    /// if this fails. Never use this API to adopt an already running process.
    pub fn assign_and_resume(&mut self, process: BorrowedHandle<'_>) -> Result<()> {
        ensure!(!self.assigned, "Private child Job already assigned");
        let pid = unsafe { GetProcessId(process.as_raw_handle()) };
        ensure!(
            pid != 0 && pid != unsafe { GetCurrentProcessId() },
            "Private child process identity unavailable"
        );
        ensure!(
            unsafe {
                AssignProcessToJobObject(self.handle.as_raw_handle(), process.as_raw_handle())
            } != 0,
            "Cannot assign suspended child to its private Job"
        );
        self.assigned = true;
        let thread = primary_thread(pid)?;
        // Assignment precedes resume, so spawned descendants cannot escape the Job.
        ensure!(
            unsafe { ResumeThread(thread.as_raw_handle()) } == 1,
            "Owned child primary thread was not suspended exactly once"
        );
        Ok(())
    }

    pub fn terminate(&self) -> Result<()> {
        ensure!(
            unsafe { TerminateJobObject(self.handle.as_raw_handle(), 1) } != 0,
            "Cannot terminate private child Job"
        );
        Ok(())
    }

    /// Observation retains the Job identity; owner Drop still explicitly terminates it.
    pub fn exit_handle(&self) -> JobExitHandle {
        JobExitHandle(self.handle.clone())
    }
}

pub struct JobExitHandle(Arc<OwnedHandle>);
impl JobExitHandle {
    pub fn is_empty(&self) -> Result<bool> {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        ensure!(
            unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            } != 0,
            "Cannot observe owned child Job cleanup"
        );
        Ok(accounting.ActiveProcesses == 0)
    }
}

impl Drop for SuspendedChildJob {
    fn drop(&mut self) {
        if self.assigned {
            // An exit observer can retain the handle, so last-handle close alone
            // is insufficient. Terminate only this Job before releasing ownership.
            let _ = self.terminate();
        }
    }
}

fn primary_thread(pid: u32) -> Result<OwnedHandle> {
    // Stable Rust does not expose a Child's primary thread handle. A fresh
    // CREATE_SUSPENDED process has one thread; reject any ambiguous snapshot.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    ensure!(
        raw != INVALID_HANDLE_VALUE,
        "Cannot snapshot owned child thread"
    );
    // SAFETY: the successful snapshot returned a new owned kernel handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut present = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    let mut thread = None;
    while present != 0 {
        if entry.th32OwnerProcessID == pid {
            ensure!(
                thread.is_none(),
                "Suspended child has multiple candidate threads"
            );
            let raw = unsafe {
                OpenThread(
                    THREAD_QUERY_LIMITED_INFORMATION | THREAD_SUSPEND_RESUME,
                    0,
                    entry.th32ThreadID,
                )
            };
            ensure!(!raw.is_null(), "Cannot open owned child primary thread");
            // SAFETY: OpenThread returned a new handle; PID verification below
            // prevents resuming a reused thread ID belonging to another process.
            let candidate = unsafe { OwnedHandle::from_raw_handle(raw) };
            ensure!(
                unsafe { GetProcessIdOfThread(candidate.as_raw_handle()) } == pid,
                "Owned child thread identity changed"
            );
            thread = Some(candidate);
        }
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        present = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    ensure!(
        unsafe { GetLastError() } == ERROR_NO_MORE_FILES,
        "Owned child thread snapshot was incomplete"
    );
    thread.context("Owned child primary thread unavailable")
}

/// Query-only retained membership, never an assignment or termination authority.
pub struct NamedJobQuery {
    handle: OwnedHandle,
}
impl NamedJobQuery {
    pub fn open_for_process(name: &str, process: BorrowedHandle<'_>) -> Result<Self> {
        ensure!(
            !name.is_empty() && name.len() <= 240 && !name.contains('\0'),
            "Invalid private Job name"
        );
        let wide: Vec<u16> = std::ffi::OsStr::new(name)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let raw = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, wide.as_ptr()) };
        ensure!(!raw.is_null(), "Original private scope Job unavailable");
        let value = Self {
            handle: unsafe { OwnedHandle::from_raw_handle(raw) },
        };
        value.verify_process(process)?;
        Ok(value)
    }
    /// Query only the retained original Job and an actual held process handle.
    /// A failed kernel query is distinct from a confirmed non-member.
    pub fn contains_process(&self, process: BorrowedHandle<'_>) -> Result<bool> {
        let mut member = 0;
        ensure!(
            unsafe {
                IsProcessInJob(
                    process.as_raw_handle(),
                    self.handle.as_raw_handle(),
                    &mut member,
                )
            } != 0,
            "OWNED_JOB_MEMBERSHIP_QUERY_UNAVAILABLE"
        );
        Ok(member != 0)
    }
    pub fn verify_process(&self, process: BorrowedHandle<'_>) -> Result<()> {
        ensure!(
            self.contains_process(process)?,
            "Original private scope Job membership changed"
        );
        Ok(())
    }
}
