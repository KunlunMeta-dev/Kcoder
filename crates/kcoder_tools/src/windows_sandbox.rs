#![allow(unsafe_op_in_unsafe_fn)]

//! Native Windows filesystem sandbox for child processes.
//!
//! A `WRITE_RESTRICTED` primary token carries per-root capability SIDs, and
//! each writable root is stamped with an inheritable ACE for its capability.
//! Windows therefore performs the normal user access check and a second write
//! check against the restricting SIDs. Only the three stdio pipe handles are
//! inherited.
//!
//! This backend intentionally refuses deny-read policies: a restricted token
//! can safely express the write allowlist, but not an arbitrary read-deny tree.
//! It is not a security boundary for pre-existing objects whose ACL already
//! grants write access to Everyone.
//! Stronger Windows isolation requires an elevated setup step, a dedicated
//! sandbox user, or an AppContainer. Writable-root ACEs are persistent and
//! deterministic so concurrent and later sandbox launches can reuse them.

use crate::os_sandbox::{OsSandboxBackend, OsSandboxSpec};
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString, c_void};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Arc;
use tokio::time::{Duration, sleep};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_SUCCESS, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL, LocalFree,
    SetHandleInformation, SetLastError,
};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, SET_ACCESS, SetEntriesInAclW,
    SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, AdjustTokenPrivileges,
    CopySid, CreateRestrictedToken, CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid,
    GetAce, GetAclInformation, GetLengthSid, GetTokenInformation, LookupPrivilegeValueW,
    SID_AND_ATTRIBUTES, SetTokenInformation, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES,
    TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY,
    TokenDefaultDacl, TokenGroups, TokenRestrictedSids,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
    GetExitCodeProcess, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    OpenProcessToken, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

const DISABLE_MAX_PRIVILEGE: u32 = 0x01;
const LUA_TOKEN: u32 = 0x04;
const WRITE_RESTRICTED: u32 = 0x08;
const CONTAINER_INHERIT_ACE: u32 = 0x2;
const OBJECT_INHERIT_ACE: u32 = 0x1;
const SE_FILE_OBJECT: i32 = 1;
const WIN_WORLD_SID: i32 = 1;
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;
const GENERIC_ALL: u32 = 0x1000_0000;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

pub(crate) struct WindowsSandboxChild {
    process: Arc<OwnedHandle>,
    job: WindowsSandboxTerminator,
    pub(crate) pid: u32,
    pub(crate) stdout: Option<tokio::fs::File>,
    pub(crate) stderr: Option<tokio::fs::File>,
}

#[derive(Clone)]
pub(crate) struct WindowsSandboxTerminator {
    job: Arc<OwnedHandle>,
}

impl WindowsSandboxTerminator {
    pub(crate) fn terminate(&self) {
        unsafe {
            TerminateJobObject(handle(&self.job), 1);
        }
    }
}

impl WindowsSandboxChild {
    pub(crate) fn terminator(&self) -> WindowsSandboxTerminator {
        self.job.clone()
    }

    pub(crate) fn terminate(&self) {
        self.job.terminate();
    }

    pub(crate) async fn wait(&self) -> io::Result<ExitStatus> {
        loop {
            let result = unsafe { WaitForSingleObject(handle(&self.process), 0) };
            if result == WAIT_OBJECT_0 {
                let mut code = 0u32;
                if unsafe { GetExitCodeProcess(handle(&self.process), &mut code) } == 0 {
                    return Err(last_error("GetExitCodeProcess"));
                }
                use std::os::windows::process::ExitStatusExt;
                return Ok(ExitStatus::from_raw(code));
            }
            if result != WAIT_TIMEOUT {
                return Err(last_error("WaitForSingleObject"));
            }
            sleep(Duration::from_millis(10)).await;
        }
    }
}

