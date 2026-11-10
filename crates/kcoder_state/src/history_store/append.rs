use super::{
    HistorySource, IdentifiedAppendOutcome, MUTATION_LOCK, Mutation, existing_file,
    open_parent_with_create, read_source_record, validate_append,
};
use anyhow::{Context, Result};
use fs2::FileExt;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{BufRead, BufReader};

impl HistorySource {
    /// Inspect UUIDs and append while holding the same cross-process mutation lock.
    pub(crate) fn append_unique(&self, bytes: &[u8], uuid: &str) -> Result<bool> {
        self.append_unique_when(bytes, uuid, || Ok(true))
    }

    pub(crate) fn append_unique_when(
        &self,
        bytes: &[u8],
        uuid: &str,
        allowed: impl FnOnce() -> Result<bool>,
    ) -> Result<bool> {
        validate_append(bytes)?;
        let mut appended = true;
        self.mutate_when_optional(None, false, || {
            if !allowed()? {
                appended = false;
                return Ok(None);
            }
            if self.path.exists() {
                for line in BufReader::new(File::open(&self.path)?).lines() {
                    let value: serde_json::Value = serde_json::from_str(&line?)?;
                    if value.get("uuid").and_then(serde_json::Value::as_str) == Some(uuid) {
                        appended = false;
                        break;
                    }
                }
            }
            Ok(appended.then_some(Mutation::Append(bytes)))
        })?;
        Ok(appended)
    }

    /// Append one identified user entry, or confirm the exact existing row
    /// while holding the same cross-process mutation lock used by writers.
    /// A reused UUID with different content or a repeated UUID is a conflict.
    pub(crate) fn append_identified_or_verify(
        &self,
        entry: &crate::HistoryEntry,
    ) -> Result<IdentifiedAppendOutcome> {
        anyhow::ensure!(
            matches!(
                &entry.message,
                kcoder_types::Message::User {
                    origin: kcoder_types::MessageOrigin::User,
                    ..
                }
            ),
            "identified history append requires an original user message"
        );
        let uuid = entry
            .uuid
            .as_deref()
            .context("identified history entry has no UUID")?;
        let mut bytes = serde_json::to_vec(entry)?;
        bytes.push(b'\n');
        validate_append(&bytes)?;
        let mut outcome = IdentifiedAppendOutcome::Appended;
        self.mutate_when_optional_with_source(None, false, |directory, name| {
            if let Some(existing) = find_identified_entry(
                existing_file(directory, name)?,
                uuid,
                &entry.session_id,
                &entry.message,
            )? {
                outcome = existing;
                return Ok(None);
            }
            Ok(Some(Mutation::Append(&bytes)))
        })?;
        Ok(outcome)
    }

    /// Inspect an identified row without changing the source. The body read
    /// and source-generation check share the cross-process mutation lock.
    pub(crate) fn inspect_identified(
        &self,
        uuid: &str,
        session_id: &str,
        message: &kcoder_types::Message,
    ) -> Result<bool> {
        let binding = self
            .binding
            .lock()
            .map_err(|_| anyhow::anyhow!("history source binding lock is poisoned"))?;
        anyhow::ensure!(
            binding.initialized,
            "history source is not initialized; identified receipt remains unknown"
        );
        let (directory, name) = open_parent_with_create(&self.path, false)?;
        let lock = existing_file(&directory, OsStr::new(MUTATION_LOCK))?
            .context("history source mutation lock is missing")?;
        FileExt::lock_exclusive(&lock).context("failed to lock identified history inspection")?;
        let observed = read_source_record(&directory, &name)?;
        binding.verify(observed.as_ref())?;
        if let Some(commit) = observed.as_ref().and_then(|record| record.commit.as_ref()) {
            commit.check_ready()?;
        }
        let existing =
            find_identified_entry(existing_file(&directory, &name)?, uuid, session_id, message)?;
        Ok(existing.is_some())
    }
}

fn find_identified_entry(
    file: Option<File>,
    uuid: &str,
    session_id: &str,
    message: &kcoder_types::Message,
) -> Result<Option<IdentifiedAppendOutcome>> {
    let Some(file) = file else {
        return Ok(None);
    };
    let mut found = false;
    for line in BufReader::new(file).lines() {
        let line = line.context("failed to read identified history row")?;
        let value: serde_json::Value = serde_json::from_str(&line)
            .context("history row is invalid while checking an identified UUID")?;
        if value.get("uuid").and_then(serde_json::Value::as_str) != Some(uuid) {
            continue;
        }
        anyhow::ensure!(!found, "identified history UUID occurs more than once");
        let entry: crate::HistoryEntry = serde_json::from_str(&line)
            .context("identified history row has duplicate or invalid fields")?;
        anyhow::ensure!(
            entry.session_id == session_id && entry.uuid.as_deref() == Some(uuid),
            "identified history UUID belongs to a different session"
        );
        anyhow::ensure!(
            entry.message == *message,
            "identified history UUID conflicts with different message content"
        );
        found = true;
    }
    Ok(found.then_some(IdentifiedAppendOutcome::AlreadyPresent))
}
