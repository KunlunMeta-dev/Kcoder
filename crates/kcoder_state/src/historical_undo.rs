//! Session retirement preserves archives and artifacts; native locks precede every snapshot.
use anyhow::{Context, Result, ensure};
use kcoder_config::{PrivateDirectory, PrivateFileLock};
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
use crate::history_storage_relocation::HistoryDirectoryBinding;
use manifest::{Manifest, capture};

pub const LIFECYCLE_LOCK_DIRECTORY: &str = ".thread-lifecycle-locks";
pub(crate) const SEAL: &str = "historical-undo.seal.json";
const META: u64 = 2 * 1024 * 1024;

/// Non-serializable proof: lifecycle lock, then session lease. Neither lock file is unlinked.
pub struct HistoricalUndoLease {
    history_path: PathBuf,
    artifact_root: PathBuf,
    session_id: String,
    history_identity: String,
    artifact_identity: String,
    history_was_absent: bool,
    _lifecycle: PrivateFileLock,
    _session: PrivateFileLock,
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
            crate::short_id::is_registry_short_id(session_id),
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
        let lifecycle = acquire_lock(&locks, &format!("{session_id}.lock"), create)?;
        let session = acquire_lock(&history, &format!("{session_id}.lease"), create)?;
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

fn acquire_lock(directory: &PrivateDirectory, name: &str, create: bool) -> Result<PrivateFileLock> {
    if create {
        return directory
            .try_exclusive_lock_guard(OsStr::new(name))?
            .context("historical_undo_session_busy");
    }
    let file = directory.open_read_write_file(OsStr::new(name), false)?;
    fs2::FileExt::try_lock_exclusive(&file).context("historical_undo_session_busy")?;
    Ok(PrivateFileLock::from_locked(file))
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
        || Ok(()),
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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    lifecycle_identity: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
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

fn seal_matches_owner(seal: &Seal, lease: &HistoricalUndoLease) -> Result<bool> {
    let history = PrivateDirectory::open_existing(
        lease
            .history_path
            .parent()
            .context("historical_undo_missing_parent")?,
    )?;
    let artifacts = PrivateDirectory::open_existing(&lease.artifact_root)?;
    seal_matches_directories(seal, &history, &artifacts)
}

fn seal_matches_directories(
    seal: &Seal,
    history: &PrivateDirectory,
    artifacts: &PrivateDirectory,
) -> Result<bool> {
    if seal.version == 2 {
        return Ok(seal.lifecycle_identity.is_empty()
            && seal.session_lease_identity.is_empty()
            && history.history_owner_seed()? == seal.history_identity
            && artifacts.history_owner_seed()? == seal.artifact_identity);
    }
    let lifecycle = artifacts.open_child(OsStr::new(LIFECYCLE_LOCK_DIRECTORY), false)?;
    Ok(history.history_matches_directory(&seal.history_identity)?
        && artifacts.history_matches_directory(&seal.artifact_identity)?
        && lifecycle.history_matches_file_identity(
            OsStr::new(&format!("{}.lock", seal.binding.session_id)),
            &seal.lifecycle_identity,
        )?
        && history.history_matches_file_identity(
            OsStr::new(&format!("{}.lease", seal.binding.session_id)),
            &seal.session_lease_identity,
        )?)
}

fn artifact_directory(history: &PrivateDirectory, seal: &Seal) -> Result<PrivateDirectory> {
    if history.history_matches_directory(&seal.artifact_identity)? {
        return history.duplicate_handle();
    }
    let artifacts = history.open_child(OsStr::new("client-sessions"), false)?;
    ensure!(
        artifacts.history_matches_directory(&seal.artifact_identity)?,
        "historical_undo_external_artifact_root_unsupported"
    );
    Ok(artifacts)
}

pub(crate) fn verify_relocation_target<'a>(
    source_history: &PrivateDirectory,
    target_history: &PrivateDirectory,
    source_control: &PrivateDirectory,
    target_control: &PrivateDirectory,
    known_files: impl Iterator<Item = &'a str>,
) -> Result<()> {
    let source = read(source_control, SEAL)?;
    ensure!(
        read(target_control, SEAL)? == source,
        "historical_undo_seal_changed"
    );
    let Some(bytes) = source else {
        return Ok(());
    };
    let seal: Seal = serde_json::from_slice(&bytes).context("historical_undo_invalid_seal")?;
    ensure!(
        matches!(seal.version, 1 | 2),
        "historical_undo_invalid_seal"
    );
    let source_artifacts = artifact_directory(source_history, &seal)?;
    let target_artifacts = artifact_directory(target_history, &seal)?;
    ensure!(
        seal_matches_directories(&seal, target_history, &target_artifacts)?,
        "historical_undo_seal_changed"
    );
    seal.manifest.verify_relocation_boundaries(
        source_history,
        target_history,
        &source_artifacts,
        &target_artifacts,
        &seal.binding.session_id,
    )?;
    crate::history_store::historical_undo::verify_relocation_metadata(
        source_history,
        target_history,
        source_control,
        &seal_ref(&bytes, &seal.binding),
        known_files,
    )
}

/// Validate the original seal and source witness before adding its existing
/// graph. A stale body manifest remains stale; relocation never reseals it.
pub(crate) fn collect_relocation(
    history_path: &Path,
    history: &PrivateDirectory,
    history_relative: &[String],
    graph: &mut crate::history_storage_relocation::graph::OwnerGraph,
) -> Result<()> {
    let control_name = history_path.with_extension("hctl");
    let control_name = control_name
        .file_name()
        .context("historical_undo_missing_parent")?;
    let control = history.open_child(control_name, false)?;
    let Some(bytes) = read(&control, SEAL)? else {
        return Ok(());
    };
    let seal: Seal = serde_json::from_slice(&bytes).context("historical_undo_invalid_seal")?;
    ensure!(
        matches!(seal.version, 1 | 2),
        "historical_undo_invalid_seal"
    );
    let parent = history_path
        .parent()
        .context("historical_undo_missing_parent")?;
    let (artifact_root, artifact_relative) =
        if history.history_matches_directory(&seal.artifact_identity)? {
            (parent.to_path_buf(), history_relative.to_vec())
        } else {
            let artifacts = history.open_child(OsStr::new("client-sessions"), false)?;
            ensure!(
                artifacts.history_matches_directory(&seal.artifact_identity)?,
                "historical_undo_external_artifact_root_unsupported"
            );
            let mut relative = history_relative.to_vec();
            relative.push("client-sessions".into());
            (parent.join("client-sessions"), relative)
        };
    let lease = HistoricalUndoLease::try_acquire_existing(
        history_path,
        &artifact_root,
        &seal.binding.session_id,
    )?;
    ensure!(
        seal_matches_owner(&seal, &lease)?,
        "historical_undo_seal_changed"
    );
    let (generation, receipt) = crate::historical_seed::undo_witness(history_path, &seal.binding)?;
    ensure!(
        generation == seal.generation
            && receipt.history_bytes == seal.manifest.history.bytes
            && receipt.history_sha256 == seal.manifest.history.sha256,
        "historical_undo_seed_binding_changed"
    );
    graph.add(
        history_relative,
        history,
        &[&format!("{}.lease", lease.session_id)],
    )?;
    let artifacts = PrivateDirectory::open_existing(&artifact_root)?;
    graph.add(&artifact_relative, &artifacts, &[])?;
    let locks = artifacts.open_child(OsStr::new(LIFECYCLE_LOCK_DIRECTORY), false)?;
    let mut lock_relative = artifact_relative.clone();
    lock_relative.push(LIFECYCLE_LOCK_DIRECTORY.into());
    graph.add(
        &lock_relative,
        &locks,
        &[&format!("{}.lock", lease.session_id)],
    )?;
    let mut control_relative = history_relative.to_vec();
    control_relative.push(
        control_name
            .to_str()
            .context("historical_undo_invalid_history_path")?
            .into(),
    );
    graph.add(&control_relative, &control, &[SEAL])?;
    if seal.version == 1 {
        if seal.history_identity == history.directory_identity()? {
            graph.retain_current_directory(history_relative);
        }
        if seal.artifact_identity == artifacts.directory_identity()? {
            graph.retain_current_directory(&artifact_relative);
        }
        let session_lock = format!("{}.lease", lease.session_id);
        if seal.session_lease_identity
            == manifest::identity(
                &history.open_single_link_regular_file(OsStr::new(&session_lock))?,
            )?
        {
            graph.retain_current_file(history_relative, &session_lock);
        }
        let lifecycle_lock = format!("{}.lock", lease.session_id);
        if seal.lifecycle_identity
            == manifest::identity(
                &locks.open_single_link_regular_file(OsStr::new(&lifecycle_lock))?,
            )?
        {
            graph.retain_current_file(&lock_relative, &lifecycle_lock);
        }
        seal.manifest
            .collect_relocation(&lease, history_relative, &artifact_relative, graph)?;
    }
    crate::history_store::historical_undo::collect_relocation_intents(
        history_path,
        history_relative,
        &control_relative,
        &seal_ref(&bytes, &seal.binding),
        graph,
    )?;
    Ok(())
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
            matches!(seal.version, 1 | 2)
                && seal.binding == *binding
                && seal.generation == generation
                && seal_matches_owner(&seal, lease)?,
            "historical_undo_seal_changed"
        );
        return Ok(seal_ref(&bytes, binding));
    }
    ensure!(
        lease.history_was_absent,
        "historical_undo_legacy_unsealed_session"
    );
    let mut manifest = capture(lease, &mut check)?;
    ensure!(
        manifest.history.bytes == receipt.history_bytes
            && manifest.history.sha256 == receipt.history_sha256,
        "historical_undo_history_changed"
    );
    manifest.retain_content_only();
    let history = PrivateDirectory::open_existing(
        lease
            .history_path
            .parent()
            .context("historical_undo_missing_parent")?,
    )?;
    let artifacts = PrivateDirectory::open_existing(&lease.artifact_root)?;
    let seal = Seal {
        version: 2,
        generation,
        binding: binding.clone(),
        history_identity: history.history_owner_seed()?,
        artifact_identity: artifacts.history_owner_seed()?,
        lifecycle_identity: String::new(),
        session_lease_identity: String::new(),
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
        matches!(seal.version, 1 | 2)
            && seal.binding == *binding
            && seal_matches_owner(&seal, lease)?,
        "historical_undo_seal_changed"
    );
    fence.assert_generation(seal.generation)?;
    ensure!(
        seal.manifest
            .matches(lease, &capture(lease, check)?, seal.version == 1)?,
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