pub(crate) fn spawn(
    program: &OsStr,
    args: &[OsString],
    cwd: &Path,
    environment: &[(OsString, OsString)],
    spec: &OsSandboxSpec,
) -> Result<WindowsSandboxChild, String> {
    if spec.backend != OsSandboxBackend::WindowsRestrictedToken {
        return Err("Windows launcher received a non-Windows sandbox plan".to_string());
    }
    if !spec.deny_read.is_empty() {
        return Err(
            "Windows restricted-token sandbox cannot enforce sandbox.denied_paths; refusing to run unsafely"
                .to_string(),
        );
    }
    if spec.rw_paths.is_empty() {
        return Err(
            "Windows restricted-token sandbox cannot enforce a fully read-only policy without a writable capability root; refusing to run unsafely"
                .to_string(),
        );
    }

    let mut capabilities = Vec::new();
    for root in &spec.rw_paths {
        let canonical = canonical_existing_root(root)?;
        let sid = LocalSid::from_string(&capability_sid(&canonical))?;
        unsafe { add_allow_ace(&canonical, sid.as_ptr())? };
        capabilities.push(sid);
    }

    let base = unsafe { OwnedHandle::from_raw_handle(open_current_process_token()? as RawHandle) };
    let mut logon_sid = unsafe { logon_sid(handle(&base))? };
    let mut world_sid = unsafe { well_known_sid(WIN_WORLD_SID)? };
    let mut restricting: Vec<SID_AND_ATTRIBUTES> = capabilities
        .iter()
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: sid.as_ptr(),
            Attributes: 0,
        })
        .collect();
    restricting.push(SID_AND_ATTRIBUTES {
        Sid: logon_sid.as_mut_ptr() as *mut c_void,
        Attributes: 0,
    });
    restricting.push(SID_AND_ATTRIBUTES {
        Sid: world_sid.as_mut_ptr() as *mut c_void,
        Attributes: 0,
    });
    let mut token: HANDLE = std::ptr::null_mut();
    let created = unsafe {
        CreateRestrictedToken(
            handle(&base),
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            0,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            restricting.len() as u32,
            restricting.as_ptr(),
            &mut token,
        )
    };
    if created == 0 {
        return Err(last_error("CreateRestrictedToken").to_string());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token as RawHandle) };
    let capability_ptrs = capabilities
        .iter()
        .map(LocalSid::as_ptr)
        .collect::<Vec<_>>();
    if !unsafe { restricted_token_contains_all(handle(&token), &capability_ptrs)? } {
        return Err(
            "CreateRestrictedToken dropped a required workspace capability SID; refusing nested or weakened sandbox"
                .to_string(),
        );
    }
    unsafe { enable_privilege(handle(&token), "SeChangeNotifyPrivilege")? };
    let mut dacl_sids = capabilities
        .iter()
        .map(LocalSid::as_ptr)
        .collect::<Vec<_>>();
    dacl_sids.push(logon_sid.as_mut_ptr() as *mut c_void);
    unsafe { set_default_dacl(handle(&token), &dacl_sids)? };

    let result = unsafe { spawn_with_token(&token, program, args, cwd, environment) };
    result.map_err(|error| error.to_string())
}

