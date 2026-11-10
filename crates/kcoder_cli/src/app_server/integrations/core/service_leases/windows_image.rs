//! Held Windows process/image identities deny writes and deletion for their lifetime.
use anyhow::{Context, Result, ensure};
use std::{
    ffi::OsString,
    fs::{File, OpenOptions},
    io::Read,
    mem::zeroed,
    os::windows::{
        ffi::OsStringExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, BorrowedHandle},
    },
    path::PathBuf,
};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, GetFileInformationByHandle,
    },
    System::Threading::QueryFullProcessImageNameW,
};
#[derive(Clone, PartialEq, Eq)]
struct Identity {
    volume: u32,
    index: u64,
    bytes: u64,
}
pub struct WindowsServiceImage {
    file: File,
    path: PathBuf,
    identity: Identity,
    sha256: String,
}
impl WindowsServiceImage {
    pub fn capture(process: BorrowedHandle<'_>, cancel: &CancellationToken) -> Result<Self> {
        let started = std::time::Instant::now();
        let current = unsafe {
            windows_sys::Win32::System::Threading::GetProcessId(process.as_raw_handle().cast())
                == windows_sys::Win32::System::Threading::GetCurrentProcessId()
        };
        let path = image_path(process.as_raw_handle().cast())?;
        let mut file = open(&path)?;
        let identity = identity(&file)?;
        let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
        let mut buffer = [0u8; 65536];
        let mut total = 0u64;
        loop {
            ensure!(!cancel.is_cancelled(), "SERVICE_NATIVE_IMAGE_CANCELLED");
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total = total
                .checked_add(count as u64)
                .context("SERVICE_NATIVE_IMAGE_CHANGED")?;
            ensure!(total <= identity.bytes, "SERVICE_NATIVE_IMAGE_CHANGED");
            hash.update(&buffer[..count]);
        }
        ensure!(total == identity.bytes, "SERVICE_NATIVE_IMAGE_CHANGED");
        let value = Self {
            file,
            path,
            identity,
            sha256: hash
                .finish()
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        };
        value.verify(process)?;
        eprintln!(
            "{}",
            serde_json::json!({"event":"native_scope_original_image_capture_observed","currentProcess":current,"bytes":total,"elapsedMs":started.elapsed().as_millis()})
        );
        Ok(value)
    }
    pub fn duplicate(&self) -> Result<Self> {
        Ok(Self {
            file: self.file.try_clone()?,
            path: self.path.clone(),
            identity: self.identity.clone(),
            sha256: self.sha256.clone(),
        })
    }
    pub fn verify(&self, process: BorrowedHandle<'_>) -> Result<()> {
        ensure!(
            image_path(process.as_raw_handle().cast())? == self.path
                && identity(&self.file)? == self.identity
                && identity(&open(&self.path)?)? == self.identity,
            "SERVICE_NATIVE_IMAGE_CHANGED"
        );
        Ok(())
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}
fn image_path(process: HANDLE) -> Result<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    ensure!(
        unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } != 0
            && length > 0
            && (length as usize) < buffer.len(),
        "SERVICE_WINDOWS_PROCESS_IMAGE_UNAVAILABLE"
    );
    PathBuf::from(OsString::from_wide(&buffer[..length as usize]))
        .canonicalize()
        .context("SERVICE_WINDOWS_PROCESS_IMAGE_UNAVAILABLE")
}
fn open(path: &std::path::Path) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .context("SERVICE_WINDOWS_IMAGE_LOCK_UNAVAILABLE")
}
fn identity(file: &File) -> Result<Identity> {
    let mut value: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    ensure!(
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut value) } != 0
            && value.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
                == 0
            && value.nNumberOfLinks == 1,
        "SERVICE_WINDOWS_IMAGE_UNSAFE"
    );
    let bytes = (u64::from(value.nFileSizeHigh) << 32) | u64::from(value.nFileSizeLow);
    ensure!(
        (4096..=1024 * 1024 * 1024).contains(&bytes),
        "SERVICE_NATIVE_IMAGE_UNAVAILABLE"
    );
    Ok(Identity {
        volume: value.dwVolumeSerialNumber,
        index: (u64::from(value.nFileIndexHigh) << 32) | u64::from(value.nFileIndexLow),
        bytes,
    })
}
