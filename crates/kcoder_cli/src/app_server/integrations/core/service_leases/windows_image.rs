//! Held Windows process/image identities deny writes and deletion for their lifetime.
use anyhow::{Context, Result, ensure};
use kcoder_native_image_identity::{
    HashFailure, file_information, open_share_read, process_image_path, sha256_bounded,
};
use std::{
    fs::File,
    os::windows::io::{AsRawHandle, BorrowedHandle},
    path::PathBuf,
};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::Foundation::HANDLE;
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
        let digest = sha256_bounded::<65536>(&mut file, identity.bytes, || cancel.is_cancelled())
            .map_err(|failure| match failure {
            HashFailure::Io(error) => anyhow::Error::from(error),
            HashFailure::Cancelled => anyhow::anyhow!("SERVICE_NATIVE_IMAGE_CANCELLED"),
            HashFailure::Overflow | HashFailure::Exceeded => {
                anyhow::anyhow!("SERVICE_NATIVE_IMAGE_CHANGED")
            }
        })?;
        let total = digest.bytes;
        ensure!(total == identity.bytes, "SERVICE_NATIVE_IMAGE_CHANGED");
        let value = Self {
            file,
            path,
            identity,
            sha256: digest.sha256,
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
    /// Reuse verified bytes only for the exact held executable object. This
    /// checks a peer process/file identity and never hashes a warm RPC image.
    pub fn same_file_peer(&self, process: BorrowedHandle<'_>) -> Result<Self> {
        ensure!(
            identity(&self.file)? == self.identity,
            "SERVICE_NATIVE_IMAGE_CHANGED"
        );
        let path = image_path(process.as_raw_handle().cast())?;
        let file = open(&path)?;
        ensure!(
            identity(&file)? == self.identity,
            "SERVICE_WINDOWS_PIPE_PEER_IMAGE_DENIED"
        );
        let value = Self {
            file,
            path,
            identity: self.identity.clone(),
            sha256: self.sha256.clone(),
        };
        value.verify(process)?;
        Ok(value)
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
    process_image_path(process)
        .context("SERVICE_WINDOWS_PROCESS_IMAGE_UNAVAILABLE")?
        .canonicalize()
        .context("SERVICE_WINDOWS_PROCESS_IMAGE_UNAVAILABLE")
}
fn open(path: &std::path::Path) -> Result<File> {
    open_share_read(path).context("SERVICE_WINDOWS_IMAGE_LOCK_UNAVAILABLE")
}
fn identity(file: &File) -> Result<Identity> {
    let value = file_information(file).context("SERVICE_WINDOWS_IMAGE_UNSAFE")?;
    ensure!(
        value.is_plain_file() && value.links == 1,
        "SERVICE_WINDOWS_IMAGE_UNSAFE"
    );
    ensure!(
        (4096..=1024 * 1024 * 1024).contains(&value.bytes),
        "SERVICE_NATIVE_IMAGE_UNAVAILABLE"
    );
    Ok(Identity {
        volume: value.volume,
        index: value.index,
        bytes: value.bytes,
    })
}
