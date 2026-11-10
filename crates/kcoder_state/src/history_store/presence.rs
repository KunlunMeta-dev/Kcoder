#[cfg(target_os = "linux")]
use anyhow::Context;
use anyhow::Result;
#[cfg(target_os = "linux")]
use fs2::FileExt;
#[cfg(target_os = "linux")]
use kcoder_config::PrivateDirectory;
use kcoder_types::PrivateFileIdentityV1;
#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::ffi::{OsStr, OsString};
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use super::{MUTATION_LOCK, SOURCE_RECORD_FILE, SourceRecord};

#[cfg(target_os = "linux")]
const MAX_SOURCE_RECORD_BYTES: usize = 4096;

/// Physical source observations are not wire-level workspace authorization decisions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistorySourceObservation {
    Unknown(HistorySourceUnknown),
    /// An ordinary history file was opened and identified. This alone does not authorize a
    /// workspace-scoped `present` response.
    PhysicalSourceFileObserved {
        identity: PrivateFileIdentityV1,
    },
    /// A bound deletion control record and missing source were observed under the shared lock.
    BoundDeletedSourceAbsent(BoundDeletedHistoryPresenceReference),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistorySourceUnknown {
    MissingHistoryParent,
    MissingControlDirectory,
    MissingControlRecord,
    MissingSourceForLiveRecord,
    LegacyDeletionWithoutBinding,
    BoundDeletionMissingSourceWithoutLock,
    BoundDeletionResidualSameIdentity,
}

/// Independent, read-only evidence for one bounded State observation; it cannot be deserialized
/// or converted into `DeletedHistoryProof`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundDeletedHistoryPresenceReference {
    history_path: PathBuf,
    workspace: PathBuf,
    thread_id: String,
    source_incarnation: uuid::Uuid,
    control_record_sha256: String,
    history_parent_identity: PrivateFileIdentityV1,
    control_directory_identity: PrivateFileIdentityV1,
}

impl BoundDeletedHistoryPresenceReference {
    pub fn history_path(&self) -> &std::path::Path {
        &self.history_path
    }

