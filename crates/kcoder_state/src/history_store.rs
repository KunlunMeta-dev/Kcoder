use crate::history_index::journal::{JournalFence, JournalMutation};
pub(crate) mod historical_undo;
use anyhow::{Context, Result};
use fs2::FileExt;
use kcoder_config::PrivateDirectory;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MUTATION_LOCK: &str = ".kcoder-history.lock";
const SOURCE_RECORD_FILE: &str = "source.json";
mod append;
mod commit;
mod control_publication;
mod goal_observation;
mod initialization;
mod live_append_receipt;
mod live_append_source;
#[cfg(target_os = "linux")]
mod live_lineage;
#[cfg(not(target_os = "linux"))]
#[path = "history_store/live_lineage_unsupported.rs"]
mod live_lineage;
mod metadata_lineage;
pub(crate) use goal_observation::try_capture_goal_metadata;
pub(crate) use live_append_receipt::LiveAppendReceipt;
pub use live_lineage::{NativeHistoryLineageReservation, NativeHistoryLineageStatus};
pub use metadata_lineage::{
    NativeGoalMetadataLineage, NativeGoalMetadataLineageStatus, NativeGoalMetadataObserver,
    NativeGoalMetadataSettlement,
};
#[cfg(test)]
mod live_append_tests;
use commit::{CommitState, Mutation, commit_mutation};
mod presence;
pub(crate) use presence::observe_source_presence;
pub use presence::{
    BoundDeletedHistoryPresenceReference, HistorySourceObservation, HistorySourceObservationBusy,
    HistorySourcePresenceUnsupported, HistorySourceUnknown,
};