unsafe fn spawn_with_token(
    token: &OwnedHandle,
    program: &OsStr,
    args: &[OsString],
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> io::Result<WindowsSandboxChild> {
    let job = create_kill_on_close_job()?;
    let (stdout_read, stdout_write) = create_pipe()?;
    let (stderr_read, stderr_write) = create_pipe()?;
    let (stdin_read, stdin_write) = create_pipe()?;
    drop(stdin_write);
    for child_end in [&stdin_read, &stdout_write, &stderr_write] {
        if SetHandleInformation(handle(child_end), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
            return Err(last_error("SetHandleInformation(child stdio)"));
        }
    }
    for parent_end in [&stdout_read, &stderr_read] {
        if SetHandleInformation(handle(parent_end), HANDLE_FLAG_INHERIT, 0) == 0 {
            return Err(last_error("SetHandleInformation(parent pipe)"));
        }
    }

    let argv = std::iter::once(program.to_os_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let mut command_line = command_line(&argv);
    let mut env_block = environment_block(environment);
    let cwd_wide = wide(cwd.as_os_str());
    let mut attribute_bytes = 0usize;
    InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attribute_bytes);
    let attribute_words = attribute_bytes.div_ceil(std::mem::size_of::<usize>());
    let mut attribute_storage = vec![0usize; attribute_words];
    let attribute_list = attribute_storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) == 0 {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    let mut inherited = [
        handle(&stdin_read),
        handle(&stdout_write),
        handle(&stderr_write),
    ];
    if UpdateProcThreadAttribute(
        attribute_list,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
        inherited.as_mut_ptr() as *mut c_void,
        std::mem::size_of_val(&inherited),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    ) == 0
    {
        DeleteProcThreadAttributeList(attribute_list);
        return Err(last_error("UpdateProcThreadAttribute(handle list)"));
    }
    let mut startup: STARTUPINFOEXW = std::mem::zeroed();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handle(&stdin_read);
    startup.StartupInfo.hStdOutput = handle(&stdout_write);
    startup.StartupInfo.hStdError = handle(&stderr_write);
    startup.lpAttributeList = attribute_list;
    let mut process_info: PROCESS_INFORMATION = std::mem::zeroed();
    let ok = CreateProcessAsUserW(
        handle(token),
        std::ptr::null(),
        command_line.as_mut_ptr(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        1,
        CREATE_UNICODE_ENVIRONMENT
            | CREATE_NO_WINDOW
            | CREATE_SUSPENDED
            | EXTENDED_STARTUPINFO_PRESENT,
        env_block.as_mut_ptr() as *mut c_void,
        cwd_wide.as_ptr(),
        &startup.StartupInfo,
        &mut process_info,
    );
    DeleteProcThreadAttributeList(attribute_list);
    drop(stdin_read);
    drop(stdout_write);
    drop(stderr_write);
    if ok == 0 {
        return Err(last_error("CreateProcessAsUserW"));
    }
    if AssignProcessToJobObject(handle(&job), process_info.hProcess) == 0 {
        TerminateProcess(process_info.hProcess, 1);
        CloseHandle(process_info.hThread);
        CloseHandle(process_info.hProcess);
        return Err(last_error("AssignProcessToJobObject"));
    }
    if ResumeThread(process_info.hThread) == u32::MAX {
        TerminateJobObject(handle(&job), 1);
        CloseHandle(process_info.hThread);
        CloseHandle(process_info.hProcess);
        return Err(last_error("ResumeThread"));
    }
    CloseHandle(process_info.hThread);
    let process = Arc::new(OwnedHandle::from_raw_handle(
        process_info.hProcess as RawHandle,
    ));
    let job = WindowsSandboxTerminator { job: Arc::new(job) };
    let stdout = std::fs::File::from_raw_handle(stdout_read.into_raw_handle());
    let stderr = std::fs::File::from_raw_handle(stderr_read.into_raw_handle());
    Ok(WindowsSandboxChild {
        process,
        job,
        pid: process_info.dwProcessId,
        stdout: Some(tokio::fs::File::from_std(stdout)),
        stderr: Some(tokio::fs::File::from_std(stderr)),
    })
}

fn create_kill_on_close_job() -> io::Result<OwnedHandle> {
    let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw.is_null() {
        return Err(last_error("CreateJobObjectW"));
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            handle(&job),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(last_error("SetInformationJobObject"));
    }
    Ok(job)
}

fn canonical_existing_root(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|error| {
        format!(
            "Windows sandbox writable root {} is unavailable: {error}",
            path.display()
        )
    })
}

fn capability_sid(path: &Path) -> String {
    let normalized = path.to_string_lossy().to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    let parts = (0..4).map(|index| {
        let offset = index * 4;
        u32::from_le_bytes(digest[offset..offset + 4].try_into().unwrap())
    });
    format!(
        "S-1-5-21-{}",
        parts
            .map(|part| part.to_string())
            .collect::<Vec<_>>()
            .join("-")
    )
}

unsafe fn add_allow_ace(path: &Path, sid: *mut c_void) -> Result<(), String> {
    let mut security_descriptor = std::ptr::null_mut();
    let mut dacl = std::ptr::null_mut();
    let path_wide = wide(path.as_os_str());
    let result = GetNamedSecurityInfoW(
        path_wide.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        &mut dacl,
        std::ptr::null_mut(),
        &mut security_descriptor,
    );
    if result != ERROR_SUCCESS {
        return Err(format!(
            "GetNamedSecurityInfoW({}) failed: {result}",
            path.display()
        ));
    }
    if dacl_grants_full_access(dacl, sid) {
        LocalFree(security_descriptor as HLOCAL);
        return Ok(());
    }
    let trustee = TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: 0,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid as *mut u16,
    };
    let explicit = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: SET_ACCESS,
        grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
        Trustee: trustee,
    };
    let mut new_dacl = std::ptr::null_mut();
    let set_entries = SetEntriesInAclW(1, &explicit, dacl, &mut new_dacl);
    if set_entries != ERROR_SUCCESS {
        LocalFree(security_descriptor as HLOCAL);
        return Err(format!(
            "SetEntriesInAclW({}) failed: {set_entries}",
            path.display()
        ));
    }
    let set_security = SetNamedSecurityInfoW(
        path_wide.as_ptr() as *mut u16,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        new_dacl,
        std::ptr::null_mut(),
    );
    LocalFree(new_dacl as HLOCAL);
    LocalFree(security_descriptor as HLOCAL);
    if set_security != ERROR_SUCCESS {
        return Err(format!(
            "SetNamedSecurityInfoW({}) failed: {set_security}",
            path.display()
        ));
    }
    Ok(())
}

