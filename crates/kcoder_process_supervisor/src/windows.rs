use crate::protocol::{
    ControlRequest, PROTOCOL_VERSION, SpawnRequest, SupervisorEvent, read_protocol_line,
    windows_environment_key,
};
use anyhow::{Context, Result};
use std::ffi::{OsStr, c_void};
use std::io::{BufRead, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, GENERIC_READ, HANDLE, HANDLE_FLAG_INHERIT,
    INVALID_HANDLE_VALUE, SetHandleInformation,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

const WAIT_OBJECT_0_VALUE: u32 = 0;
const WAIT_TIMEOUT_VALUE: u32 = 258;
const START_TIMEOUT: Duration = Duration::from_secs(10);

enum ControlMessage {
    Command(std::result::Result<ControlRequest, String>),
    Stop,
}

pub fn run<R: BufRead + Send + 'static>(request: SpawnRequest, input: R) -> Result<u32> {
    let mut status = StatusWriter::create(&request.status_file)?;
    let job = match Job::create() {
        Ok(job) => job,
        Err(error) => {
            write_supervisor_error(&mut status, &error)?;
            return Err(error);
        }
    };
    if let Err(error) = job.assign_current() {
        write_supervisor_error(&mut status, &error)?;
        return Err(error);
    }
    match run_supervised(&request, input, &job, &mut status) {
        Ok(exit_code) => {
            status.write(&SupervisorEvent::Exit { code: exit_code })?;
            job.disarm_kill_on_close()?;
            Ok(exit_code)
        }
        Err(error) => {
            write_supervisor_error(&mut status, &error)?;
            job.terminate(1)?;
            job.wait_until_only_current(Duration::from_secs(2))?;
            Err(error)
        }
    }
}

fn write_supervisor_error(status: &mut StatusWriter, error: &anyhow::Error) -> Result<()> {
    let error_text = error.to_string();
    status.write(&SupervisorEvent::Error {
        code: "supervisor_failed",
        message: bounded_error(&error_text),
    })
}

fn run_supervised<R: BufRead + Send + 'static>(
    request: &SpawnRequest,
    input: R,
    job: &Job,
    status: &mut StatusWriter,
) -> Result<u32> {
    let stdout = inherited_standard_handle(STD_OUTPUT_HANDLE)?;
    let stderr = inherited_standard_handle(STD_ERROR_HANDLE)?;
    let stdin = null_input_handle()?;
    let mut attributes = AttributeList::new(&[stdin.0, stdout, stderr])?;
    let process = create_suspended_process(request, stdin.0, stdout, stderr, &mut attributes)?;
    drop(attributes);
    drop(stdin);

    let (control_sender, control_receiver) = mpsc::channel();
    let reader_sender = control_sender.clone();
    std::thread::spawn(move || read_controls(input, reader_sender));

    status.write(&SupervisorEvent::Ready {
        version: PROTOCOL_VERSION,
        nonce: &request.nonce,
        pid: process.process_id,
    })?;

    let start = match control_receiver.recv_timeout(START_TIMEOUT) {
        Ok(ControlMessage::Command(Ok(command))) => command,
        Ok(ControlMessage::Command(Err(error))) => anyhow::bail!(error),
        Ok(ControlMessage::Stop) => anyhow::bail!("START command is missing"),
        Err(RecvTimeoutError::Timeout) => anyhow::bail!("timed out waiting for START command"),
        Err(RecvTimeoutError::Disconnected) => anyhow::bail!("START command is missing"),
    };
    start.validate(&request.nonce)?;
    anyhow::ensure!(
        matches!(start, ControlRequest::Start { .. }),
        "expected START command"
    );

    let control_job = job.duplicate_handle()?;
    let control_nonce = request.nonce.clone();
    let control_active = Arc::new(AtomicBool::new(true));
    let thread_active = Arc::clone(&control_active);
    let control_thread = std::thread::spawn(move || {
        loop {
            let message = match control_receiver.recv() {
                Ok(message) => message,
                Err(_) => ControlMessage::Command(Err("control input closed".into())),
            };
            let ControlMessage::Command(command) = message else {
                break;
            };
            if !thread_active.load(Ordering::Acquire) {
                break;
            }
            let Ok(command) = command else {
                control_job.terminate_job(1);
                break;
            };
            if command.validate(&control_nonce).is_err() {
                control_job.terminate_job(1);
                break;
            }
            if matches!(command, ControlRequest::Kill { .. }) {
                control_job.terminate_job(1);
                break;
            }
        }
    });

    let resumed = unsafe { ResumeThread(process.thread.0) };
    anyhow::ensure!(
        resumed != u32::MAX,
        "failed to resume supervised process: {}",
        std::io::Error::last_os_error()
    );
    drop(process.thread);
    wait_for_process(process.process.0)?;
    while job.active_processes()? > 1 {
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut exit_code = 1u32;
    anyhow::ensure!(
        unsafe { GetExitCodeProcess(process.process.0, &mut exit_code) } != 0,
        "failed to read supervised process exit code"
    );
    drop(process.process);
    control_active.store(false, Ordering::Release);
    let _ = control_sender.send(ControlMessage::Stop);
    control_thread
        .join()
        .map_err(|_| anyhow::anyhow!("control thread panicked"))?;
    Ok(exit_code)
}

fn read_controls<R: BufRead>(mut input: R, sender: mpsc::Sender<ControlMessage>) {
    loop {
        let command = match read_protocol_line(&mut input) {
            Ok(Some(line)) => serde_json::from_str::<ControlRequest>(&line)
                .map_err(|error| format!("invalid control command: {error}")),
            Ok(None) => return,
            Err(error) => Err(error.to_string()),
        };
        let failed = command.is_err();
        if sender.send(ControlMessage::Command(command)).is_err() || failed {
            return;
        }
    }
}

struct StatusWriter {
    file: std::fs::File,
}

impl StatusWriter {
    fn create(path: &str) -> Result<Self> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .context("failed to create private supervisor status file")?;
        Ok(Self { file })
    }

    fn write(&mut self, event: &SupervisorEvent<'_>) -> Result<()> {
        serde_json::to_writer(&mut self.file, event)?;
        self.file.write_all(b"\n")?;
        self.file.flush()?;
        self.file.sync_data()?;
        Ok(())
    }
}

