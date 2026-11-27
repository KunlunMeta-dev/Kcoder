//! Existing identity evidence and mutation primitives for an owned retention journal.
//!
//! Callers must already hold their original lifecycle and namespace mutation guards,
//! persist the exact pending operation, and reject unknown children before mutation.
//! These methods never adopt a scanned object, repair permissions, or recurse.
use super::{
    PortableLeaseIdentity, PrivateDirectory, PrivateManifestRemoval, validate_single_name,
};
use anyhow::{Result, ensure};
use kcoder_types::PrivateFileKind;
use std::{ffi::OsStr, fs::File};

#[cfg(target_os = "linux")]
#[path = "portable_retention/linux.rs"]
mod platform;
#[cfg(windows)]
#[path = "portable_retention/windows.rs"]
mod platform;

/// A held exact object, never a transferable deletion authorization.
pub struct VerifiedPortableEntry {
    file: File,
    identity: PortableLeaseIdentity,
}
impl VerifiedPortableEntry {
    pub fn file(&self) -> &File {
        &self.file
    }
    pub fn identity(&self) -> &PortableLeaseIdentity {
        &self.identity
    }
}

fn identity(file: &File, kind: PrivateFileKind) -> Result<PortableLeaseIdentity> {
    super::portable_lease::identity_for_kind(file, kind)
}
fn verify(file: &File, expected: &PortableLeaseIdentity, kind: PrivateFileKind) -> Result<()> {
    ensure!(
        identity(file, kind)? == *expected,
        "portable retention identity changed"
    );
    Ok(())
}

impl PrivateDirectory {
    /// Evidence from this actual private directory descriptor; no namespace claim.
    pub fn portable_retention_identity(&self) -> Result<PortableLeaseIdentity> {
        self.verify_private_directory()?;
        identity(&self.directory, PrivateFileKind::Directory)
    }
    pub fn portable_verify_retention_identity(
        &self,
        expected: &PortableLeaseIdentity,
    ) -> Result<()> {
        self.portable_retention_identity()?;
        verify(&self.directory, expected, PrivateFileKind::Directory)
    }
    pub fn portable_retention_regular_handle_identity(
        &self,
        file: &File,
    ) -> Result<PortableLeaseIdentity> {
        self.portable_retention_identity()?;
        identity(file, PrivateFileKind::RegularFile)
    }
    pub fn portable_retention_regular_identity(
        &self,
        name: &OsStr,
    ) -> Result<PortableLeaseIdentity> {
        self.portable_retention_identity()?;
        identity(
            &self.open_single_link_regular_file(name)?,
            PrivateFileKind::RegularFile,
        )
    }
    pub fn portable_open_verified_regular(
        &self,
        name: &OsStr,
        expected: &PortableLeaseIdentity,
    ) -> Result<VerifiedPortableEntry> {
        self.portable_retention_identity()?;
        let file = self.open_single_link_regular_file(name)?;
        verify(&file, expected, PrivateFileKind::RegularFile)?;
        Ok(VerifiedPortableEntry {
            file,
            identity: expected.clone(),
        })
    }
    pub fn portable_open_verified_child(
        &self,
        name: &OsStr,
        expected: &PortableLeaseIdentity,
    ) -> Result<Self> {
        self.portable_retention_identity()?;
        validate_single_name(name)?;
        let child = self.open_child(name, false)?;
        child.portable_verify_retention_identity(expected)?;
        Ok(child)
    }
    /// No-replace, parent-handle-relative move of the original object. A lost reply
    /// must be reconciled against the same original pending journal, never retried blind.
    pub fn portable_quarantine_verified_entry(
        &self,
        name: &OsStr,
        expected: &PortableLeaseIdentity,
        destination: &OsStr,
    ) -> Result<VerifiedPortableEntry> {
        self.portable_retention_identity()?;
        validate_single_name(name)?;
        validate_single_name(destination)?;
        ensure!(name != destination, "quarantine locator must be distinct");
        #[cfg(any(target_os = "linux", windows))]
        {
            platform::quarantine(self, name, expected, destination)
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = expected;
            anyhow::bail!("portable retention mutations unsupported")
        }
    }
    /// Only one already-quarantined ordinary leaf. If parent durability reporting
    /// fails after removal, the result retains that known effect for reconciliation.
    pub fn portable_remove_verified_regular_leaf(
        &self,
        name: &OsStr,
        expected: &PortableLeaseIdentity,
    ) -> Result<PrivateManifestRemoval> {
        self.portable_retention_identity()?;
        validate_single_name(name)?;
        #[cfg(any(target_os = "linux", windows))]
        {
            platform::remove_leaf(self, name, expected)?;
            Ok(PrivateManifestRemoval {
                removed: vec![name.into()],
                failure: self.sync().err(),
            })
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = expected;
            anyhow::bail!("portable retention mutations unsupported")
        }
    }
    /// The caller owns the exact quarantined directory under its namespace guard.
    /// The kernel enforces empty-directory removal; no recursive deletion is used.
    pub fn portable_remove_verified_empty_directory(
        &self,
        name: &OsStr,
        expected: &PortableLeaseIdentity,
    ) -> Result<()> {
        self.portable_retention_identity()?;
        validate_single_name(name)?;
        #[cfg(any(target_os = "linux", windows))]
        {
            platform::remove_empty_directory(self, name, expected)?;
            self.sync()
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = expected;
            anyhow::bail!("portable retention mutations unsupported")
        }
    }
    /// Necessary platform support only; original birth, byte proofs and released
    /// dependents remain independently required. Unknown/network filesystems fail closed.
    pub fn portable_retention_filesystem_supported(&self) -> Result<bool> {
        #[cfg(any(target_os = "linux", windows))]
        {
            self.portable_retention_identity()?;
            platform::filesystem_supported(&self.directory)
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            Ok(false)
        }
    }
}

#[cfg(any(target_os = "linux", windows))]
fn verify_named(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PortableLeaseIdentity,
) -> Result<()> {
    match expected.kind() {
        PrivateFileKind::RegularFile => {
            parent.portable_open_verified_regular(name, expected)?;
        }
        PrivateFileKind::Directory => {
            parent.portable_open_verified_child(name, expected)?;
        }
    }
    Ok(())
}

#[cfg(all(test, any(target_os = "linux", windows)))]
#[path = "portable_retention/tests.rs"]
mod tests;
