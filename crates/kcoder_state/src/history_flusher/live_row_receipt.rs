//! Exact row identity from the same held source append as its batch.
use super::*;
use crate::history_store::LiveAppendReceipt;
use anyhow::{Context, Result, ensure};
use kcoder_types::TurnAttemptIdentity;
use sha2::{Digest, Sha256};

/// Process-local held evidence. It is not serializable, a fresh-session
/// lineage, a source grant, or proof the model consumed this entry.
pub struct NativeHistoryRowReceipt {
    batch: LiveAppendReceipt,
    session_id: String,
    uuid: String,
    attempt: Option<TurnAttemptIdentity>,
    start: u64,
    end: u64,
    sha256: String,
}

impl NativeHistoryRowReceipt {
    #[cfg(target_os = "linux")]
    pub(crate) fn verify_lineage_identity(
        &self,
        entry: &HistoryEntry,
        original: &LiveAppendReceipt,
    ) -> Result<()> {
        ensure!(
            self.session_id == entry.session_id
                && entry.uuid.as_deref() == Some(self.uuid.as_str())
                && self.attempt == entry.history_attempt,
            "native history row identity differs"
        );
        self.batch.same_original_lineage_commit(original)?;
        ensure!(
            original.matches_lineage_row(self.start, self.end, &self.sha256),
            "native history row is not the tracked original batch"
        );
        Ok(())
    }

    /// Run on a bounded blocking worker outside State/activity locks. The host
    /// separately verifies accepted source, current gate and native authority.
    pub fn verify_entry(
        &mut self,
        session_id: &str,
        uuid: &str,
        attempt: Option<&TurnAttemptIdentity>,
        message: &Message,
        max_bytes: u64,
    ) -> Result<()> {
        ensure!(
            self.session_id == session_id && self.uuid == uuid && self.attempt.as_ref() == attempt,
            "history row identity differs"
        );
        let bytes = self
            .batch
            .read_verified_row(self.start, self.end, &self.sha256, max_bytes)?;
        let row: HistoryEntry = serde_json::from_slice(&bytes).context("history row is invalid")?;
        ensure!(
            row.session_id == session_id
                && row.uuid.as_deref() == Some(uuid)
                && row.history_attempt.as_ref() == attempt
                && row.message == *message,
            "history row contents differ"
        );
        Ok(())
    }
}

