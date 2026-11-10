//! Immutable instruction recipes use the normal job's private plan directory.
use crate::instruction_sources::InstructionSourceSnapshot;
use anyhow::{Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read, path::Path};
use zeroize::Zeroizing;

const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;
const CHECK_INTERVAL: usize = 64 * 1024;
#[path = "shape.rs"]
mod shape;

/// Private journal reference, never a client-supplied filesystem selection.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstructionArtifactReference {
    version: u32,
    job_id: String,
    profile_identity: String,
    directory_identity: String,
    file_identity: PortableLeaseIdentity,
    bytes: u64,
    sha256: String,
}
impl std::fmt::Debug for InstructionArtifactReference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstructionArtifactReference")
            .field("version", &self.version)
            .field("bytes", &self.bytes)
            .finish_non_exhaustive()
    }
}
impl InstructionArtifactReference {
    /// The normal migration writer must own this job before calling publication.
    pub(crate) fn publish(
        directory: &PrivateDirectory,
        profile: &Path,
        job_id: &str,
        snapshot: &InstructionSourceSnapshot,
        mut check: impl FnMut() -> bool,
    ) -> Result<Self> {
        validate_job(job_id)?;
        directory.verify_private_directory()?;
        ensure!(check(), "migration_cancelled");
        validate_snapshot(snapshot)?;
        let profile_identity = profile_identity(profile)?;
        let directory_identity = directory.directory_identity()?;
        let bytes = encode(snapshot, MAX_ARTIFACT_BYTES, &mut check)?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let name = filename(&sha256)?;
        match directory.open_single_link_regular_file(OsStr::new(&name)) {
            Ok(_) => {}
            Err(error) if is_missing(&error) => {
                let mut reader = CheckedReader {
                    bytes: &bytes,
                    position: 0,
                    check: &mut check,
                };
                directory.atomic_publish_from_reader(
                    OsStr::new(&name),
                    &mut reader,
                    false,
                    || {
                        ensure!(
                            directory.directory_identity()? == directory_identity
                                && self::profile_identity(profile)? == profile_identity,
                            "migration_instruction_artifact_owner_changed"
                        );
                        Ok(None)
                    },
                )?;
            }
            Err(error) => return Err(error),
        }
        ensure!(check(), "migration_cancelled");
        let reference = Self {
            version: 1,
            job_id: job_id.into(),
            profile_identity,
            directory_identity,
            file_identity: directory.portable_regular_identity(OsStr::new(&name))?,
            bytes: bytes.len() as u64,
            sha256,
        };
        // An earlier lost publication receipt is reconciled by the same immutable bytes.
        reference.read(directory, profile, job_id)?;
        Ok(reference)
    }

    pub(crate) fn read(
        &self,
        directory: &PrivateDirectory,
        profile: &Path,
        job_id: &str,
    ) -> Result<InstructionSourceSnapshot> {
        self.validate_owner(directory, profile, job_id)?;
        let name = filename(&self.sha256)?;
        let file = directory.open_single_link_regular_file(OsStr::new(&name))?;
        ensure!(
            file.metadata()?.len() == self.bytes
                && directory.portable_regular_handle_identity(&file)? == self.file_identity,
            "migration_instruction_artifact_changed"
        );
        let mut bytes = Zeroizing::new(Vec::new());
        (&file).take(self.bytes + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == self.bytes
                && format!("{:x}", Sha256::digest(&bytes)) == self.sha256
                && directory.portable_regular_handle_identity(&file)? == self.file_identity
                && directory.portable_regular_identity(OsStr::new(&name))? == self.file_identity,
            "migration_instruction_artifact_changed"
        );
        shape::check(&bytes)?;
        let snapshot: InstructionSourceSnapshot = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("migration_instruction_artifact_invalid"))?;
        validate_snapshot(&snapshot)?;
        self.validate_owner(directory, profile, job_id)?;
        Ok(snapshot)
    }

    pub(crate) fn job_id(&self) -> &str {
        &self.job_id
    }
    pub(crate) fn open_directory(
        &self,
        parent: &PrivateDirectory,
        profile: &Path,
    ) -> Result<PrivateDirectory> {
        validate_job(&self.job_id)?;
        let directory = parent.open_child(OsStr::new(&format!("{}.plans", self.job_id)), false)?;
        self.validate_owner(&directory, profile, &self.job_id)?;
        Ok(directory)
    }

    fn validate_owner(
        &self,
        directory: &PrivateDirectory,
        profile: &Path,
        job_id: &str,
    ) -> Result<()> {
        validate_job(job_id)?;
        directory.verify_private_directory()?;
        ensure!(
            self.version == 1
                && self.bytes > 0
                && self.bytes <= MAX_ARTIFACT_BYTES as u64
                && self.job_id == job_id
                && self.profile_identity == profile_identity(profile)?
                && self.directory_identity == directory.directory_identity()?,
            "migration_instruction_artifact_owner_changed"
        );
        filename(&self.sha256)?;
        Ok(())
    }
}

