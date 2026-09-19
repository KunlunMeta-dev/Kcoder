use crate::history_index::journal::{JournalFence, JournalMutation};
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
mod commit;
use commit::{CommitState, Mutation, commit_mutation};

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
}

/// A writer's fixed source identity; clones share the first-write initialization decision.
#[derive(Clone, Debug)]
pub(super) struct HistorySource {
    path: PathBuf,
    binding: Arc<Mutex<SourceBinding>>,
}

#[derive(Debug)]
struct SourceBinding {
    incarnation: uuid::Uuid,
    generation: Option<uuid::Uuid>,
    initialized: bool,
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
            Err(error) => return Err(error),
        };
        if source.as_ref().is_some_and(|source| source.deleted) {
            return Err(DeletedSource.into());
        }
        let binding = SourceBinding {
            incarnation: source
                .as_ref()
                .map_or_else(uuid::Uuid::new_v4, |source| source.incarnation),
            initialized: source.is_some(),
            generation: source.as_ref().map(SourceRecord::body_generation),
        };
        Ok(Self {
            path,
            binding: Arc::new(Mutex::new(binding)),
        })
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
        let mut binding = self
            .binding
            .lock()
            .map_err(|_| anyhow::anyhow!("history source binding lock is poisoned"))?;
        let (directory, name) =
            open_parent_with_create(&self.path, !binding.initialized && expected.is_none())?;
        let lock = open_mutation_lock(&directory)?;
        FileExt::lock_exclusive(&lock).context("failed to lock history mutation")?;
        let mut journal_fence = JournalFence::from_locked_history(
            self.path.parent().context("history source has no parent")?,
            lock,
        )?;
        let mut observed = read_source_record(&directory, &name)?;
        binding.verify(observed.as_ref())?;
        if let Some(expected) = expected {
            anyhow::ensure!(
                observed.as_ref() == expected.0.as_ref(),
                "history source changed after resume preparation; prepare it again"
            );
            if let Some(record) = observed.as_mut() {
                if let Err(error) = commit::confirm_completed_pending(
                    &self.path,
                    &directory,
                    &name,
                    record,
                    &mut journal_fence,
                ) {
                    binding.refresh_after_failed_own_write(&directory, &name);
                    return Err(error);
                }
                binding.generation = Some(record.body_generation());
            }
        }
        if !recover
            && let Some(commit) = observed.as_ref().and_then(|record| record.commit.as_ref())
        {
            commit.check_ready()?;
        }
        let journal = journal_fence.begin_history_source(&self.path)?;
        if !binding.initialized {
            // Reject unsafe history leaves before claiming the candidate source.
            drop(existing_file(&directory, &name)?);
            let sources = directory.open_child(&source_directory_name(&name)?, true)?;
            let record = SourceRecord {
                schema_version: 1,
                incarnation: binding.incarnation,
                deleted: false,
                commit: None,
            };
            // A failed atomic replacement may already have committed. Never accept missing
            // control state again after attempting this writer's first initialization.
            binding.initialized = true;
            binding.generation = Some(record.body_generation());
            sources.atomic_replace(
                OsStr::new(SOURCE_RECORD_FILE),
                &serde_json::to_vec(&record)?,
            )?;
            observed = Some(record);
        }
        let mutation = prepare()?;
        let result = commit_mutation(
            &self.path,
            &directory,
            &name,
            observed.context("history source is not initialized")?,
            mutation,
        );
        match result {
            Ok(generation) => {
                binding.generation = Some(generation);
                finish_source_journal(journal);
                Ok(())
            }
            Err(error) => {
                binding.refresh_after_failed_own_write(&directory, &name);
                Err(error)
            }
        }
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
        !stamp
            .0
            .as_ref()
            .and_then(|record| record.commit.as_ref())
            .is_some_and(|commit| commit.pending.is_some()),
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
    if !stamp
        .0
        .as_ref()
        .and_then(|record| record.commit.as_ref())
        .is_some_and(|commit| commit.pending.is_some())
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
    let (directory, name) = open_parent(path)?;
    let lock = open_mutation_lock(&directory)?;
    FileExt::lock_exclusive(&lock).context("failed to lock history deletion")?;
    let mut journal_fence = JournalFence::from_locked_history(
        path.parent().context("history source has no parent")?,
        lock,
    )?;
    let journal = journal_fence.begin_history_source(path)?;
    // Persist deletion before unlink, so a failed cleanup cannot authorize old writers.
    let existed = existing_file(&directory, &name)?.is_some();
    let sources = directory.open_child(&source_directory_name(&name)?, true)?;
    let record = SourceRecord {
        schema_version: 1,
        incarnation: uuid::Uuid::new_v4(),
        deleted: true,
        commit: None,
    };
    sources.atomic_replace(
        OsStr::new(SOURCE_RECORD_FILE),
        &serde_json::to_vec(&record)?,
    )?;
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
mod tests {
    use super::*;
    const REPLACEMENT_HISTORY: &[u8] = b"{\"replacement\":true}\n";

    #[test]
    fn source_journal_reports_real_append_replace_metadata_and_delete() {
        use crate::history_index::journal::{JournalDomain, JournalFence, changes_since};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let mut cursor = {
            let mut fence = JournalFence::try_acquire(temp.path(), JournalDomain::History).unwrap();
            fence.activate().unwrap()
        };
        let source = HistorySource::bind(&path).unwrap();
        let sidecar = crate::session_state_path(temp.path(), "session");
        for operation in 0..4 {
            match operation {
                0 => source.append(b"{\"timestamp_ms\":1}\n").unwrap(),
                1 => source.replace(b"{\"timestamp_ms\":2}\n").unwrap(),
                2 => source
                    .write_metadata(&sidecar, || Ok(b"{\"schema_version\":1}".to_vec()))
                    .unwrap(),
                _ => {
                    assert!(delete_records(&path).unwrap());
                }
            }
            let changes = changes_since(temp.path(), JournalDomain::History, &cursor, 10)
                .unwrap()
                .unwrap();
            assert_eq!(
                changes.session_ids,
                ["session"],
                "operation {operation} must invalidate before authority"
            );
            cursor = changes.watermark;
        }
    }

    #[cfg(unix)]
    #[test]
    fn source_journal_preserves_legacy_non_utf8_and_backslash_names() {
        use crate::history_index::journal::{JournalDomain, JournalFence, changes_since};
        use std::os::unix::ffi::OsStringExt;
        for tracking in [false, true] {
            for name in [
                OsString::from("legacy\\name.jsonl"),
                OsString::from_vec(b"legacy-\xff.jsonl".to_vec()),
            ] {
                let temp = tempfile::tempdir().unwrap();
                let cursor = tracking.then(|| {
                    JournalFence::try_acquire(temp.path(), JournalDomain::History)
                        .unwrap()
                        .activate()
                        .unwrap()
                });
                let path = temp.path().join(name);
                let source = HistorySource::bind(&path).unwrap();
                source.append(b"{}\n").unwrap();
                assert_eq!(fs::read(&path).unwrap(), b"{}\n");
                source.replace(b"[]\n").unwrap();
                assert!(delete_records(&path).unwrap());
                if let Some(cursor) = cursor {
                    assert!(
                        changes_since(temp.path(), JournalDomain::History, &cursor, 10)
                            .unwrap()
                            .is_none()
                    );
                } else {
                    assert!(!temp.path().join("history-journal").exists());
                    assert!(!temp.path().join(".kcoder-history-tracking.json").exists());
                }
            }
        }
    }

