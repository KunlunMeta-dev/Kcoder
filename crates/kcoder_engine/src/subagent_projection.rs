//! Private receipts associate public projections with their checkpoint baseline.
//! Ordering covers participating writers in this process, not other processes.

use anyhow::{Context, Result};
use kcoder_config::PrivateDirectory;
use kcoder_types::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

// Two internally generated records occupy less than 1 KiB. A damaged receipt
// must not turn a metadata lookup into an unbounded JSON read.
const MAX_RECEIPT_BYTES: u64 = 4096;
const MAX_CHECKPOINT_BYTES: u64 = 16 * 1024 * 1024;
type Segments = Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>;
static SEGMENTS: OnceLock<Segments> = OnceLock::new();

/// Synchronous file work only. Async checkpoint owners take their async gate
/// first; these segments never acquire it or retain a guard across an await.
pub(crate) fn with_segment<T>(path: &Path, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let key = std::path::absolute(path).context("resolve projection segment path")?;
    let segment = {
        let mut segments = SEGMENTS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        segments.retain(|_, weak| weak.strong_count() > 0);
        if let Some(segment) = segments.get(&key).and_then(Weak::upgrade) {
            segment
        } else {
            let segment = Arc::new(Mutex::new(()));
            segments.insert(key, Arc::downgrade(&segment));
            segment
        }
    };
    let _guard = segment
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    work()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Baseline {
    Missing,
    Bytes { sha256: String },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    public_sha256: String,
    private_baseline: Baseline,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipts {
    version: u8,
    records: Vec<Receipt>,
}

fn directory(path: &Path, create: bool) -> Result<PrivateDirectory> {
    let parent = path
        .parent()
        .context("subagent transcript has no directory")?;
    if create {
        PrivateDirectory::open_or_create(parent)
    } else {
        PrivateDirectory::open_existing(parent)
    }
}

fn optional_file(directory: &PrivateDirectory, path: &Path) -> Result<Option<File>> {
    match directory.open_regular_file(path.file_name().context("artifact has no file name")?) {
        Ok(file) => Ok(Some(file)),
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

struct DigestReader<R> {
    inner: R,
    digest: Sha256,
    bytes: u64,
}

impl<R: Read> Read for DigestReader<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(output)?;
        self.digest.update(&output[..count]);
        self.bytes += count as u64;
        Ok(count)
    }
}

fn digest_reader<R>(inner: R) -> DigestReader<R> {
    DigestReader {
        inner,
        digest: Sha256::new(),
        bytes: 0,
    }
}

fn private_baseline(directory: &PrivateDirectory, path: &Path) -> Result<Baseline> {
    let Some(file) = optional_file(directory, path)? else {
        return Ok(Baseline::Missing);
    };
    let mut reader = digest_reader(file);
    std::io::copy(&mut reader, &mut std::io::sink())?;
    Ok(Baseline::Bytes {
        sha256: format!("{:x}", reader.digest.finalize()),
    })
}

fn public_identity(directory: &PrivateDirectory, path: &Path) -> Result<Option<String>> {
    let Some(file) = optional_file(directory, &path.with_extension("public.txt"))? else {
        return Ok(None);
    };
    let mut reader = digest_reader(file);
    let mut header = [0; super::subagent_boundary_runtime::PUBLIC_TRANSCRIPT_HEADER.len()];
    if reader.read_exact(&mut header).is_err()
        || header != super::subagent_boundary_runtime::PUBLIC_TRANSCRIPT_HEADER
    {
        return Ok(None);
    }
    std::io::copy(&mut reader, &mut std::io::sink())?;
    Ok(Some(format!("{:x}", reader.digest.finalize())))
}

fn valid_sha256(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn receipt_path(path: &Path) -> PathBuf {
    path.with_extension("public-receipts.json")
}

fn load_receipts(directory: &PrivateDirectory, path: &Path) -> Result<Receipts> {
    let Some(file) = optional_file(directory, &receipt_path(path))? else {
        return Ok(Receipts::default());
    };
    anyhow::ensure!(
        file.metadata()?.len() <= MAX_RECEIPT_BYTES,
        "invalid projection receipt size"
    );
    let receipts: Receipts = serde_json::from_reader(file.take(MAX_RECEIPT_BYTES + 1))?;
    anyhow::ensure!(
        receipts.version == 1
            && receipts.records.len() <= 2
            && receipts.records.iter().all(|record| {
                valid_sha256(&record.public_sha256)
                    && match &record.private_baseline {
                        Baseline::Missing => true,
                        Baseline::Bytes { sha256 } => valid_sha256(sha256),
                    }
            }),
        "invalid projection receipt"
    );
    Ok(receipts)
}

pub(crate) fn publish(path: &Path, public: &[u8]) -> Result<()> {
    with_segment(path, || {
        let directory = directory(path, true)?;
        let baseline = private_baseline(&directory, path)?;
        publish_locked(&directory, path, public, baseline, || Ok(()))
    })
}

fn publish_locked(
    directory: &PrivateDirectory,
    path: &Path,
    public: &[u8],
    baseline: Baseline,
    before_public: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let current = public_identity(directory, path)?;
    let next = Receipt {
        public_sha256: format!("{:x}", Sha256::digest(public)),
        private_baseline: baseline,
    };
    let mut records = Vec::with_capacity(2);
    if let Some(previous) = load_receipts(directory, path)
        .unwrap_or_default()
        .records
        .into_iter()
        .find(|record| {
            Some(&record.public_sha256) == current.as_ref()
                && record.public_sha256 != next.public_sha256
        })
    {
        records.push(previous);
    }
    records.push(next);
    let receipts = serde_json::to_vec(&Receipts {
        version: 1,
        records,
    })?;
    let receipt_path = receipt_path(path);
    directory.atomic_replace(
        receipt_path
            .file_name()
            .context("receipt has no file name")?,
        &receipts,
    )?;
    // A failure before/inside public replacement leaves the current receipt
    // available. A successful replacement already has its matching receipt.
    before_public()?;
    let public_path = path.with_extension("public.txt");
    directory.atomic_replace(
        public_path
            .file_name()
            .context("public artifact has no file name")?,
        public,
    )
}

fn read_checkpoint(directory: &PrivateDirectory, path: &Path) -> Result<(Vec<Message>, Baseline)> {
    let file = optional_file(directory, path)?.context("private checkpoint is missing")?;
    anyhow::ensure!(
        file.metadata()?.len() <= MAX_CHECKPOINT_BYTES,
        "legacy transcript exceeds the bounded conversion budget"
    );
    let mut reader = BufReader::new(digest_reader(file.take(MAX_CHECKPOINT_BYTES + 1)));
    let messages = serde_json::from_reader(&mut reader).context("legacy checkpoint is invalid")?;
    let reader = reader.into_inner();
    anyhow::ensure!(
        reader.bytes <= MAX_CHECKPOINT_BYTES,
        "legacy transcript exceeds the bounded conversion budget"
    );
    Ok((
        messages,
        Baseline::Bytes {
            sha256: format!("{:x}", reader.digest.finalize()),
        },
    ))
}

fn materialize_locked(directory: &PrivateDirectory, path: &Path) -> Result<()> {
    let (messages, baseline) = read_checkpoint(directory, path)?;
    let public = super::subagent_boundary_runtime::public_subagent_transcript(&messages)?;
    publish_locked(directory, path, &public, baseline, || Ok(()))
}

fn public_starts_with(directory: &PrivateDirectory, path: &Path, prefix: &[u8]) -> Result<bool> {
    let mut file = optional_file(directory, &path.with_extension("public.txt"))?
        .context("public projection disappeared")?;
    let mut buffer = [0; 8192];
    for expected in prefix.chunks(buffer.len()) {
        match file.read_exact(&mut buffer[..expected.len()]) {
            Ok(()) if &buffer[..expected.len()] == expected => {}
            Ok(()) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(true)
}

pub(crate) fn materialize(path: &Path) -> Result<()> {
    with_segment(path, || materialize_locked(&directory(path, false)?, path))
}

pub(crate) fn ensure(
    path: &Path,
    preserve_unknown: bool,
    preserve_live_extension: bool,
) -> Result<()> {
    with_segment(path, || {
        let directory = directory(path, false)?;
        if let Some(public) = public_identity(&directory, path)? {
            let receipts = load_receipts(&directory, path).unwrap_or_default();
            if let Some(receipt) = receipts
                .records
                .iter()
                .find(|record| record.public_sha256 == public)
            {
                let baseline = private_baseline(&directory, path)?;
                // Retained public output remains useful after private retention.
                // A same-baseline safe-boundary projection may be ahead of disk.
                if baseline == Baseline::Missing || baseline == receipt.private_baseline {
                    return Ok(());
                }
                let (messages, baseline) = read_checkpoint(&directory, path)?;
                let expected =
                    super::subagent_boundary_runtime::public_subagent_transcript(&messages)?;
                // Conservatively keep a running writer's N+2 projection while
                // disk advances only to N+1. A prefix does not prove the private
                // history was never replaced/rewound. Header-only snapshots and
                // terminal reads must rebuild; never mark this fallback with a
                // verified new baseline or promise complete freshness.
                if preserve_live_extension
                    && expected.len()
                        > super::subagent_boundary_runtime::PUBLIC_TRANSCRIPT_HEADER.len()
                    && public_starts_with(&directory, path, &expected)?
                {
                    return Ok(());
                }
                return publish_locked(&directory, path, &expected, baseline, || Ok(()));
            } else if preserve_unknown || private_baseline(&directory, path)? == Baseline::Missing {
                return Ok(());
            }
        }
        materialize_locked(&directory, path)
    })
}

#[cfg(test)]
#[path = "subagent_projection_tests.rs"]
mod tests;
