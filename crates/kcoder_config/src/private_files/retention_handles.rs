//! Narrow filesystem primitives for a future retention journal.
//!
//! None of these APIs grants retention authority or proves a receipt released.
//! Mutating callers must hold the exact owner lease and exclusive entry claim,
//! and persist their intent before calling. All cooperating writers must use
//! that same lifecycle protocol. An administrator able to rewrite private
//! files under the same UID is outside this boundary.

use super::{PrivateDirectory, validate_single_name};
use anyhow::Result;
use kcoder_types::{PrivateFileIdentityV1, PrivateFileKind};
use std::ffi::{OsStr, OsString};
use std::fs::File;

#[cfg(target_os = "linux")]
#[path = "retention_handles_linux.rs"]
mod linux;

#[derive(Debug, Clone, Copy)]
pub enum PrivateLeaseMode {
    Shared,
    Exclusive,
}

/// Keeps the verified object open. Identity must be rechecked before mutation.
#[derive(Debug)]
pub struct VerifiedPrivateEntry {
    file: File,
    identity: PrivateFileIdentityV1,
}

/// An unpublished Linux inode. The service must commit its native identity and
/// sealed bytes digest before publishing a name. Drop cannot leave a named temp.
#[derive(Debug)]
pub struct AnonymousPrivateEntry {
    file: File,
    identity: PrivateFileIdentityV1,
    parent: PrivateFileIdentityV1,
}

impl AnonymousPrivateEntry {
    pub fn identity(&self) -> &PrivateFileIdentityV1 {
        &self.identity
    }
    pub fn file(&self) -> &File {
        &self.file
    }
    pub fn seal(&mut self, bytes: &[u8]) -> Result<()> {
        use std::io::Write;
        anyhow::ensure!(bytes.len() <= 65_536, "anonymous manifest exceeds bound");
        anyhow::ensure!(
            self.file.metadata()?.len() == 0,
            "anonymous manifest already sealed"
        );
        self.file.write_all(bytes)?;
        self.file.sync_all()?;
        Ok(())
    }
}

