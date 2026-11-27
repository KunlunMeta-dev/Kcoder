//! Logical profile continuity is separate from the current filesystem binding.
//!
//! This record never grants authorization, proves shutdown, or replaces a domain
//! owner's source, epoch, revocation, or publication checks.
use crate::{PortableLeaseIdentity, PrivateDirectory};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fs::File, io::Write};

const RECORD: &str = ".profile-identity.json";
const MAX_RECORD_BYTES: u64 = 8192;

#[derive(Deserialize)]
#[serde(untagged)]
enum Record {
    Legacy(LegacyRecord),
    Seed(SeedRecord),
}

// The original envelope remains readable and is copied byte for byte. Its
// physical fields describe history, never the current root or record handle.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyRecord {
    version: u32,
    logical_seed: String,
    profile_identity: String,
    record_identity: PortableLeaseIdentity,
    operation_id: String,
    source_profile_identity: String,
    source_record_sha256: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeedRecord {
    version: u32,
    logical_seed: String,
}

impl Record {
    fn logical_seed(&self) -> &str {
        match self {
            Self::Legacy(record) => &record.logical_seed,
            Self::Seed(record) => &record.logical_seed,
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Legacy(record) => {
                ensure!(record.version == 1, "PROFILE_IDENTITY_UNSUPPORTED_VERSION");
                validate_operation(&record.operation_id)?;
                ensure!(
                    valid_seed(&record.profile_identity)
                        && valid_seed(&record.source_profile_identity)
                        && record.source_record_sha256.as_ref().is_none_or(|value| {
                            value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                        }),
                    "PROFILE_IDENTITY_RECORD_INVALID"
                );
                // Deserialization validates the historical identity's wire format.
                let _ = &record.record_identity;
            }
            Self::Seed(record) => {
                ensure!(record.version == 2, "PROFILE_IDENTITY_UNSUPPORTED_VERSION");
            }
        }
        ensure!(
            valid_seed(self.logical_seed()),
            "PROFILE_IDENTITY_RECORD_INVALID"
        );
        Ok(())
    }
}

struct HeldRecord {
    bytes: Vec<u8>,
    identity: PortableLeaseIdentity,
    anchor: File,
}

/// A held, read-only observation. An unrecorded legacy profile keeps its original
/// physical identity as the logical seed without creating any metadata.
pub struct ProfileIdentity {
    root: PrivateDirectory,
    profile_identity: String,
    logical_seed: String,
    record: Option<HeldRecord>,
}

impl std::fmt::Debug for ProfileIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProfileIdentity { native_binding: held }")
    }
}