    #[test]
    fn source_journal_pending_observation_and_recovery_do_not_fake_ready() {
        use crate::history_index::journal::{JournalDomain, JournalFence, changes_since};
        for stage in [
            commit::CommitStage::AfterPending,
            commit::CommitStage::AfterAuthority,
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("session.jsonl");
            let source = HistorySource::bind(&path).unwrap();
            source.append(b"{}\n").unwrap();
            let baseline = JournalFence::try_acquire(temp.path(), JournalDomain::History)
                .unwrap()
                .activate()
                .unwrap();
            let _cut = commit::install_cut(&path, stage, false);
            let error = source.append(b"[]\n").unwrap_err();
            assert_eq!(
                is_uncertain_mutation(&error),
                stage == commit::CommitStage::AfterAuthority
            );
            assert!(changes_since(temp.path(), JournalDomain::History, &baseline, 10).is_err());
            let control = path.with_extension("hctl").join(SOURCE_RECORD_FILE);
            let before_control = fs::read(&control).unwrap();
            let prepared = prepare_source_stamp(&path);
            assert_eq!(fs::read(&control).unwrap(), before_control);
            assert!(changes_since(temp.path(), JournalDomain::History, &baseline, 10).is_err());
            if stage == commit::CommitStage::AfterAuthority {
                let sidecar = crate::session_state_path(temp.path(), "session");
                source
                    .write_prepared_metadata(&prepared.unwrap(), &sidecar, || {
                        Ok(b"{\"schema_version\":1}".to_vec())
                    })
                    .unwrap();
                assert_eq!(fs::read(&path).unwrap(), b"{}\n[]\n");
            } else {
                assert!(prepared.is_err());
                source.replace(b"recovered\n").unwrap();
            }
            source.check().unwrap();
            assert!(
                changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn source_journal_tracks_pending_confirmation_after_late_activation() {
        use crate::history_index::journal::{JournalDomain, JournalFence, changes_since};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        source.append(b"{}\n").unwrap();
        let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
        assert!(source.append(b"[]\n").is_err());
        let baseline = JournalFence::try_acquire(temp.path(), JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
        {
            let (directory, name) = open_parent(&path).unwrap();
            let lock = open_mutation_lock(&directory).unwrap();
            FileExt::lock_exclusive(&lock).unwrap();
            let mut fence = JournalFence::from_locked_history(temp.path(), lock).unwrap();
            let mut record = read_source_record(&directory, &name).unwrap().unwrap();
            commit::confirm_completed_pending(&path, &directory, &name, &mut record, &mut fence)
                .unwrap();
        }
        assert_eq!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .unwrap()
                .session_ids,
            ["session"]
        );
        assert_eq!(
            committed_source_stamp(&path)
                .unwrap()
                .known_committed_bytes(),
            Some(6)
        );
    }

    #[test]
    fn source_journal_untracked_writer_holds_activation_fence_without_creating_index() {
        use crate::history_index::journal::{JournalDomain, JournalFence};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        let sidecar = crate::session_state_path(temp.path(), "session");
        source
            .write_metadata(&sidecar, || {
                assert!(JournalFence::try_acquire(temp.path(), JournalDomain::History).is_err());
                Ok(b"{\"schema_version\":1}".to_vec())
            })
            .unwrap();
        assert!(!temp.path().join("history-journal").exists());
        assert!(!temp.path().join(".kcoder-history-tracking.json").exists());
        assert!(JournalFence::try_acquire(temp.path(), JournalDomain::History).is_ok());
    }

    #[test]
    fn source_journal_finish_failures_never_replay_committed_metadata() {
        use crate::history_index::journal::{JournalDomain, JournalFence, changes_since};
        for token_failure in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("session.jsonl");
            let source = HistorySource::bind(&path).unwrap();
            source.append(b"{}\n").unwrap();
            let baseline = JournalFence::try_acquire(temp.path(), JournalDomain::History)
                .unwrap()
                .activate()
                .unwrap();
            let sidecar = crate::session_state_path(temp.path(), "session");
            let mut calls = 0;
            source
                .write_metadata(&sidecar, || {
                    calls += 1;
                    if token_failure {
                        let token = temp.path().join(".kcoder-history-tracking.json");
                        fs::remove_file(&token)?;
                        fs::create_dir(&token)?;
                    } else {
                        fs::write(
                            temp.path().join("history-journal/catalog.sqlite3"),
                            b"corrupt after begin",
                        )?;
                    }
                    Ok(b"{\"schema_version\":1}".to_vec())
                })
                .unwrap();
            assert_eq!(calls, 1);
            assert_eq!(fs::read(&sidecar).unwrap(), b"{\"schema_version\":1}");
            assert_eq!(fs::read(&path).unwrap(), b"{}\n");
            source.check().unwrap();
            let changes = changes_since(temp.path(), JournalDomain::History, &baseline, 10);
            if token_failure {
                assert!(changes.is_err());
            } else {
                assert!(changes.unwrap().is_none());
            }
        }
    }

    #[test]
    fn source_journal_revocation_failure_prevents_authority_write() {
        use crate::history_index::journal::{JournalDomain, JournalFence};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        source.append(b"{}\n").unwrap();
        JournalFence::try_acquire(temp.path(), JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
        let token = temp.path().join(".kcoder-history-tracking.json");
        fs::remove_file(&token).unwrap();
        fs::create_dir(&token).unwrap();
        let before = source_stamp(&path).unwrap();
        assert!(source.append(b"[]\n").is_err());
        assert_eq!(source_stamp(&path).unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), b"{}\n");
    }

    #[test]
    fn source_journal_relative_child() {
        if std::env::var_os("KCODER_SOURCE_JOURNAL_RELATIVE_CHILD").is_none() {
            return;
        }
        let path = Path::new("session.jsonl");
        let source = HistorySource::bind(path).unwrap();
        source.append(b"{}\n").unwrap();
        source.replace(b"[]\n").unwrap();
        assert!(delete_records(path).unwrap());
    }

    #[test]
    fn source_journal_preserves_relative_delete_and_cross_process_tracking() {
        use crate::history_index::journal::{JournalDomain, JournalFence, changes_since};
        let temp = tempfile::tempdir().unwrap();
        let baseline = JournalFence::try_acquire(temp.path(), JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "history_store::tests::source_journal_relative_child",
                "--nocapture",
            ])
            .env("KCODER_SOURCE_JOURNAL_RELATIVE_CHILD", "1")
            .current_dir(temp.path())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("source writer blocked on a second mutation lock");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .unwrap()
                .session_ids,
            ["session"]
        );
        assert!(!temp.path().join("session.jsonl").exists());
    }