fn source_directory_name(name: &OsStr) -> Result<OsString> {
    let path = Path::new(name);
    anyhow::ensure!(
        crate::session_persistence::is_primary_session_history_path(path),
        "history source must use a primary .jsonl path, not an alias or diagnostic file"
    );
    Ok(path.with_extension("hctl").into_os_string())
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceRecord {
    schema_version: u32,
    incarnation: uuid::Uuid,
    deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    commit: Option<CommitState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deletion: Option<DeletionBinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeletionBinding {
    workspace: PathBuf,
    workspace_identity: kcoder_types::PrivateFileIdentityV1,
    history_parent: kcoder_types::PrivateFileIdentityV1,
    source_identity: Option<kcoder_types::PrivateFileIdentityV1>,
    source_bytes: Option<(u64, String)>,
    source_incarnation: uuid::Uuid,
}

/// A read-only capability minted from the canonical, durable deleted source.
/// Private fields prevent RPC input from manufacturing deletion authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeletedHistoryProof {
    history_path: PathBuf,
    thread_id: String,
    binding: DeletionBinding,
    record_sha256: String,
}

impl DeletedHistoryProof {
    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn sha256(&self) -> &str {
        &self.record_sha256
    }

    pub fn verify(&self, history_path: &Path, workspace: &Path) -> Result<()> {
        anyhow::ensure!(
            read_deletion_proof(history_path, workspace)?.as_ref() == Some(self),
            "deleted history proof changed"
        );
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn workspace_deletion_identity(path: &Path) -> Result<kcoder_types::PrivateFileIdentityV1> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    Ok(kcoder_types::PrivateFileIdentityV1 {
        version: 1,
        kind: kcoder_types::PrivateFileKind::Directory,
        native: kcoder_types::PrivateNativeFileIdentity::Linux {
            device: metadata.dev(),
            inode: metadata.ino(),
        },
    })
}

#[cfg(not(target_os = "linux"))]
fn workspace_deletion_identity(_: &Path) -> Result<kcoder_types::PrivateFileIdentityV1> {
    anyhow::bail!("durable history deletion proof unavailable on this platform")
}

#[cfg(target_os = "linux")]
fn history_parent_identity(
    directory: &PrivateDirectory,
) -> Result<kcoder_types::PrivateFileIdentityV1> {
    use std::os::unix::fs::MetadataExt;
    let metadata = directory.directory_metadata()?;
    anyhow::ensure!(metadata.is_dir(), "history parent is not a directory");
    // Ordinary State directories retain their existing mode. Retention's
    // private-directory policy does not apply to this source identity witness.
    Ok(kcoder_types::PrivateFileIdentityV1 {
        version: 1,
        kind: kcoder_types::PrivateFileKind::Directory,
        native: kcoder_types::PrivateNativeFileIdentity::Linux {
            device: metadata.dev(),
            inode: metadata.ino(),
        },
    })
}

#[cfg(not(target_os = "linux"))]
fn history_parent_identity(_: &PrivateDirectory) -> Result<kcoder_types::PrivateFileIdentityV1> {
    anyhow::bail!("history directory identity unavailable on this platform")
}

pub(super) fn read_deletion_proof(
    path: &Path,
    workspace: &Path,
) -> Result<Option<DeletedHistoryProof>> {
    use sha2::{Digest, Sha256};
    let (directory, name) = open_parent_with_create(path, false)?;
    let Some(record) = read_source_record(&directory, &name)? else {
        return Ok(None);
    };
    if !record.deleted {
        return Ok(None);
    }
    let binding = record
        .deletion
        .clone()
        .context("legacy deleted source has no bound proof")?;
    let workspace = dunce::canonicalize(workspace)?;
    anyhow::ensure!(
        binding.workspace == workspace
            && binding.workspace_identity == workspace_deletion_identity(&workspace)?
            && binding.history_parent == history_parent_identity(&directory)?
            && binding.source_incarnation == record.incarnation
            && record.schema_version == 1
            && record.commit.is_none(),
        "deleted source binding differs"
    );
    verify_deleted_source_presence(&directory, &name, &binding)?;
    let sources = directory.open_child(&source_directory_name(&name)?, false)?;
    let mut bytes = Vec::new();
    sources
        .open_regular_file(OsStr::new(SOURCE_RECORD_FILE))?
        .take(4097)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= 4096, "deleted source proof is oversized");
    // Compare the actual bytes, including their complete source binding.
    let reread: SourceRecord = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(reread == record, "deleted source changed while reading");
    Ok(Some(DeletedHistoryProof {
        history_path: dunce::canonicalize(path.parent().context("history parent missing")?)?
            .join(&name),
        thread_id: crate::session_persistence::session_id_from_history_path(path)?,
        binding,
        record_sha256: format!("{:x}", Sha256::digest(&bytes)),
    }))
}

impl SourceRecord {
    fn body_generation(&self) -> uuid::Uuid {
        // A v1 source has one stable baseline until an actual body replacement.
        self.commit
            .as_ref()
            .map_or(self.incarnation, |commit| commit.generation)
    }
}

/// Exact control-state comparison, not a size/mtime or hash-only identity hint.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(super) struct SourceStamp(Option<SourceRecord>);

impl SourceStamp {
    /// Body identity excludes metadata-only revision changes, but retains every
    /// actual replacement and committed append boundary.
    pub(super) fn committed_body_key(&self) -> Result<(uuid::Uuid, uuid::Uuid, u64)> {
        let source = self.0.as_ref().context("history source is unobserved")?;
        anyhow::ensure!(!source.deleted, "history source was deleted");
        Ok((
            source.incarnation,
            source.body_generation(),
            self.known_committed_bytes()
                .context("history commit is unknown")?,
        ))
    }

    /// Private derived-cache proof; callers cannot construct an authoritative source stamp.
    pub(super) fn resume_checkpoint_proof(&self) -> Result<Vec<u8>> {
        anyhow::ensure!(
            self.known_committed_bytes().is_some(),
            "unknown checkpoint boundary"
        );
        Ok(serde_json::to_vec(&self.0)?)
    }

    pub(super) fn extends_resume_checkpoint(&self, proof: &[u8], offset: u64) -> bool {
        if proof.len() > 4096 {
            return false;
        }
        let Ok(Some(record)) = serde_json::from_slice::<Option<SourceRecord>>(proof) else {
            return false;
        };
        if record.schema_version != 2
            || record.deleted
            || record
                .commit
                .as_ref()
                .is_none_or(|commit| commit.validate().is_err())
        {
            return false;
        }
        let previous = Self(Some(record));
        previous.known_committed_bytes() == Some(offset) && self.extends_committed_body(&previous)
    }

    /// Permit incremental consumption only within one monotonically advancing committed body.
    pub(super) fn extends_committed_body(&self, previous: &Self) -> bool {
        let (Some(current), Some(previous)) = (&self.0, &previous.0) else {
            return false;
        };
        let (Some(commit), Some(old)) = (&current.commit, &previous.commit) else {
            return false;
        };
        !current.deleted
            && !previous.deleted
            && current.incarnation == previous.incarnation
            && commit.generation == old.generation
            && commit.pending.is_none()
            && old.pending.is_none()
            && commit.revision >= old.revision
            && matches!((commit.committed_bytes, old.committed_bytes), (Some(end), Some(start)) if end >= start)
    }

    /// Observed control-state boundary only; this does not certify any separately read bytes.
    pub(super) fn known_committed_bytes(&self) -> Option<u64> {
        let commit = self.0.as_ref()?.commit.as_ref()?;
        if commit.pending.is_some() {
            return None;
        }
        commit.committed_bytes
    }

    /// A prepared resume commits metadata without replacing or appending its
    /// model body. Preserve the original incarnation, generation and watermark;
    /// revision changes alone are not evidence of a different committed body.
    pub(super) fn same_committed_body(&self, previous: &Self) -> bool {
        self.extends_committed_body(previous)
            && self.known_committed_bytes().is_some()
            && self.known_committed_bytes() == previous.known_committed_bytes()
    }
}

/// A writer's fixed source identity; clones share the first-write initialization decision.
#[derive(Clone, Debug)]
pub(super) struct HistorySource {
    path: PathBuf,
    binding: Arc<Mutex<SourceBinding>>,
    private_storage: Arc<std::sync::OnceLock<Arc<kcoder_config::PrivateTempDir>>>,
}

/// A non-owning process-local reference to the exact writer binding.
#[derive(Clone)]
pub(super) struct HistorySourceIdentity {
    path: PathBuf,
    binding: std::sync::Weak<Mutex<SourceBinding>>,
}

impl HistorySourceIdentity {
    pub(super) fn matches(&self, current: &HistorySource) -> bool {
        self.path == current.path
            && self.binding.strong_count() > 0
            && std::sync::Weak::ptr_eq(&self.binding, &Arc::downgrade(&current.binding))
    }

    #[cfg(test)]
    pub(super) fn is_alive(&self) -> bool {
        self.binding.strong_count() > 0
    }
}

pub(super) enum TryHistoryGeneration {
    Busy,
    Available(Option<uuid::Uuid>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IdentifiedAppendOutcome {
    Appended,
    AlreadyPresent,
}

#[derive(Debug)]
struct SourceBinding {
    incarnation: uuid::Uuid,
    generation: Option<uuid::Uuid>,
    initialized: bool,
    metadata_lineage: Option<Arc<metadata_lineage::Slot>>,
    #[cfg(target_os = "linux")]
    lineage: Option<std::sync::Weak<live_lineage::LineageSlot>>,
}

impl SourceBinding {
    fn verify(&self, source: Option<&SourceRecord>) -> Result<()> {
        if let Some(source) = source {
            if source.deleted {
                return Err(DeletedSource.into());
            }
            anyhow::ensure!(
                self.initialized && source.incarnation == self.incarnation,
                "history source incarnation changed; bind a new writer explicitly"
            );
            anyhow::ensure!(
                Some(source.body_generation()) == self.generation,
                "history body generation changed; reload before writing"
            );
        } else {
            anyhow::ensure!(
                !self.initialized,
                "bound history source record is missing; explicit recovery is required"
            );
        }
        Ok(())
    }

    // An error may follow a visible pending/ready control write. Only adopt while owning its lock.
    fn refresh_after_failed_own_write(&mut self, directory: &PrivateDirectory, name: &OsStr) {
        if let Ok(Some(record)) = read_source_record(directory, name)
            && !record.deleted
            && record.incarnation == self.incarnation
        {
            self.generation = Some(record.body_generation());
        }
    }
}

impl HistorySource {
    /// Observe an existing read binding without waiting for a writer or creating
    /// source resources. The reader separately bounds and validates its bytes.
    pub(super) fn check_read_binding(&self) -> Result<()> {
        let binding = self
            .binding
            .try_lock()
            .map_err(|_| anyhow::anyhow!("history source binding is busy or unavailable"))?;
        let (directory, name) = open_parent_with_create(&self.path, false)?;
        let observed = read_source_record(&directory, &name)?;
        binding.verify(observed.as_ref())?;
        if let Some(commit) = observed.and_then(|record| record.commit) {
            commit.check_ready()?;
        }
        Ok(())
    }

    pub(super) fn identity(&self) -> HistorySourceIdentity {
        HistorySourceIdentity {
            path: self.path.clone(),
            binding: Arc::downgrade(&self.binding),
        }
    }

    /// Compare the live writer binding, not persisted IDs or authorization.
    pub(super) fn shares_binding(&self, other: &Self) -> bool {
        self.path == other.path && Arc::ptr_eq(&self.binding, &other.binding)
    }

    /// A non-waiting in-process observation for an already-bound writer. It
    /// is not an on-disk source witness or an authorization grant.
    pub(super) fn try_bound_generation(&self) -> Result<TryHistoryGeneration> {
        match self.binding.try_lock() {
            Ok(binding) => Ok(TryHistoryGeneration::Available(binding.generation)),
            Err(std::sync::TryLockError::WouldBlock) => Ok(TryHistoryGeneration::Busy),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                anyhow::bail!("history source binding is unavailable")
            }
        }
    }

    /// Observe the source without creating its parent, lock, control record, or history.
    pub(super) fn bind(path: &Path) -> Result<Self> {
        source_directory_name(
            path.file_name()
                .context("history source has no file name")?,
        )?;
        let path = std::path::absolute(path).context("failed to resolve history source path")?;
        let source = match open_parent_with_create(&path, false) {
            Ok((directory, name)) => read_source_record(&directory, &name)?,
            Err(error) if missing(&error) => None,
            Err(error) => {
                let message = format!(
                    "failed to bind history source {}: {error:#}",
                    path.display()
                );
                return Err(error.context(message));
            }
        };
        if source.as_ref().is_some_and(|source| source.deleted) {
            return Err(DeletedSource.into());
        }
        let binding = SourceBinding {
            incarnation: source
                .as_ref()
                .map_or_else(uuid::Uuid::new_v4, |source| source.incarnation),
            initialized: source.is_some(),
            metadata_lineage: None,
            generation: source.as_ref().map(SourceRecord::body_generation),
            #[cfg(target_os = "linux")]
            lineage: None,
        };
        Ok(Self {
            path,
            binding: Arc::new(Mutex::new(binding)),
            private_storage: Default::default(),
        })
    }

    /// Keep owned temporary storage alive until queued writers also release it.
    pub(super) fn retain_private_storage(&self, storage: Arc<kcoder_config::PrivateTempDir>) {
        self.private_storage.get_or_init(|| storage);
    }

    pub(super) fn private_storage(&self) -> Option<Arc<kcoder_config::PrivateTempDir>> {
        self.private_storage.get().cloned()
    }

    /// Validate an idle writer without materializing a new source or mutation lock.
    pub(super) fn check(&self) -> Result<()> {
        let binding = self
            .binding
            .lock()
            .map_err(|_| anyhow::anyhow!("history source binding lock is poisoned"))?;
        let (directory, name) = match open_parent_with_create(&self.path, false) {
            Ok(parent) => parent,
            Err(error) if missing(&error) && !binding.initialized => return Ok(()),
            Err(error) => return Err(error),
        };
        let lock = existing_file(&directory, OsStr::new(MUTATION_LOCK))?;
        if let Some(lock) = lock.as_ref() {
            FileExt::lock_exclusive(lock).context("failed to lock history source check")?;
        }
        let observed = read_source_record(&directory, &name)?;
        binding.verify(observed.as_ref())?;
        if let Some(commit) = observed.and_then(|record| record.commit) {
            commit.check_ready()?;
        }
        Ok(())
    }

    /// Materialize an empty accepted session using the same source/commit fence as appends.
    /// Existing history remains untouched and no transcript entry is fabricated.
    pub(super) fn materialize(&self) -> Result<()> {
        self.mutate_when(None, false, || Ok(Mutation::Materialize))
    }

    pub(super) fn append(&self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return self.check();
        }
        validate_append(bytes)?;
        self.mutate_when(None, false, || Ok(Mutation::Append(bytes)))
    }

    pub(super) fn replace(&self, bytes: &[u8]) -> Result<()> {
        validate_replacement(bytes)?;
        self.mutate_when(None, true, || Ok(Mutation::Replace(bytes)))
    }

    pub(super) fn initialize(&self, bytes: &[u8], generation: uuid::Uuid) -> Result<()> {
        initialization::initialize(self, bytes, generation)
    }
    pub(super) fn reconcile_initialization(
        &self,
        generation: uuid::Uuid,
        length: u64,
        sha256: &str,
    ) -> Result<()> {
        initialization::reconcile(self, generation, length, sha256)
    }
    pub(super) fn check_generation(&self, expected: uuid::Uuid) -> Result<()> {
        self.check()?;
        anyhow::ensure!(
            self.binding
                .lock()
                .map_err(|_| anyhow::anyhow!("history source binding lock is poisoned"))?
                .generation
                == Some(expected),
            "historical_seed_source_generation_changed"
        );
        Ok(())
    }

    /// Commit session metadata in the same source transaction as transcript mutations.
    /// The callback must not acquire AppState locks or reenter this source.
    pub(super) fn write_metadata(
        &self,
        path: &Path,
        prepare: impl FnOnce() -> Result<Vec<u8>>,
    ) -> Result<()> {
        self.mutate_when(None, false, || {
            Ok(Mutation::Metadata {
                path,
                bytes: prepare()?,
            })
        })
    }

    /// Check the prepared identity under the mutation lock, before initializing a legacy source.
    pub(super) fn write_prepared_metadata(
        &self,
        expected: &SourceStamp,
        path: &Path,
        prepare: impl FnOnce() -> Result<Vec<u8>>,
    ) -> Result<()> {
        self.mutate_when(Some(expected), false, || {
            Ok(Mutation::Metadata {
                path,
                bytes: prepare()?,
            })
        })
    }

    fn mutate_when<'a>(
        &self,
        expected: Option<&SourceStamp>,
        recover: bool,
        prepare: impl FnOnce() -> Result<Mutation<'a>>,
    ) -> Result<()> {
        self.mutate_when_optional(expected, recover, || prepare().map(Some))
    }

    fn mutate_when_optional<'a>(
        &self,
        expected: Option<&SourceStamp>,
        recover: bool,
        prepare: impl FnOnce() -> Result<Option<Mutation<'a>>>,
    ) -> Result<()> {
        self.mutate_when_optional_with_source(expected, recover, |_, _| prepare())
    }

    fn mutate_when_optional_with_source<'a>(
        &self,
        expected: Option<&SourceStamp>,
        recover: bool,
        prepare: impl FnOnce(&PrivateDirectory, &OsStr) -> Result<Option<Mutation<'a>>>,
    ) -> Result<()> {
        self.mutate_when_optional_with_receipt(expected, recover, false, prepare)
            .map(|_| ())
    }
}

