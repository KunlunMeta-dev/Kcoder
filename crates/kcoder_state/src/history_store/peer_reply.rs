//! Bounded explicit-reference fallback for a compacted original Source history.
use super::*;
use kcoder_types::session_address::SessionAddressV1;
use std::io::{BufRead, BufReader};

const MAX_REPLY_HISTORY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REPLY_HISTORY_ROWS: usize = 10_000;
const MAX_REPLY_ROW_BYTES: u64 = 2 * 1024 * 1024;
#[cfg(test)]
thread_local! { static SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(crate) fn take_reply_history_scans() -> usize {
    SCANS.with(|count| count.replace(0))
}

impl HistorySource {
    pub(crate) fn contains_received_reply(
        &self,
        source: &SessionAddressV1,
        destination: &SessionAddressV1,
        id: &str,
    ) -> Result<bool> {
        #[cfg(test)]
        SCANS.with(|count| count.set(count.get() + 1));
        let binding = self
            .binding
            .try_lock()
            .map_err(|_| anyhow::anyhow!("PEER_REPLY_HISTORY_BUSY"))?;
        anyhow::ensure!(binding.initialized, "PEER_REPLY_HISTORY_UNAVAILABLE");
        let (directory, name) = open_parent_with_create(&self.path, false)?;
        let lock = existing_file(&directory, OsStr::new(MUTATION_LOCK))?
            .context("PEER_REPLY_HISTORY_UNAVAILABLE")?;
        FileExt::try_lock_shared(&lock).context("PEER_REPLY_HISTORY_BUSY")?;
        let _lock = PrivateFileLock::from_locked(lock);
        let observed = read_source_record(&directory, &name)?;
        binding.verify(observed.as_ref())?;
        if let Some(commit) = observed.as_ref().and_then(|record| record.commit.as_ref()) {
            commit.check_ready()?;
        }
        let file = existing_file(&directory, &name)?.context("PEER_REPLY_HISTORY_UNAVAILABLE")?;
        anyhow::ensure!(
            file.metadata()?.len() <= MAX_REPLY_HISTORY_BYTES,
            "PEER_REPLY_HISTORY_BUDGET"
        );
        let mut reader = BufReader::new(file);
        let mut rows = 0;
        let mut found = false;
        loop {
            let mut line = Vec::new();
            let count = reader
                .by_ref()
                .take(MAX_REPLY_ROW_BYTES + 1)
                .read_until(b'\n', &mut line)?;
            if count == 0 {
                break;
            }
            rows += 1;
            anyhow::ensure!(
                rows <= MAX_REPLY_HISTORY_ROWS && count as u64 <= MAX_REPLY_ROW_BYTES,
                "PEER_REPLY_HISTORY_BUDGET"
            );
            let entry: crate::HistoryEntry =
                serde_json::from_slice(&line).context("PEER_REPLY_HISTORY_INVALID")?;
            anyhow::ensure!(
                entry.session_id == source.thread_id,
                "PEER_REPLY_HISTORY_CHANGED"
            );
            if crate::peer_agent_history::reply_metadata_matches(
                &entry.message,
                source,
                destination,
                id,
            )? {
                anyhow::ensure!(!found, "PEER_REPLY_REFERENCE_AMBIGUOUS");
                found = true;
            }
        }
        binding.verify(read_source_record(&directory, &name)?.as_ref())?;
        Ok(found)
    }
}
