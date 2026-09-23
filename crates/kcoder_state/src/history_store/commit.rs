use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CommitState {
    pub revision: u64,
    pub generation: uuid::Uuid,
    pub committed_bytes: Option<u64>,
    pub pending: Option<PendingCommit>,
    pub last_operation: Option<MutationPlan>,
}

impl CommitState {
    fn legacy(incarnation: uuid::Uuid) -> Self {
        Self {
            revision: 0,
            generation: incarnation,
            committed_bytes: None,
            pending: None,
            last_operation: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PendingCommit {
    pub next_revision: u64,
    pub operation: MutationPlan,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum MutationPlan {
    Append {
        start: u64,
        end: u64,
        sha256: String,
    },
    Replace {
        length: u64,
        generation: uuid::Uuid,
        sha256: String,
    },
    Metadata {
        relative_path: Vec<String>,
        length: u64,
        sha256: String,
    },
}

pub(super) enum Mutation<'a> {
    Materialize,
    Append(&'a [u8]),
    Replace(&'a [u8]),
    Metadata { path: &'a Path, bytes: Vec<u8> },
}

impl CommitState {
    pub fn check_ready(&self) -> Result<()> {
        anyhow::ensure!(
            self.pending.is_none(),
            "history source has an unfinished commit; explicit recovery is required"
        );
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            (self.revision == 0) == self.last_operation.is_none(),
            "history revision and last operation are inconsistent"
        );
        if let Some(pending) = &self.pending {
            anyhow::ensure!(
                self.revision.checked_add(1) == Some(pending.next_revision),
                "invalid pending history revision"
            );
            pending.operation.validate()?;
            match &pending.operation {
                MutationPlan::Append { start, .. } => anyhow::ensure!(
                    self.committed_bytes.is_none_or(|known| known == *start),
                    "pending append does not start at the committed watermark"
                ),
                MutationPlan::Replace { generation, .. } => anyhow::ensure!(
                    *generation != self.generation,
                    "pending replacement must rotate the body generation"
                ),
                MutationPlan::Metadata { .. } => {}
            }
        }
        if let Some(operation) = &self.last_operation {
            operation.validate()?;
            match operation {
                MutationPlan::Append { end, .. } => anyhow::ensure!(
                    self.committed_bytes.is_none_or(|known| known == *end),
                    "append receipt does not match the committed watermark"
                ),
                MutationPlan::Replace {
                    length, generation, ..
                } => anyhow::ensure!(
                    self.committed_bytes == Some(*length) && self.generation == *generation,
                    "replacement receipt does not match the committed body"
                ),
                MutationPlan::Metadata { .. } => {}
            }
        }
        Ok(())
    }
}

impl MutationPlan {
    fn validate(&self) -> Result<()> {
        let digest = match self {
            Self::Append { start, end, sha256 } => {
                anyhow::ensure!(end > start, "invalid pending append range");
                sha256
            }
            Self::Replace { sha256, .. } => sha256,
            Self::Metadata {
                relative_path,
                sha256,
                ..
            } => {
                anyhow::ensure!(!relative_path.is_empty(), "empty metadata target");
                for part in relative_path {
                    anyhow::ensure!(
                        !part.is_empty()
                            && part != "."
                            && part != ".."
                            && !part.contains(['/', '\\', ':', '\0']),
                        "invalid metadata target component"
                    );
                }
                sha256
            }
        };
        anyhow::ensure!(
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid history commit digest"
        );
        Ok(())
    }
}

fn metadata_bytes(directory: &PrivateDirectory, name: &OsStr) -> Result<Option<Vec<u8>>> {
    let Some(mut file) = existing_file(directory, name)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

fn metadata_target(
    source_path: &Path,
    directory: &PrivateDirectory,
    relative_path: &[String],
    create: bool,
) -> Result<(PrivateDirectory, OsString)> {
    let parent = source_path.parent().context("history has no parent")?;
    let session_id = crate::session_persistence::session_id_from_history_path(source_path)?;
    let sidecar = crate::session_state_path(parent, &session_id);
    let target: PathBuf = relative_path.iter().collect();
    anyhow::ensure!(
        target == sidecar.strip_prefix(parent)?,
        "pending metadata target does not belong to this source"
    );
    let (leaf, parents) = relative_path
        .split_last()
        .context("missing metadata target")?;
    let (first, rest) = parents
        .split_first()
        .context("metadata must have a session directory")?;
    let mut current = directory.open_child(OsStr::new(first), create)?;
    for component in rest {
        current = current.open_child(OsStr::new(component), create)?;
    }
    Ok((current, OsString::from(leaf.as_str())))
}

pub(super) fn write_record(
    directory: &PrivateDirectory,
    name: &OsStr,
    record: &SourceRecord,
) -> Result<()> {
    let bytes = serde_json::to_vec(record)?;
    anyhow::ensure!(bytes.len() <= 4096, "history source record is too large");
    directory
        .open_child(&source_directory_name(name)?, true)?
        .atomic_replace(OsStr::new(SOURCE_RECORD_FILE), &bytes)
}

pub(super) fn commit_mutation(
    source_path: &Path,
    directory: &PrivateDirectory,
    name: &OsStr,
    original: SourceRecord,
    mutation: Mutation<'_>,
) -> Result<uuid::Uuid> {
    let mutation = match mutation {
        Mutation::Materialize => {
            if existing_file(directory, name)?.is_some() { return Ok(original.body_generation()); }
            Mutation::Replace(&[])
        }
        mutation => mutation,
    };
    let mut record = original.clone();
    let state = record
        .commit
        .get_or_insert_with(|| CommitState::legacy(original.incarnation));
    let next_revision = state
        .revision
        .checked_add(1)
        .context("history commit revision is exhausted")?;
    let digest = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let operation = match &mutation {
        Mutation::Materialize => anyhow::bail!("materialization was not normalized"),
        Mutation::Append(bytes) => {
            let start = existing_file(directory, name)?
                .map(|f| f.metadata().map(|m| m.len()))
                .transpose()?
                .unwrap_or(0);
            anyhow::ensure!(
                state.committed_bytes.is_none_or(|known| known == start),
                "history length diverged from its committed watermark; explicit recovery is required"
            );
            MutationPlan::Append {
                start,
                end: start
                    .checked_add(u64::try_from(bytes.len())?)
                    .context("history length overflow")?,
                sha256: digest(bytes),
            }
        }
        Mutation::Replace(bytes) => {
            drop(existing_file(directory, name)?);
            MutationPlan::Replace {
                length: u64::try_from(bytes.len())?,
                generation: uuid::Uuid::new_v4(),
                sha256: digest(bytes),
            }
        }
        Mutation::Metadata { path, bytes } => {
            let absolute = std::path::absolute(path)?;
            let relative = absolute
                .strip_prefix(
                    source_path
                        .parent()
                        .context("history source has no parent")?,
                )
                .context("metadata target is outside its history source directory")?;
            let relative_path = relative
                .components()
                .map(|part| match part {
                    std::path::Component::Normal(part) => part
                        .to_str()
                        .map(str::to_owned)
                        .context("metadata target is not UTF-8"),
                    _ => anyhow::bail!("metadata target must use normal relative components"),
                })
                .collect::<Result<Vec<_>>>()?;
            MutationPlan::Metadata {
                relative_path,
                length: u64::try_from(bytes.len())?,
                sha256: digest(bytes),
            }
        }
    };
    operation.validate()?;
    let metadata = match &operation {
        MutationPlan::Metadata { relative_path, .. } => Some(metadata_target(
            source_path,
            directory,
            relative_path,
            true,
        )?),
        _ => None,
    };
    let before_metadata = metadata
        .as_ref()
        .map(|(directory, name)| metadata_bytes(directory, name))
        .transpose()?
        .flatten();
    state.pending = Some(PendingCommit {
        next_revision,
        operation: operation.clone(),
    });
    record.schema_version = 2;
    // Failure here cannot have written authority bytes. Do not invalidate queued body commands.
    write_record(directory, name, &record)?;
    #[cfg(test)]
    maybe_cut(source_path, CommitStage::AfterPending)?;
    let result = match &mutation {
        Mutation::Materialize => anyhow::bail!("materialization was not normalized"),
        Mutation::Append(bytes) => append_locked(directory, name, bytes, |dir, name, bytes| {
            dir.append(name, bytes)
        }),
        Mutation::Replace(bytes) => replace_locked(directory, name, bytes, |dir, name, bytes| {
            dir.atomic_replace(name, bytes)
        }),
        Mutation::Metadata { path, bytes } => {
            let (target_directory, target_name) =
                metadata.as_ref().expect("metadata target prepared above");
            let write = (|| -> Result<()> {
                #[cfg(test)]
                crate::session_persistence::maybe_fail_before_atomic_replace(path)?;
                #[cfg(not(test))]
                let _ = path;
                // The authority parent is synced before the separate control receipt is advanced.
                target_directory.atomic_replace(target_name, bytes)
            })();
            write.map_err(|error| {
                if metadata_bytes(target_directory, target_name)
                    .is_ok_and(|after| after == before_metadata)
                {
                    error
                } else {
                    UncertainMutation(error).into()
                }
            })
        }
    };
    if let Err(error) = result {
        if is_uncertain_mutation(&error) {
            return Err(error);
        }
        // Proven prewrite failure is retryable only after restoring the original control state.
        return match write_record(directory, name, &original) {
            Ok(()) => Err(error),
            Err(rollback) => Err(error.context(format!(
                "failed to restore uncommitted control record: {rollback:#}"
            ))),
        };
    }
    #[cfg(test)]
    maybe_cut(source_path, CommitStage::AfterAuthority)
        .map_err(|error| UncertainMutation(error))?;
    finish_pending(&mut record)?;
    let generation = record
        .commit
        .as_ref()
        .context("missing committed source state")?
        .generation;
    write_record(directory, name, &record)
        .map(|()| generation)
        .map_err(|error| {
            UncertainMutation(error.context("authority written but history commit receipt failed"))
                .into()
        })
}

fn finish_pending(record: &mut SourceRecord) -> Result<()> {
    let state = record.commit.as_mut().context("missing commit state")?;
    let PendingCommit {
        next_revision,
        operation,
    } = state.pending.take().context("missing pending commit")?;
    match &operation {
        MutationPlan::Append { start, end, .. } => {
            if state.committed_bytes == Some(*start) || *start == 0 {
                state.committed_bytes = Some(*end);
            }
        }
        MutationPlan::Replace {
            length, generation, ..
        } => {
            state.committed_bytes = Some(*length);
            state.generation = *generation;
        }
        MutationPlan::Metadata { .. } => {}
    }
    state.revision = next_revision;
    state.last_operation = Some(operation);
    Ok(())
}

fn verify_range(mut file: File, start: u64, end: u64, digest: &str) -> Result<()> {
    anyhow::ensure!(
        file.metadata()?.len() == end,
        "pending commit does not match the exact file length"
    );
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = end
        .checked_sub(start)
        .context("invalid pending commit range")?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let take = usize::try_from(remaining.min(buffer.len() as u64))?;
        let read = file.read(&mut buffer[..take])?;
        anyhow::ensure!(read != 0, "pending commit ended before its expected range");
        hash.update(&buffer[..read]);
        remaining -= read as u64;
    }
    anyhow::ensure!(
        file.metadata()?.len() == end && format!("{:x}", hash.finalize()) == digest,
        "pending commit content digest does not match; explicit recovery is required"
    );
    Ok(())
}

/// Confirm a completed authority write without rewriting it or replaying the operation.
/// The caller owns the source lock and has compared the exact prepared source stamp.
pub(super) fn confirm_completed_pending(
    source_path: &Path,
    directory: &PrivateDirectory,
    name: &OsStr,
    record: &mut SourceRecord,
    journal_fence: &mut JournalFence,
) -> Result<()> {
    verify_completed_pending(source_path, directory, name, record)?;
    if record
        .commit
        .as_ref()
        .is_none_or(|state| state.pending.is_none())
    {
        return Ok(());
    }
    let journal = journal_fence.begin_history_source(source_path)?;
    finish_pending(record)?;
    write_record(directory, name, record).map_err(|error| {
        anyhow::Error::from(UncertainMutation(
            error.context("verified authority but recovery receipt failed"),
        ))
    })?;
    finish_source_journal(journal);
    Ok(())
}

/// Verify under the source lock without advancing its receipt or changing authority bytes.
pub(super) fn verify_completed_pending(
    source_path: &Path,
    directory: &PrivateDirectory,
    name: &OsStr,
    record: &SourceRecord,
) -> Result<()> {
    let Some(pending) = record
        .commit
        .as_ref()
        .and_then(|state| state.pending.as_ref())
    else {
        return Ok(());
    };
    match &pending.operation {
        MutationPlan::Append { start, end, sha256 } => {
            verify_range(directory.open_regular_file(name)?, *start, *end, sha256)?;
        }
        MutationPlan::Replace { length, sha256, .. } => {
            verify_range(directory.open_regular_file(name)?, 0, *length, sha256)?;
        }
        MutationPlan::Metadata {
            relative_path,
            length,
            sha256,
        } => {
            let (target, name) = metadata_target(source_path, directory, relative_path, false)?;
            verify_range(target.open_regular_file(&name)?, 0, *length, sha256)?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CommitStage {
    AfterPending,
    AfterAuthority,
}

#[cfg(test)]
static COMMIT_CUTS: std::sync::OnceLock<
    Mutex<std::collections::HashMap<PathBuf, (CommitStage, bool)>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
pub(super) struct CommitCutGuard(PathBuf);

#[cfg(test)]
impl Drop for CommitCutGuard {
    fn drop(&mut self) {
        if let Some(cuts) = COMMIT_CUTS.get() {
            cuts.lock().unwrap().remove(&self.0);
        }
    }
}

#[cfg(test)]
pub(super) fn install_cut(path: &Path, stage: CommitStage, exit_process: bool) -> CommitCutGuard {
    COMMIT_CUTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap()
        .insert(path.to_path_buf(), (stage, exit_process));
    CommitCutGuard(path.to_path_buf())
}

#[cfg(test)]
fn maybe_cut(path: &Path, stage: CommitStage) -> Result<()> {
    let cut = COMMIT_CUTS.get().and_then(|cuts| {
        let mut cuts = cuts.lock().unwrap();
        if cuts.get(path).is_some_and(|(at, _)| *at == stage) {
            cuts.remove(path)
        } else {
            None
        }
    });
    if let Some((_, exit_process)) = cut {
        if exit_process {
            std::process::exit(73);
        }
        anyhow::bail!("injected history commit interruption");
    }
    Ok(())
}