    #[cfg(unix)]
    #[test]
    fn legacy_source_validation_accepts_filesystem_root_parent() {
        validate_live_source(Path::new("/kcoder-legacy-read-only-probe.jsonl")).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn legacy_source_reader_child() {
        let Some(directory) = std::env::var_os("KCODER_TEST_LEGACY_READER_DIRECTORY") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let path = directory.join("legacy.jsonl");
        assert_eq!(crate::load_history(&path).unwrap().len(), 1);
        assert_eq!(
            crate::recent_session_candidates(&directory).unwrap().len(),
            1
        );
        crate::prepare_session_resume(&path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires root to exercise a separate unprivileged OS reader"]
    fn legacy_source_reader_is_not_blocked_by_another_owners_deletion() {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;
        assert_eq!(unsafe { libc::geteuid() }, 0, "requires a root test runner");
        let temp = tempfile::tempdir().unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).unwrap();
        let readable = temp.path().join("legacy.jsonl");
        fs::write(&readable, b"{\"session_id\":\"legacy\",\"timestamp_ms\":1,\"uuid\":\"u1\",\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"visible\"}]}\n").unwrap();
        fs::set_permissions(&readable, fs::Permissions::from_mode(0o644)).unwrap();
        let other = temp.path().join("other.jsonl");
        fs::write(&other, b"{}\n").unwrap();
        delete_records(&other).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "history_store::tests::legacy_source_reader_child",
                "--nocapture",
            ])
            .env("KCODER_TEST_LEGACY_READER_DIRECTORY", temp.path())
            .current_dir(temp.path())
            .uid(65534)
            .gid(65534)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "unprivileged history reader failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn replace_test_source(path: &Path, incarnation: uuid::Uuid, deleted: bool) {
        let (directory, name) = open_parent(path).unwrap();
        let lock = open_mutation_lock(&directory).unwrap();
        FileExt::lock_exclusive(&lock).unwrap();
        let sources = directory
            .open_child(&source_directory_name(&name).unwrap(), true)
            .unwrap();
        sources
            .atomic_replace(
                OsStr::new(SOURCE_RECORD_FILE),
                &serde_json::to_vec(&SourceRecord {
                    schema_version: 1,
                    incarnation,
                    deleted,
                    commit: None,
                })
                .unwrap(),
            )
            .unwrap();
    }

    #[test]
    fn source_binding_bind_and_empty_check_do_not_create_files() {
        let temp = tempfile::tempdir().unwrap();
        let existing_parent_source =
            HistorySource::bind(&temp.path().join("existing-parent.jsonl")).unwrap();
        existing_parent_source.check().unwrap();
        existing_parent_source.append(b"").unwrap();
        let path = temp.path().join("not-created").join("session.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        source.check().unwrap();
        source.append(b"").unwrap();
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn source_binding_clones_share_first_snapshot_initialization() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        let shared = source.clone();
        source.replace(b"").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"");
        shared.check().unwrap();
        shared.append(b"shared\n").unwrap();
        source.replace(b"snapshot\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"snapshot\n");
    }

    #[test]
    fn source_binding_missing_parent_does_not_recreate_directory() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("history");
        let path = parent.join("session.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        source.append(b"original\n").unwrap();
        let parked = temp.path().join("parked");
        fs::rename(&parent, &parked).unwrap();
        assert!(source.append(b"stale\n").is_err());
        assert!(source.replace(b"stale snapshot\n").is_err());
        assert!(
            !parent.exists(),
            "bound writer recreated its missing parent"
        );
        assert_eq!(
            fs::read(parked.join("session.jsonl")).unwrap(),
            b"original\n"
        );
    }

    #[test]
    fn source_binding_first_writer_claims_and_rejects_competing_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let first = HistorySource::bind(&path).unwrap();
        let competing = HistorySource::bind(&path).unwrap();
        first.append(b"first\n").unwrap();
        assert!(competing.check().is_err());
        assert!(competing.append(b"stale\n").is_err());
        assert!(competing.replace(b"stale snapshot\n").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"first\n");
        let attached = HistorySource::bind(&path).unwrap();
        attached.append(b"attached\n").unwrap();
        first.append(b"original\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first\nattached\noriginal\n");
    }

    #[test]
    fn source_binding_rejects_changed_incarnation_for_append_and_replace() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        replace_test_source(&path, uuid::Uuid::new_v4(), false);
        let source = HistorySource::bind(&path).unwrap();
        source.append(b"original\n").unwrap();
        replace_test_source(&path, uuid::Uuid::new_v4(), false);
        assert!(source.check().is_err());
        assert!(source.append(b"stale\n").is_err());
        assert!(source.replace(b"stale snapshot\n").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original\n");
        HistorySource::bind(&path)
            .unwrap()
            .append(b"new writer\n")
            .unwrap();
    }