// Authority already committed: never turn derived-journal finalization into a retryable write.
fn finish_source_journal(journal: JournalMutation<'_>) {
    if let Err(error) = journal.finish() {
        tracing::warn!(%error, "history authority committed but journal finalization failed; use authoritative reads");
    }
}

#[derive(Debug)]
struct DeletedSource;

impl std::fmt::Display for DeletedSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("history source was deleted; start a new session")
    }
}

impl std::error::Error for DeletedSource {}

pub(super) fn is_deleted_source(error: &anyhow::Error) -> bool {
    error.downcast_ref::<DeletedSource>().is_some()
}

pub(super) fn validate_live_source(path: &Path) -> Result<()> {
    source_incarnation(path).map(|_| ())
}

pub(super) fn source_incarnation(path: &Path) -> Result<Option<uuid::Uuid>> {
    Ok(source_stamp(path)?.0.map(|source| source.incarnation))
}

pub(super) fn source_stamp(path: &Path) -> Result<SourceStamp> {
    let name = path
        .file_name()
        .context("history source has no file name")?;
    let control = path.with_file_name(source_directory_name(name)?);
    match fs::symlink_metadata(&control) {
        // An unrelated owner's control directory must not gate a readable legacy source.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(SourceStamp(None)),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let (directory, name) = open_parent_with_create(path, false)?;
    let source = read_source_record(&directory, &name)?;
    if source.as_ref().is_some_and(|source| source.deleted) {
        return Err(DeletedSource.into());
    }
    Ok(SourceStamp(source))
}

/// Read only control state for bounded observations; never verify pending body or metadata bytes.
pub(super) fn observation_source_stamp(path: &Path) -> Result<SourceStamp> {
    let stamp = source_stamp(path)?;
    anyhow::ensure!(
        stamp
            .0
            .as_ref()
            .and_then(|record| record.commit.as_ref())
            .is_none_or(|commit| commit.pending.is_none()),
        "history source has a pending commit; retry observation after explicit recovery"
    );
    Ok(stamp)
}

/// Application-managed freshness only; external edits require an explicit full projection read.
/// This reads bounded control state without a lifecycle/mutation lock or body verification.
pub(super) fn committed_source_stamp(path: &Path) -> Result<SourceStamp> {
    let stamp = observation_source_stamp(path)?;
    anyhow::ensure!(
        stamp.known_committed_bytes().is_some(),
        "history source has no known committed boundary; use legacy reads or explicit recovery"
    );
    Ok(stamp)
}

/// Pending can stay unchanged while authority is being written. Establish readiness before replay.
pub(super) fn prepare_source_stamp(path: &Path) -> Result<SourceStamp> {
    let stamp = source_stamp(path)?;
    if stamp
        .0
        .as_ref()
        .and_then(|record| record.commit.as_ref())
        .is_none_or(|commit| commit.pending.is_none())
    {
        return Ok(stamp);
    }
    let (directory, name) = open_parent_with_create(path, false)?;
    let lock = existing_file(&directory, OsStr::new(MUTATION_LOCK))?
        .context("pending history commit is missing its mutation lock")?;
    FileExt::try_lock_exclusive(&lock)
        .context("history commit is in progress; retry session preparation")?;
    let observed = read_source_record(&directory, &name)?;
    if let Some(record) = &observed {
        if record.deleted {
            return Err(DeletedSource.into());
        }
        commit::verify_completed_pending(path, &directory, &name, record)?;
    } else {
        anyhow::bail!("history source disappeared during preparation");
    }
    Ok(SourceStamp(observed))
}

#[cfg(test)]
fn check_live_source(directory: &PrivateDirectory, name: &OsStr) -> Result<()> {
    if read_source_record(directory, name)?.is_some_and(|source| source.deleted) {
        return Err(DeletedSource.into());
    }
    Ok(())
}

fn read_source_record(directory: &PrivateDirectory, name: &OsStr) -> Result<Option<SourceRecord>> {
    let sources = match directory.open_child(&source_directory_name(name)?, false) {
        Ok(sources) => sources,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let file = existing_file(&sources, OsStr::new(SOURCE_RECORD_FILE))?
        .context("history source control directory exists but its record is missing; explicit recovery is required")?;
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= 4096, "history source record is too large");
    let source: SourceRecord = serde_json::from_slice(&bytes)
        .context("history source record is corrupt; explicit recovery is required")?;
    anyhow::ensure!(
        matches!(
            (source.schema_version, source.commit.is_some()),
            (1, false) | (2, true)
        ),
        "unsupported history source version"
    );
    if let Some(commit) = &source.commit {
        commit.validate()?;
    }
    Ok(Some(source))
}

pub(super) fn has_source_record(path: &Path) -> Result<bool> {
    let (directory, name) = match open_parent_with_create(path, false) {
        Ok(parent) => parent,
        Err(error) if missing(&error) => return Ok(false),
        Err(error) => return Err(error),
    };
    Ok(read_source_record(&directory, &name)?.is_some())
}

pub(super) fn delete_records(path: &Path) -> Result<bool> {
    delete_records_bound(path, None)
}

pub(super) fn mark_deleted_with_proof(
    path: &Path,
    workspace: &Path,
) -> Result<DeletedHistoryProof> {
    delete_records_bound(path, Some(workspace))?;
    read_deletion_proof(path, workspace)?.context("deleted history proof missing after commit")
}

fn verify_deletion_workspace(path: &Path, workspace: &Path) -> Result<PathBuf> {
    let canonical = dunce::canonicalize(workspace)?;
    if read_deletion_proof(path, &canonical)?.is_some() {
        return Ok(canonical);
    }
    let (directory, name) = open_parent_with_create(path, false)?;
    anyhow::ensure!(
        existing_file(&directory, &name)?.is_some()
            || read_source_record(&directory, &name)?.is_some(),
        "history source authority missing"
    );
    let persisted = crate::history::history_persisted_base_cwd(path)?
        .context("history has no canonical workspace for deletion")?;
    anyhow::ensure!(
        dunce::canonicalize(persisted)? == canonical,
        "history belongs to another workspace"
    );
    workspace_deletion_identity(&canonical)?;
    Ok(canonical)
}

#[cfg(target_os = "linux")]
fn history_file_identity(file: &File) -> Result<kcoder_types::PrivateFileIdentityV1> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "history source is not a regular file");
    Ok(kcoder_types::PrivateFileIdentityV1 {
        version: 1,
        kind: kcoder_types::PrivateFileKind::RegularFile,
        native: kcoder_types::PrivateNativeFileIdentity::Linux {
            device: metadata.dev(),
            inode: metadata.ino(),
        },
    })
}