fn validate_job(job_id: &str) -> Result<()> {
    ensure!(
        job_id.len() == 36
            && job_id.starts_with("mig-")
            && job_id[4..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "migration_invalid_job_reference"
    );
    Ok(())
}
fn profile_identity(profile: &Path) -> Result<String> {
    let directory = PrivateDirectory::open_existing(profile)?;
    directory.verify_trusted_config_directory()?;
    Ok(format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\0{}",
            profile.canonicalize()?.display(),
            directory.directory_identity()?
        ))
    ))
}
fn filename(digest: &str) -> Result<String> {
    ensure!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "migration_instruction_artifact_invalid"
    );
    Ok(format!("instructions-{digest}.json"))
}
fn validate_snapshot(snapshot: &InstructionSourceSnapshot) -> Result<()> {
    let first = snapshot
        .summaries()
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("migration_instruction_source_empty"))?;
    // This validates the entire captured recipe without reopening the source.
    snapshot.original_bytes(&first.id)?;
    Ok(())
}
fn is_missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
    })
}
fn encode(
    snapshot: &InstructionSourceSnapshot,
    limit: usize,
    check: &mut impl FnMut() -> bool,
) -> Result<Zeroizing<Vec<u8>>> {
    let mut writer = BoundedWriter {
        bytes: Zeroizing::new(Vec::new()),
        limit,
        next_check: 0,
        cancelled: false,
        check,
    };
    if serde_json::to_writer(&mut writer, snapshot).is_err() {
        anyhow::bail!(if writer.cancelled {
            "migration_cancelled"
        } else {
            "migration_instruction_artifact_budget_exceeded"
        });
    }
    Ok(writer.bytes)
}
struct BoundedWriter<'a, F> {
    bytes: Zeroizing<Vec<u8>>,
    limit: usize,
    next_check: usize,
    cancelled: bool,
    check: &'a mut F,
}
impl<F: FnMut() -> bool> std::io::Write for BoundedWriter<'_, F> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > self.limit {
            return Err(std::io::Error::other("instruction artifact exceeds budget"));
        }
        for chunk in bytes.chunks(CHECK_INTERVAL) {
            if self.bytes.len() >= self.next_check {
                if !(self.check)() {
                    self.cancelled = true;
                    return Err(std::io::Error::other("instruction capture cancelled"));
                }
                self.next_check = self.bytes.len().saturating_add(CHECK_INTERVAL);
            }
            self.bytes.extend_from_slice(chunk);
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct CheckedReader<'a, F> {
    bytes: &'a [u8],
    position: usize,
    check: &'a mut F,
}
impl<F: FnMut() -> bool> Read for CheckedReader<'_, F> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if !(self.check)() {
            return Err(std::io::Error::other("instruction capture cancelled"));
        }
        let size = output
            .len()
            .min(CHECK_INTERVAL)
            .min(self.bytes.len() - self.position);
        output[..size].copy_from_slice(&self.bytes[self.position..self.position + size]);
        self.position += size;
        Ok(size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn encoding_budget_is_checked_before_extending_the_output_buffer() {
        let mut check = || true;
        let mut writer = BoundedWriter {
            bytes: Zeroizing::new(Vec::new()),
            limit: 16,
            next_check: 0,
            cancelled: false,
            check: &mut check,
        };
        writer.write_all(b"1234567890123456").unwrap();
        let capacity = writer.bytes.capacity();
        assert!(writer.write_all(&[b'x'; 4096]).is_err());
        assert_eq!(writer.bytes.as_slice(), b"1234567890123456");
        assert_eq!(writer.bytes.capacity(), capacity);
    }
}