    #[test]
    fn source_binding_deleted_source_cannot_be_restored_by_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        source.append(b"original\n").unwrap();
        delete_records(&path).unwrap();
        assert!(source.check().is_err());
        assert!(source.append(b"stale\n").is_err());
        assert!(source.replace(b"stale snapshot\n").is_err());
        assert!(!path.exists());
        assert!(HistorySource::bind(&path).is_err());
    }

    #[test]
    fn source_binding_lost_control_cannot_preserve_managed_watermark() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("lost-control.jsonl");
        let old = HistorySource::bind(&path).unwrap();
        old.append(b"original\n").unwrap();
        let original = source_stamp(&path).unwrap().0.unwrap();
        assert_eq!(original.commit.as_ref().unwrap().committed_bytes, Some(9));
        let control = path.with_extension("hctl");
        fs::rename(&control, temp.path().join("parked-control")).unwrap();
        assert!(old.check().is_err());
        assert!(old.append(b"stale\n").is_err());
        assert!(old.replace(b"stale snapshot\n").is_err());
        assert!(!control.exists());
        assert!(source_stamp(&path).unwrap().0.is_none());

        // A fresh binder cannot infer trust in retained bytes from a missing control directory.
        let fresh = HistorySource::bind(&path).unwrap();
        let sidecar = crate::session_state_path(temp.path(), "lost-control");
        fresh
            .write_metadata(&sidecar, || Ok(b"{}".to_vec()))
            .unwrap();
        fresh.append(b"new\n").unwrap();
        let rebuilt = source_stamp(&path).unwrap().0.unwrap();
        assert_ne!(rebuilt.incarnation, original.incarnation);
        assert_eq!(rebuilt.commit.unwrap().committed_bytes, None);
        assert!(old.append(b"stale\n").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original\nnew\n");

        fresh.replace(b"explicit snapshot\n").unwrap();
        let snapshot = source_stamp(&path).unwrap().0.unwrap();
        assert_eq!(snapshot.commit.unwrap().committed_bytes, Some(18));
        assert!(old.replace(b"stale snapshot\n").is_err());
    }

    #[test]
    fn source_binding_missing_record_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        replace_test_source(&path, uuid::Uuid::new_v4(), false);
        let source = HistorySource::bind(&path).unwrap();
        source.append(b"original\n").unwrap();
        let (directory, name) = open_parent(&path).unwrap();
        directory
            .open_child(&source_directory_name(&name).unwrap(), false)
            .unwrap()
            .remove_regular_file(OsStr::new(SOURCE_RECORD_FILE))
            .unwrap();
        assert!(source.check().is_err());
        assert!(source.append(b"stale\n").is_err());
        assert!(source.replace(b"stale snapshot\n").is_err());
        assert!(
            HistorySource::bind(&path).is_err(),
            "missing managed control cannot become legacy"
        );
        assert_eq!(fs::read(&path).unwrap(), b"original\n");
    }

    #[test]
    fn source_binding_rejects_non_primary_history_aliases() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            "SOURCE~1.JSO",
            "source.txt",
            "source.lease",
            "source.exit.jsonl",
        ] {
            assert!(
                HistorySource::bind(&temp.path().join(name)).is_err(),
                "unsupported source name: {name}"
            );
        }
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn source_binding_windows_diagnostic_case_aliases_are_rejected() {
        for name in [
            "session.exit.JSONL",
            "session.EXIT.jsonl",
            "session.ExIt.JsOnL",
        ] {
            assert!(
                source_directory_name(OsStr::new(name)).is_err(),
                "diagnostic alias accepted: {name}"
            );
            assert!(!crate::session_persistence::is_primary_session_history_path(Path::new(name)));
        }
        assert!(crate::session_persistence::is_primary_session_history_path(
            Path::new("session.JSONL")
        ));
    }

    #[test]
    fn prepared_history_rejects_replaced_source_incarnation_before_commit() {
        for same_state in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("prepared-source.jsonl");
            let original = crate::AppState::new(temp.path());
            original.with_history_path(&path);
            original.add_message(crate::Message::user_text("seed"));
            original.save_history().unwrap();
            let prepared = crate::prepare_session_resume(&path).unwrap();
            let sidecar = original.session_state_path().unwrap();
            let before = fs::read(&sidecar).unwrap();
            replace_test_source(&path, uuid::Uuid::new_v4(), false);
            let target = if same_state {
                original
            } else {
                crate::AppState::new(temp.path())
            };
            let messages_before = target.messages().len();
            assert!(
                target.apply_prepared_session_resume(prepared).is_err(),
                "prepared state accepted a different source incarnation"
            );
            assert_eq!(target.messages().len(), messages_before);
            assert_eq!(fs::read(&sidecar).unwrap(), before);
        }
    }

    #[test]
    fn prepared_legacy_resume_commits_metadata_through_bound_source() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy-resume.jsonl");
        fs::write(&path, b"{\"session_id\":\"legacy-resume\",\"timestamp_ms\":1,\"uuid\":\"u1\",\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"visible\"}]}\n").unwrap();
        let original = fs::read(&path).unwrap();
        let prepared = crate::prepare_session_resume(&path).unwrap();
        assert_eq!(
            source_incarnation(&path).unwrap(),
            None,
            "preparation stays read-only"
        );
        let state = crate::AppState::new(temp.path());
        state.apply_prepared_session_resume(prepared).unwrap();
        assert!(
            source_incarnation(&path).unwrap().is_some(),
            "metadata commit must bind a managed source"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(state.messages().len(), 1);
        assert!(state.session_state_path().unwrap().exists());
        state.add_message(crate::Message::user_text("followup"));
        assert_eq!(crate::load_history(&path).unwrap().len(), 2);
    }

    #[test]
    fn prepared_resume_rejects_new_commit_in_same_incarnation_before_sidecar_write() {
        for metadata_only in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("changed-commit.jsonl");
            let original = crate::AppState::new(temp.path());
            original.with_history_path(&path);
            original.add_message(crate::Message::user_text("first"));
            original.save_history().unwrap();
            let prepared = crate::prepare_session_resume(&path).unwrap();
            if metadata_only {
                original.set_goal("newer goal", None);
            } else {
                original.add_message(crate::Message::user_text("newer message"));
            }
            let sidecar = original.session_state_path().unwrap();
            let before = fs::read(&sidecar).unwrap();
            let target = crate::AppState::new(temp.path());
            assert!(
                target.apply_prepared_session_resume(prepared).is_err(),
                "same incarnation does not prove the prepared revision is current"
            );
            assert!(target.messages().is_empty());
            assert_eq!(fs::read(&sidecar).unwrap(), before);
        }
    }

    #[test]
    fn source_commit_revision_tracks_body_and_metadata_without_guessing_legacy_watermark() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("commits.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_deferred_history_path(&path);
        state.add_message(crate::Message::user_text("first"));
        let control = path.with_extension("hctl").join(SOURCE_RECORD_FILE);
        let read =
            || serde_json::from_slice::<serde_json::Value>(&fs::read(&control).unwrap()).unwrap();
        let first = read();
        assert_eq!(first["schema_version"], 2);
        assert_eq!(first["commit"]["revision"], 1);
        assert_eq!(
            first["commit"]["committed_bytes"],
            fs::metadata(&path).unwrap().len()
        );
        state.set_goal("metadata only", None);
        let second = read();
        assert_eq!(second["commit"]["revision"], 2);
        assert_eq!(
            second["commit"]["committed_bytes"],
            first["commit"]["committed_bytes"]
        );
        assert_eq!(
            second["commit"]["generation"],
            first["commit"]["generation"]
        );
        state.save_history().unwrap();
        let snapshot = read();
        assert_eq!(snapshot["commit"]["revision"], 4);
        assert_ne!(
            snapshot["commit"]["generation"],
            first["commit"]["generation"]
        );
        assert!(snapshot["commit"]["pending"].is_null());

        let legacy = temp.path().join("legacy-watermark.jsonl");
        fs::write(&legacy, b"{}\n").unwrap();
        let old = crate::AppState::new(temp.path());
        old.with_history_path(&legacy);
        let record: serde_json::Value = serde_json::from_slice(
            &fs::read(legacy.with_extension("hctl").join(SOURCE_RECORD_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(record["commit"]["revision"], 1);
        assert!(record["commit"]["committed_bytes"].is_null());
    }

    #[test]
    fn source_commit_rejects_inconsistent_receipt_and_pending_ranges_before_binding() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("invalid-receipt.jsonl");
        HistorySource::bind(&path)
            .unwrap()
            .replace(b"base\n")
            .unwrap();
        let control = path.with_extension("hctl").join(SOURCE_RECORD_FILE);
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&control).unwrap()).unwrap();
        for damage in [
            "watermark",
            "missing_last",
            "generation",
            "pending_start",
            "pending_generation",
        ] {
            let mut invalid = original.clone();
            match damage {
                "watermark" => invalid["commit"]["committed_bytes"] = 9999_u64.into(),
                "missing_last" => invalid["commit"]["last_operation"] = serde_json::Value::Null,
                "generation" => {
                    invalid["commit"]["generation"] = uuid::Uuid::new_v4().to_string().into()
                }
                "pending_start" => {
                    invalid["commit"]["pending"] = serde_json::json!({
                        "next_revision": 2, "operation": {"kind":"append", "start":9999, "end":10000, "sha256":"0".repeat(64)}
                    })
                }
                "pending_generation" => {
                    invalid["commit"]["pending"] = serde_json::json!({
                        "next_revision":2, "operation":{"kind":"replace", "length":5, "generation":original["commit"]["generation"], "sha256":"0".repeat(64)}
                    })
                }
                _ => unreachable!(),
            }
            let bytes = serde_json::to_vec(&invalid).unwrap();
            fs::write(&control, &bytes).unwrap();
            assert!(HistorySource::bind(&path).is_err(), "accepted {damage}");
            assert_eq!(fs::read(&control).unwrap(), bytes);
            assert_eq!(fs::read(&path).unwrap(), b"base\n");
        }
    }

    #[test]
    fn source_commit_crash_child() {
        let Some(path) = std::env::var_os("KCODER_TEST_SOURCE_COMMIT_CRASH_PATH") else {
            return;
        };
        let path = PathBuf::from(path);
        let stage = match std::env::var("KCODER_TEST_SOURCE_COMMIT_CRASH_STAGE")
            .unwrap()
            .as_str()
        {
            "pending" => commit::CommitStage::AfterPending,
            "authority" => commit::CommitStage::AfterAuthority,
            _ => panic!("invalid owned crash stage"),
        };
        let _cut = commit::install_cut(&path, stage, true);
        HistorySource::bind(&path)
            .unwrap()
            .append(b"tail\n")
            .unwrap();
        panic!("child did not exit at its commit boundary");
    }

    #[test]
    fn source_commit_crash_keeps_pending_across_processes_until_explicit_recovery() {
        for stage in ["pending", "authority"] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("crash.jsonl");
            HistorySource::bind(&path)
                .unwrap()
                .append(b"base\n")
                .unwrap();
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "history_store::tests::source_commit_crash_child"])
                .env("KCODER_TEST_SOURCE_COMMIT_CRASH_PATH", &path)
                .env("KCODER_TEST_SOURCE_COMMIT_CRASH_STAGE", stage)
                .output()
                .unwrap();
            assert_eq!(child.status.code(), Some(73));
            let expected: &[u8] = if stage == "pending" {
                b"base\n"
            } else {
                b"base\ntail\n"
            };
            assert_eq!(fs::read(&path).unwrap(), expected);
            let record: serde_json::Value = serde_json::from_slice(
                &fs::read(path.with_extension("hctl").join(SOURCE_RECORD_FILE)).unwrap(),
            )
            .unwrap();
            assert_eq!(record["commit"]["revision"], 1);
            assert_eq!(record["commit"]["committed_bytes"], 5);
            assert_eq!(record["commit"]["pending"]["next_revision"], 2);
            assert_eq!(record["commit"]["pending"]["operation"]["start"], 5);
            assert_eq!(record["commit"]["pending"]["operation"]["end"], 10);
            let restarted = HistorySource::bind(&path).unwrap();
            assert!(restarted.check().is_err());
            assert!(restarted.append(b"later\n").is_err());
            assert_eq!(fs::read(&path).unwrap(), expected);
            restarted.replace(b"recovered\n").unwrap();
            restarted.check().unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"recovered\n");
        }
    }

    #[test]
    fn source_commit_uncertain_task_receipt_preserves_pending_delivery_in_memory() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("delivery-cut.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        let mut task = crate::Task::new("agent", "pending delivery");
        task.kind = crate::TaskKind::Subagent;
        state.upsert_task(task);
        let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
        let error = state
            .enqueue_subagent_delivery("agent", "keep me")
            .unwrap_err();
        assert!(is_uncertain_mutation(&error));
        assert_eq!(
            state.task("agent").unwrap().message_queue.len(),
            1,
            "do not roll memory behind possibly committed authority"
        );
        state.save_history().unwrap();
        let restored = crate::AppState::new(temp.path());
        restored.resume_from_history(&path).unwrap();
        assert_eq!(restored.task("agent").unwrap().message_queue.len(), 1);
    }

    #[test]
    fn source_commit_uncertain_mode_receipt_cannot_roll_back_or_report_retry_success() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("mode-cut.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
        assert!(state.enter_orchestrate_before_first_message().is_err());
        assert_eq!(state.session_mode(), crate::SessionMode::Orchestrate);
        assert!(state.enter_orchestrate_before_first_message().is_err());
        state.save_history().unwrap();
        assert!(!state.enter_orchestrate_before_first_message().unwrap());
    }

    #[test]
    fn source_commit_cold_resume_confirms_completed_pending_without_rewriting_body() {
        for kind in ["append", "replace", "metadata"] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("resume-pending.jsonl");
            let old = crate::AppState::new(temp.path());
            old.with_history_path(&path);
            old.add_message(crate::Message::user_text("first"));
            old.save_history().unwrap();
            let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
            match kind {
                "append" => old.add_message(crate::Message::user_text("second")),
                "replace" => {
                    old.set_messages(vec![crate::Message::user_text("replacement")]);
                    assert!(old.save_history().is_err());
                }
                "metadata" => {
                    old.set_goal("pending goal", None);
                }
                _ => unreachable!(),
            }
            let before = fs::read(&path).unwrap();
            assert!(HistorySource::bind(&path).unwrap().check().is_err());
            let prepared = crate::prepare_session_resume(&path).unwrap();
            let resumed = crate::AppState::new(temp.path());
            resumed.apply_prepared_session_resume(prepared).unwrap();
            assert_eq!(
                fs::read(&path).unwrap(),
                before,
                "{kind} recovery must not rewrite authority"
            );
            assert_eq!(
                resumed.messages().len(),
                if kind == "append" { 2 } else { 1 }
            );
            if kind == "metadata" {
                assert_eq!(resumed.goal().unwrap().objective, "pending goal");
            }
            HistorySource::bind(&path).unwrap().check().unwrap();
            resumed.add_message(crate::Message::user_text("after recovery"));
            assert_eq!(
                crate::load_history(&path).unwrap().len(),
                if kind == "append" { 3 } else { 2 }
            );
        }
    }

    #[test]
    fn source_commit_prepare_cannot_capture_old_authority_under_live_pending_writer() {
        for kind in ["append", "replace", "metadata"] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("prepare-race.jsonl");
            let old = crate::AppState::new(temp.path());
            old.with_history_path(&path);
            old.add_message(crate::Message::user_text("first"));
            old.set_goal("old goal", None);
            old.save_history().unwrap();
            crate::prepare_session_resume(&path).unwrap();
            let sidecar = old.session_state_path().unwrap();
            let bytes = if kind == "metadata" {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&fs::read(&sidecar).unwrap()).unwrap();
                value["goal"]["objective"] = "new goal".into();
                serde_json::to_vec_pretty(&value).unwrap()
            } else {
                b"{\"session_id\":\"prepare-race\",\"timestamp_ms\":2,\"uuid\":\"u2\",\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"second\"}]}\n".to_vec()
            };
            let source = HistorySource::bind(&path).unwrap();
            let _cut = commit::install_cut(&path, commit::CommitStage::AfterPending, false);
            let result = match kind {
                "append" => source.append(&bytes),
                "replace" => source.replace(&bytes),
                _ => source.write_metadata(&sidecar, || Ok(bytes.clone())),
            };
            assert!(result.is_err());
            let (directory, name) = open_parent(&path).unwrap();
            let writer_lock = open_mutation_lock(&directory).unwrap();
            FileExt::lock_exclusive(&writer_lock).unwrap();
            // This deterministic cut represents the original writer still owning its pending commit.
            assert!(
                crate::prepare_session_resume(&path).is_err(),
                "prepared stale {kind} authority while its writer still owns pending"
            );
            match kind {
                "append" => directory.append(&name, &bytes).unwrap(),
                "replace" => directory.atomic_replace(&name, &bytes).unwrap(),
                _ => crate::session_persistence::write_bytes_atomic(&sidecar, &bytes).unwrap(),
            }
            drop(writer_lock);
            let control = path.with_extension("hctl").join(SOURCE_RECORD_FILE);
            let before = fs::read(&control).unwrap();
            let prepared = crate::prepare_session_resume(&path).unwrap();
            assert_eq!(
                fs::read(&control).unwrap(),
                before,
                "preparation is read-only"
            );
            let resumed = crate::AppState::new(temp.path());
            resumed.apply_prepared_session_resume(prepared).unwrap();
            assert_eq!(
                resumed.messages().len(),
                if kind == "append" { 2 } else { 1 }
            );
            if kind == "metadata" {
                assert_eq!(resumed.goal().unwrap().objective, "new goal");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn source_commit_metadata_cannot_follow_a_replaced_parent_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let path = temp.path().join("anchored.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        let sidecar = state.session_state_path().unwrap();
        fs::write(foreign.path().join("state.json"), b"protected").unwrap();
        fs::rename(sidecar.parent().unwrap(), temp.path().join("moved-state")).unwrap();
        std::os::unix::fs::symlink(foreign.path(), sidecar.parent().unwrap()).unwrap();
        let source = HistorySource::bind(&path).unwrap();
        assert!(
            source
                .write_metadata(&sidecar, || Ok(b"replacement".to_vec()))
                .is_err(),
            "metadata authority followed a foreign parent symlink"
        );
        assert_eq!(
            fs::read(foreign.path().join("state.json")).unwrap(),
            b"protected"
        );
    }

    #[test]
    fn source_commit_recovery_rejects_digest_length_and_truncation_mismatch_without_writes() {
        for kind in ["append", "replace", "metadata"] {
            for damage in ["same_length", "extra_bytes", "truncated"] {
                let temp = tempfile::tempdir().unwrap();
                let path = temp.path().join("proof.jsonl");
                let old = crate::AppState::new(temp.path());
                old.with_history_path(&path);
                old.add_message(crate::Message::user_text("first"));
                old.save_history().unwrap();
                let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
                match kind {
                    "append" => old.add_message(crate::Message::user_text("second")),
                    "replace" => {
                        old.set_messages(vec![crate::Message::user_text("replacement")]);
                        assert!(old.save_history().is_err());
                    }
                    "metadata" => {
                        old.set_goal("pending goal", None);
                    }
                    _ => unreachable!(),
                }
                let prepared = crate::prepare_session_resume(&path).unwrap();
                let sidecar = old.session_state_path().unwrap();
                let damaged_path = if kind == "metadata" { &sidecar } else { &path };
                let mut bytes = fs::read(damaged_path).unwrap();
                match damage {
                    "same_length" => {
                        let marker: &[u8] = match kind {
                            "append" => b"second",
                            "replace" => b"replacement",
                            _ => b"pending goal",
                        };
                        let offset = bytes
                            .windows(marker.len())
                            .position(|part| part == marker)
                            .unwrap();
                        bytes[offset] = b'X';
                    }
                    "extra_bytes" => bytes.extend_from_slice(b" \n"),
                    "truncated" => {
                        bytes.pop();
                    }
                    _ => unreachable!(),
                }
                fs::write(damaged_path, &bytes).unwrap();
                let control = path.with_extension("hctl").join(SOURCE_RECORD_FILE);
                let before_control = fs::read(&control).unwrap();
                let before_body = fs::read(&path).unwrap();
                let before_sidecar = fs::read(&sidecar).unwrap();
                let target = crate::AppState::new(temp.path());
                let error = target
                    .apply_prepared_session_resume(prepared)
                    .expect_err("damaged commit proof must be rejected");
                let detail = format!("{error:#}");
                assert!(
                    detail.contains(if damage == "same_length" {
                        "content digest does not match"
                    } else {
                        "exact file length"
                    }),
                    "wrong rejection for {kind}/{damage}: {detail}"
                );
                assert!(target.messages().is_empty());
                assert_eq!(fs::read(&control).unwrap(), before_control);
                assert_eq!(fs::read(&path).unwrap(), before_body);
                assert_eq!(fs::read(&sidecar).unwrap(), before_sidecar);
            }
        }
    }

    #[test]
    fn deleted_history_rejects_late_metadata_persistence() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("late-metadata.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("seed"));
        state.save_history().unwrap();
        let sidecar = state.session_state_path().unwrap();
        crate::delete_session_history_files(&path).unwrap();
        state.set_cwd(temp.path());
        state.commit_session_state();
        assert!(
            !sidecar.exists(),
            "late metadata writer recreated deleted sidecar"
        );
        assert!(!path.exists());
    }

    #[test]
    fn deleted_history_rejects_late_orchestrate_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("late-mode.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.save_history().unwrap();
        let sidecar = state.session_state_path().unwrap();
        crate::delete_session_history_files(&path).unwrap();
        assert!(state.enter_orchestrate_before_first_message().is_err());
        assert_eq!(state.session_mode(), crate::SessionMode::Default);
        assert!(!sidecar.exists());
    }

    #[test]
    fn task_metadata_mutations_cannot_recreate_deleted_session() {
        for action in 0..7 {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("deleted-tasks.jsonl");
            let state = crate::AppState::new(temp.path());
            state.with_history_path(&path);
            let mut task = crate::Task::new("agent", "source-bound task");
            task.kind = crate::TaskKind::Subagent;
            task.status = crate::TaskStatus::Completed;
            state.upsert_task(task.clone());
            state.save_history().unwrap();
            let sidecar = state.session_state_path().unwrap();
            crate::delete_session_history_files(&path).unwrap();
            match action {
                0 => state.upsert_task(task),
                1 => {
                    state.update_task("agent", |task| task.output = Some("late".into()));
                }
                2 => {
                    state.mark_task_notification_injected("agent");
                }
                3 => {
                    state.claim_task_notification_injected("agent");
                }
                4 => {
                    state.task_for_output_delivery("agent");
                }
                5 => {
                    state.remove_task("agent");
                }
                6 => {
                    assert!(
                        state.enqueue_subagent_delivery("agent", "late").is_err(),
                        "deleted source must reject reliable enqueue receipt"
                    );
                    assert!(state.task("agent").unwrap().message_queue.is_empty());
                }
                _ => unreachable!(),
            }
            assert!(
                !sidecar.exists(),
                "task mutation {action} recreated deleted sidecar"
            );
            assert!(!path.exists());
        }
    }

    #[test]
    fn task_metadata_mutations_cannot_overwrite_replacement_source() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("replaced-tasks.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        let mut task = crate::Task::new("agent", "old task");
        task.kind = crate::TaskKind::Subagent;
        state.upsert_task(task);
        state.save_history().unwrap();
        let sidecar = state.session_state_path().unwrap();
        replace_test_source(&path, uuid::Uuid::new_v4(), false);
        let replacement = crate::AppState::new(temp.path());
        replacement.with_history_path(&path);
        replacement.set_goal("replacement goal", None);
        let before = fs::read(&sidecar).unwrap();
        assert!(state.enqueue_subagent_delivery("agent", "stale").is_err());
        assert!(state.task("agent").unwrap().message_queue.is_empty());
        state.update_task("agent", |task| task.output = Some("late".into()));
        assert_eq!(fs::read(&sidecar).unwrap(), before);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn deleted_history_rejects_unflushed_first_message_without_jsonl() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("unflushed-first.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("accepted but not flushed"));
        assert!(!path.exists());
        let sidecar = state.session_state_path().unwrap();
        crate::delete_session_history_files(&path).unwrap();
        assert!(state.flush_history().await.is_err());
        assert!(
            !path.exists(),
            "first queued message recreated the deleted source"
        );
        assert!(!sidecar.exists());
    }

    #[test]
    fn source_binding_corrupt_record_never_allows_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        replace_test_source(&path, uuid::Uuid::new_v4(), false);
        let source = HistorySource::bind(&path).unwrap();
        source.append(b"original\n").unwrap();
        let (directory, name) = open_parent(&path).unwrap();
        directory
            .open_child(&source_directory_name(&name).unwrap(), false)
            .unwrap()
            .atomic_replace(OsStr::new(SOURCE_RECORD_FILE), b"{broken")
            .unwrap();
        assert!(source.check().is_err());
        assert!(source.append(b"stale\n").is_err());
        assert!(source.replace(b"stale snapshot\n").is_err());
        assert!(HistorySource::bind(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original\n");
    }

    #[test]
    fn deleted_history_residue_is_not_listed_or_prepared() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("deleted-residue.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("seed"));
        state.save_history().unwrap();
        let bytes = fs::read(&path).unwrap();
        crate::delete_session_history_files(&path).unwrap();
        // Reproduce a crash after the durable tombstone but before unlink completes.
        fs::write(&path, &bytes).unwrap();
        assert!(
            crate::recent_session_candidates(temp.path())
                .unwrap()
                .is_empty()
        );
        assert!(crate::prepare_session_resume(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn deleted_history_prepared_resume_cannot_recreate_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("deleted-prepared.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("seed"));
        state.save_history().unwrap();
        let prepared = crate::prepare_session_resume(&path).unwrap();
        let sidecar = state.session_state_path().unwrap();
        crate::delete_session_history_files(&path).unwrap();
        let target = crate::AppState::new(temp.path());
        assert!(target.apply_prepared_session_resume(prepared).is_err());
        assert!(
            !sidecar.exists(),
            "old prepared state recreated deleted sidecar"
        );
        assert!(target.messages().is_empty());
    }

    #[test]
    fn source_lifecycle_child_writer() {
        use std::io::{BufRead, Write};
        let Some(directory) = std::env::var_os("KCODER_TEST_STALE_WRITER_DIRECTORY") else {
            return;
        };
        let path = std::path::PathBuf::from(directory).join("cross-process.jsonl");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _entered = runtime.enter();
        let state = crate::AppState::new(path.parent().unwrap());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("seed"));
        state.save_history().unwrap();
        state.add_message(crate::Message::user_text("accepted in another process"));
        println!("KCODER_STALE_WRITER_READY");
        std::io::stdout().flush().unwrap();
        let mut command = String::new();
        std::io::stdin().lock().read_line(&mut command).unwrap();
        assert_eq!(command.trim(), "continue");
        let result = runtime.block_on(state.flush_history());
        if std::env::var("KCODER_TEST_STALE_WRITER_REPLACEMENT").as_deref() == Ok("1") {
            assert_eq!(fs::read(&path).unwrap(), REPLACEMENT_HISTORY);
        } else {
            assert!(
                !path.exists(),
                "cross-process writer resurrected deleted history"
            );
        }
        assert!(
            result.is_err(),
            "old process must observe source invalidation"
        );
        assert_eq!(state.messages().len(), 2);
    }

    #[test]
    fn deleted_history_rejects_writer_in_another_process() {
        assert_stale_process_writer(false, false);
    }

    #[test]
    fn replaced_history_rejects_writer_in_another_process() {
        assert_stale_process_writer(true, false);
    }

    #[test]
    fn snapshot_generation_rejects_queued_writer_in_another_process() {
        assert_stale_process_writer(true, true);
    }

    #[test]
    fn source_generation_first_prepare_failure_keeps_retryable_v1_binding() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("prepare-generation.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        let shared = source.clone();
        let sidecar = crate::session_state_path(temp.path(), "prepare-generation");
        let error = source
            .write_metadata(&sidecar, || anyhow::bail!("prepare rejected"))
            .unwrap_err();
        assert!(error.to_string().contains("prepare rejected"));
        assert!(!path.exists());
        assert!(!sidecar.exists());
        shared.check().unwrap();
        let peer = HistorySource::bind(&path).unwrap();
        shared.append(b"retried\n").unwrap();
        peer.append(b"peer\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"retried\npeer\n");
    }

    #[test]
    fn committed_projection_rejects_real_pending_authority_without_advancing_watermark() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pending-projection.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        source.append(b"{}\n").unwrap();
        let initial = crate::history_index::CommittedListProjection::read(&path, 3, 3).unwrap();
        let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
        assert!(source.append(b"{}\n").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{}\n{}\n");
        assert!(initial.update(3, 3).is_err());
        assert!(crate::history_index::CommittedListProjection::read(&path, 6, 3).is_err());
        assert_eq!(initial.committed_offset(), 3);
        assert_eq!(fs::read(&path).unwrap(), b"{}\n{}\n");
    }

    #[test]
    fn source_generation_recovered_snapshot_does_not_reauthorize_old_writers() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("recover-generation.jsonl");
        let owner = HistorySource::bind(&path).unwrap();
        owner.append(b"old\n").unwrap();
        let peer = HistorySource::bind(&path).unwrap();
        let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
        assert!(is_uncertain_mutation(
            &owner.replace(b"replacement\n").unwrap_err()
        ));
        assert!(peer.check().is_err());
        assert!(owner.check().is_err());
        {
            let (directory, name) = open_parent(&path).unwrap();
            let lock = open_mutation_lock(&directory).unwrap();
            FileExt::lock_exclusive(&lock).unwrap();
            let mut record = read_source_record(&directory, &name).unwrap().unwrap();
            let mut journal_fence = JournalFence::from_locked_history(temp.path(), lock).unwrap();
            commit::confirm_completed_pending(
                &path,
                &directory,
                &name,
                &mut record,
                &mut journal_fence,
            )
            .unwrap();
        }
        for old in [&owner, &peer] {
            assert!(old.append(b"stale\n").is_err());
            assert!(old.replace(b"stale snapshot\n").is_err());
        }
        assert_eq!(fs::read(&path).unwrap(), b"replacement\n");
        HistorySource::bind(&path)
            .unwrap()
            .append(b"fresh\n")
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement\nfresh\n");
    }

    #[test]
    fn source_generation_preserves_v1_peers_during_nonreplacement_upgrade() {
        for metadata_first in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("legacy-generation.jsonl");
            fs::write(&path, b"legacy\n").unwrap();
            let control = temp.path().join("legacy-generation.hctl");
            fs::create_dir(&control).unwrap();
            let record = SourceRecord {
                schema_version: 1,
                incarnation: uuid::Uuid::new_v4(),
                deleted: false,
                commit: None,
            };
            fs::write(
                control.join(SOURCE_RECORD_FILE),
                serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
            let owner = HistorySource::bind(&path).unwrap();
            let peer = HistorySource::bind(&path).unwrap();
            let sidecar = crate::session_state_path(temp.path(), "legacy-generation");
            if metadata_first {
                owner
                    .write_metadata(&sidecar, || Ok(b"{}".to_vec()))
                    .unwrap();
            } else {
                owner.append(b"owner\n").unwrap();
            }
            peer.check().expect("v1 migration did not replace the body");
            peer.append(b"peer\n").unwrap();
            owner.replace(b"replacement\n").unwrap();
            assert!(peer.append(b"stale\n").is_err());
            assert_eq!(fs::read(&path).unwrap(), b"replacement\n");
        }
    }

    #[test]
    fn source_generation_allows_append_peers_but_rejects_stale_snapshot_and_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("body-generation.jsonl");
        let owner = HistorySource::bind(&path).unwrap();
        owner.replace(b"seed\n").unwrap();
        let peer = HistorySource::bind(&path).unwrap();
        owner.append(b"owner\n").unwrap();
        peer.append(b"peer\n").unwrap();
        owner.replace(b"replacement\n").unwrap();
        assert!(
            peer.check().is_err(),
            "old writer must observe body replacement"
        );
        assert!(peer.append(b"stale\n").is_err());
        assert!(peer.replace(b"stale snapshot\n").is_err());
        let sidecar = crate::session_state_path(temp.path(), "body-generation");
        assert!(
            peer.write_metadata(&sidecar, || Ok(b"{}".to_vec()))
                .is_err()
        );
        assert!(!sidecar.exists());
        assert_eq!(fs::read(&path).unwrap(), b"replacement\n");
        owner.append(b"owner after snapshot\n").unwrap();
        HistorySource::bind(&path)
            .unwrap()
            .append(b"fresh peer\n")
            .unwrap();
    }

    fn assert_stale_process_writer(replacement: bool, preserve_incarnation: bool) {
        use std::io::{BufRead, Write};
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cross-process.jsonl");
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "history_store::tests::source_lifecycle_child_writer",
                    "--nocapture",
                ])
                .env("KCODER_TEST_STALE_WRITER_DIRECTORY", temp.path())
                .env(
                    "KCODER_TEST_STALE_WRITER_REPLACEMENT",
                    if replacement { "1" } else { "0" },
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines() {
                let line = line.unwrap();
                if line == "KCODER_STALE_WRITER_READY" {
                    let _ = ready_tx.send(());
                }
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(path.exists());
        if preserve_incarnation {
            let before = source_incarnation(&path).unwrap();
            HistorySource::bind(&path)
                .unwrap()
                .replace(REPLACEMENT_HISTORY)
                .unwrap();
            assert_eq!(source_incarnation(&path).unwrap(), before);
        } else {
            crate::delete_session_history_files(&path).unwrap();
            assert!(!path.exists());
        }
        if replacement && !preserve_incarnation {
            replace_test_source(&path, uuid::Uuid::new_v4(), false);
            HistorySource::bind(&path)
                .unwrap()
                .replace(REPLACEMENT_HISTORY)
                .unwrap();
        }
        child
            .0
            .stdin
            .take()
            .unwrap()
            .write_all(b"continue\n")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "writer child did not finish");
            std::thread::sleep(Duration::from_millis(5));
        };
        reader.join().unwrap();
        if replacement {
            assert_eq!(fs::read(&path).unwrap(), REPLACEMENT_HISTORY);
        } else {
            assert!(!path.exists(), "another process recreated deleted history");
        }
        assert!(status.success(), "writer child failed: {status}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn deleted_history_rejects_previously_queued_writer() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("deleted-session.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("seed"));
        state.save_history().unwrap();
        state.add_message(crate::Message::user_text("accepted before deletion"));
        crate::delete_session_history_files(&path).unwrap();
        assert!(!path.exists());
        // No await before deletion: the worker cannot have consumed the queued message.
        let result = state.flush_history().await;
        assert!(!path.exists(), "queued writer resurrected deleted history");
        assert!(result.is_err(), "deleted writer flush must fail");
        assert_eq!(state.messages().len(), 2);
    }

    #[test]
    fn deleted_history_rejects_old_synchronous_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("deleted-snapshot.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("seed"));
        state.save_history().unwrap();
        crate::delete_session_history_files(&path).unwrap();
        let result = state.save_history();
        assert!(!path.exists(), "old snapshot resurrected deleted history");
        assert!(result.is_err(), "deleted writer snapshot must fail");
        assert_eq!(state.messages().len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pruned_history_rejects_previously_queued_writer() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pruned-session.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("seed"));
        state.save_history().unwrap();
        state.add_message(crate::Message::user_text("accepted before pruning"));
        let report = crate::prune_session_history(temp.path(), 0).unwrap();
        assert_eq!(report.deleted_sessions, 1);
        assert!(!path.exists());
        let result = state.flush_history().await;
        assert!(!path.exists(), "queued writer resurrected pruned history");
        assert!(result.is_err(), "pruned writer flush must fail");
        assert_eq!(state.messages().len(), 2);
    }

    #[tokio::test]
    async fn prepared_resume_cannot_discard_uncommitted_same_path_messages() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("first"));
        state.flush_history().await.unwrap();
        let prepared = crate::prepare_session_resume(&path).unwrap();
        state.add_message(crate::Message::user_text("pending"));
        let sidecar = state.session_state_path().unwrap();
        let before = fs::read(&sidecar).unwrap();
        assert!(state.apply_prepared_session_resume(prepared).is_err());
        assert_eq!(state.messages().len(), 2);
        assert_eq!(fs::read(&sidecar).unwrap(), before);
        state.flush_history().await.unwrap();
        state.resume_from_history(&path).unwrap();
        assert_eq!(state.messages().len(), 2);
    }

    #[tokio::test]
    async fn prepared_resume_cannot_clear_uncertain_atomic_replace() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("first"));
        state.flush_history().await.unwrap();
        let bytes = fs::read(&path).unwrap();
        let queue = state
            .inner
            .read()
            .unwrap()
            .history_flusher
            .as_ref()
            .unwrap()
            .queue
            .clone();
        let error = queue
            .replace_snapshot(|| {
                replace_records_with(&path, &bytes, |directory, name, bytes| {
                    directory.atomic_replace(name, bytes)?;
                    anyhow::bail!("injected failure after atomic rename")
                })
            })
            .unwrap_err();
        assert!(is_uncertain_mutation(&error));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let alias_directory = temp.path().join("alias");
        fs::create_dir(&alias_directory).unwrap();
        let alias = alias_directory.join("..").join("session.jsonl");
        let prepared = crate::prepare_session_resume(&alias).unwrap();
        assert!(state.apply_prepared_session_resume(prepared).is_err());
        assert!(state.flush_history().await.is_err());
        state.save_history().unwrap();
        state.flush_history().await.unwrap();
        assert_eq!(crate::load_history(&path).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn mutation_store_same_path_install_preserves_pending_queue() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(crate::Message::user_text("queued"));
        let queue = state
            .inner
            .read()
            .unwrap()
            .history_flusher
            .as_ref()
            .unwrap()
            .queue
            .clone();
        state.with_history_path(&path);
        let current = state
            .inner
            .read()
            .unwrap()
            .history_flusher
            .as_ref()
            .unwrap()
            .queue
            .clone();
        assert!(std::sync::Arc::ptr_eq(&queue, &current));
        state.flush_history().await.unwrap();
    }

    #[test]
    fn mutation_store_rejects_unterminated_batches_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        assert!(append_records(&path, b"{}").is_err());
        assert!(!path.exists());
    }

    #[test]
    fn mutation_store_holds_same_directory_lock_during_append() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        append_records_with(&path, b"{}\n", |directory, name, bytes| {
            let probe = open_mutation_lock(directory)?;
            assert!(FileExt::try_lock_exclusive(&probe).is_err());
            directory.append(name, bytes)
        })
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{}\n");
    }

    #[test]
    fn mutation_store_refuses_existing_half_record_without_repairing_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        fs::write(&path, b"{").unwrap();
        let error = append_records(&path, b"{}\n").unwrap_err();
        assert!(is_uncertain_mutation(&error));
        assert_eq!(fs::read(&path).unwrap(), b"{");
    }

    #[test]
    fn mutation_store_reports_partial_append_as_uncertain() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let error = append_records_with(&path, b"{}\n", |directory, name, bytes| {
            directory.append(name, &bytes[..1])?;
            anyhow::bail!("injected failure after partial write")
        })
        .unwrap_err();
        assert!(is_uncertain_mutation(&error));
        assert_eq!(fs::read(&path).unwrap(), b"{");
    }

    #[test]
    #[cfg(unix)]
    fn mutation_store_replacement_rejects_a_leaf_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let destination = outside.path().join("untouched");
        fs::write(&destination, b"original").unwrap();
        let path = temp.path().join("session.jsonl");
        std::os::unix::fs::symlink(&destination, &path).unwrap();
        assert!(replace_records(&path, b"{}\n").is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"original");
    }
}