fn inherited_standard_handle(kind: u32) -> Result<HANDLE> {
    let handle = unsafe { GetStdHandle(kind) };
    anyhow::ensure!(
        !handle.is_null() && handle != INVALID_HANDLE_VALUE,
        "supervisor standard output handle is unavailable"
    );
    set_inherit(handle, true)?;
    Ok(handle)
}

fn null_input_handle() -> Result<OwnedHandle> {
    let path = wide_nul("NUL");
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    anyhow::ensure!(
        handle != INVALID_HANDLE_VALUE,
        "failed to open NUL for supervised stdin: {}",
        std::io::Error::last_os_error()
    );
    Ok(OwnedHandle(handle))
}

fn create_suspended_process(
    request: &SpawnRequest,
    stdin: HANDLE,
    stdout: HANDLE,
    stderr: HANDLE,
    attributes: &mut AttributeList,
) -> Result<OwnedProcessInformation> {
    let executable = wide_nul(&request.executable);
    let cwd = wide_nul(&request.cwd);
    let mut command_line = windows_command_line(&request.executable, &request.args);
    let environment = environment_block(&request.env);
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin;
    startup.StartupInfo.hStdOutput = stdout;
    startup.StartupInfo.hStdError = stderr;
    startup.lpAttributeList = attributes.pointer;
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    let created = unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast::<c_void>(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    };
    anyhow::ensure!(
        created != 0,
        "failed to create supervised process: {}",
        std::io::Error::last_os_error()
    );
    Ok(OwnedProcessInformation {
        process: OwnedHandle(info.hProcess),
        thread: OwnedHandle(info.hThread),
        process_id: info.dwProcessId,
    })
}

fn wait_for_process(handle: HANDLE) -> Result<()> {
    loop {
        match unsafe { WaitForSingleObject(handle, 100) } {
            WAIT_OBJECT_0_VALUE => return Ok(()),
            WAIT_TIMEOUT_VALUE => continue,
            _ => anyhow::bail!(
                "failed waiting for supervised process: {}",
                std::io::Error::last_os_error()
            ),
        }
    }
}

struct Job {
    handle: OwnedHandle,
}

impl Job {
    fn create() -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        anyhow::ensure!(
            !handle.is_null(),
            "failed to create Job Object: {}",
            std::io::Error::last_os_error()
        );
        let handle = OwnedHandle(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        anyhow::ensure!(
            configured != 0,
            "failed to configure Job Object: {}",
            std::io::Error::last_os_error()
        );
        Ok(Self { handle })
    }