impl ProfileIdentity {
    pub fn observe(profile: &PrivateDirectory) -> Result<Self> {
        profile.verify_config_root_directory()?;
        let root = profile.duplicate_handle()?;
        let profile_identity = root.directory_identity()?;
        let mut logical_seed = profile_identity.clone();
        let record = match root.open_single_link_regular_file(OsStr::new(RECORD)) {
            Ok(anchor) => {
                let bytes = read_bytes(&anchor)?;
                let value: Record =
                    serde_json::from_slice(&bytes).context("PROFILE_IDENTITY_RECORD_INVALID")?;
                value.validate()?;
                logical_seed = value.logical_seed().into();
                Some(HeldRecord {
                    identity: PortableLeaseIdentity::from_private_regular_handle(&anchor)?,
                    bytes,
                    anchor,
                })
            }
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
        Ok(Self {
            root,
            profile_identity,
            logical_seed,
            record,
        })
    }

    pub fn logical_seed(&self) -> &str {
        &self.logical_seed
    }

    pub fn verify(&self, profile: &PrivateDirectory) -> Result<()> {
        self.root.verify_config_root_directory()?;
        profile.verify_config_root_directory()?;
        ensure!(
            self.root.directory_identity()? == self.profile_identity
                && profile.directory_identity()? == self.profile_identity,
            "PROFILE_IDENTITY_ROOT_CHANGED"
        );
        let current = match profile.open_single_link_regular_file(OsStr::new(RECORD)) {
            Ok(file) => Some(file),
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
        match (&self.record, current) {
            (None, None) => Ok(()),
            (Some(original), Some(current)) => {
                ensure!(
                    PortableLeaseIdentity::from_private_regular_handle(&current)?
                        == original.identity
                        && read_bytes(&current)? == original.bytes
                        && PortableLeaseIdentity::from_private_regular_handle(&original.anchor)?
                            == original.identity
                        && read_bytes(&original.anchor)? == original.bytes,
                    "PROFILE_IDENTITY_RECORD_CHANGED"
                );
                Ok(())
            }
            _ => anyhow::bail!("PROFILE_IDENTITY_RECORD_CHANGED"),
        }
    }

    /// Verify stable seed continuity at an already-published target. The caller
    /// verifies the operation's authority and publication independently; a seed
    /// record does not describe or authorize individual moves.
    pub fn verify_relocation(
        &self,
        source: &PrivateDirectory,
        final_target: &PrivateDirectory,
        operation_id: &str,
    ) -> Result<Self> {
        validate_operation(operation_id)?;
        self.verify(source)?;
        let target = Self::observe(final_target)?;
        ensure!(
            target.profile_identity != self.profile_identity,
            "PROFILE_IDENTITY_RELOCATION_SAME_ROOT"
        );
        let record = target
            .record
            .as_ref()
            .context("PROFILE_IDENTITY_RELOCATION_UNCONFIRMED")?;
        let expected = self.relocation_bytes()?;
        ensure!(
            target.logical_seed == self.logical_seed && record.bytes == expected,
            "PROFILE_IDENTITY_RELOCATION_CONFLICT"
        );
        self.verify(source)?;
        target.verify(final_target)?;
        Ok(target)
    }

    /// Create the legacy profile's first stable seed only at the final target.
    /// Existing records must already have been copied unchanged by the caller.
    /// The caller must verify that the published target belongs to this original
    /// stopped operation before creating or resuming its prepared seed file.
    /// This is not a Native identity migration or an authorization capability.
    pub fn relocate(
        &self,
        source: &PrivateDirectory,
        final_target: &PrivateDirectory,
        operation_id: &str,
    ) -> Result<Self> {
        validate_operation(operation_id)?;
        self.verify(source)?;
        let target = Self::observe(final_target)?;
        ensure!(
            target.profile_identity != self.profile_identity,
            "PROFILE_IDENTITY_RELOCATION_SAME_ROOT"
        );
        if target.record.is_some() {
            return self.verify_relocation(source, final_target, operation_id);
        }
        ensure!(
            self.record.is_none(),
            "PROFILE_IDENTITY_RELOCATION_UNCONFIRMED"
        );
        let expected = self.relocation_bytes()?;
        let prepared_name = prepared_name(
            operation_id,
            &self.profile_identity,
            &target.profile_identity,
        )?;
        let prepared_name = OsStr::new(&prepared_name);
        match source.open_single_link_regular_file(prepared_name) {
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
            Ok(_) => anyhow::bail!("PROFILE_IDENTITY_RELOCATION_UNCONFIRMED"),
        }
        let prepared = match final_target.open_read_write_file(prepared_name, true) {
            Ok(file) => {
                (&file).write_all(&expected)?;
                file.sync_all()?;
                file
            }
            Err(error) if exists(&error) => {
                final_target.open_single_link_regular_file(prepared_name)?
            }
            Err(error) => return Err(error),
        };
        let identity = PortableLeaseIdentity::from_private_regular_handle(&prepared)?;
        let named = final_target.open_single_link_regular_file(prepared_name)?;
        ensure!(
            PortableLeaseIdentity::from_private_regular_handle(&named)? == identity
                && read_bytes(&named)? == expected
                && read_bytes(&prepared)? == expected,
            "PROFILE_IDENTITY_RELOCATION_CONFLICT"
        );
        self.verify(source)?;
        final_target.rename_no_replace(prepared_name, OsStr::new(RECORD))?;
        let target = self.verify_relocation(source, final_target, operation_id)?;
        ensure!(
            target
                .record
                .as_ref()
                .is_some_and(|record| record.identity == identity),
            "PROFILE_IDENTITY_RELOCATION_UNCONFIRMED"
        );
        Ok(target)
    }

    fn relocation_bytes(&self) -> Result<Vec<u8>> {
        if let Some(record) = &self.record {
            return Ok(record.bytes.clone());
        }
        let mut bytes = serde_json::to_vec(&SeedRecord {
            version: 2,
            logical_seed: self.logical_seed.clone(),
        })?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

fn prepared_name(operation: &str, source: &str, target: &str) -> Result<String> {
    Ok(format!(
        ".profile-identity-{:x}.prepared",
        Sha256::digest(serde_json::to_vec(&(operation, source, target))?)
    ))
}

fn valid_seed(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
}

fn validate_operation(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.chars().count() <= 256,
        "PROFILE_IDENTITY_INVALID_OPERATION"
    );
    Ok(())
}

fn read_bytes(file: &File) -> Result<Vec<u8>> {
    let size = file.metadata()?.len();
    ensure!(size <= MAX_RECORD_BYTES, "PROFILE_IDENTITY_RECORD_INVALID");
    let mut bytes = vec![0; size as usize];
    let mut offset = 0;
    while offset < bytes.len() {
        #[cfg(unix)]
        let count = {
            use std::os::unix::fs::FileExt;
            file.read_at(&mut bytes[offset..], offset as u64)?
        };
        #[cfg(windows)]
        let count = {
            use std::os::windows::fs::FileExt;
            file.seek_read(&mut bytes[offset..], offset as u64)?
        };
        #[cfg(not(any(unix, windows)))]
        let count: usize = anyhow::bail!("PROFILE_IDENTITY_READ_UNAVAILABLE");
        ensure!(count > 0, "PROFILE_IDENTITY_RECORD_CHANGED");
        offset += count;
    }
    ensure!(
        file.metadata()?.len() == size,
        "PROFILE_IDENTITY_RECORD_CHANGED"
    );
    Ok(bytes)
}

fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

fn exists(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists)
}

#[cfg(test)]
mod tests;