/// The caller must retain the original batch on source uncertainty and must
/// never replay it automatically. Missing source is not materialized here.
pub(super) fn flush_with_live_row_receipt(
    source: &HistorySource,
    batch: &mut Vec<HistoryEntry>,
    target_uuid: &str,
) -> Result<NativeHistoryRowReceipt> {
    ensure!(
        !batch.is_empty() && !target_uuid.is_empty(),
        "history row request is invalid"
    );
    let mut encoded = Vec::new();
    let mut selected = None;
    for entry in batch.iter() {
        let start = u64::try_from(encoded.len())?;
        serde_json::to_writer(&mut encoded, entry)?;
        encoded.push(b'\n');
        let end = u64::try_from(encoded.len())?;
        if entry.uuid.as_deref() == Some(target_uuid) {
            ensure!(selected.is_none(), "history row identity is ambiguous");
            let first = usize::try_from(start)?;
            let last = usize::try_from(end)?;
            selected = Some((
                entry.session_id.clone(),
                entry.history_attempt.clone(),
                start,
                end,
                format!("{:x}", Sha256::digest(&encoded[first..last])),
            ));
        }
    }
    let (session_id, attempt, local_start, local_end, sha256) =
        selected.context("history row was not in the writer batch")?;
    let receipt = source.append_with_live_receipt(&encoded)?;
    // Authority already committed; clear the batch before any later validation
    // so a metadata failure cannot cause an automatic duplicate append.
    batch.clear();
    let (batch_start, batch_end) = receipt.range();
    let range = (|| -> Result<(u64, u64)> {
        ensure!(
            batch_end.checked_sub(batch_start) == Some(u64::try_from(encoded.len())?),
            "history batch range differs"
        );
        let start = batch_start
            .checked_add(local_start)
            .context("history row offset overflow")?;
        let end = batch_start
            .checked_add(local_end)
            .context("history row offset overflow")?;
        ensure!(start < end && end <= batch_end, "history row range differs");
        Ok((start, end))
    })()
    .map_err(crate::history_store::committed_evidence_invalid)?;
    Ok(NativeHistoryRowReceipt {
        batch: receipt,
        session_id,
        uuid: target_uuid.into(),
        attempt,
        start: range.0,
        end: range.1,
        sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(uuid: &str, text: &str) -> HistoryEntry {
        HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: 1,
            uuid: Some(uuid.into()),
            parent_uuid: None,
            message: Message::user_text(text),
            history_attempt: Some(TurnAttemptIdentity {
                thread_id: "session".into(),
                turn_id: "turn".into(),
                attempt_id: "attempt".into(),
            }),
            web_sources: Vec::new(),
        }
    }

    #[test]
    fn held_receipt_selects_the_exact_row_from_one_committed_batch() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("session.jsonl");
        std::fs::write(&path, b"")?;
        let source = HistorySource::bind(&path)?;
        let target = entry("second", "target message");
        let mut batch = vec![entry("first", "earlier"), target.clone()];
        let mut receipt = flush_with_live_row_receipt(&source, &mut batch, "second")?;
        assert!(batch.is_empty());
        receipt.verify_entry(
            "session",
            "second",
            target.history_attempt.as_ref(),
            &target.message,
            4096,
        )?;
        assert!(
            receipt
                .verify_entry(
                    "session",
                    "second",
                    target.history_attempt.as_ref(),
                    &Message::user_text("changed"),
                    4096
                )
                .is_err()
        );
        assert!(
            receipt
                .verify_entry(
                    "session",
                    "first",
                    target.history_attempt.as_ref(),
                    &target.message,
                    4096
                )
                .is_err()
        );
        assert_eq!(crate::load_history(&path)?.len(), 2);
        Ok(())
    }

    #[test]
    fn duplicate_or_missing_row_is_rejected_before_any_source_write() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("session.jsonl");
        std::fs::write(&path, b"")?;
        let source = HistorySource::bind(&path)?;
        let mut duplicate = vec![entry("same", "one"), entry("same", "two")];
        assert!(flush_with_live_row_receipt(&source, &mut duplicate, "same").is_err());
        assert_eq!(duplicate.len(), 2);
        let mut missing = vec![entry("other", "one")];
        assert!(flush_with_live_row_receipt(&source, &mut missing, "absent").is_err());
        assert_eq!(missing.len(), 1);
        assert!(std::fs::read(&path)?.is_empty());
        assert!(!path.with_extension("hctl").exists());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn held_row_rejects_same_content_replacement() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("session.jsonl");
        std::fs::write(&path, b"")?;
        let source = HistorySource::bind(&path)?;
        let target = entry("target", "original");
        let mut receipt =
            flush_with_live_row_receipt(&source, &mut vec![target.clone()], "target")?;
        let bytes = std::fs::read(&path)?;
        let saved = temp.path().join("original-held.jsonl");
        std::fs::rename(&path, &saved)?;
        std::fs::write(&path, &bytes)?;
        assert!(
            receipt
                .verify_entry(
                    "session",
                    "target",
                    target.history_attempt.as_ref(),
                    &target.message,
                    4096
                )
                .is_err()
        );
        assert_eq!(std::fs::read(saved)?, bytes);
        Ok(())
    }

    #[test]
    fn a_later_append_requires_reconciliation_instead_of_reusing_old_evidence() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("session.jsonl");
        std::fs::write(&path, b"")?;
        let source = HistorySource::bind(&path)?;
        let target = entry("target", "original");
        let mut receipt =
            flush_with_live_row_receipt(&source, &mut vec![target.clone()], "target")?;
        source.append(b"{}\n")?;
        assert!(
            receipt
                .verify_entry(
                    "session",
                    "target",
                    target.history_attempt.as_ref(),
                    &target.message,
                    4096
                )
                .is_err()
        );
        Ok(())
    }
}
