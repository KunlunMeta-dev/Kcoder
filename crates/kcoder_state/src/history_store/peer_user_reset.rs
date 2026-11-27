//! Independent facts from a genuinely new native User append, never a history observation.
use super::*;
use crate::peer_wake_budget::{FreshPeerUserAppend, PeerWakeUserResetReference};
use anyhow::ensure;
use sha2::{Digest, Sha256};

pub(crate) struct UserResetRow {
    session_id: String,
    uuid: String,
    local_start: u64,
    local_end: u64,
    sha256: String,
}
impl UserResetRow {
    pub(crate) fn from_encoded_entry(
        entry: &crate::HistoryEntry,
        start: u64,
        end: u64,
        bytes: &[u8],
    ) -> Result<Option<Self>> {
        if !kcoder_types::is_real_user_message(&entry.message) {
            return Ok(None);
        }
        let uuid = entry
            .uuid
            .clone()
            .context("native User input has no UUID")?;
        ensure!(
            start < end && end <= bytes.len() as u64,
            "native User row range is invalid"
        );
        Ok(Some(Self {
            session_id: entry.session_id.clone(),
            uuid,
            local_start: start,
            local_end: end,
            sha256: format!("{:x}", Sha256::digest(&bytes[start as usize..end as usize])),
        }))
    }
}

fn rebind_user_reset_row(
    bytes: &[u8],
    expected: Option<UserResetRow>,
) -> Result<Option<UserResetRow>> {
    let Some(expected) = expected else {
        return Ok(None);
    };
    let mut offset = 0_u64;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        let end = offset
            .checked_add(u64::try_from(line.len())?)
            .context("native User row offset overflow")?;
        let entry: crate::HistoryEntry = serde_json::from_slice(line)
            .context("native User row is invalid after attachment path encoding")?;
        if entry.uuid.as_deref() == Some(expected.uuid.as_str()) {
            ensure!(
                entry.session_id == expected.session_id,
                "native User row session changed after attachment path encoding"
            );
            return UserResetRow::from_encoded_entry(&entry, offset, end, bytes);
        }
        offset = end;
    }
    anyhow::bail!("native User row disappeared during attachment path encoding")
}

impl HistorySource {
    pub(crate) fn verify_peer_user_reset(
        &self,
        reference: &PeerWakeUserResetReference,
    ) -> Result<()> {
        reference.validate()?;
        let binding = self
            .binding
            .try_lock()
            .map_err(|_| anyhow::anyhow!("PEER_WAKE_USER_SOURCE_BUSY"))?;
        let (directory, name) = open_parent_with_create(&self.path, false)?;
        let lock = directory.open_single_link_regular_file(OsStr::new(MUTATION_LOCK))?;
        FileExt::try_lock_shared(&lock).context("PEER_WAKE_USER_SOURCE_WRITER_BUSY")?;
        let _lock = PrivateFileLock::from_locked(lock);
        let record =
            read_source_record(&directory, &name)?.context("PEER_WAKE_USER_SOURCE_MISSING")?;
        binding.verify(Some(&record))?;
        ensure!(
            !record.deleted
                && record.incarnation == reference.incarnation
                && record.body_generation() == reference.body_generation,
            "PEER_WAKE_USER_SOURCE_GENERATION_CHANGED"
        );
        let commit = record
            .commit
            .as_ref()
            .context("PEER_WAKE_USER_BOUNDARY_UNKNOWN")?;
        commit.check_ready()?;
        let body = directory.open_single_link_regular_file(&name)?;
        ensure!(
            directory.portable_regular_handle_identity(&body)? == reference.body_file
                && commit
                    .committed_bytes
                    .is_some_and(|bytes| bytes >= reference.row_end)
                && body.metadata()?.len() == commit.committed_bytes.unwrap_or(0),
            "PEER_WAKE_USER_NATIVE_ROW_CHANGED"
        );
        Ok(())
    }
    pub(crate) fn append_with_user_reset(
        &self,
        bytes: &[u8],
        row: Option<UserResetRow>,
        live: bool,
    ) -> Result<(
        Option<live_append_receipt::LiveAppendReceipt>,
        Option<FreshPeerUserAppend>,
    )> {
        let encoded = self.encode_history_rows(bytes)?;
        validate_append(encoded.as_ref())?;
        let row = if matches!(&encoded, std::borrow::Cow::Owned(_)) {
            rebind_user_reset_row(encoded.as_ref(), row)?
        } else {
            row
        };
        let before = std::cell::Cell::new(0u64);
        self.mutate_with_receipt_observer(
            None,
            false,
            live,
            |directory, name| {
                before.set(
                    existing_file(directory, name)?
                        .map(|file| file.metadata().map(|metadata| metadata.len()))
                        .transpose()?
                        .unwrap_or(0),
                );
                Ok(Some(if live {
                    Mutation::AppendWitnessed(encoded.as_ref())
                } else {
                    Mutation::Append(encoded.as_ref())
                }))
            },
            |directory, name, incarnation, generation| {
                row.map(|row| {
                    build_fact(
                        self,
                        directory,
                        name,
                        incarnation,
                        generation,
                        before.get(),
                        row,
                    )
                })
                .transpose()
            },
        )
        .map(|(receipt, fact)| (receipt, fact.flatten()))
    }