    pub fn workspace(&self) -> &std::path::Path {
        &self.workspace
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn source_incarnation(&self) -> uuid::Uuid {
        self.source_incarnation
    }

    pub fn control_record_sha256(&self) -> &str {
        &self.control_record_sha256
    }
}

/// Returned as a concrete error when a writer owns the existing history mutation lock.
#[derive(Debug, thiserror::Error)]
#[error("history source presence observation is busy")]
pub struct HistorySourceObservationBusy;

/// Returned on platforms where bounded source identity observation is not implemented.
#[derive(Debug, thiserror::Error)]
#[error("bounded history source presence observation is currently supported only on Linux")]
pub struct HistorySourcePresenceUnsupported;

#[cfg(target_os = "linux")]
pub(crate) fn observe_source_presence(
    history_path: &Path,
    workspace: &Path,
) -> Result<HistorySourceObservation> {
    let name = history_path
        .file_name()
        .context("history source has no file name")?
        .to_os_string();
    let control_name = super::source_directory_name(&name)?;
    let parent_path = history_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let canonical_parent = match dunce::canonicalize(parent_path) {
        Ok(parent) => parent,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HistorySourceObservation::Unknown(
                HistorySourceUnknown::MissingHistoryParent,
            ));
        }
        Err(error) => return Err(error).context("failed to resolve history parent"),
    };
    let directory = match PrivateDirectory::open_existing(&canonical_parent) {
        Ok(directory) => directory,
        Err(error) if super::missing(&error) => {
            return Ok(HistorySourceObservation::Unknown(
                HistorySourceUnknown::MissingHistoryParent,
            ));
        }
        Err(error) => return Err(error).context("failed to open existing history parent"),
    };
    let history_parent_identity = super::history_parent_identity(&directory)?;
    let canonical_history_path = canonical_parent.join(&name);

    // This is deliberately read-only: unlike the mutation helper, it never creates the lease.
    let mutation_lock = match directory.open_regular_file(OsStr::new(MUTATION_LOCK)) {
        Ok(lock) => Some(lock),
        Err(error) if super::missing(&error) => None,
        Err(error) => return Err(error).context("failed to open existing history mutation lock"),
    };
    let (lock_held, mutation_lock_identity) = if let Some(lock) = mutation_lock.as_ref() {
        match FileExt::try_lock_shared(lock) {
            Ok(()) => (true, Some(super::history_file_identity(lock)?)),
            Err(error) if lock_contended(&error) => {
                return Err(HistorySourceObservationBusy.into());
            }
            Err(error) => return Err(error).context("failed to acquire shared history lock"),
        }
    } else {
        (false, None)
    };

    let sources = match directory.open_child(&control_name, false) {
        Ok(sources) => sources,
        Err(error) if super::missing(&error) => {
            return Ok(HistorySourceObservation::Unknown(
                HistorySourceUnknown::MissingControlDirectory,
            ));
        }
        Err(error) => {
            return Err(error).context("failed to open existing history control directory");
        }
    };
    let Some(control_bytes) = read_control_record(&sources)? else {
        return Ok(HistorySourceObservation::Unknown(
            HistorySourceUnknown::MissingControlRecord,
        ));
    };
    let record = decode_source_record(&control_bytes)?;

    if !record.deleted {
        let Some(source) = existing_history_source(&directory, &name)? else {
            return Ok(HistorySourceObservation::Unknown(
                HistorySourceUnknown::MissingSourceForLiveRecord,
            ));
        };
        return Ok(HistorySourceObservation::PhysicalSourceFileObserved {
            identity: super::history_file_identity(&source)?,
        });
    }

    let Some(binding) = record.deletion.as_ref() else {
        return Ok(HistorySourceObservation::Unknown(
            HistorySourceUnknown::LegacyDeletionWithoutBinding,
        ));
    };
    let canonical_workspace = validate_deletion_binding(workspace, &directory, &record, binding)?;
    let source = existing_history_source(&directory, &name)?;
    if let Some(source) = source {
        let identity = super::history_file_identity(&source)?;
        anyhow::ensure!(
            binding.source_identity.as_ref() == Some(&identity),
            "deleted history path now contains a foreign source identity"
        );
        return Ok(HistorySourceObservation::Unknown(
            HistorySourceUnknown::BoundDeletionResidualSameIdentity,
        ));
    }
    if !lock_held {
        return Ok(HistorySourceObservation::Unknown(
            HistorySourceUnknown::BoundDeletionMissingSourceWithoutLock,
        ));
    }

    let control_directory_identity = super::history_parent_identity(&sources)?;
    let lock_identity = mutation_lock_identity.context("shared lock identity unavailable")?;
    verify_locked_absence(
        &canonical_parent,
        &directory,
        &name,
        &control_name,
        &control_bytes,
        &history_parent_identity,
        &control_directory_identity,
        &lock_identity,
    )?;
    let final_workspace = dunce::canonicalize(workspace)?;
    anyhow::ensure!(
        final_workspace == canonical_workspace
            && super::workspace_deletion_identity(&final_workspace)? == binding.workspace_identity,
        "workspace changed while observing deleted history absence"
    );

    Ok(HistorySourceObservation::BoundDeletedSourceAbsent(
        BoundDeletedHistoryPresenceReference {
            history_path: canonical_history_path,
            workspace: canonical_workspace,
            thread_id: crate::session_persistence::session_id_from_history_path(history_path)?,
            source_incarnation: record.incarnation,
            control_record_sha256: format!("{:x}", Sha256::digest(&control_bytes)),
            history_parent_identity,
            control_directory_identity,
        },
    ))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn observe_source_presence(
    _history_path: &Path,
    _workspace: &Path,
) -> Result<HistorySourceObservation> {
    Err(HistorySourcePresenceUnsupported.into())
}

#[cfg(target_os = "linux")]
fn lock_contended(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || error
            .raw_os_error()
            .is_some_and(|code| Some(code) == fs2::lock_contended_error().raw_os_error())
}

