//! Capture and first publication retain exact flushed-descriptor receipts.
use super::files::{CreationFiles, publish_json, read_bytes, read_json};
use anyhow::{Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Read, Write},
};
use zeroize::Zeroizing;

pub(super) const MAX_JOB_BYTES: usize = 16 * 1024 * 1024;
const PREPARED: &str = "create.prepared.json";
const PREPARED_SEAL: &str = "create.prepared.seal.json";
const PUBLISHED_SEAL: &str = "create.published.seal.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Seal {
    version: u32,
    birth_sha256: String,
    directory_identity: String,
    file_identity: PortableLeaseIdentity,
    bytes: u64,
    sha256: String,
}

impl CreationFiles {
    pub fn prepared<T: DeserializeOwned>(&self) -> Result<Option<T>> {
        self.prepared_bytes()?
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|_| anyhow::anyhow!("migration_batch_creation_unknown"))
            })
            .transpose()
    }

    /// Only the original creation worker may publish this immutable normal-job capture.
    pub fn prepare(&self, job: &impl Serialize, mut check: impl FnMut() -> bool) -> Result<()> {
        ensure!(check(), "migration_cancelled");
        let bytes = encode(job, &mut check)?;
        if let Some(existing) = self.prepared_bytes()? {
            ensure!(
                *existing == *bytes,
                "migration_batch_create_intent_conflict"
            );
            return Ok(());
        }
        let directory_identity = self.directory.directory_identity()?;
        let mut reader = CheckedReader {
            bytes: &bytes,
            position: 0,
            check: &mut check,
        };
        self.directory.atomic_publish_observed_from_reader(
            OsStr::new(PREPARED),
            &mut reader,
            false,
            || {
                ensure!(
                    self.directory.directory_identity()? == directory_identity,
                    "migration_batch_creation_unknown"
                );
                Ok(None)
            },
            |file| {
                publish_json(
                    &self.directory,
                    PREPARED_SEAL,
                    &Seal {
                        version: 1,
                        birth_sha256: self.birth_sha256.clone(),
                        directory_identity: directory_identity.clone(),
                        file_identity: self.directory.portable_regular_handle_identity(file)?,
                        bytes: bytes.len() as u64,
                        sha256: hash(&bytes),
                    },
                )
            },
        )?;
        self.prepared_bytes()?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
        Ok(())
    }

    /// The caller also holds the migrations catalog writer. An earlier final seal
    /// never grants permission to recreate a now-missing ordinary journal.
    pub fn publish(&self, parent: &PrivateDirectory) -> Result<()> {
        ensure!(
            !self.publication_started()?,
            "migration_batch_creation_unknown"
        );
        let bytes = self
            .prepared_bytes()?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
        let directory_identity = parent.directory_identity()?;
        let name = format!("{}.json", self.birth.job_id);
        let mut reader = std::io::Cursor::new(&*bytes);
        parent.atomic_publish_observed_from_reader(
            OsStr::new(&name),
            &mut reader,
            false,
            || {
                ensure!(
                    parent.directory_identity()? == directory_identity,
                    "migration_batch_creation_unknown"
                );
                Ok(None)
            },
            |file| {
                publish_json(
                    &self.directory,
                    PUBLISHED_SEAL,
                    &Seal {
                        version: 1,
                        birth_sha256: self.birth_sha256.clone(),
                        directory_identity: directory_identity.clone(),
                        file_identity: parent.portable_regular_handle_identity(file)?,
                        bytes: bytes.len() as u64,
                        sha256: hash(&bytes),
                    },
                )
            },
        )?;
        self.verify_first_publication(parent)?;
        Ok(())
    }

    /// Read-only recovery distinguishes a prepared capture from an attempted
    /// publication; a missing ordinary journal after an attempt remains unknown.
    pub fn publication_started(&self) -> Result<bool> {
        let seal: Option<Seal> = read_json(&self.directory, PUBLISHED_SEAL, 16 * 1024)?;
        if let Some(seal) = &seal {
            self.validate_seal(seal)?;
            let prepared = self
                .prepared_bytes()?
                .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
            ensure!(
                seal.bytes == prepared.len() as u64 && seal.sha256 == hash(&prepared),
                "migration_batch_creation_unknown"
            );
        }
        Ok(seal.is_some())
    }

    /// Used only for the original sequence-one journal; later ordinary updates
    /// have their own authoritative journal sequence and creation binding.
    pub fn verify_first_publication(&self, parent: &PrivateDirectory) -> Result<()> {
        let seal: Seal = read_json(&self.directory, PUBLISHED_SEAL, 16 * 1024)?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
        self.validate_seal(&seal)?;
        read_sealed(parent, &format!("{}.json", self.birth.job_id), &seal)?;
        Ok(())
    }

    fn prepared_bytes(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let seal: Option<Seal> = read_json(&self.directory, PREPARED_SEAL, 16 * 1024)?;
        let Some(seal) = seal else {
            ensure!(
                read_bytes(&self.directory, PREPARED, MAX_JOB_BYTES as u64)?.is_none(),
                "migration_batch_creation_unknown"
            );
            return Ok(None);
        };
        self.validate_seal(&seal)?;
        read_sealed(&self.directory, PREPARED, &seal).map(Some)
    }
    fn validate_seal(&self, seal: &Seal) -> Result<()> {
        ensure!(
            seal.version == 1
                && seal.birth_sha256 == self.birth_sha256
                && seal.bytes > 0
                && seal.bytes <= MAX_JOB_BYTES as u64,
            "migration_batch_creation_unknown"
        );
        super::model::digest(&seal.sha256)?;
        Ok(())
    }
}