#[cfg(not(target_os = "linux"))]
fn history_file_identity(_: &File) -> Result<kcoder_types::PrivateFileIdentityV1> {
    anyhow::bail!("history file identity unavailable on this platform")
}

fn current_history_source(
    directory: &PrivateDirectory,
    name: &OsStr,
) -> Result<Option<(kcoder_types::PrivateFileIdentityV1, (u64, String))>> {
    use sha2::{Digest, Sha256};
    let Some(mut file) = existing_file(directory, name)? else {
        return Ok(None);
    };
    // History files keep State's existing permissions. Retained payload-only
    // 0600 policy is not imposed on an ordinary transcript by a proof read.
    let identity = history_file_identity(&file)?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .context("history size overflow")?;
        hash.update(&chunk[..count]);
    }
    let current =
        existing_file(directory, name)?.context("history source disappeared while reading")?;
    anyhow::ensure!(
        history_file_identity(&current)? == identity,
        "history source changed while reading"
    );
    Ok(Some((identity, (total, format!("{:x}", hash.finalize())))))
}

fn verify_deleted_source_presence(
    directory: &PrivateDirectory,
    name: &OsStr,
    binding: &DeletionBinding,
) -> Result<()> {
    anyhow::ensure!(
        binding.source_identity.is_some() == binding.source_bytes.is_some(),
        "incomplete deleted history source binding"
    );
    if let Some((identity, bytes)) = current_history_source(directory, name)? {
        anyhow::ensure!(
            binding.source_identity.as_ref() == Some(&identity)
                && binding.source_bytes.as_ref() == Some(&bytes),
            "deleted history path now contains a foreign source"
        );
    }
    Ok(())
}

