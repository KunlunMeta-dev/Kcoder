//! Held parent identity supplied by the native connection owner.
use anyhow::Result;
use kcoder_config::PrivateDirectory;

pub trait NativeComponentParentAuthority: Send + Sync {
    #[cfg(windows)]
    fn verified_windows_parent_process(&self) -> Result<std::os::windows::io::BorrowedHandle<'_>> {
        anyhow::bail!("NATIVE_WINDOWS_PARENT_UNAVAILABLE")
    }
    fn administrative_workspace_binding(
        &self,
    ) -> Result<(&str, kcoder_app_protocol::RetentionPrincipalV1)>;
    fn verify_native_component_roots(
        &self,
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
    ) -> Result<()>;
}

#[cfg(windows)]
pub use windows::{actual_parent_pid, capture_current_service_parent, process_start};

#[cfg(windows)]
mod windows {
    use anyhow::{Result, ensure};
    use kcoder_native_scope::service_identity::process_sid;
    use std::{
        mem::{size_of, zeroed},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::{
        Foundation::{FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
            },
        },
    };
    pub fn actual_parent_pid() -> Result<u32> {
        // SAFETY: ToolHelp returns a new owned snapshot handle.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        ensure!(
            snapshot != INVALID_HANDLE_VALUE,
            "NATIVE_WINDOWS_PROCESS_SNAPSHOT_UNAVAILABLE"
        );
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.cast()) };
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let own = unsafe { GetCurrentProcessId() };
        let mut found = unsafe { Process32FirstW(snapshot.as_raw_handle().cast(), &mut entry) };
        while found != 0 {
            if entry.th32ProcessID == own {
                ensure!(
                    entry.th32ParentProcessID != 0 && entry.th32ParentProcessID != own,
                    "NATIVE_WINDOWS_PARENT_UNAVAILABLE"
                );
                return Ok(entry.th32ParentProcessID);
            }
            found = unsafe { Process32NextW(snapshot.as_raw_handle().cast(), &mut entry) };
        }
        anyhow::bail!("NATIVE_WINDOWS_PARENT_UNAVAILABLE")
    }
    pub fn process_start(process: HANDLE) -> Result<u64> {
        let (mut created, mut exited, mut kernel, mut user): (
            FILETIME,
            FILETIME,
            FILETIME,
            FILETIME,
        ) = unsafe { zeroed() };
        // SAFETY: all four outputs are correctly sized and the process handle is held.
        ensure!(
            unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }
                != 0,
            "NATIVE_WINDOWS_PROCESS_TIME_UNAVAILABLE"
        );
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
    pub fn capture_current_service_parent() -> Result<OwnedHandle> {
        let pid = actual_parent_pid()?;
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        ensure!(!raw.is_null(), "SERVICE_WINDOWS_ACTUAL_PARENT_UNAVAILABLE");
        let parent = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
        ensure!(
            actual_parent_pid()? == pid
                && process_start(parent.as_raw_handle().cast())?
                    <= process_start(unsafe { GetCurrentProcess() })?
                && process_sid(parent.as_raw_handle().cast())?
                    == process_sid(unsafe { GetCurrentProcess() })?
                && unsafe { WaitForSingleObject(parent.as_raw_handle().cast(), 0) } == WAIT_TIMEOUT,
            "SERVICE_WINDOWS_ACTUAL_PARENT_CHANGED_OR_FOREIGN"
        );
        Ok(parent)
    }
}