fn read_sealed(
    directory: &PrivateDirectory,
    name: &str,
    seal: &Seal,
) -> Result<Zeroizing<Vec<u8>>> {
    ensure!(
        directory.directory_identity()? == seal.directory_identity,
        "migration_batch_creation_unknown"
    );
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        directory.portable_regular_handle_identity(&file)? == seal.file_identity
            && file.metadata()?.len() == seal.bytes,
        "migration_batch_creation_unknown"
    );
    let mut bytes = Zeroizing::new(Vec::new());
    (&file).take(seal.bytes + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == seal.bytes
            && hash(&bytes) == seal.sha256
            && directory.portable_regular_handle_identity(&file)? == seal.file_identity
            && directory.portable_regular_identity(OsStr::new(name))? == seal.file_identity
            && directory.directory_identity()? == seal.directory_identity,
        "migration_batch_creation_unknown"
    );
    Ok(bytes)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn encode(value: &impl Serialize, check: &mut impl FnMut() -> bool) -> Result<Zeroizing<Vec<u8>>> {
    let mut writer = BoundedWriter {
        bytes: Zeroizing::new(Vec::new()),
        check,
        cancelled: false,
        next_check: 0,
    };
    if serde_json::to_writer(&mut writer, value).is_err() {
        anyhow::bail!(if writer.cancelled {
            "migration_cancelled"
        } else {
            "migration_journal_budget_exceeded"
        });
    }
    Ok(writer.bytes)
}
struct BoundedWriter<'a, F> {
    bytes: Zeroizing<Vec<u8>>,
    check: &'a mut F,
    cancelled: bool,
    next_check: usize,
}
impl<F: FnMut() -> bool> Write for BoundedWriter<'_, F> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > MAX_JOB_BYTES {
            return Err(std::io::Error::other(
                "normal migration journal exceeds budget",
            ));
        }
        for part in bytes.chunks(64 * 1024) {
            if self.bytes.len() >= self.next_check {
                if !(self.check)() {
                    self.cancelled = true;
                    return Err(std::io::Error::other("migration capture cancelled"));
                }
                self.next_check = self.bytes.len().saturating_add(64 * 1024);
            }
            self.bytes.extend_from_slice(part);
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
            return Err(std::io::Error::other("migration capture cancelled"));
        }
        let count = output
            .len()
            .min(64 * 1024)
            .min(self.bytes.len() - self.position);
        output[..count].copy_from_slice(&self.bytes[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }
}