fn delete_records_bound(path: &Path, workspace: Option<&Path>) -> Result<bool> {
    // Reject foreign requests before creating a lock, source directory or journal.
    let workspace = workspace
        .map(|workspace| verify_deletion_workspace(path, workspace))
        .transpose()?;
    let (directory, name) = open_parent(path)?;
    let lock = open_mutation_lock(&directory)?;
    FileExt::lock_exclusive(&lock).context("failed to lock history deletion")?;
    // Repeat the full workspace check under the mutation lock.
    if let Some(workspace) = &workspace {
        verify_deletion_workspace(path, workspace)?;
    }
    let existed = existing_file(&directory, &name)?.is_some();
    let previous = read_source_record(&directory, &name)?;
    if let Some(prior) = previous.as_ref().filter(|record| record.deleted) {
        if let Some(binding) = &prior.deletion {
            verify_deleted_source_presence(&directory, &name, binding)?;
        } else {
            anyhow::ensure!(
                !existed,
                "legacy deleted history path now contains a source"
            );
        }
    }
    let mut journal_fence = JournalFence::from_locked_history(
        path.parent().context("history source has no parent")?,
        lock,
    )?;
    let journal = journal_fence.begin_history_source(path)?;
    if !previous.as_ref().is_some_and(|record| record.deleted) {
        let incarnation = previous
            .as_ref()
            .map_or_else(uuid::Uuid::new_v4, |record| record.incarnation);
        let deletion = workspace
            .map(|workspace| -> Result<_> {
                anyhow::ensure!(
                    existed || previous.is_some(),
                    "history source authority missing"
                );
                let source = current_history_source(&directory, &name)?;
                let source_identity = source.as_ref().map(|(identity, _)| identity.clone());
                let source_bytes = source.map(|(_, bytes)| bytes);
                Ok(DeletionBinding {
                    workspace_identity: workspace_deletion_identity(&workspace)?,
                    workspace,
                    history_parent: history_parent_identity(&directory)?,
                    source_identity,
                    source_bytes,
                    source_incarnation: incarnation,
                })
            })
            .transpose()?;
        let record = SourceRecord {
            schema_version: 1,
            incarnation,
            deleted: true,
            commit: None,
            deletion,
        };
        if previous.is_none() {
            control_publication::publish_initial_record(&directory, &name, &record)?;
        } else {
            commit::write_record(&directory, &name, &record)?;
        }
    }
    // Repeated deletion never changes the durable source incarnation or proof.
    if existed {
        directory
            .remove_regular_file(&name)
            .context("history deletion was committed, but file cleanup failed; retry cleanup")?;
    }
    finish_source_journal(journal);
    Ok(existed)
}

