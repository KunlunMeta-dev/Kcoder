//! Session retirement preserves archives and artifacts; native locks precede every snapshot.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::{
    historical_context::HistoricalSessionSeedBinding, historical_undo::HistoricalUndoSealReceipt,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
pub(crate) mod manifest;
use manifest::{Manifest, capture};

pub const LIFECYCLE_LOCK_DIRECTORY: &str = ".thread-lifecycle-locks";
const SEAL: &str = "historical-undo.seal.json";
const META: u64 = 2 * 1024 * 1024;

/// Non-serializable proof: lifecycle lock, then session lease. Neither lock file is unlinked.
pub struct HistoricalUndoLease {
    history_path: PathBuf,
    artifact_root: PathBuf,
    session_id: String,
    history_identity: String,
    artifact_identity: String,
    history_was_absent: bool,
    _lifecycle: File,
    _session: File,
}
impl HistoricalUndoLease {
    pub fn try_acquire(
        history_path: &Path,
        artifact_root: &Path,
        session_id: &str,
    ) -> Result<Self> {
        Self::acquire_at(history_path, artifact_root, session_id, true)
    }
    /// Existing publication locks are required for observation and retirement.
    pub fn try_acquire_existing(
        history_path: &Path,
        artifact_root: &Path,
        session_id: &str,
    ) -> Result<Self> {
        Self::acquire_at(history_path, artifact_root, session_id, false)
    }
    fn acquire_at(
        history_path: &Path,
        artifact_root: &Path,
        session_id: &str,
        create: bool,
    ) -> Result<Self> {
        ensure!(
            session_id.len() == 5 && session_id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
            "historical_undo_invalid_session"
        );
        ensure!(
            history_path.file_name().and_then(OsStr::to_str)
                == Some(&format!("{session_id}.jsonl")),
            "historical_undo_invalid_history_path"
        );
        let history_parent = history_path
            .parent()
            .context("historical_undo_missing_parent")?;
        let history = PrivateDirectory::open_existing(history_parent)?;
        history.verify_trusted_config_directory()?;
        let artifacts = PrivateDirectory::open_existing(artifact_root)?;
        artifacts.verify_trusted_config_directory()?;
        let history_path = history_parent
            .canonicalize()?
            .join(format!("{session_id}.jsonl"));
        let artifact_root = artifact_root.canonicalize()?;
        let locks = artifacts.open_child(OsStr::new(LIFECYCLE_LOCK_DIRECTORY), create)?;
        locks.verify_private_directory()?;
        if !create {
            locks.open_single_link_regular_file(OsStr::new(&format!("{session_id}.lock")))?;
            history.open_single_link_regular_file(OsStr::new(&format!("{session_id}.lease")))?;
        }
        let lifecycle = locks
            .try_exclusive_lock(OsStr::new(&format!("{session_id}.lock")))?
            .context("historical_undo_session_busy")?;
        let session = history
            .try_exclusive_lock(OsStr::new(&format!("{session_id}.lease")))?
            .context("historical_undo_session_busy")?;
        let history_was_absent =
            match history.entry_metadata(OsStr::new(&format!("{session_id}.jsonl"))) {
                Ok(metadata) => {
                    ensure!(metadata.is_file(), "historical_undo_invalid_history_path");
                    false
                }
                Err(error) if missing(&error) => true,
                Err(error) => return Err(error),
            };
        let lease = Self {
            history_path,
            artifact_root,
            session_id: session_id.into(),
            history_identity: history.directory_identity()?,
            artifact_identity: artifacts.directory_identity()?,
            history_was_absent,
            _lifecycle: lifecycle,
            _session: session,
        };
        lease.verify(history_path_ref(&lease), &lease.artifact_root, session_id)?;
        Ok(lease)
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn verify(
        &self,
        history_path: &Path,
        artifact_root: &Path,
        session_id: &str,
    ) -> Result<()> {
        let history_parent = history_path
            .parent()
            .context("historical_undo_missing_parent")?;
        ensure!(
            history_parent.canonicalize()?.join(
                history_path
                    .file_name()
                    .context("historical_undo_invalid_history_path")?
            ) == self.history_path
                && artifact_root.canonicalize()? == self.artifact_root
                && session_id == self.session_id,
            "historical_undo_wrong_owner"
        );
        ensure!(
            PrivateDirectory::open_existing(history_parent)?.directory_identity()?
                == self.history_identity
                && PrivateDirectory::open_existing(artifact_root)?.directory_identity()?
                    == self.artifact_identity,
            "historical_undo_target_changed"
        );
        let history = PrivateDirectory::open_existing(history_parent)?;
        let artifacts = PrivateDirectory::open_existing(artifact_root)?;
        let lifecycle = artifacts.open_child(OsStr::new(LIFECYCLE_LOCK_DIRECTORY), false)?;
        ensure!(
            manifest::identity(
                &history
                    .open_single_link_regular_file(OsStr::new(&format!("{session_id}.lease")))?
            )? == manifest::identity(&self._session)?
                && manifest::identity(
                    &lifecycle
                        .open_single_link_regular_file(OsStr::new(&format!("{session_id}.lock")))?
                )? == manifest::identity(&self._lifecycle)?,
            "historical_undo_lease_identity_changed"
        );
        Ok(())
    }
}
fn history_path_ref(lease: &HistoricalUndoLease) -> &Path {
    &lease.history_path
}
pub(crate) fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|value| {
        value
            .downcast_ref::<std::io::Error>()
            .is_some_and(|value| value.kind() == std::io::ErrorKind::NotFound)
    })
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn read(directory: &PrivateDirectory, name: &str) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= META,
        "historical_undo_metadata_budget_exceeded"
    );
    let mut bytes = Vec::new();
    file.take(META + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= META,
        "historical_undo_metadata_budget_exceeded"
    );
    Ok(Some(bytes))
}
pub(crate) fn publish(directory: &PrivateDirectory, name: &str, bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() as u64 <= META,
        "historical_undo_metadata_budget_exceeded"
    );
    if let Some(previous) = read(directory, name)? {
        ensure!(previous == bytes, "historical_undo_receipt_changed");
        return Ok(());
    }
    directory.atomic_publish_from_reader(
        OsStr::new(name),
        &mut std::io::Cursor::new(bytes),
        false,
        || Ok(None),
    )?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Seal {
    version: u8,
    generation: uuid::Uuid,
    binding: HistoricalSessionSeedBinding,
    history_identity: String,
    artifact_identity: String,
    lifecycle_identity: String,
    session_lease_identity: String,
    manifest: Manifest,
}
fn seal_ref(bytes: &[u8], binding: &HistoricalSessionSeedBinding) -> HistoricalUndoSealReceipt {
    HistoricalUndoSealReceipt {
        operation_id: binding.operation_id.clone(),
        session_id: binding.session_id.clone(),
        seal_sha256: digest(bytes),
    }
}

