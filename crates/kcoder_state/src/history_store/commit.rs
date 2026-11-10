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
    /// The most recent committed metadata replace. `last_operation` is often a
    /// later append, so this is what proves a crashed metadata intent never
    /// renamed (the target is still exactly these bytes). Absent in records
    /// written before it existed; those keep requiring explicit recovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed_metadata: Option<MutationPlan>,
}

impl CommitState {
    fn legacy(incarnation: uuid::Uuid) -> Self {
        Self {
            revision: 0,
            generation: incarnation,
            committed_bytes: None,
            pending: None,
            last_operation: None,
            committed_metadata: None,
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
    AppendWitnessed(&'a [u8]),
    Replace(&'a [u8]),
    Initialize {
        bytes: &'a [u8],
        generation: uuid::Uuid,
    },
    Metadata {
        path: &'a Path,
        bytes: Vec<u8>,
    },
}

pub(super) struct CommittedMutation {
    pub generation: uuid::Uuid,
    pub append_receipt: Option<super::live_append_receipt::LiveAppendReceipt>,
    pub metadata_publication: Option<super::metadata_lineage::Publication>,
    #[cfg(target_os = "linux")]
    pub lineage_receipt: Option<super::live_append_receipt::LiveAppendReceipt>,
}

#[cfg(target_os = "linux")]
pub(super) struct LineageCommitOptions {
    pub preparation: Option<super::live_append_receipt::PreparedLiveAppend>,
    pub observe_ready_publisher: bool,
}

pub(super) struct CommitObservations {
    pub live_preparation: Option<super::live_append_receipt::PreparedLiveAppend>,
    pub metadata: super::metadata_lineage::ObservationMode,
    #[cfg(target_os = "linux")]
    pub lineage: LineageCommitOptions,
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
        if let Some(operation) = &self.committed_metadata {
            anyhow::ensure!(
                matches!(operation, MutationPlan::Metadata { .. }),
                "committed metadata receipt is not a metadata operation"
            );
            operation.validate()?;
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

pub(super) fn metadata_target(
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

#[cfg(all(test, target_os = "linux"))]
thread_local! {
    static CONTROL_READY_SYNC_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CONTROL_READY_REPLACEMENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CONTROL_OBSERVER_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(all(test, target_os = "linux"))]
pub(super) fn inject_control_ready_sync_failure() {
    CONTROL_READY_SYNC_FAILURE.with(|armed| armed.set(true));
}

#[cfg(all(test, target_os = "linux"))]
pub(super) fn inject_control_ready_replacement() {
    CONTROL_READY_REPLACEMENT.with(|armed| armed.set(true));
}

#[cfg(all(test, target_os = "linux"))]
pub(super) fn inject_control_observer_failure() {
    CONTROL_OBSERVER_FAILURE.with(|armed| armed.set(true));
}

/// Publish a ready control record and retain the exact descriptor observed
/// before rename. Call only for an explicitly reserved lineage observation.
pub(super) fn write_record_with_publisher(
    directory: &PrivateDirectory,
    name: &OsStr,
    record: &SourceRecord,
) -> Result<Option<File>> {
    let bytes = serde_json::to_vec(record)?;
    anyhow::ensure!(bytes.len() <= 4096, "history source record is too large");
    let control = directory.open_child(&source_directory_name(name)?, true)?;
    #[cfg(all(test, target_os = "linux"))]
    if CONTROL_READY_SYNC_FAILURE.with(|armed| armed.replace(false)) {
        control.inject_pre_sync_failure_once()?;
    }
    let mut original = None;
    let count = control.atomic_publish_observed_from_reader(
        OsStr::new(SOURCE_RECORD_FILE),
        &mut std::io::Cursor::new(&bytes),
        true,
        || Ok(None),
        |file| {
            // Failure to retain observer evidence must not fail a normal write.
            #[cfg(all(test, target_os = "linux"))]
            if CONTROL_OBSERVER_FAILURE.with(|armed| armed.replace(false)) {
                return Ok(());
            }
            #[cfg(test)]
            if DROP_METADATA_CONTROL_OBSERVER.with(|armed| armed.replace(false)) {
                return Ok(());
            }
            original = file.try_clone().ok();
            Ok(())
        },
    )?;
    anyhow::ensure!(
        count == bytes.len() as u64,
        "history control length differs"
    );
    #[cfg(all(test, target_os = "linux"))]
    if CONTROL_READY_REPLACEMENT.with(|armed| armed.replace(false)) {
        control.rename_no_replace(
            OsStr::new(SOURCE_RECORD_FILE),
            OsStr::new("controlled-original-source.json"),
        )?;
        control.atomic_replace(OsStr::new(SOURCE_RECORD_FILE), &bytes)?;
    }
    Ok(original)
}

#[cfg(test)]
thread_local! {
    static DROP_METADATA_OBSERVER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static DROP_METADATA_CONTROL_OBSERVER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(super) fn inject_metadata_observer_failure() {
    DROP_METADATA_OBSERVER.with(|armed| armed.set(true));
}

#[cfg(test)]
pub(super) fn inject_metadata_control_observer_failure() {
    DROP_METADATA_CONTROL_OBSERVER.with(|armed| armed.set(true));
}

pub(super) fn commit_mutation(
    source_path: &Path,
    directory: &PrivateDirectory,
    name: &OsStr,
    original: SourceRecord,
    mutation: Mutation<'_>,
    observations: CommitObservations,
) -> Result<CommittedMutation> {
    let live_preparation = observations.live_preparation;
    let metadata_observation = observations.metadata;
    #[cfg(target_os = "linux")]
    let LineageCommitOptions {
        preparation: lineage_preparation,
        observe_ready_publisher,
    } = observations.lineage;
    let mutation = match mutation {
        Mutation::Materialize => {
            if existing_file(directory, name)?.is_some() {
                return Ok(CommittedMutation {
                    generation: original.body_generation(),
                    append_receipt: None,
                    metadata_publication: None,
                    #[cfg(target_os = "linux")]
                    lineage_receipt: None,
                });
            }
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
    anyhow::ensure!(
        matches!(&mutation, Mutation::AppendWitnessed(_)) == live_preparation.is_some(),
        "history append witness preparation mismatch"
    );
    #[cfg(target_os = "linux")]
    anyhow::ensure!(
        !observe_ready_publisher || live_preparation.is_some() || lineage_preparation.is_some(),
        "native control observation requires a live append"
    );
    let operation = match &mutation {
        Mutation::Materialize => anyhow::bail!("materialization was not normalized"),
        Mutation::Append(bytes) | Mutation::AppendWitnessed(bytes) => {
            let start = match &live_preparation {
                Some(prepared) => prepared.len()?,
                None => existing_file(directory, name)?
                    .map(|f| f.metadata().map(|m| m.len()))
                    .transpose()?
                    .unwrap_or(0),
            };
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
        Mutation::Initialize { bytes, generation } => {
            anyhow::ensure!(
                existing_file(directory, name)?.is_none(),
                "initial history already exists"
            );
            MutationPlan::Replace {
                length: u64::try_from(bytes.len())?,
                generation: *generation,
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
    let mut append_receipt = None;
    let mut metadata_publisher = None;
    #[cfg(target_os = "linux")]
    let mut lineage_receipt = None;
    let result = match &mutation {
        Mutation::Materialize => anyhow::bail!("materialization was not normalized"),
        Mutation::Append(bytes) => append_locked(directory, name, bytes, |dir, name, bytes| {
            #[cfg(target_os = "linux")]
            if let Some(prepared) = lineage_preparation {
                let MutationPlan::Append { start, end, sha256 } = &operation else {
                    unreachable!("tracked append has an append plan");
                };
                let written = dir.append_held(name, bytes)?;
                // An observer failure cannot turn a completed normal append into
                // a retryable write failure or change the writer's result.
                lineage_receipt = prepared.finish(written, *start, *end, sha256).ok();
                return Ok(());
            }
            dir.append(name, bytes)
        }),
        Mutation::AppendWitnessed(bytes) => {
            let MutationPlan::Append { start, end, sha256 } = &operation else {
                unreachable!("witnessed append has an append plan");
            };
            let prepared = live_preparation.expect("witnessed append preparation");
            append_locked(directory, name, bytes, |dir, name, bytes| {
                let written = dir.append_held(name, bytes).map_err(UncertainMutation)?;
                let receipt = prepared
                    .finish(written, *start, *end, sha256)
                    .map_err(UncertainMutation)?;
                append_receipt = Some(receipt);
                Ok(())
            })
        }
        Mutation::Replace(bytes) => replace_locked(directory, name, bytes, |dir, name, bytes| {
            dir.atomic_replace(name, bytes)
        }),
        Mutation::Initialize { bytes, .. } => {
            replace_locked(directory, name, bytes, |dir, name, bytes| {
                dir.atomic_publish_from_reader(
                    name,
                    &mut std::io::Cursor::new(bytes),
                    false,
                    || Ok(None),
                )?;
                Ok(())
            })
        }
        Mutation::Metadata { path, bytes } => {
            let (target_directory, target_name) =
                metadata.as_ref().expect("metadata target prepared above");
            // Keep the failpoint error boundary so the rollback path below always runs.
            let mut write_metadata = || -> Result<()> {
                #[cfg(test)]
                crate::session_persistence::maybe_fail_before_atomic_replace(path)?;
                #[cfg(not(test))]
                let _ = path;
                // The authority parent is synced before the separate control receipt is advanced.
                if metadata_observation.metadata_publisher {
                    target_directory
                        .atomic_publish_observed_from_reader(
                            target_name,
                            &mut std::io::Cursor::new(bytes),
                            true,
                            || Ok(None),
                            |file| {
                                #[cfg(test)]
                                let drop_observer =
                                    DROP_METADATA_OBSERVER.with(|armed| armed.replace(false));
                                #[cfg(not(test))]
                                let drop_observer = false;
                                metadata_publisher =
                                    (!drop_observer).then(|| file.try_clone().ok()).flatten();
                                Ok(())
                            },
                        )
                        .map(|_| ())
                } else {
                    target_directory.atomic_replace(target_name, bytes)
                }
            };
            let write = write_metadata();
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
    maybe_cut(source_path, CommitStage::AfterAuthority).map_err(UncertainMutation)?;
    finish_pending(&mut record)?;
    let committed = record
        .commit
        .as_ref()
        .context("missing committed source state")?;
    let generation = committed.generation;
    let revision = committed.revision;
    #[cfg(target_os = "linux")]
    let observe_any_publisher = observe_ready_publisher || metadata_observation.control_publisher;
    #[cfg(not(target_os = "linux"))]
    let observe_any_publisher = metadata_observation.control_publisher;
    let control_write = if observe_any_publisher {
        write_record_with_publisher(directory, name, &record)
    } else {
        write_record(directory, name, &record).map(|()| None)
    };
    let mut published_control = control_write.map_err(|error| {
        UncertainMutation(error.context("authority written but history commit receipt failed"))
    })?;
    let metadata_control = if metadata_observation.control_publisher {
        published_control
            .as_ref()
            .and_then(|file| file.try_clone().ok())
    } else {
        None
    };
    if let Some(receipt) = &mut append_receipt {
        let verify = (|| -> Result<()> {
            anyhow::ensure!(
                read_source_record(directory, name)?.as_ref() == Some(&record),
                "history source control changed after append"
            );
            receipt.verify_contents()?;
            receipt.bind_committed(
                record.incarnation,
                generation,
                revision,
                &record,
                published_control.take(),
            )?;
            receipt.verify_contents()
        })();
        verify.map_err(UncertainMutation)?;
    }
    #[cfg(target_os = "linux")]
    if observe_ready_publisher {
        if let Some(receipt) = &mut append_receipt {
            lineage_receipt = receipt.duplicate_for_lineage().ok();
        } else if let Some(receipt) = &mut lineage_receipt {
            let verify = (|| -> Result<()> {
                let publisher = published_control
                    .take()
                    .context("history publisher unavailable")?;
                anyhow::ensure!(
                    read_source_record(directory, name)?.as_ref() == Some(&record),
                    "history control changed after append"
                );
                receipt.bind_committed(
                    record.incarnation,
                    generation,
                    revision,
                    &record,
                    Some(publisher),
                )?;
                receipt.verify_contents()
            })();
            if verify.is_err() {
                lineage_receipt = None;
            }
        }
    }
    Ok(CommittedMutation {
        generation,
        append_receipt,
        metadata_publication: metadata_observation.control_publisher.then_some(
            super::metadata_lineage::Publication {
                record,
                metadata: metadata_publisher,
                control: metadata_control,
            },
        ),
        #[cfg(target_os = "linux")]
        lineage_receipt,
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
        MutationPlan::Metadata { .. } => state.committed_metadata = Some(operation.clone()),
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
    if unstarted_pending(source_path, directory, name, record)? {
        // The process exited after recording the intent and before its
        // authority changed: the bytes are exactly the committed ones, so the
        // intent is dropped without advancing the revision or the body.
        let journal = journal_fence.begin_history_source(source_path)?;
        if let Some(state) = record.commit.as_mut() {
            state.pending = None;
        }
        write_record(directory, name, record).map_err(|error| {
            anyhow::Error::from(UncertainMutation(
                error.context("abandoning an unstarted append failed"),
            ))
        })?;
        finish_source_journal(journal);
        return Ok(());
    }
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

/// An intent whose authority never changed, so dropping it loses nothing:
/// - an append whose body never received a byte: its start is the committed
///   watermark and the file still ends exactly there;
/// - a metadata replace that never renamed: the target is still byte-for-byte
///   the last committed metadata of the same path.
///
/// Anything else (a torn or longer tail, unknown metadata bytes) stays
/// ambiguous and needs explicit recovery.
fn unstarted_pending(
    source_path: &Path,
    directory: &PrivateDirectory,
    name: &OsStr,
    record: &SourceRecord,
) -> Result<bool> {
    let Some(state) = record.commit.as_ref() else {
        return Ok(false);
    };
    let Some(pending) = state.pending.as_ref() else {
        return Ok(false);
    };
    let committed_metadata = state
        .committed_metadata
        .as_ref()
        .or(match &state.last_operation {
            Some(operation @ MutationPlan::Metadata { .. }) => Some(operation),
            _ => None,
        });
    match (&pending.operation, committed_metadata) {
        (MutationPlan::Append { start, end, .. }, _) => {
            if state.committed_bytes != Some(*start) || end <= start {
                return Ok(false);
            }
            Ok(directory.open_regular_file(name)?.metadata()?.len() == *start)
        }
        (
            MutationPlan::Metadata { relative_path, .. },
            Some(MutationPlan::Metadata {
                relative_path: committed_path,
                length,
                sha256,
            }),
        ) if relative_path == committed_path => {
            let (target, target_name) =
                metadata_target(source_path, directory, relative_path, false)?;
            let Ok(file) = target.open_regular_file(&target_name) else {
                return Ok(false);
            };
            Ok(verify_range(file, 0, *length, sha256).is_ok())
        }
        _ => Ok(false),
    }
}

/// Verify under the source lock without advancing its receipt or changing authority bytes.
pub(super) fn verify_completed_pending(
    source_path: &Path,
    directory: &PrivateDirectory,
    name: &OsStr,
    record: &SourceRecord,
) -> Result<()> {
    if unstarted_pending(source_path, directory, name, record)? {
        return Ok(());
    }
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