impl VerifiedPrivateEntry {
    pub fn verify_manifest_mode(&self) -> Result<()> {
        verify(&self.file, &self.identity, PrivateFileKind::RegularFile)?;
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            anyhow::ensure!(
                self.file.metadata()?.mode() & 0o777 == 0o600,
                "manifest mode must be 0600"
            );
            Ok(())
        }
        #[cfg(not(target_os = "linux"))]
        {
            unsupported()
        }
    }
    pub fn file(&self) -> &File {
        &self.file
    }

    pub fn identity(&self) -> &PrivateFileIdentityV1 {
        &self.identity
    }

    pub fn try_exclusive_lease(&self) -> Result<bool> {
        verify(&self.file, &self.identity, PrivateFileKind::RegularFile)?;
        match fs2::FileExt::try_lock_exclusive(&self.file) {
            Ok(()) => Ok(true),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error().is_some_and(|code| {
                        Some(code) == fs2::lock_contended_error().raw_os_error()
                    }) =>
            {
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }
}

/// A leaf already moved to its unique, never-reused quarantine locator. Before
/// constructing this manifest the caller must durably commit the successfully
/// verified `quarantined` phase. This API never performs the earlier rename.
#[derive(Debug)]
pub struct PrivateRemovalEntry {
    pub name: OsString,
    pub identity: PrivateFileIdentityV1,
}

/// `removed` includes unlinks whose subsequent directory sync failed. Such a
/// failure must remain a pending journal phase; it is not a released receipt.
#[derive(Debug)]
pub struct PrivateManifestRemoval {
    pub removed: Vec<OsString>,
    pub failure: Option<anyhow::Error>,
}

impl PrivateDirectory {
    /// No named-temp or non-Linux compatibility fallback is permitted.
    pub fn create_anonymous_private_entry(&self) -> Result<AnonymousPrivateEntry> {
        let parent = self.retention_identity()?;
        #[cfg(target_os = "linux")]
        {
            linux::anonymous(self, parent)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = parent;
            unsupported()
        }
    }

    /// No-replace publication only. This intentionally does not fsync the
    /// parent: callers need a journal checkpoint between publication and sync.
    pub fn publish_anonymous_private_entry(
        &self,
        anonymous: &AnonymousPrivateEntry,
        name: &OsStr,
    ) -> Result<VerifiedPrivateEntry> {
        validate_single_name(name)?;
        self.verify_retention_identity(&anonymous.parent)?;
        #[cfg(target_os = "linux")]
        {
            linux::publish_anonymous(self, anonymous, name)
        }
        #[cfg(not(target_os = "linux"))]
        {
            unsupported()
        }
    }

    /// Remove only this exact already-quarantined regular leaf. Siblings are
    /// neither scanned nor modified. Caller commits Quarantined before unlink.
    pub fn remove_verified_regular_leaf(
        &self,
        name: &OsStr,
        expected: &PrivateFileIdentityV1,
    ) -> Result<PrivateManifestRemoval> {
        self.retention_identity()?;
        validate_single_name(name)?;
        #[cfg(target_os = "linux")]
        {
            linux::remove_leaf(self, name, expected)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = expected;
            unsupported()
        }
    }

    /// Journal callers need to distinguish rename visibility from parent
    /// durability. The caller MUST sync before committing Quarantined.
    pub fn quarantine_verified_entry_unflushed(
        &self,
        name: &OsStr,
        expected: &PrivateFileIdentityV1,
        destination: &OsStr,
    ) -> Result<VerifiedPrivateEntry> {
        self.retention_identity()?;
        validate_single_name(name)?;
        validate_single_name(destination)?;
        anyhow::ensure!(name != destination, "quarantine locator must be distinct");
        #[cfg(target_os = "linux")]
        {
            linux::quarantine_inner(self, name, expected, destination, false)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = expected;
            unsupported()
        }
    }

    /// Requires a durable exact Quarantined journal phase. The caller MUST
    /// fsync the parent before committing Gone or refunding any charge.
    pub fn unlink_verified_regular_leaf_unflushed(
        &self,
        name: &OsStr,
        expected: &PrivateFileIdentityV1,
    ) -> Result<()> {
        self.retention_identity()?;
        validate_single_name(name)?;
        #[cfg(target_os = "linux")]
        {
            linux::unlink_leaf(self, name, expected)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = expected;
            unsupported()
        }
    }
    /// Verify an opened private directory without changing its permissions.
    pub fn retention_identity(&self) -> Result<PrivateFileIdentityV1> {
        identity(&self.directory, PrivateFileKind::Directory)
    }

    pub fn verify_retention_identity(&self, expected: &PrivateFileIdentityV1) -> Result<()> {
        verify(&self.directory, expected, PrivateFileKind::Directory)
    }

    pub fn open_verified_child(
        &self,
        name: &OsStr,
        expected: &PrivateFileIdentityV1,
    ) -> Result<Self> {
        self.retention_identity()?;
        validate_single_name(name)?;
        let child = self.open_child(name, false)?;
        child.verify_retention_identity(expected)?;
        Ok(child)
    }

    pub fn open_verified_regular(
        &self,
        name: &OsStr,
        expected: &PrivateFileIdentityV1,
    ) -> Result<VerifiedPrivateEntry> {
        self.retention_identity()?;
        let file = self.open_regular_file(name)?;
        verify(&file, expected, PrivateFileKind::RegularFile)?;
        Ok(VerifiedPrivateEntry {
            file,
            identity: expected.clone(),
        })
    }

    /// Open without creation and verify the SAME descriptor returned for byte IO.
    pub fn open_verified_read_write_regular(
        &self,
        name: &OsStr,
        expected: &PrivateFileIdentityV1,
    ) -> Result<File> {
        self.retention_identity()?;
        validate_single_name(name)?;
        verified_read_write_file(self.open_read_write_file(name, false)?, expected)
    }

    /// Capture identity of an already created/sealed regular leaf.
    pub fn retention_regular_identity(&self, name: &OsStr) -> Result<PrivateFileIdentityV1> {
        self.retention_identity()?;
        identity(&self.open_regular_file(name)?, PrivateFileKind::RegularFile)
    }

    /// Does not create a missing lease. None means a live lock holder.
    pub fn try_existing_verified_lock(
        &self,
        name: &OsStr,
        expected: &PrivateFileIdentityV1,
        mode: PrivateLeaseMode,
    ) -> Result<Option<VerifiedPrivateEntry>> {
        self.retention_identity()?;
        validate_single_name(name)?;
        let file = self.open_read_write_file(name, false)?;
        verify(&file, expected, PrivateFileKind::RegularFile)?;
        let result = match mode {
            PrivateLeaseMode::Shared => fs2::FileExt::try_lock_shared(&file),
            PrivateLeaseMode::Exclusive => fs2::FileExt::try_lock_exclusive(&file),
        };
        match result {
            Ok(()) => {
                verify(&file, expected, PrivateFileKind::RegularFile)?;
                self.open_verified_regular(name, expected)?;
                Ok(Some(VerifiedPrivateEntry {
                    file,
                    identity: expected.clone(),
                }))
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error().is_some_and(|code| {
                        Some(code) == fs2::lock_contended_error().raw_os_error()
                    }) =>
            {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Move, then verify the moved object. A replacement object is preserved on
    /// mismatch, never deleted or silently moved back over another object.
    pub fn quarantine_verified_entry(
        &self,
        name: &OsStr,
        expected: &PrivateFileIdentityV1,
        quarantine_name: &OsStr,
    ) -> Result<VerifiedPrivateEntry> {
        self.retention_identity()?;
        validate_single_name(name)?;
        validate_single_name(quarantine_name)?;
        anyhow::ensure!(
            name != quarantine_name,
            "quarantine locator must be distinct"
        );
        #[cfg(target_os = "linux")]
        {
            linux::quarantine(self, name, expected, quarantine_name)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = expected;
            unsupported()
        }
    }

    /// Unlink one bounded level of already-quarantined regular leaves only.
    /// Caller must first persist each verified quarantine identity/phase. Nested
    /// directory manifests are verified separately, not recursively walked.
    /// Preflight rejects unknown children before the first unlink.
    pub fn remove_verified_manifest(
        &self,
        manifest: &[PrivateRemovalEntry],
    ) -> Result<PrivateManifestRemoval> {
        self.retention_identity()?;
        anyhow::ensure!(manifest.len() <= 32, "private manifest exceeds 32 leaves");
        #[cfg(target_os = "linux")]
        {
            linux::remove_manifest(self, manifest)
        }
        #[cfg(not(target_os = "linux"))]
        {
            unsupported()
        }
    }

    /// The caller must already have quarantined this exact directory and hold
    /// its claim. No recursive path deletion and no permission changes.
    pub fn remove_verified_empty_directory(
        &self,
        name: &OsStr,
        expected: &PrivateFileIdentityV1,
    ) -> Result<()> {
        self.retention_identity()?;
        validate_single_name(name)?;
        #[cfg(target_os = "linux")]
        {
            linux::remove_empty_directory(self, name, expected)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = expected;
            unsupported()
        }
    }

    /// A necessary, not sufficient, capability gate. The future ledger must
    /// additionally probe durable initialization and required rename support.
    pub fn retention_filesystem_supported(&self) -> Result<bool> {
        #[cfg(target_os = "linux")]
        {
            self.retention_identity()?;
            linux::filesystem_supported(&self.directory)
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(false)
        }
    }
}

#[cfg(all(test, not(target_os = "linux")))]
mod unsupported_tests {
    use super::*;

    #[test]
    fn retention_platform_gate_is_false_without_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_or_create(temp.path()).unwrap();
        assert!(!directory.retention_filesystem_supported().unwrap());
        assert!(directory.retention_identity().is_err());
    }
}

fn identity(file: &File, kind: PrivateFileKind) -> Result<PrivateFileIdentityV1> {
    #[cfg(target_os = "linux")]
    {
        linux::identity(file, kind)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (file, kind);
        unsupported()
    }
}

fn verify(file: &File, expected: &PrivateFileIdentityV1, kind: PrivateFileKind) -> Result<()> {
    anyhow::ensure!(
        expected.version == PrivateFileIdentityV1::VERSION,
        "unsupported private identity version"
    );
    anyhow::ensure!(expected.kind == kind, "private identity kind mismatch");
    anyhow::ensure!(
        identity(file, kind)? == *expected,
        "private object identity mismatch"
    );
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn unsupported<T>() -> Result<T> {
    anyhow::bail!("verified retention handles are unsupported on this platform")
}

#[cfg(all(test, target_os = "linux"))]
#[path = "retention_handles_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "linux"))]
#[path = "retention_anonymous_tests.rs"]
mod anonymous_tests;

fn verified_read_write_file(file: File, expected: &PrivateFileIdentityV1) -> Result<File> {
    verify(&file, expected, PrivateFileKind::RegularFile)?;
    Ok(file)
}

#[cfg(all(test, target_os = "linux"))]
mod read_write_review_tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn retention_read_write_regular_checks_actual_fd_not_matching_path() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let directory = PrivateDirectory::open_or_create(temp.path())?;
        directory.atomic_replace(OsStr::new("payload"), b"original")?;
        directory.atomic_replace(OsStr::new("other"), b"foreign")?;
        let expected = directory.retention_regular_identity(OsStr::new("payload"))?;
        // The pathname still matches expected, but the held IO fd is another
        // regular inode. Exercise the exact verifier used by the public opener.
        let foreign_fd = directory.open_read_write_file(OsStr::new("other"), false)?;
        directory.open_verified_regular(OsStr::new("payload"), &expected)?;
        assert!(verified_read_write_file(foreign_fd, &expected).is_err());
        assert!(
            directory
                .open_verified_read_write_regular(OsStr::new("other"), &expected)
                .is_err()
        );
        let mut bytes = Vec::new();
        directory
            .open_regular_file(OsStr::new("other"))?
            .read_to_end(&mut bytes)?;
        assert_eq!(bytes, b"foreign");
        let mut file =
            directory.open_verified_read_write_regular(OsStr::new("payload"), &expected)?;
        file.write_all(b"verified")?;
        file.sync_all()?;
        drop(file);
        let mut bytes = Vec::new();
        directory
            .open_regular_file(OsStr::new("payload"))?
            .read_to_end(&mut bytes)?;
        assert_eq!(bytes, b"verified");
        assert!(
            directory
                .open_verified_read_write_regular(OsStr::new("missing"), &expected)
                .is_err()
        );
        assert!(!temp.path().join("missing").exists());
        Ok(())
    }
}
