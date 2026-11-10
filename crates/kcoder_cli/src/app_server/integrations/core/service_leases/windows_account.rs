//! Personal service processes retain their actual non-elevated Windows token.
//! No account name, SID string, password or caller declaration creates this owner.
use anyhow::{Result, ensure};
use std::{
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::{HANDLE, WAIT_TIMEOUT},
    Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid,
        TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_STATISTICS, TokenElevation,
        TokenIntegrityLevel, TokenStatistics,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken, WaitForSingleObject},
};

pub struct CurrentWindowsServiceAccount {
    token: OwnedHandle,
    sid: Vec<u8>,
}
impl CurrentWindowsServiceAccount {
    pub fn capture() -> Result<Self> {
        let process = unsafe { GetCurrentProcess() };
        let mut token = std::ptr::null_mut();
        // SAFETY: the pseudo process handle is current, and this receives a new
        // non-inherited query-only token handle. No impersonation is performed.
        ensure!(
            unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } != 0,
            "SERVICE_WINDOWS_CURRENT_TOKEN_UNAVAILABLE"
        );
        let token = unsafe { OwnedHandle::from_raw_handle(token.cast()) };
        let sid = crate::service_identity::process_sid(process)?;
        let value = Self { token, sid };
        value.verify()?;
        Ok(value)
    }
    pub fn verify(&self) -> Result<()> {
        ensure!(
            crate::service_identity::process_sid(unsafe { GetCurrentProcess() })? == self.sid,
            "SERVICE_WINDOWS_CURRENT_SID_CHANGED"
        );
        let mut current = std::ptr::null_mut();
        ensure!(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut current) } != 0,
            "SERVICE_WINDOWS_CURRENT_TOKEN_UNAVAILABLE"
        );
        let current = unsafe { OwnedHandle::from_raw_handle(current.cast()) };
        let original = token_statistics(self.token.as_raw_handle().cast())?;
        let observed = token_statistics(current.as_raw_handle().cast())?;
        ensure!(
            original.TokenId.HighPart == observed.TokenId.HighPart
                && original.TokenId.LowPart == observed.TokenId.LowPart
                && original.AuthenticationId.HighPart == observed.AuthenticationId.HighPart
                && original.AuthenticationId.LowPart == observed.AuthenticationId.LowPart,
            "SERVICE_WINDOWS_CURRENT_TOKEN_CHANGED"
        );
        nonprivileged_token(self.token.as_raw_handle().cast())
    }
    /// Only an actual retained process handle is accepted; no serialized PID or
    /// user-supplied SID can substitute for the scheduler/Job's original child.
    pub fn verify_owned_process(&self, process: BorrowedHandle<'_>) -> Result<()> {
        self.verify()?;
        let process = process.as_raw_handle().cast();
        ensure!(
            unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT
                && crate::service_identity::process_sid(process)? == self.sid,
            "SERVICE_WINDOWS_CHILD_SID_MISMATCH_OR_EXITED"
        );
        let mut raw = std::ptr::null_mut();
        ensure!(
            unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } != 0,
            "SERVICE_WINDOWS_CHILD_TOKEN_UNAVAILABLE"
        );
        // SAFETY: the query API returned this new non-inheritable token handle.
        let token = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
        nonprivileged_token(token.as_raw_handle().cast())
    }
    pub fn sid(&self) -> &[u8] {
        &self.sid
    }
    pub fn sid_string(&self) -> Result<String> {
        self.verify()?;
        let mut text = std::ptr::null_mut();
        ensure!(
            unsafe {
                windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW(
                    self.sid.as_ptr().cast_mut().cast(),
                    &mut text,
                )
            } != 0,
            "SERVICE_WINDOWS_CURRENT_SID_UNAVAILABLE"
        );
        struct Local(*mut u16);
        impl Drop for Local {
            fn drop(&mut self) {
                unsafe {
                    windows_sys::Win32::Foundation::LocalFree(self.0.cast());
                }
            }
        }
        let text = Local(text);
        let mut length = 0;
        while length < 256 && unsafe { *text.0.add(length) } != 0 {
            length += 1;
        }
        ensure!(
            (1..256).contains(&length),
            "SERVICE_WINDOWS_CURRENT_SID_UNAVAILABLE"
        );
        Ok(String::from_utf16(unsafe {
            std::slice::from_raw_parts(text.0, length)
        })?)
    }
}

fn token_statistics(token: HANDLE) -> Result<TOKEN_STATISTICS> {
    let mut value: TOKEN_STATISTICS = unsafe { zeroed() };
    let mut length = 0;
    ensure!(
        unsafe {
            GetTokenInformation(
                token,
                TokenStatistics,
                (&mut value as *mut TOKEN_STATISTICS).cast(),
                size_of::<TOKEN_STATISTICS>() as u32,
                &mut length,
            )
        } != 0,
        "SERVICE_WINDOWS_TOKEN_METADATA_UNAVAILABLE"
    );
    Ok(value)
}

fn token_bytes(
    token: HANDLE,
    class: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> Result<Vec<usize>> {
    let mut required = 0;
    unsafe { GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut required) };
    ensure!(
        (1..=65536).contains(&required),
        "SERVICE_WINDOWS_TOKEN_METADATA_UNAVAILABLE"
    );
    let words = usize::try_from(required)?.div_ceil(size_of::<usize>());
    let mut bytes = vec![0usize; words];
    ensure!(
        unsafe {
            GetTokenInformation(
                token,
                class,
                bytes.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } != 0,
        "SERVICE_WINDOWS_TOKEN_METADATA_UNAVAILABLE"
    );
    Ok(bytes)
}

fn nonprivileged_token(token: HANDLE) -> Result<()> {
    let mut elevation: TOKEN_ELEVATION = unsafe { zeroed() };
    let mut length = 0;
    ensure!(
        unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut length,
            )
        } != 0
            && elevation.TokenIsElevated == 0,
        "SERVICE_WINDOWS_NONPRIVILEGED_TOKEN_REQUIRED"
    );
    let integrity = token_bytes(token, TokenIntegrityLevel)?;
    ensure!(
        integrity.len() * size_of::<usize>() >= size_of::<TOKEN_MANDATORY_LABEL>(),
        "SERVICE_WINDOWS_INTEGRITY_UNAVAILABLE"
    );
    // SAFETY: GetTokenInformation populated this aligned allocation; the SID
    // remains inside it while its terminal integrity RID is inspected.
    let label = unsafe { &*(integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()) };
    ensure!(
        unsafe { IsValidSid(label.Label.Sid) } != 0,
        "SERVICE_WINDOWS_INTEGRITY_UNAVAILABLE"
    );
    let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) };
    ensure!(count > 0, "SERVICE_WINDOWS_INTEGRITY_UNAVAILABLE");
    let rid = unsafe { *GetSidSubAuthority(label.Label.Sid, u32::from(count - 1)) };
    ensure!(
        rid <= 0x2000,
        "SERVICE_WINDOWS_NONPRIVILEGED_TOKEN_REQUIRED"
    );
    Ok(())
}
