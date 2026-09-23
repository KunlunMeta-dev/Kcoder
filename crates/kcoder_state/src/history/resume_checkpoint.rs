//! Bounded, disposable replay checkpoints. Sidecar state is never cached here.
use super::{PreparedHistoryReplay, replay::ReplayState};
use crate::history_index::journal::{self, JournalDomain, JournalWatermark};
use crate::history_store::SourceStamp;
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const VERSION: u32 = 1;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 8 * 1024 * 1024;
const DIRECTORY: &str = ".kcoder-resume-checkpoints";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    version: u32,
    semantics: u32,
    path: PathBuf,
    proof: Vec<u8>,
    watermark: JournalWatermark,
    state: ReplayState,
}

struct BoundedBytes(Vec<u8>);
impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) as u64 > MAX_BYTES {
            return Err(std::io::Error::other(
                "checkpoint serialization exceeds budget",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn load(directory: &PrivateDirectory, name: &OsStr) -> Result<Checkpoint> {
    let child = directory.open_child(OsStr::new(DIRECTORY), false)?;
    let file = child.open_regular_file(name)?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 33).read_to_end(&mut bytes)?;
    #[cfg(test)]
    super::resume_checkpoint_tests::CHECKPOINT_BYTES.with(|n| n.set(n.get() + bytes.len() as u64));
    ensure!(
        bytes.len() >= 32 && bytes.len() as u64 <= MAX_BYTES + 32,
        "invalid checkpoint size"
    );
    ensure!(
        Sha256::digest(&bytes[32..]).as_slice() == &bytes[..32],
        "checkpoint checksum mismatch"
    );
    Ok(serde_json::from_slice(&bytes[32..])?)
}

fn save(directory: &PrivateDirectory, name: &OsStr, checkpoint: &Checkpoint) -> Result<()> {
    let mut payload = BoundedBytes(Vec::new());
    serde_json::to_writer(&mut payload, checkpoint)?;
    let digest = Sha256::digest(&payload.0);
    let mut bytes = Vec::with_capacity(payload.0.len() + 32);
    bytes.extend_from_slice(&digest);
    bytes.extend_from_slice(&payload.0);
    directory
        .open_child(OsStr::new(DIRECTORY), true)?
        .atomic_replace(name, &bytes)?;
    #[cfg(test)]
    super::resume_checkpoint_tests::CHECKPOINT_WRITTEN_BYTES
        .with(|n| n.set(n.get() + bytes.len() as u64));
    Ok(())
}

/// All failures are cache misses at the caller; authority and the generic replay stay unchanged.
pub(super) fn replay(path: &Path, stamp: &SourceStamp) -> Result<PreparedHistoryReplay> {
    let canonical = std::fs::canonicalize(path)?;
    let parent = canonical.parent().context("history has no parent")?;
    let directory = PrivateDirectory::open_existing(parent)?;
    let leaf = canonical.file_name().context("history has no filename")?;
    let watermark = journal::current_watermark(parent, JournalDomain::History)?
        .context("checkpoint reuse requires explicitly enabled history tracking")?;
    let end = stamp
        .known_committed_bytes()
        .context("unknown committed checkpoint boundary")?;
    let filename = format!(
        "{:x}.checkpoint",
        Sha256::digest(serde_json::to_vec(&canonical)?)
    );
    let name = OsStr::new(&filename);
    let proof = stamp.resume_checkpoint_proof()?;
    let (state, unchanged) = load(&directory, name)
        .ok()
        .filter(|checkpoint| {
            checkpoint.version == VERSION
                && checkpoint.semantics == kcoder_types::REAL_USER_MESSAGE_SEMANTICS_VERSION
                && checkpoint.path == canonical
                && stamp.extends_resume_checkpoint(&checkpoint.proof, checkpoint.state.offset)
                && journal::changes_since(
                    parent,
                    JournalDomain::History,
                    &checkpoint.watermark,
                    4096,
                )
                .ok()
                .flatten()
                .is_some_and(|changes| changes.watermark == watermark)
        })
        .map(|checkpoint| {
            let unchanged = checkpoint.proof == proof && checkpoint.watermark == watermark;
            (checkpoint.state, unchanged)
        })
        .unwrap_or_default();
    let mut file = directory.open_regular_file(leaf)?;
    let identity = file_identity(&file)?;
    ensure!(
        file.metadata()?.len() == end && state.offset <= end,
        "checkpoint body boundary mismatch"
    );
    file.seek(SeekFrom::Start(state.offset))?;
    let remaining = end - state.offset;
    let state = state.read(
        &canonical,
        std::io::BufReader::new((&mut file).take(remaining)),
        Some(&kcoder_types::is_real_user_message),
        Some(MAX_LINE_BYTES),
    )?;
    ensure!(state.offset == end, "checkpoint tail ended before boundary");
    ensure!(
        file.metadata()?.len() == end
            && file_identity(&directory.open_regular_file(leaf)?)? == identity
            && file_identity(&PrivateDirectory::open_existing(parent)?.open_regular_file(leaf)?)?
                == identity,
        "history identity changed during checkpoint replay"
    );
    ensure!(
        crate::history_store::source_stamp(path)? == *stamp
            && journal::current_watermark(parent, JournalDomain::History)?.as_ref()
                == Some(&watermark),
        "source tracking changed during checkpoint replay"
    );
    let checkpoint = Checkpoint {
        version: VERSION,
        semantics: kcoder_types::REAL_USER_MESSAGE_SEMANTICS_VERSION,
        path: canonical,
        proof,
        watermark,
        state,
    };
    if !unchanged && let Err(error) = save(&directory, name, &checkpoint) {
        tracing::debug!(%error, "resume checkpoint could not be persisted; recovery remains valid");
    }
    Ok(checkpoint.state.finish(path))
}

#[cfg(unix)]
fn file_identity(file: &File) -> std::io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity(file: &File) -> std::io::Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    // SAFETY: the output is POD and the owned file handle remains live throughout the call.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber as u64,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}
