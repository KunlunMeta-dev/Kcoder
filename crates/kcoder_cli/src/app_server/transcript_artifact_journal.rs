use anyhow::{Context, Result, ensure};
use kcoder_state::history_index::journal::{JournalDomain, JournalFence, JournalMutation};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
pub(super) enum Kind {
    TurnClientMessages,
    TurnOutcomes,
    ApprovalDecisions,
    TurnFileChanges,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::TurnClientMessages => "turn-client-messages",
            Self::TurnOutcomes => "turn-outcomes",
            Self::ApprovalDecisions => "approval-decisions",
            Self::TurnFileChanges => "turn-file-changes",
        }
    }
}

fn root(directory: &Path, thread_id: &str, kind: Kind) -> Result<PathBuf> {
    super::validate_thread_id(thread_id)?;
    ensure!(
        directory.file_name() == Some(OsStr::new(kind.name())),
        "unexpected transcript artifact kind"
    );
    let thread = directory
        .parent()
        .context("artifact directory has no thread")?;
    ensure!(
        thread.file_name() == Some(OsStr::new(thread_id)),
        "transcript artifact thread directory mismatch"
    );
    Ok(thread
        .parent()
        .context("artifact thread has no client root")?
        .to_path_buf())
}

fn finish(mutation: JournalMutation<'_>, thread_id: &str) {
    // The authority operation has committed; never replay it or change its successful result.
    if let Err(error) = mutation.finish() {
        tracing::warn!(%error, %thread_id, "transcript artifact committed but journal completion failed");
    }
}

pub(super) fn write<T>(
    directory: &Path,
    thread_id: &str,
    kind: Kind,
    authority: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let root = root(directory, thread_id, kind)?;
    super::ensure_private_artifact_directory(&root)?;
    let mut fence = JournalFence::try_acquire(&root, JournalDomain::ClientMetadata)?;
    let mutation = fence.begin(thread_id)?;
    super::ensure_private_artifact_directory(directory)?;
    let result = authority()?;
    finish(mutation, thread_id);
    Ok(result)
}

pub(super) fn remove(path: &Path, thread_id: &str, kind: Kind) -> Result<()> {
    let directory = path.parent().context("artifact file has no parent")?;
    let root = root(directory, thread_id, kind)?;
    super::ensure_private_artifact_directory(&root)?;
    let mut fence = JournalFence::try_acquire(&root, JournalDomain::ClientMetadata)?;
    // The absence decision belongs under the same domain fence as a real removal.
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    let mutation = fence.begin(thread_id)?;
    std::fs::remove_file(path)?;
    finish(mutation, thread_id);
    Ok(())
}
