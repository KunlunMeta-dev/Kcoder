//! The original private handle receives confirmation only after exact Job cleanup.
use crate::protocol::CleanupFileIdentity;
use anyhow::{Context, Result, ensure};
use std::{
    ffi::c_void,
    fs::File,
    io::{Seek, SeekFrom, Write},
    mem::zeroed,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::null_mut,
};
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE,
        HANDLE_FLAG_INHERIT, SetHandleInformation,
    },
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ALL_ACCESS, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO,
        FILE_TYPE_DISK, FILE_WRITE_DATA, FileIdInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx, GetFileType,
    },
    System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
    System::Threading::GetCurrentProcess,
};

pub(crate) const CONFIRMED_BYTES: &[u8] = b"kcoder-owned-cleanup/v1\nconfirmed\n";

pub(crate) struct Writer {
    file: File,
    identity: CleanupFileIdentity,
}
impl Writer {
    pub(crate) fn from_transferred(handle: u64, expected: &CleanupFileIdentity) -> Result<Self> {
        let raw = usize::try_from(handle).context("Cleanup handle width mismatch")? as HANDLE;
        ensure!(
            !raw.is_null() && raw as isize != -1,
            "Invalid cleanup handle"
        );
        ensure!(
            unsafe { GetFileType(raw) } == FILE_TYPE_DISK,
            "Cleanup handle is not a disk file"
        );
        let mut owned = null_mut();
        // Ask the kernel to validate numeric input before constructing Rust ownership.
        ensure!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    raw,
                    GetCurrentProcess(),
                    &mut owned,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE,
                )
            } != 0,
            "Cannot take ownership of cleanup file"
        );
        // SAFETY: successful duplication returned this new owned disk file handle.
        let file = unsafe { File::from_raw_handle(owned) };
        ensure!(
            unsafe { SetHandleInformation(owned, HANDLE_FLAG_INHERIT, 0) } != 0,
            "Cannot prevent cleanup handle inheritance"
        );
        let identity = validate_empty(&file)?;
        ensure!(&identity == expected, "Cleanup receipt identity changed");
        Ok(Self { file, identity })
    }
    pub(crate) fn confirm(&mut self) -> Result<()> {
        ensure!(
            validate_empty(&self.file)? == self.identity,
            "Cleanup receipt changed"
        );
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(CONFIRMED_BYTES)?;
        self.file.sync_all()?;
        ensure!(
            file_identity(&self.file)? == self.identity
                && self.file.metadata()?.len() == CONFIRMED_BYTES.len() as u64,
            "Cleanup confirmation identity changed"
        );
        Ok(())
    }
}

pub(crate) fn validate_empty(file: &File) -> Result<CleanupFileIdentity> {
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() == 0,
        "Cleanup receipt is not an empty regular file"
    );
    ensure!(
        granted_access(file)? & FILE_WRITE_DATA != 0,
        "Cleanup receipt is not writable"
    );
    file_identity(file)
}

fn file_identity(file: &File) -> Result<CleanupFileIdentity> {
    let raw = file.as_raw_handle().cast();
    let mut basic: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    let mut id: FILE_ID_INFO = unsafe { zeroed() };
    ensure!(
        unsafe { GetFileInformationByHandle(raw, &mut basic) } != 0
            && basic.nNumberOfLinks == 1
            && basic.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "Unsafe cleanup receipt links/reparse identity"
    );
    ensure!(
        unsafe {
            GetFileInformationByHandleEx(
                raw,
                FileIdInfo,
                (&mut id as *mut FILE_ID_INFO).cast(),
                size_of::<FILE_ID_INFO>() as u32,
            )
        } != 0
            && id.VolumeSerialNumber != 0
            && id.FileId.Identifier.iter().any(|byte| *byte != 0),
        "Cleanup receipt file identity unavailable"
    );
    Ok(CleanupFileIdentity {
        volume_serial_number: id.VolumeSerialNumber,
        file_id: id.FileId.Identifier,
    })
}

#[repr(C)]
struct ObjectBasicInformation {
    attributes: u32,
    granted_access: u32,
    handle_count: u32,
    pointer_count: u32,
    reserved: [u32; 10],
}
fn granted_access(file: &File) -> Result<u32> {
    type Query = unsafe extern "system" fn(HANDLE, u32, *mut c_void, u32, *mut u32) -> i32;
    let name: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
    let module = unsafe { GetModuleHandleW(name.as_ptr()) };
    ensure!(!module.is_null(), "Native handle query unavailable");
    let symbol = unsafe { GetProcAddress(module, c"NtQueryObject".as_ptr().cast()) }
        .context("Native handle query unavailable")?;
    // SAFETY: the system-exported function has the documented NtQueryObject signature.
    let query: Query = unsafe { std::mem::transmute(symbol) };
    let mut info: ObjectBasicInformation = unsafe { zeroed() };
    let mut returned = 0;
    ensure!(
        unsafe {
            query(
                file.as_raw_handle().cast(),
                0,
                (&mut info as *mut ObjectBasicInformation).cast(),
                size_of::<ObjectBasicInformation>() as u32,
                &mut returned,
            )
        } >= 0
            && returned as usize >= size_of::<ObjectBasicInformation>(),
        "Cannot inspect cleanup handle access"
    );
    Ok(info.granted_access)
}
