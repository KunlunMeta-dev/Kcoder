//! Verified existing-file leases are portable; retention/unlink capabilities remain separate.
use super::{PrivateDirectory, PrivateLeaseMode};
use anyhow::{Result, ensure};
use kcoder_types::PrivateFileKind;
use serde::{Deserialize, Deserializer, Serialize};
use std::{ffi::OsStr, fs::File};

/// An identity is evidence only. Acquisition also verifies the live parent, descriptor and name.
/// Linux serialization deliberately matches existing PrivateFileIdentityV1 regular-file leases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableLeaseIdentity {
    #[serde(deserialize_with = "version_one")]
    version: u32,
    kind: PrivateFileKind,
    native: NativeIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "camelCase", deny_unknown_fields)]
enum NativeIdentity {
    Linux {
        device: u64,
        inode: u64,
    },
    Unix {
        device: u64,
        inode: u64,
    },
    Windows {
        #[serde(rename = "volumeSerialNumber")]
        volume_serial_number: u64,
        #[serde(rename = "fileId")]
        file_id: [u8; 16],
    },
}

fn version_one<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(deserializer)?;
    if value != 1 {
        return Err(serde::de::Error::custom(
            "unsupported portable lease identity version",
        ));
    }
    Ok(value)
}

/// Drop releases this exact descriptor's OS lock; no cleanup or deletion authority is granted.
pub struct VerifiedPrivateLease {
    file: File,
    identity: PortableLeaseIdentity,
}
impl VerifiedPrivateLease {
    pub fn file(&self) -> &File {
        &self.file
    }
    #[cfg(unix)]
    pub fn into_inherited_lock(self) -> File {
        let mut lease = std::mem::ManuallyDrop::new(self);
        // SAFETY: the file is moved once and its lock now follows the open-file
        // description through all supervised descendants, without an explicit unlock.
        let file = unsafe { std::ptr::read(&lease.file) };
        unsafe { std::ptr::drop_in_place(&mut lease.identity) };
        file
    }
    pub fn identity(&self) -> &PortableLeaseIdentity {
        &self.identity
    }
}
impl Drop for VerifiedPrivateLease {
    fn drop(&mut self) {
        // A fork/dup may retain this open-file description after its owner ends.
        // Explicit unlock makes the lease lifetime independent of those copies.
        let _ = fs2::FileExt::unlock(&self.file);
    }
}
impl PortableLeaseIdentity {
    /// Observe the actual opened regular single-link object. This is not a private
    /// lease, namespace binding, authorization grant, or retention capability.
    /// Callers separately validate their pinned parent and allowed read scope.
    pub fn from_regular_handle(file: &File) -> Result<Self> {
        observed_identity(file, PrivateFileKind::RegularFile, false)
    }
    pub(super) fn kind(&self) -> PrivateFileKind {
        self.kind
    }
}

impl PrivateDirectory {
    /// Inspect an existing ordinary private leaf without creating, chmodding or repairing it.
    pub fn portable_regular_identity(&self, name: &OsStr) -> Result<PortableLeaseIdentity> {
        self.verify_private_directory()?;
        identity(&self.open_single_link_regular_file(name)?)
    }

    /// Observe an already-held regular descriptor supplied by a native publisher.
    /// This is identity evidence and never establishes namespace or cleanup ownership.
    pub fn portable_regular_handle_identity(&self, file: &File) -> Result<PortableLeaseIdentity> {
        self.verify_private_directory()?;
        identity(file)
    }

