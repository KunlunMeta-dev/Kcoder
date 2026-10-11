use super::*;
use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, HLOCAL, LocalFree};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
    EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl, GetTokenInformation,
    INHERITED_ACE, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub(super) fn verify_child_inherits_private_acl(file: &File) -> Result<()> {
    let token = current_process_token()?;
    let user = match token_user(token) {
        Ok(user) => user,
        Err(error) => {
            unsafe { CloseHandle(token) };
            return Err(error);
        }
    };
    let sid = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
    let verification = verify_private_acl(file.as_raw_handle() as HANDLE, sid, None, false, true);
    unsafe { CloseHandle(token) };
    verification
}

fn current_process_token() -> Result<HANDLE> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error()).context("OpenProcessToken failed");
    }
    Ok(token)
}

fn token_user(token: HANDLE) -> Result<Vec<u8>> {
    let mut needed = 0u32;
    unsafe {
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
    }
    anyhow::ensure!(needed != 0, "GetTokenInformation(TokenUser size) failed");
    let mut buffer = vec![0u8; needed as usize];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut c_void,
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("GetTokenInformation(TokenUser) failed");
    }
    Ok(buffer)
}

fn verify_private_acl(
    handle: HANDLE,
    expected_sid: *mut c_void,
    exact_ace_flags: Option<u8>,
    require_protected: bool,
    require_inherited: bool,
) -> Result<()> {
    let mut descriptor = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != ERROR_SUCCESS {
        anyhow::bail!("GetSecurityInfo(private artifact) failed: {result}")
    }
    let verification = (|| -> Result<()> {
        anyhow::ensure!(!dacl.is_null(), "private artifact has a null DACL");
        let mut control = 0u16;
        let mut revision = 0u32;
        anyhow::ensure!(
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } != 0,
            "GetSecurityDescriptorControl(private artifact) failed"
        );
        if require_protected {
            anyhow::ensure!(
                control & SE_DACL_PROTECTED != 0,
                "private artifact DACL is not protected"
            );
        }
        let mut info = ACL_SIZE_INFORMATION::default();
        anyhow::ensure!(
            unsafe {
                GetAclInformation(
                    dacl,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of_val(&info) as u32,
                    AclSizeInformation,
                )
            } != 0,
            "GetAclInformation(private artifact) failed"
        );
        anyhow::ensure!(info.AceCount == 1, "private artifact DACL is not exclusive");
        let mut raw_ace = std::ptr::null_mut();
        anyhow::ensure!(
            unsafe { GetAce(dacl, 0, &mut raw_ace) } != 0,
            "GetAce(private artifact) failed"
        );
        let ace = unsafe { &*(raw_ace as *const ACCESS_ALLOWED_ACE) };
        let ace_sid = std::ptr::addr_of!(ace.SidStart) as *mut c_void;
        let flags_match = exact_ace_flags.is_none_or(|flags| ace.Header.AceFlags == flags)
            && (!require_inherited || ace.Header.AceFlags & INHERITED_ACE as u8 != 0);
        anyhow::ensure!(
            ace.Header.AceType == ACCESS_ALLOWED_ACE_TYPE as u8
                && flags_match
                && ace.Mask & FILE_ALL_ACCESS == FILE_ALL_ACCESS
                && unsafe { EqualSid(ace_sid, expected_sid) } != 0,
            "private artifact DACL does not grant only the current user full access"
        );
        Ok(())
    })();
    unsafe { LocalFree(descriptor as HLOCAL) };
    verification
}
