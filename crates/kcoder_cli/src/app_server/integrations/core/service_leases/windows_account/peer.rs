//! Peer IPC retains real same-SID, same-tier tokens without enabling personal services.
use super::*;
use windows_sys::Win32::{
    Foundation::{ERROR_NO_TOKEN, GetLastError},
    Security::{
        GetLengthSid, IsTokenRestricted, TOKEN_USER, TokenIsAppContainer, TokenSessionId, TokenUser,
    },
    System::Threading::{GetCurrentThread, OpenThreadToken},
};

#[derive(Clone, Copy, PartialEq, Eq)]
struct Tier {
    elevated: u32,
    integrity: u32,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    token: (i32, u32),
    modified: (i32, u32),
    logon: (i32, u32),
    session: u32,
}
pub struct CurrentWindowsPeerAccount {
    token: OwnedHandle,
    sid: Vec<u8>,
    tier: Tier,
    stamp: Stamp,
}
pub struct WindowsPeerTokenWitness {
    token: OwnedHandle,
    sid: Vec<u8>,
    tier: Tier,
    stamp: Stamp,
}
fn no_impersonation() -> Result<()> {
    let mut token = std::ptr::null_mut();
    let opened = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) };
    if opened != 0 {
        drop(unsafe { OwnedHandle::from_raw_handle(token.cast()) });
        anyhow::bail!("PEER_SOURCE_WINDOWS_IMPERSONATION_DENIED");
    }
    ensure!(
        unsafe { GetLastError() } == ERROR_NO_TOKEN,
        "PEER_SOURCE_WINDOWS_THREAD_TOKEN_UNKNOWN"
    );
    Ok(())
}
fn query(process: HANDLE) -> Result<OwnedHandle> {
    let mut token = std::ptr::null_mut();
    ensure!(
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } != 0,
        "PEER_SOURCE_WINDOWS_TOKEN_UNAVAILABLE"
    );
    Ok(unsafe { OwnedHandle::from_raw_handle(token.cast()) })
}
fn sid(token: HANDLE) -> Result<Vec<u8>> {
    let bytes = token_bytes(token, TokenUser)?;
    ensure!(
        bytes.len() * size_of::<usize>() >= size_of::<TOKEN_USER>(),
        "PEER_SOURCE_WINDOWS_TOKEN_UNAVAILABLE"
    );
    let sid = unsafe { (*(bytes.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    ensure!(
        unsafe { IsValidSid(sid) } != 0,
        "PEER_SOURCE_WINDOWS_SID_UNAVAILABLE"
    );
    let len = unsafe { GetLengthSid(sid) } as usize;
    ensure!(
        (8..=68).contains(&len),
        "PEER_SOURCE_WINDOWS_SID_UNAVAILABLE"
    );
    Ok(unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), len) }.to_vec())
}
fn tier(token: HANDLE) -> Result<Tier> {
    ensure!(
        unsafe { IsTokenRestricted(token) } == 0,
        "PEER_SOURCE_WINDOWS_RESTRICTED_TOKEN_DENIED"
    );
    let app = token_bytes(token, TokenIsAppContainer)?;
    ensure!(
        app.first().is_some_and(|v| *v as u32 == 0),
        "PEER_SOURCE_WINDOWS_APPCONTAINER_DENIED"
    );
    let mut elevation: TOKEN_ELEVATION = unsafe { zeroed() };
    let mut len = 0;
    ensure!(
        unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            )
        } != 0,
        "PEER_SOURCE_WINDOWS_ELEVATION_UNAVAILABLE"
    );
    let bytes = token_bytes(token, TokenIntegrityLevel)?;
    ensure!(
        bytes.len() * size_of::<usize>() >= size_of::<TOKEN_MANDATORY_LABEL>(),
        "PEER_SOURCE_WINDOWS_INTEGRITY_UNAVAILABLE"
    );
    let label = unsafe { &*bytes.as_ptr().cast::<TOKEN_MANDATORY_LABEL>() };
    ensure!(
        unsafe { IsValidSid(label.Label.Sid) } != 0,
        "PEER_SOURCE_WINDOWS_INTEGRITY_UNAVAILABLE"
    );
    let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) };
    ensure!(count > 0, "PEER_SOURCE_WINDOWS_INTEGRITY_UNAVAILABLE");
    let integrity = unsafe { *GetSidSubAuthority(label.Label.Sid, u32::from(count - 1)) };
    ensure!(
        (0x2000..=0x3000).contains(&integrity),
        "PEER_SOURCE_WINDOWS_TOKEN_TIER_DENIED"
    );
    Ok(Tier {
        elevated: elevation.TokenIsElevated,
        integrity,
    })
}
fn stamp(token: HANDLE) -> Result<Stamp> {
    let s = token_statistics(token)?;
    let session = token_bytes(token, TokenSessionId)?;
    Ok(Stamp {
        token: (s.TokenId.HighPart, s.TokenId.LowPart),
        modified: (s.ModifiedId.HighPart, s.ModifiedId.LowPart),
        logon: (s.AuthenticationId.HighPart, s.AuthenticationId.LowPart),
        session: *session
            .first()
            .ok_or_else(|| anyhow::anyhow!("PEER_SOURCE_WINDOWS_TOKEN_UNAVAILABLE"))?
            as u32,
    })
}
impl CurrentWindowsPeerAccount {
    pub fn duplicate(&self) -> Result<Self> {
        self.verify()?;
        Ok(Self {
            token: self.token.try_clone()?,
            sid: self.sid.clone(),
            tier: self.tier,
            stamp: self.stamp,
        })
    }
    pub fn capture() -> Result<Self> {
        no_impersonation()?;
        let token = query(unsafe { GetCurrentProcess() })?;
        let h = token.as_raw_handle().cast();
        let value = Self {
            sid: sid(h)?,
            tier: tier(h)?,
            stamp: stamp(h)?,
            token,
        };
        value.verify()?;
        Ok(value)
    }
    pub fn verify(&self) -> Result<()> {
        no_impersonation()?;
        let token = query(unsafe { GetCurrentProcess() })?;
        let h = token.as_raw_handle().cast();
        ensure!(
            stamp(self.token.as_raw_handle().cast())? == self.stamp
                && stamp(h)? == self.stamp
                && sid(h)? == self.sid
                && tier(h)? == self.tier,
            "PEER_SOURCE_WINDOWS_CURRENT_TOKEN_CHANGED"
        );
        Ok(())
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
            "PEER_SOURCE_WINDOWS_SID_UNAVAILABLE"
        );
        let mut len = 0;
        while len < 256 && unsafe { *text.add(len) } != 0 {
            len += 1;
        }
        let value = String::from_utf16(unsafe { std::slice::from_raw_parts(text, len) });
        unsafe { windows_sys::Win32::Foundation::LocalFree(text.cast()) };
        ensure!(
            (1..256).contains(&len),
            "PEER_SOURCE_WINDOWS_SID_UNAVAILABLE"
        );
        Ok(value?)
    }
    pub fn capture_process(&self, process: BorrowedHandle<'_>) -> Result<WindowsPeerTokenWitness> {
        self.verify()?;
        ensure!(
            unsafe { WaitForSingleObject(process.as_raw_handle().cast(), 0) } == WAIT_TIMEOUT,
            "PEER_SOURCE_WINDOWS_PEER_EXITED"
        );
        let token = query(process.as_raw_handle().cast())?;
        let h = token.as_raw_handle().cast();
        let value = WindowsPeerTokenWitness {
            sid: sid(h)?,
            tier: tier(h)?,
            stamp: stamp(h)?,
            token,
        };
        ensure!(
            value.sid == self.sid && value.tier == self.tier,
            "PEER_SOURCE_WINDOWS_PEER_TIER_DENIED"
        );
        value.verify(self, process)?;
        Ok(value)
    }
}
impl WindowsPeerTokenWitness {
    pub fn verify(
        &self,
        account: &CurrentWindowsPeerAccount,
        process: BorrowedHandle<'_>,
    ) -> Result<()> {
        account.verify()?;
        ensure!(
            unsafe { WaitForSingleObject(process.as_raw_handle().cast(), 0) } == WAIT_TIMEOUT,
            "PEER_SOURCE_WINDOWS_PEER_EXITED"
        );
        let token = query(process.as_raw_handle().cast())?;
        let h = token.as_raw_handle().cast();
        // Distinct logons may share an authorized OS profile. Each original
        // primary token, logon and session must remain unchanged independently.
        ensure!(
            stamp(self.token.as_raw_handle().cast())? == self.stamp
                && stamp(h)? == self.stamp
                && sid(h)? == self.sid
                && self.sid == account.sid
                && tier(h)? == self.tier
                && self.tier == account.tier,
            "PEER_SOURCE_WINDOWS_PEER_TOKEN_CHANGED"
        );
        Ok(())
    }
}