#[cfg(test)]
pub(super) fn append_records(path: &Path, bytes: &[u8]) -> Result<()> {
    append_records_with(path, bytes, |directory, name, bytes| {
        directory.append(name, bytes)
    })
}

#[cfg(test)]
fn append_records_with(
    path: &Path,
    bytes: &[u8],
    append: impl FnOnce(&PrivateDirectory, &OsStr, &[u8]) -> Result<()>,
) -> Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }
    validate_append(bytes)?;
    let (directory, name) = open_parent(path)?;
    let lock = open_mutation_lock(&directory)?;
    FileExt::lock_exclusive(&lock).context("failed to lock history mutation")?;
    check_live_source(&directory, &name)?;
    append_locked(&directory, &name, bytes, append)
}

fn validate_append(bytes: &[u8]) -> Result<()> {
    anyhow::ensure!(
        bytes.ends_with(b"\n"),
        "history append requires complete newline-terminated records"
    );
    Ok(())
}

fn append_locked(
    directory: &PrivateDirectory,
    name: &OsStr,
    bytes: &[u8],
    append: impl FnOnce(&PrivateDirectory, &OsStr, &[u8]) -> Result<()>,
) -> Result<()> {
    let before = existing_file(directory, name)?;
    let length = before
        .as_ref()
        .map(|file| file.metadata().map(|metadata| metadata.len()))
        .transpose()?
        .unwrap_or(0);
    if let Some(mut file) = before
        && length > 0
    {
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            return Err(UncertainMutation(anyhow::anyhow!(
                "history has an incomplete trailing record; explicit recovery is required"
            ))
            .into());
        }
    }
    match append(directory, name, bytes) {
        Ok(()) => Ok(()),
        Err(error) => {
            let unchanged_length = existing_file(directory, name)
                .and_then(|file| {
                    file.map(|file| file.metadata().map(|metadata| metadata.len()))
                        .transpose()
                        .map_err(Into::into)
                })
                .is_ok_and(|after| after.unwrap_or(0) == length);
            if unchanged_length {
                Err(error)
            } else {
                Err(UncertainMutation(error).into())
            }
        }
    }
}