unsafe fn dacl_grants_full_access(dacl: *mut ACL, sid: *mut c_void) -> bool {
    if dacl.is_null() {
        return false;
    }
    let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
    if GetAclInformation(
        dacl,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
        AclSizeInformation,
    ) == 0
    {
        return false;
    }
    for index in 0..info.AceCount {
        let mut ace = std::ptr::null_mut();
        if GetAce(dacl, index, &mut ace) == 0 || ace.is_null() {
            continue;
        }
        let allowed = ace as *const ACCESS_ALLOWED_ACE;
        if (*allowed).Header.AceType != ACCESS_ALLOWED_ACE_TYPE {
            continue;
        }
        let ace_sid = std::ptr::addr_of!((*allowed).SidStart) as *mut c_void;
        if EqualSid(ace_sid, sid) != 0 && ((*allowed).Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS {
            return true;
        }
    }
    false
}

unsafe fn open_current_process_token() -> Result<HANDLE, String> {
    let mut token = std::ptr::null_mut();
    let access = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    if OpenProcessToken(GetCurrentProcess(), access, &mut token) == 0 {
        return Err(last_error("OpenProcessToken").to_string());
    }
    Ok(token)
}

unsafe fn enable_privilege(token: HANDLE, name: &str) -> Result<(), String> {
    let mut luid = std::mem::zeroed();
    let wide_name = wide(OsStr::new(name));
    if LookupPrivilegeValueW(std::ptr::null(), wide_name.as_ptr(), &mut luid) == 0 {
        return Err(last_error("LookupPrivilegeValueW").to_string());
    }
    let mut privileges: TOKEN_PRIVILEGES = std::mem::zeroed();
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Luid = luid;
    privileges.Privileges[0].Attributes = 0x2;
    SetLastError(ERROR_SUCCESS);
    if AdjustTokenPrivileges(
        token,
        0,
        &privileges,
        0,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    ) == 0
    {
        return Err(last_error("AdjustTokenPrivileges").to_string());
    }
    let status = GetLastError();
    if status != ERROR_SUCCESS {
        return Err(format!(
            "AdjustTokenPrivileges did not enable {name}: {status} ({})",
            io::Error::from_raw_os_error(status as i32)
        ));
    }
    Ok(())
}

unsafe fn restricted_token_contains_all(
    token: HANDLE,
    required_sids: &[*mut c_void],
) -> Result<bool, String> {
    let mut needed = 0u32;
    GetTokenInformation(
        token,
        TokenRestrictedSids,
        std::ptr::null_mut(),
        0,
        &mut needed,
    );
    if needed == 0 {
        return Err(last_error("GetTokenInformation(TokenRestrictedSids size)").to_string());
    }
    let mut buffer = vec![0u8; needed as usize];
    if GetTokenInformation(
        token,
        TokenRestrictedSids,
        buffer.as_mut_ptr() as *mut c_void,
        needed,
        &mut needed,
    ) == 0
    {
        return Err(last_error("GetTokenInformation(TokenRestrictedSids)").to_string());
    }

    let count = std::ptr::read_unaligned(buffer.as_ptr() as *const u32) as usize;
    let after_count = buffer.as_ptr().add(std::mem::size_of::<u32>()) as usize;
    let alignment = std::mem::align_of::<SID_AND_ATTRIBUTES>();
    let groups = ((after_count + alignment - 1) & !(alignment - 1)) as *const SID_AND_ATTRIBUTES;
    Ok(required_sids.iter().all(|required| {
        (0..count).any(|index| {
            let entry = std::ptr::read_unaligned(groups.add(index));
            EqualSid(entry.Sid, *required) != 0
        })
    }))
}

#[repr(C)]
struct TokenDefaultDaclInfo {
    default_dacl: *mut ACL,
}

unsafe fn set_default_dacl(token: HANDLE, sids: &[*mut c_void]) -> Result<(), String> {
    let entries = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: *sid as *mut u16,
            },
        })
        .collect::<Vec<_>>();
    let mut dacl = std::ptr::null_mut();
    let result = SetEntriesInAclW(
        entries.len() as u32,
        entries.as_ptr(),
        std::ptr::null_mut(),
        &mut dacl,
    );
    if result != ERROR_SUCCESS {
        return Err(format!("SetEntriesInAclW(default DACL) failed: {result}"));
    }
    let mut info = TokenDefaultDaclInfo { default_dacl: dacl };
    let ok = SetTokenInformation(
        token,
        TokenDefaultDacl,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<TokenDefaultDaclInfo>() as u32,
    );
    LocalFree(dacl as HLOCAL);
    if ok == 0 {
        return Err(last_error("SetTokenInformation(TokenDefaultDacl)").to_string());
    }
    Ok(())
}

