//! Process-lifetime desktop singleton for a Windows user/logon session.
//! This is an exclusive named-object reservation, not a thread-owned mutex, so
//! async worker tasks may move threads. Host must reap its Job before dropping it.
use crate::windows_peer::current_user_sid;
use anyhow::{Result, ensure};
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{ERROR_ALREADY_EXISTS, GetLastError, LocalFree},
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        SECURITY_ATTRIBUTES,
    },
    System::{
        RemoteDesktop::ProcessIdToSessionId,
        Threading::{CreateMutexW, GetCurrentProcessId},
    },
};

pub struct DesktopReservation {
    _handle: OwnedHandle,
    pub session_id: u32,
    job_name: String,
}
impl DesktopReservation {
    pub(crate) fn job_name(&self) -> &str {
        &self.job_name
    }
    pub fn acquire() -> Result<Self> {
        let mut session_id = 0;
        ensure!(
            unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session_id) } != 0,
            "cannot read desktop session"
        );
        let sid = current_user_sid().map_err(|_| anyhow::anyhow!("cannot read desktop user"))?;
        let name: Vec<_> = format!("Local\\KCoder-Desktop-{sid}-{session_id}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let sddl: Vec<_> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = std::ptr::null_mut();
        ensure!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            } != 0,
            "desktop lock ACL failed"
        );
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = unsafe { CreateMutexW(&attributes, 0, name.as_ptr()) };
        let error = unsafe { GetLastError() };
        unsafe {
            LocalFree(descriptor);
        }
        ensure!(!handle.is_null(), "desktop reservation failed: {error}");
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        ensure!(
            error != ERROR_ALREADY_EXISTS,
            "desktop_busy: another KCoder process owns this desktop"
        );
        Ok(Self {
            _handle: handle,
            session_id,
            job_name: format!("Local\\KCoder-Desktop-Job-{sid}-{session_id}"),
        })
    }
}