/// Acquire the lease before publication. Existing bodies may only reuse an already sealed baseline.
pub fn seal_historical_session(
    lease: &HistoricalUndoLease,
    binding: &HistoricalSessionSeedBinding,
    mut check: impl FnMut(u64) -> bool,
) -> Result<HistoricalUndoSealReceipt> {
    lease.verify(
        &lease.history_path,
        &lease.artifact_root,
        &binding.session_id,
    )?;
    let (generation, receipt) = crate::historical_seed::undo_witness(&lease.history_path, binding)?;
    let fence = crate::history_store::historical_undo::SeedUndoFence::open(&lease.history_path)?;
    fence.assert_generation(generation)?;
    let control = fence.control_directory()?;
    if let Some(bytes) = read(&control, SEAL)? {
        let seal: Seal = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("historical_undo_invalid_seal"))?;
        ensure!(
            seal.version == 1
                && seal.binding == *binding
                && seal.generation == generation
                && seal.history_identity == lease.history_identity
                && seal.artifact_identity == lease.artifact_identity
                && seal.lifecycle_identity == manifest::identity(&lease._lifecycle)?
                && seal.session_lease_identity == manifest::identity(&lease._session)?,
            "historical_undo_seal_changed"
        );
        return Ok(seal_ref(&bytes, binding));
    }
    ensure!(
        lease.history_was_absent,
        "historical_undo_legacy_unsealed_session"
    );
    let manifest = capture(lease, &mut check)?;
    ensure!(
        manifest.history.bytes == receipt.history_bytes
            && manifest.history.sha256 == receipt.history_sha256,
        "historical_undo_history_changed"
    );
    let seal = Seal {
        version: 1,
        generation,
        binding: binding.clone(),
        history_identity: lease.history_identity.clone(),
        artifact_identity: lease.artifact_identity.clone(),
        lifecycle_identity: manifest::identity(&lease._lifecycle)?,
        session_lease_identity: manifest::identity(&lease._session)?,
        manifest,
    };
    let bytes = serde_json::to_vec(&seal)?;
    publish(&control, SEAL, &bytes)?;
    Ok(seal_ref(&bytes, binding))
}