unsafe fn logon_sid(token: HANDLE) -> Result<Vec<u8>, String> {
    let mut needed = 0u32;
    GetTokenInformation(token, TokenGroups, std::ptr::null_mut(), 0, &mut needed);
    if needed == 0 {
        return Err(last_error("GetTokenInformation(TokenGroups size)").to_string());
    }
    let mut buffer = vec![0u8; needed as usize];
    if GetTokenInformation(
        token,
        TokenGroups,
        buffer.as_mut_ptr() as *mut c_void,
        needed,
        &mut needed,
    ) == 0
    {
        return Err(last_error("GetTokenInformation(TokenGroups)").to_string());
    }
    let count = std::ptr::read_unaligned(buffer.as_ptr() as *const u32) as usize;
    let after_count = buffer.as_ptr().add(std::mem::size_of::<u32>()) as usize;
    let alignment = std::mem::align_of::<SID_AND_ATTRIBUTES>();
    let groups = ((after_count + alignment - 1) & !(alignment - 1)) as *const SID_AND_ATTRIBUTES;
    for index in 0..count {
        let entry = std::ptr::read_unaligned(groups.add(index));
        if entry.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID {
            let length = GetLengthSid(entry.Sid);
            if length == 0 {
                return Err(last_error("GetLengthSid(logon SID)").to_string());
            }
            let mut sid = vec![0u8; length as usize];
            if CopySid(length, sid.as_mut_ptr() as *mut c_void, entry.Sid) == 0 {
                return Err(last_error("CopySid(logon SID)").to_string());
            }
            return Ok(sid);
        }
    }
    Err("current process token does not contain a logon SID".to_string())
}