#[cfg(test)]
pub(super) fn replace_records(path: &Path, bytes: &[u8]) -> Result<()> {
    replace_records_with(path, bytes, |directory, name, bytes| {
        directory.atomic_replace(name, bytes)
    })
}

#[cfg(test)]
fn replace_records_with(
    path: &Path,
    bytes: &[u8],
    replace: impl FnOnce(&PrivateDirectory, &OsStr, &[u8]) -> Result<()>,
) -> Result<()> {
    validate_replacement(bytes)?;
    let (directory, name) = open_parent(path)?;
    let lock = open_mutation_lock(&directory)?;
    FileExt::lock_exclusive(&lock).context("failed to lock history mutation")?;
    check_live_source(&directory, &name)?;
    replace_locked(&directory, &name, bytes, replace)
}

fn validate_replacement(bytes: &[u8]) -> Result<()> {
    anyhow::ensure!(
        bytes.is_empty() || bytes.ends_with(b"\n"),
        "history snapshot requires complete newline-terminated records"
    );
    Ok(())
}

fn replace_locked(
    directory: &PrivateDirectory,
    name: &OsStr,
    bytes: &[u8],
    replace: impl FnOnce(&PrivateDirectory, &OsStr, &[u8]) -> Result<()>,
) -> Result<()> {
    // Reject a non-regular leaf before replacement; all operations stay relative to one parent handle.
    drop(existing_file(directory, name)?);
    replace(directory, name, bytes).map_err(|error| UncertainMutation(error).into())
}