/// A native retirement receipt contains private location/proof fields and must stay out of RPC.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalSessionUndoReceipt {
    pub undo_id: String,
    pub source_operation_id: String,
    pub session_id: String,
    pub seal_sha256: String,
    pub(crate) quarantined_file: String,
    pub(crate) tombstone_sha256: String,
}

pub fn preview_historical_session_undo(
    lease: &HistoricalUndoLease,
    binding: &HistoricalSessionSeedBinding,
    expected: &HistoricalUndoSealReceipt,
    mut check: impl FnMut(u64) -> bool,
) -> Result<()> {
    validate(lease, binding, expected, &mut check).map(|_| ())
}
fn validate(
    lease: &HistoricalUndoLease,
    binding: &HistoricalSessionSeedBinding,
    expected: &HistoricalUndoSealReceipt,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<(crate::history_store::historical_undo::SeedUndoFence, Seal)> {
    lease.verify(
        &lease.history_path,
        &lease.artifact_root,
        &binding.session_id,
    )?;
    ensure!(
        expected.operation_id == binding.operation_id && expected.session_id == binding.session_id,
        "historical_undo_wrong_seal"
    );
    let fence = crate::history_store::historical_undo::SeedUndoFence::open(&lease.history_path)?;
    let bytes = read(&fence.control_directory()?, SEAL)?.context("historical_undo_missing_seal")?;
    ensure!(
        digest(&bytes) == expected.seal_sha256,
        "historical_undo_seal_changed"
    );
    let seal: Seal = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("historical_undo_invalid_seal"))?;
    ensure!(
        seal.version == 1
            && seal.binding == *binding
            && seal.history_identity == lease.history_identity
            && seal.artifact_identity == lease.artifact_identity
            && seal.lifecycle_identity == manifest::identity(&lease._lifecycle)?
            && seal.session_lease_identity == manifest::identity(&lease._session)?,
        "historical_undo_seal_changed"
    );
    fence.assert_generation(seal.generation)?;
    ensure!(
        capture(lease, check)? == seal.manifest,
        "historical_undo_session_modified"
    );
    Ok((fence, seal))
}

pub fn undo_historical_session(
    lease: &HistoricalUndoLease,
    binding: &HistoricalSessionSeedBinding,
    expected: &HistoricalUndoSealReceipt,
    undo_id: &str,
    check: impl FnMut(u64) -> bool,
) -> Result<HistoricalSessionUndoReceipt> {
    undo_historical_session_with_commit(lease, binding, expected, undo_id, check, || Ok(()))
}

/// Persist the owner's retiring checkpoint immediately before the first native mutation.
pub fn undo_historical_session_with_commit(
    lease: &HistoricalUndoLease,
    binding: &HistoricalSessionSeedBinding,
    expected: &HistoricalUndoSealReceipt,
    undo_id: &str,
    mut check: impl FnMut(u64) -> bool,
    before_retire: impl FnOnce() -> Result<()>,
) -> Result<HistoricalSessionUndoReceipt> {
    ensure!(
        uuid::Uuid::parse_str(undo_id).is_ok_and(|id| id.to_string() == undo_id),
        "historical_undo_invalid_operation"
    );
    lease.verify(
        &lease.history_path,
        &lease.artifact_root,
        &binding.session_id,
    )?;
    {
        let mut fence =
            crate::history_store::historical_undo::SeedUndoFence::open(&lease.history_path)?;
        if let Some(receipt) = fence.reconcile_retirement(expected, undo_id)? {
            return Ok(receipt);
        }
    }
    let (mut fence, seal) = validate(lease, binding, expected, &mut check)?;
    ensure!(check(0), "historical_undo_cancelled");
    before_retire()?;
    fence.retire(binding, expected, undo_id, &seal.manifest.history)
}

pub fn read_historical_session_undo(
    lease: &HistoricalUndoLease,
    expected: &HistoricalUndoSealReceipt,
    undo_id: &str,
) -> Result<Option<HistoricalSessionUndoReceipt>> {
    lease.verify(
        &lease.history_path,
        &lease.artifact_root,
        &expected.session_id,
    )?;
    let fence = crate::history_store::historical_undo::SeedUndoFence::open(&lease.history_path)?;
    fence.observe_retirement(expected, undo_id)
}