    pub(crate) fn append_identified_with_user_reset(
        &self,
        entry: &crate::HistoryEntry,
    ) -> Result<(IdentifiedAppendOutcome, Option<FreshPeerUserAppend>)> {
        if !kcoder_types::is_real_user_message(&entry.message) {
            return self
                .append_identified_or_verify(entry)
                .map(|outcome| (outcome, None));
        }
        let uuid = entry
            .uuid
            .as_deref()
            .context("identified input has no UUID")?;
        ensure!(
            kcoder_types::is_real_user_message(&entry.message)
                || entry.message.peer_agent_data().is_some(),
            "identified input source is invalid"
        );
        let mut stored_entry = entry.clone();
        crate::history_attachment_paths::encode_entry(&self.path, &mut stored_entry)?;
        let mut bytes = serde_json::to_vec(&stored_entry)?;
        bytes.push(b'\n');
        validate_append(&bytes)?;
        let row = UserResetRow::from_encoded_entry(&stored_entry, 0, bytes.len() as u64, &bytes)?;
        let mut outcome = IdentifiedAppendOutcome::Appended;
        let before = std::cell::Cell::new(0u64);
        let (_, fact) = self.mutate_with_receipt_observer(
            None,
            false,
            false,
            |directory, name| {
                if let Some(existing) = super::append::find_identified_entry(
                    existing_file(directory, name)?,
                    &self.path,
                    uuid,
                    &entry.session_id,
                    &entry.message,
                )? {
                    outcome = existing;
                    return Ok(None);
                }
                before.set(
                    existing_file(directory, name)?
                        .map(|file| file.metadata().map(|metadata| metadata.len()))
                        .transpose()?
                        .unwrap_or(0),
                );
                Ok(Some(Mutation::Append(&bytes)))
            },
            |directory, name, incarnation, generation| {
                row.map(|row| {
                    build_fact(
                        self,
                        directory,
                        name,
                        incarnation,
                        generation,
                        before.get(),
                        row,
                    )
                })
                .transpose()
            },
        )?;
        Ok((outcome, fact.flatten()))
    }
}
fn build_fact(
    source: &HistorySource,
    directory: &PrivateDirectory,
    name: &OsStr,
    incarnation: uuid::Uuid,
    generation: uuid::Uuid,
    before: u64,
    row: UserResetRow,
) -> Result<FreshPeerUserAppend> {
    let start = before
        .checked_add(row.local_start)
        .context("native User offset overflow")?;
    let end = before
        .checked_add(row.local_end)
        .context("native User offset overflow")?;
    let file = directory.open_single_link_regular_file(name)?;
    ensure!(
        file.metadata()?.len() >= end,
        "native User row did not reach its committed boundary"
    );
    let record =
        read_source_record(directory, name)?.context("native User source control is missing")?;
    ensure!(
        !record.deleted
            && record.incarnation == incarnation
            && record.body_generation() == generation,
        "native User source control changed"
    );
    let commit = record
        .commit
        .as_ref()
        .context("native User committed boundary is unknown")?;
    commit.check_ready()?;
    ensure!(
        commit.committed_bytes.is_some_and(|bytes| bytes >= end),
        "native User committed boundary is unknown"
    );
    Ok(FreshPeerUserAppend::from_native_writer(
        source.clone(),
        PeerWakeUserResetReference::from_native_writer(
            row.session_id,
            incarnation,
            generation,
            row.uuid,
            start,
            end,
            row.sha256,
            directory.portable_regular_handle_identity(&file)?,
        ),
    ))
}