#[cfg(target_os = "linux")]
fn read_control_record(sources: &PrivateDirectory) -> Result<Option<Vec<u8>>> {
    let file = match sources.open_regular_file(OsStr::new(SOURCE_RECORD_FILE)) {
        Ok(file) => file,
        Err(error) if super::missing(&error) => return Ok(None),
        Err(error) => return Err(error).context("failed to open history source control record"),
    };
    let mut bytes = Vec::with_capacity(MAX_SOURCE_RECORD_BYTES + 1);
    file.take((MAX_SOURCE_RECORD_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .context("failed to read bounded history source control record")?;
    anyhow::ensure!(
        bytes.len() <= MAX_SOURCE_RECORD_BYTES,
        "history source record is too large"
    );
    Ok(Some(bytes))
}

#[cfg(target_os = "linux")]
fn decode_source_record(bytes: &[u8]) -> Result<SourceRecord> {
    let record: SourceRecord = serde_json::from_slice(bytes)
        .context("history source record is corrupt; explicit recovery is required")?;
    anyhow::ensure!(
        matches!(
            (record.schema_version, record.commit.is_some()),
            (1, false) | (2, true)
        ),
        "unsupported history source version"
    );
    if let Some(commit) = &record.commit {
        commit.validate()?;
    }
    Ok(record)
}

#[cfg(target_os = "linux")]
fn existing_history_source(directory: &PrivateDirectory, name: &OsStr) -> Result<Option<File>> {
    match directory.open_regular_file(name) {
        Ok(source) => Ok(Some(source)),
        Err(error) if super::missing(&error) => Ok(None),
        Err(error) => Err(error).context("failed to inspect existing history source"),
    }
}

#[cfg(target_os = "linux")]
fn validate_deletion_binding(
    workspace: &Path,
    directory: &PrivateDirectory,
    record: &SourceRecord,
    binding: &super::DeletionBinding,
) -> Result<PathBuf> {
    anyhow::ensure!(
        binding.source_identity.is_some() == binding.source_bytes.is_some(),
        "incomplete deleted history source binding"
    );
    let canonical_workspace =
        dunce::canonicalize(workspace).context("failed to canonicalize deletion workspace")?;
    anyhow::ensure!(
        binding.workspace == canonical_workspace
            && binding.workspace_identity
                == super::workspace_deletion_identity(&canonical_workspace)?
            && binding.history_parent == super::history_parent_identity(directory)?
            && binding.source_incarnation == record.incarnation
            && record.schema_version == 1
            && record.commit.is_none(),
        "deleted source binding differs"
    );
    Ok(canonical_workspace)
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
fn verify_locked_absence(
    canonical_parent: &Path,
    locked_parent: &PrivateDirectory,
    name: &OsStr,
    control_name: &OsString,
    expected_control_bytes: &[u8],
    expected_parent_identity: &PrivateFileIdentityV1,
    expected_control_identity: &PrivateFileIdentityV1,
    expected_lock_identity: &PrivateFileIdentityV1,
) -> Result<()> {
    let current_parent = PrivateDirectory::open_existing(canonical_parent)
        .context("history parent changed while observing deletion absence")?;
    let current_parent_identity = super::history_parent_identity(&current_parent)?;
    let locked_parent_identity = super::history_parent_identity(locked_parent)?;
    anyhow::ensure!(
        &current_parent_identity == expected_parent_identity
            && &locked_parent_identity == expected_parent_identity,
        "history parent identity changed while observing deletion absence"
    );
    let current_lock = current_parent
        .open_regular_file(OsStr::new(MUTATION_LOCK))
        .context("existing history mutation lock changed while observing absence")?;
    anyhow::ensure!(
        super::history_file_identity(&current_lock)? == *expected_lock_identity,
        "history mutation lock identity changed while observing absence"
    );
    let current_sources = current_parent
        .open_child(control_name, false)
        .context("history control directory changed while observing absence")?;
    let current_control_identity = super::history_parent_identity(&current_sources)?;
    anyhow::ensure!(
        &current_control_identity == expected_control_identity,
        "history control directory identity changed while observing absence"
    );
    let current_control_bytes = read_control_record(&current_sources)?
        .context("history control record disappeared while observing absence")?;
    anyhow::ensure!(
        current_control_bytes == expected_control_bytes,
        "history source control record changed while observing absence"
    );
    anyhow::ensure!(
        existing_history_source(&current_parent, name)?.is_none(),
        "history source reappeared while observing deletion absence"
    );
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
#[path = "presence_tests.rs"]
mod tests;

#[cfg(all(test, not(target_os = "linux")))]
mod unsupported_platform_tests {
    #[test]
    fn bounded_observation_reports_unsupported_platform() {
        let error = super::observe_source_presence(
            std::path::Path::new("session.jsonl"),
            std::path::Path::new("."),
        )
        .unwrap_err();
        assert!(
            error
                .downcast_ref::<super::HistorySourcePresenceUnsupported>()
                .is_some(),
            "expected typed unsupported-platform error, got: {error:#}"
        );
    }
}