    /// Missing/replaced/unsafe leaves fail. None means contention, never missing identity.
    pub fn try_existing_portable_lock(
        &self,
        name: &OsStr,
        expected: &PortableLeaseIdentity,
        mode: PrivateLeaseMode,
    ) -> Result<Option<VerifiedPrivateLease>> {
        self.verify_private_directory()?;
        let file = self.open_read_write_file(name, false)?;
        verify(&file, expected)?;
        #[cfg(test)]
        tests::before_acquisition();
        let locked = match mode {
            PrivateLeaseMode::Shared => fs2::FileExt::try_lock_shared(&file),
            PrivateLeaseMode::Exclusive => fs2::FileExt::try_lock_exclusive(&file),
        };
        match locked {
            Ok(()) => {
                let lease = VerifiedPrivateLease {
                    file,
                    identity: expected.clone(),
                };
                #[cfg(test)]
                tests::after_acquisition();
                self.verify_private_directory()?;
                verify(&lease.file, expected)?;
                // Reopen the name after acquisition; a held renamed inode is not enough.
                verify(&self.open_single_link_regular_file(name)?, expected)?;
                Ok(Some(lease))
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error().is_some_and(|code| {
                        Some(code) == fs2::lock_contended_error().raw_os_error()
                    }) =>
            {
                // A busy renamed descriptor does not prove the original operation's
                // pathname still identifies that holder. Status probes must fail closed too.
                self.verify_private_directory()?;
                verify(&file, expected)?;
                verify(&self.open_single_link_regular_file(name)?, expected)?;
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }
}

fn verify(file: &File, expected: &PortableLeaseIdentity) -> Result<()> {
    ensure!(
        expected.version == 1 && expected.kind == PrivateFileKind::RegularFile,
        "portable lease identity kind/version mismatch"
    );
    ensure!(
        identity(file)? == *expected,
        "portable lease identity changed"
    );
    Ok(())
}

fn identity(file: &File) -> Result<PortableLeaseIdentity> {
    identity_for_kind(file, PrivateFileKind::RegularFile)
}

// Retention evidence may describe a directory. Lease acquisition above remains
// restricted to regular files and never grants directory mutation authority.
pub(super) fn identity_for_kind(
    file: &File,
    kind: PrivateFileKind,
) -> Result<PortableLeaseIdentity> {
    observed_identity(file, kind, true)
}
fn observed_identity(
    file: &File,
    kind: PrivateFileKind,
    private: bool,
) -> Result<PortableLeaseIdentity> {
    let metadata = file.metadata()?;
    ensure!(
        match kind {
            PrivateFileKind::RegularFile => metadata.is_file(),
            PrivateFileKind::Directory => metadata.is_dir(),
        },
        "portable identity kind mismatch"
    );
    #[cfg(unix)]
    let native = {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid only observes this process's effective identity.
        ensure!(
            (kind != PrivateFileKind::RegularFile || metadata.nlink() == 1)
                && (!private
                    || metadata.uid() == unsafe { libc::geteuid() }
                        && metadata.mode() & 0o077 == 0
                        && metadata.mode() & 0o7000 == 0),
            "portable lease ownership, links or mode is unsafe"
        );
        #[cfg(target_os = "linux")]
        {
            NativeIdentity::Linux {
                device: metadata.dev(),
                inode: metadata.ino(),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            NativeIdentity::Unix {
                device: metadata.dev(),
                inode: metadata.ino(),
            }
        }
    };
    #[cfg(windows)]
    let native = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO, FileIdInfo,
            GetFileInformationByHandle, GetFileInformationByHandleEx,
        };
        let handle = file.as_raw_handle().cast();
        let mut basic: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let mut id: FILE_ID_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: owned live handle and correctly sized, aligned output structures.
        ensure!(
            unsafe { GetFileInformationByHandle(handle, &mut basic) } != 0
                && (kind != PrivateFileKind::RegularFile || basic.nNumberOfLinks == 1)
                && basic.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "portable lease links or reparse identity unavailable"
        );
        ensure!(
            unsafe {
                GetFileInformationByHandleEx(
                    handle,
                    FileIdInfo,
                    (&mut id as *mut FILE_ID_INFO).cast(),
                    std::mem::size_of::<FILE_ID_INFO>() as u32,
                )
            } != 0
                && id.VolumeSerialNumber != 0
                && id.FileId.Identifier.iter().any(|byte| *byte != 0),
            "portable lease stable file identity unavailable"
        );
        if private {
            match kind {
                PrivateFileKind::RegularFile => {
                    crate::file_permissions::verify_windows_user_only_file_handle(file)?
                }
                PrivateFileKind::Directory => {
                    crate::file_permissions::verify_windows_user_only_directory_handle(file)?
                }
            }
        }
        NativeIdentity::Windows {
            volume_serial_number: id.VolumeSerialNumber,
            file_id: id.FileId.Identifier,
        }
    };
    #[cfg(not(any(unix, windows)))]
    return Err(anyhow::anyhow!(
        "portable leases unsupported on this platform"
    ));
    #[cfg(any(unix, windows))]
    Ok(PortableLeaseIdentity {
        version: 1,
        kind,
        native,
    })
}

#[cfg(test)]
#[path = "portable_lease_tests.rs"]
mod tests;