#[derive(Debug)]
struct UncertainMutation(anyhow::Error);

impl std::fmt::Display for UncertainMutation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "history mutation may be partially committed: {:#}",
            self.0
        )
    }
}

impl std::error::Error for UncertainMutation {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref())
    }
}

pub(super) fn is_uncertain_mutation(error: &anyhow::Error) -> bool {
    error.downcast_ref::<UncertainMutation>().is_some()
}

pub(super) fn committed_evidence_invalid(error: anyhow::Error) -> anyhow::Error {
    UncertainMutation(error.context("history append committed but row evidence is unavailable"))
        .into()
}

pub(super) fn incomplete_snapshot(error: anyhow::Error) -> anyhow::Error {
    UncertainMutation(error.context("history snapshot committed but session state save failed"))
        .into()
}

fn existing_file(directory: &PrivateDirectory, name: &OsStr) -> Result<Option<File>> {
    match directory.open_regular_file(name) {
        Ok(file) => Ok(Some(file)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn open_parent(path: &Path) -> Result<(PrivateDirectory, OsString)> {
    open_parent_with_create(path, true)
}

fn open_parent_with_create(path: &Path, create: bool) -> Result<(PrivateDirectory, OsString)> {
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if create {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create history directory {}", parent.display()))?;
    }
    let canonical = dunce::canonicalize(parent)?;
    let directory = PrivateDirectory::open_existing(&canonical)?;
    let name = path
        .file_name()
        .context("history path has no file name")?
        .to_os_string();
    anyhow::ensure!(
        !name.to_string_lossy().eq_ignore_ascii_case(MUTATION_LOCK),
        "history path uses the reserved mutation lock name"
    );
    Ok((directory, name))
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn open_mutation_lock(directory: &PrivateDirectory) -> Result<File> {
    let name = OsStr::new(MUTATION_LOCK);
    match directory.open_regular_file(name) {
        Ok(file) => Ok(file),
        Err(error) if missing(&error) => {
            directory.append(name, b"")?;
            directory.open_regular_file(name)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests;