unsafe fn well_known_sid(kind: i32) -> Result<Vec<u8>, String> {
    let mut needed = 0u32;
    CreateWellKnownSid(
        kind,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        &mut needed,
    );
    let mut sid = vec![0u8; needed as usize];
    if CreateWellKnownSid(
        kind,
        std::ptr::null_mut(),
        sid.as_mut_ptr() as *mut c_void,
        &mut needed,
    ) == 0
    {
        return Err(last_error("CreateWellKnownSid").to_string());
    }
    Ok(sid)
}

fn create_pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut read = std::ptr::null_mut();
    let mut write = std::ptr::null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null_mut(), 0) } == 0 {
        return Err(last_error("CreatePipe"));
    }
    Ok(unsafe {
        (
            OwnedHandle::from_raw_handle(read as RawHandle),
            OwnedHandle::from_raw_handle(write as RawHandle),
        )
    })
}

fn environment_block(environment: &[(OsString, OsString)]) -> Vec<u16> {
    let mut entries = environment.to_vec();
    entries.sort_by(|left, right| {
        left.0
            .to_string_lossy()
            .to_lowercase()
            .cmp(&right.0.to_string_lossy().to_lowercase())
    });
    let mut block = Vec::new();
    for (name, value) in entries {
        block.extend(name.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

fn command_line(argv: &[OsString]) -> Vec<u16> {
    let joined = argv
        .iter()
        .map(|arg| quote_arg(arg))
        .collect::<Vec<_>>()
        .join(" ");
    wide(OsStr::new(&joined))
}

fn quote_arg(arg: &OsStr) -> String {
    let value = arg.to_string_lossy();
    if !value.is_empty() && !value.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return value.into_owned();
    }
    let mut quoted = String::from("\"");
    let mut slashes = 0usize;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
        } else if ch == '"' {
            quoted.push_str(&"\\".repeat(slashes * 2 + 1));
            quoted.push('"');
            slashes = 0;
        } else {
            quoted.push_str(&"\\".repeat(slashes));
            slashes = 0;
            quoted.push(ch);
        }
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn handle(value: &OwnedHandle) -> HANDLE {
    value.as_raw_handle() as HANDLE
}

fn last_error(operation: &str) -> io::Error {
    let code = unsafe { GetLastError() } as i32;
    io::Error::other(format!(
        "{operation} failed: {code} ({})",
        io::Error::from_raw_os_error(code)
    ))
}

struct LocalSid(*mut c_void);

impl LocalSid {
    fn from_string(value: &str) -> Result<Self, String> {
        unsafe extern "system" {
            #[link_name = "ConvertStringSidToSidW"]
            fn ConvertStringSidToSidW(value: *const u16, sid: *mut *mut c_void) -> i32;
        }
        let value = wide(OsStr::new(value));
        let mut sid = std::ptr::null_mut();
        if unsafe { ConvertStringSidToSidW(value.as_ptr(), &mut sid) } == 0 {
            return Err(last_error("ConvertStringSidToSidW").to_string());
        }
        Ok(Self(sid))
    }

    fn as_ptr(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for LocalSid {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0 as HLOCAL) };
    }
}

trait IntoRawHandleOwned {
    fn into_raw_handle(self) -> RawHandle;
}

impl IntoRawHandleOwned for OwnedHandle {
    fn into_raw_handle(self) -> RawHandle {
        use std::os::windows::io::IntoRawHandle;
        IntoRawHandle::into_raw_handle(self)
    }
}
