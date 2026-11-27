//! Only OS-protected system images may retain multiple servicing hard links.
use anyhow::{Context, Result, ensure};
use std::{ffi::c_void, fs::File, mem::size_of, os::windows::io::AsRawHandle, sync::OnceLock};
use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, GENERIC_ALL, GENERIC_WRITE, GetLastError, LocalFree},
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
        CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetLengthSid, IsValidAcl,
        IsValidSid, LookupAccountNameW, OWNER_SECURITY_INFORMATION, WinBuiltinAdministratorsSid,
        WinLocalSystemSid,
    },
    Storage::FileSystem::{
        DELETE, FILE_APPEND_DATA, FILE_DELETE_CHILD, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA,
        FILE_WRITE_EA, WRITE_DAC, WRITE_OWNER,
    },
    System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE},
};

static TRUSTED: OnceLock<Vec<Vec<u8>>> = OnceLock::new();
const WRITE: u32 = GENERIC_ALL
    | GENERIC_WRITE
    | DELETE
    | WRITE_DAC
    | WRITE_OWNER
    | FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | FILE_DELETE_CHILD;

fn trusted_sids() -> Result<&'static [Vec<u8>]> {
    if TRUSTED.get().is_none() {
        let mut values = Vec::new();
        for kind in [WinLocalSystemSid, WinBuiltinAdministratorsSid] {
            let mut bytes = vec![0u8; 68];
            let mut length = bytes.len() as u32;
            ensure!(
                unsafe {
                    CreateWellKnownSid(
                        kind,
                        std::ptr::null_mut(),
                        bytes.as_mut_ptr().cast(),
                        &mut length,
                    )
                } != 0,
                "NATIVE_SYSTEM_IMAGE_PRINCIPAL_UNAVAILABLE"
            );
            bytes.truncate(length as usize);
            values.push(bytes);
        }
        let name: Vec<u16> = "NT SERVICE\\TrustedInstaller"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let (mut sid_len, mut domain_len, mut use_kind) = (0, 0, 0);
        ensure!(
            unsafe {
                LookupAccountNameW(
                    std::ptr::null(),
                    name.as_ptr(),
                    std::ptr::null_mut(),
                    &mut sid_len,
                    std::ptr::null_mut(),
                    &mut domain_len,
                    &mut use_kind,
                )
            } == 0
                && unsafe { GetLastError() } == ERROR_INSUFFICIENT_BUFFER
                && (8..=68).contains(&sid_len)
                && domain_len <= 1024,
            "NATIVE_SYSTEM_IMAGE_PRINCIPAL_UNAVAILABLE"
        );
        let mut sid = vec![0u8; sid_len as usize];
        let mut domain = vec![0u16; domain_len as usize];
        ensure!(
            unsafe {
                LookupAccountNameW(
                    std::ptr::null(),
                    name.as_ptr(),
                    sid.as_mut_ptr().cast(),
                    &mut sid_len,
                    domain.as_mut_ptr(),
                    &mut domain_len,
                    &mut use_kind,
                )
            } != 0
                && sid_len as usize <= sid.len(),
            "NATIVE_SYSTEM_IMAGE_PRINCIPAL_UNAVAILABLE"
        );
        sid.truncate(sid_len as usize);
        values.push(sid);
        // These are fixed OS principal identities, never a cached ACL allow verdict.
        let _ = TRUSTED.set(values);
    }
    Ok(TRUSTED
        .get()
        .context("NATIVE_SYSTEM_IMAGE_PRINCIPAL_UNAVAILABLE")?)
}

fn trusted(sid: *mut c_void, principals: &[Vec<u8>]) -> bool {
    !sid.is_null()
        && unsafe { IsValidSid(sid) } != 0
        && principals
            .iter()
            .any(|value| unsafe { EqualSid(sid, value.as_ptr().cast_mut().cast()) } != 0)
}

pub(super) fn verify(file: &File) -> Result<()> {
    let principals = trusted_sids()?;
    let (mut owner, mut dacl, mut descriptor): (*mut c_void, *mut ACL, *mut c_void) = (
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );
    let code = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    struct Security(*mut c_void);
    impl Drop for Security {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }
    let _security = Security(descriptor);
    ensure!(
        code == 0
            && trusted(owner, principals)
            && !dacl.is_null()
            && unsafe { IsValidAcl(dacl) } != 0,
        "NATIVE_SYSTEM_IMAGE_ACL_INVALID"
    );
    // SAFETY: GetSecurityInfo returned an OS allocation and IsValidAcl accepted its bounds.
    let count = unsafe { (*dacl).AceCount } as u32;
    ensure!(count <= 256, "NATIVE_SYSTEM_IMAGE_ACL_INVALID");
    for index in 0..count {
        let mut pointer = std::ptr::null_mut();
        ensure!(
            unsafe { GetAce(dacl, index, &mut pointer) } != 0 && !pointer.is_null(),
            "NATIVE_SYSTEM_IMAGE_ACL_INVALID"
        );
        let header = unsafe { &*pointer.cast::<ACE_HEADER>() };
        if header.AceType == ACCESS_DENIED_ACE_TYPE as u8 {
            continue;
        }
        ensure!(
            header.AceType == ACCESS_ALLOWED_ACE_TYPE as u8
                && header.AceSize as usize >= size_of::<ACCESS_ALLOWED_ACE>(),
            "NATIVE_SYSTEM_IMAGE_ACL_INVALID"
        );
        let ace = unsafe { &*pointer.cast::<ACCESS_ALLOWED_ACE>() };
        if ace.Mask & WRITE == 0 {
            continue;
        }
        let sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast::<u8>();
        let offset = sid as usize - pointer as usize;
        ensure!(
            offset + 8 <= header.AceSize as usize,
            "NATIVE_SYSTEM_IMAGE_ACL_INVALID"
        );
        let length = 8 + usize::from(unsafe { *sid.add(1) }) * 4;
        ensure!(
            length <= 68
                && offset + length <= header.AceSize as usize
                && trusted(sid.cast(), principals)
                && unsafe { GetLengthSid(sid.cast()) } as usize == length,
            "NATIVE_SYSTEM_IMAGE_ACL_INVALID"
        );
    }
    Ok(())
}
