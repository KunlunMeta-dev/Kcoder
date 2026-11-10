//! Query the SID from the actual held Windows process token.
use anyhow::{Result, ensure};
use std::{
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Security::{GetLengthSid, GetTokenInformation, IsValidSid, TOKEN_QUERY, TOKEN_USER, TokenUser},
    System::Threading::OpenProcessToken,
};

pub fn process_sid(process: HANDLE) -> Result<Vec<u8>> {
    let mut token = std::ptr::null_mut();
    // SAFETY: query-only token access; the returned token is owned below.
    ensure!(
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } != 0,
        "NATIVE_WINDOWS_PROCESS_TOKEN_UNAVAILABLE"
    );
    let token = unsafe { OwnedHandle::from_raw_handle(token.cast()) };
    let mut needed = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle().cast(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    ensure!(
        needed as usize >= size_of::<TOKEN_USER>() && needed <= 65536,
        "NATIVE_WINDOWS_PROCESS_SID_UNAVAILABLE"
    );
    let mut buffer = vec![0u64; (needed as usize).div_ceil(size_of::<u64>())];
    ensure!(
        unsafe {
            GetTokenInformation(
                token.as_raw_handle().cast(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } != 0,
        "NATIVE_WINDOWS_PROCESS_SID_UNAVAILABLE"
    );
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    ensure!(
        unsafe { IsValidSid(user.User.Sid) } != 0,
        "NATIVE_WINDOWS_PROCESS_SID_UNAVAILABLE"
    );
    let length = unsafe { GetLengthSid(user.User.Sid) } as usize;
    ensure!(
        length > 0 && length <= 68,
        "NATIVE_WINDOWS_PROCESS_SID_UNAVAILABLE"
    );
    // SAFETY: the validated SID is owned by the live TOKEN_USER buffer and is copied before it drops.
    Ok(unsafe { std::slice::from_raw_parts(user.User.Sid.cast::<u8>(), length) }.to_vec())
}