    fn assign_current(&self) -> Result<()> {
        anyhow::ensure!(
            unsafe { AssignProcessToJobObject(self.handle.0, GetCurrentProcess()) } != 0,
            "failed to assign supervisor to Job Object: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }

    fn duplicate_handle(&self) -> Result<OwnedHandle> {
        let process = unsafe { GetCurrentProcess() };
        let mut duplicate = null_mut();
        anyhow::ensure!(
            unsafe {
                DuplicateHandle(
                    process,
                    self.handle.0,
                    process,
                    &mut duplicate,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            } != 0,
            "failed to duplicate Job Object handle: {}",
            std::io::Error::last_os_error()
        );
        Ok(OwnedHandle(duplicate))
    }

    fn active_processes(&self) -> Result<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle.0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        };
        anyhow::ensure!(
            queried != 0,
            "failed to query Job Object: {}",
            std::io::Error::last_os_error()
        );
        Ok(info.ActiveProcesses)
    }

    fn disarm_kill_on_close(&self) -> Result<()> {
        self.set_limit_flags(0)
            .context("failed to disarm Job Object kill-on-close")
    }

    fn set_limit_flags(&self, flags: u32) -> Result<()> {
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = flags;
        anyhow::ensure!(
            unsafe {
                SetInformationJobObject(
                    self.handle.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } != 0,
            "failed to update Job Object limits: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }

    fn terminate(&self, exit_code: u32) -> Result<()> {
        anyhow::ensure!(
            unsafe { TerminateJobObject(self.handle.0, exit_code) } != 0,
            "failed to terminate Job Object: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }

    fn wait_until_only_current(&self, timeout: Duration) -> Result<()> {
        let deadline = std::time::Instant::now() + timeout;
        while self.active_processes()? > 1 {
            anyhow::ensure!(
                std::time::Instant::now() < deadline,
                "timed out waiting for terminated Job Object"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}

struct AttributeList {
    _storage: Vec<u8>,
    pointer: windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl AttributeList {
    fn new(handles: &[HANDLE]) -> Result<Self> {
        let mut bytes = 0usize;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes) };
        anyhow::ensure!(bytes > 0, "failed to size process attribute list");
        let mut storage = vec![0u8; bytes];
        let pointer = storage.as_mut_ptr().cast();
        anyhow::ensure!(
            unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut bytes) } != 0,
            "failed to initialize process attribute list"
        );
        let updated = unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast::<c_void>(),
                std::mem::size_of_val(handles),
                null_mut(),
                null(),
            )
        };
        if updated == 0 {
            unsafe { DeleteProcThreadAttributeList(pointer) };
            anyhow::bail!(
                "failed to configure inherited handle allowlist: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok(Self {
            _storage: storage,
            pointer,
        })
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.pointer) };
    }
}

struct OwnedProcessInformation {
    process: OwnedHandle,
    thread: OwnedHandle,
    process_id: u32,
}

struct OwnedHandle(HANDLE);

// Ownership of a Windows kernel handle can move between threads; Drop closes it only on the receiving thread.
unsafe impl Send for OwnedHandle {}

impl OwnedHandle {
    fn terminate_job(&self, exit_code: u32) {
        unsafe { TerminateJobObject(self.0, exit_code) };
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn set_inherit(handle: HANDLE, inherit: bool) -> Result<()> {
    let flags = if inherit { HANDLE_FLAG_INHERIT } else { 0 };
    anyhow::ensure!(
        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, flags) } != 0,
        "failed to configure handle inheritance: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}

fn wide_nul(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn windows_command_line(executable: &str, args: &[String]) -> Vec<u16> {
    let mut values = Vec::with_capacity(args.len() + 1);
    values.push(executable);
    values.extend(args.iter().map(String::as_str));
    let command = values
        .into_iter()
        .map(quote_windows_argument)
        .collect::<Vec<_>>()
        .join(" ");
    wide_nul(&command)
}

fn quote_windows_argument(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return value.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for character in value.chars() {
        if character == '\\' {
            backslashes += 1;
        } else if character == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
            quoted.push('"');
            backslashes = 0;
        } else {
            quoted.push_str(&"\\".repeat(backslashes));
            backslashes = 0;
            quoted.push(character);
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

fn environment_block(environment: &std::collections::BTreeMap<String, String>) -> Vec<u16> {
    let mut block = Vec::new();
    let mut entries = environment.iter().collect::<Vec<_>>();
    entries.sort_by(|(left, _), (right, _)| {
        windows_environment_key(left)
            .cmp(&windows_environment_key(right))
            .then_with(|| left.cmp(right))
    });
    for (name, value) in entries {
        block.extend(OsStr::new(&format!("{name}={value}")).encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

fn bounded_error(message: &str) -> &str {
    let mut end = message.len().min(4096);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    &message[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn empty_environment_is_double_nul_terminated() {
        assert_eq!(environment_block(&BTreeMap::new()), vec![0, 0]);
    }

    #[test]
    fn environment_is_sorted_case_insensitively_and_double_nul_terminated() {
        let environment = BTreeMap::from([
            ("z_value".to_owned(), "3".to_owned()),
            ("Á_value".to_owned(), "2".to_owned()),
            ("a_value".to_owned(), "1".to_owned()),
        ]);
        let block = environment_block(&environment);
        let text = String::from_utf16(&block[..block.len() - 2]).unwrap();
        assert_eq!(text, "a_value=1\0z_value=3\0Á_value=2");
        assert!(block.ends_with(&[0, 0]));
    }
}
