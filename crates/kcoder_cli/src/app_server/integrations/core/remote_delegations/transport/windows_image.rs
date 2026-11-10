//! Actual Windows Native images anchored by held process/file handles and private ACLs.
use crate::native_component_parent::NativeComponentParentAuthority;
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::{
    ffi::OsString,
    fs::File,
    io::Read,
    os::windows::{
        ffi::OsStringExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{HANDLE, WAIT_TIMEOUT},
    Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ},
    System::Threading::{GetCurrentProcess, QueryFullProcessImageNameW, WaitForSingleObject},
};

/// The caller must pass the actual locally captured OS parent handle. A PID,
/// target/agentInfo claim or cross-host handle string has no constructor here.
pub struct WindowsNativeImageParent {
    parent_owner: Arc<dyn NativeComponentParentAuthority>,
    parent: OwnedHandle,
    sid: Vec<u8>,
    installation: PrivateDirectory,
    installation_path: PathBuf,
    own: File,
    parent_image: File,
    identity: PortableLeaseIdentity,
    sha256: String,
    bytes: u64,
}
impl WindowsNativeImageParent {
    pub fn capture_after_verified_parent(
        parent_owner: Arc<dyn NativeComponentParentAuthority>,
        expected_sha256: &str,
    ) -> Result<Self> {
        ensure!(
            expected_sha256.len() == 64
                && expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "REMOTE_WINDOWS_NATIVE_PIN_REQUIRED"
        );
        let parent = parent_owner
            .verified_windows_parent_process()?
            .try_clone_to_owned()?;
        let parent_handle = parent.as_raw_handle().cast();
        let own_path = image_path(unsafe { GetCurrentProcess() })?;
        let installation_path = own_path
            .parent()
            .context("REMOTE_WINDOWS_INSTALLATION_REQUIRED")?
            .to_owned();
        let installation = PrivateDirectory::open_existing(&installation_path)?;
        installation.verify_private_directory()?;
        let own = open_pinned(&own_path)?;
        let identity = installation.portable_regular_handle_identity(&own)?;
        let bytes = own.metadata()?.len();
        let mut reader = own.try_clone()?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 128 * 1024];
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        let sha256 = format!("{:x}", hash.finalize());
        ensure!(
            sha256 == expected_sha256
                && installation.portable_regular_handle_identity(&own)? == identity,
            "REMOTE_WINDOWS_NATIVE_INSTALLATION_MISMATCH"
        );
        let parent_path = image_path(parent_handle)?;
        verify_installation(&installation, &parent_path)?;
        let parent_image = open_pinned(&parent_path)?;
        ensure!(
            installation.portable_regular_handle_identity(&parent_image)? == identity,
            "REMOTE_WINDOWS_NATIVE_PARENT_IMAGE_MISMATCH"
        );
        let sid =
            kcoder_native_scope::service_identity::process_sid(unsafe { GetCurrentProcess() })?;
        let value = Self {
            parent_owner,
            parent,
            sid,
            installation,
            installation_path,
            own,
            parent_image,
            identity,
            sha256,
            bytes,
        };
        value.verify()?;
        Ok(value)
    }
    pub fn verify(&self) -> Result<()> {
        self.parent_owner.verified_windows_parent_process()?;
        let parent = self.parent.as_raw_handle().cast();
        // SAFETY: the original actual process handle is held; no wait blocks.
        ensure!(
            unsafe { WaitForSingleObject(parent, 0) } == WAIT_TIMEOUT,
            "REMOTE_WINDOWS_NATIVE_PARENT_EXITED"
        );
        ensure!(
            kcoder_native_scope::service_identity::process_sid(parent)? == self.sid
                && kcoder_native_scope::service_identity::process_sid(unsafe {
                    GetCurrentProcess()
                })? == self.sid,
            "REMOTE_WINDOWS_NATIVE_PARENT_SID_CHANGED"
        );
        self.installation.verify_private_directory()?;
        ensure!(
            PrivateDirectory::open_existing(&self.installation_path)?.directory_identity()?
                == self.installation.directory_identity()?,
            "REMOTE_WINDOWS_INSTALLATION_CHANGED"
        );
        for file in [&self.own, &self.parent_image] {
            ensure!(
                self.installation.portable_regular_handle_identity(file)? == self.identity
                    && file.metadata()?.len() == self.bytes,
                "REMOTE_WINDOWS_NATIVE_IMAGE_CHANGED"
            );
        }
        for process in [unsafe { GetCurrentProcess() }, parent] {
            let path = image_path(process)?;
            verify_installation(&self.installation, &path)?;
            ensure!(
                self.installation
                    .portable_regular_handle_identity(&open_pinned(&path)?)?
                    == self.identity,
                "REMOTE_WINDOWS_NATIVE_IMAGE_CHANGED"
            );
        }
        Ok(())
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}
fn verify_installation(installation: &PrivateDirectory, path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute()
            && PrivateDirectory::open_existing(
                path.parent()
                    .context("REMOTE_WINDOWS_INSTALLATION_REQUIRED")?
            )?
            .directory_identity()?
                == installation.directory_identity()?,
        "REMOTE_WINDOWS_INSTALLATION_CHANGED"
    );
    Ok(())
}
fn open_pinned(path: &Path) -> Result<File> {
    // FILE_SHARE_READ denies write/delete/rename while this exact image is held.
    // Existing compatible readers remain usable; unsafe sharing fails closed.
    Ok(std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?)
}
fn image_path(process: HANDLE) -> Result<PathBuf> {
    let mut path = vec![0u16; 32768];
    let mut length = u32::try_from(path.len())?;
    // SAFETY: query-only actual held/pseudo process handle and sized UTF-16 output.
    ensure!(
        unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) } != 0
            && length > 0
            && usize::try_from(length)? < path.len(),
        "REMOTE_WINDOWS_PROCESS_IMAGE_UNAVAILABLE"
    );
    path.truncate(usize::try_from(length)?);
    Ok(PathBuf::from(OsString::from_wide(&path)))
}
