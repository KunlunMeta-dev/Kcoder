use super::journal::{JournalDomain, JournalFence, current_watermark};
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::path::Path;

/// A short read/publication fence, not a lock to retain across source loading,
/// provider requests, async waits or client page navigation.
pub struct TranscriptReadFence {
    proof: Vec<u8>,
    _history: JournalFence,
    _client: JournalFence,
}
impl TranscriptReadFence {
    /// Requires previously activated tracking; never implicitly opts into external-writer semantics.
    pub fn acquire(history: &Path, client: &Path, scope: &str) -> Result<Option<Self>> {
        ensure!(
            !scope.is_empty() && scope.len() <= 8192,
            "invalid transcript receipt scope"
        );
        let history = dunce::canonicalize(history)?;
        let client = dunce::canonicalize(client)?;
        ensure!(
            history.as_os_str().len() <= 8192 && client.as_os_str().len() <= 8192,
            "transcript root exceeds budget"
        );
        // Read-only probes avoid creating fence files when indexing was never enabled.
        if current_watermark(&history, JournalDomain::History)?.is_none()
            || current_watermark(&client, JournalDomain::ClientMetadata)?.is_none()
        {
            return Ok(None);
        }
        // All dual-domain users take the source fence first, then client metadata.
        let source_fence = JournalFence::try_acquire(&history, JournalDomain::History)?;
        let client_fence = JournalFence::try_acquire(&client, JournalDomain::ClientMetadata)?;
        let Some(source) = current_watermark(&history, JournalDomain::History)? else {
            return Ok(None);
        };
        let Some(metadata) = current_watermark(&client, JournalDomain::ClientMetadata)? else {
            return Ok(None);
        };
        let bytes = serde_json::to_vec(&(
            "kcoder.transcript-receipt.v1",
            scope,
            &history,
            &client,
            source,
            metadata,
        ))?;
        Ok(Some(Self {
            proof: Sha256::digest(bytes).to_vec(),
            _history: source_fence,
            _client: client_fence,
        }))
    }
    pub fn proof(&self) -> &[u8] {
        &self.proof
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history_index::journal::{JournalDomain, JournalFence};

    #[test]
    fn transcript_receipt_requires_tracking_and_fences_both_domains() {
        let history = tempfile::tempdir().unwrap();
        let client = tempfile::tempdir().unwrap();
        assert!(
            TranscriptReadFence::acquire(history.path(), client.path(), "thread")
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_dir(history.path()).unwrap().count(), 0);
        for (root, domain) in [
            (history.path(), JournalDomain::History),
            (client.path(), JournalDomain::ClientMetadata),
        ] {
            JournalFence::try_acquire(root, domain)
                .unwrap()
                .activate()
                .unwrap();
        }
        let receipt = TranscriptReadFence::acquire(history.path(), client.path(), "thread")
            .unwrap()
            .unwrap();
        let proof = receipt.proof().to_vec();
        assert!(!proof.is_empty());
        let mut store =
            crate::history_index::TranscriptPageStore::open(client.path(), "thread", true)
                .unwrap()
                .unwrap();
        let generation = store.begin().unwrap();
        store
            .append(&generation, &[serde_json::json!({"id":"row"})])
            .unwrap();
        store.publish(&generation, receipt.proof()).unwrap();
        assert_eq!(
            store
                .page(&generation, receipt.proof(), None, 1, 1024)
                .unwrap()
                .rows
                .len(),
            1
        );
        assert!(JournalFence::try_acquire(history.path(), JournalDomain::History).is_err());
        assert!(JournalFence::try_acquire(client.path(), JournalDomain::ClientMetadata).is_err());
        drop(receipt);
        let mut writer = JournalFence::try_acquire(history.path(), JournalDomain::History).unwrap();
        writer.begin("thread").unwrap().finish().unwrap();
        drop(writer);
        let receipt = TranscriptReadFence::acquire(history.path(), client.path(), "thread")
            .unwrap()
            .unwrap();
        assert_ne!(receipt.proof(), proof);
        assert!(store.current_generation(receipt.proof()).unwrap().is_none());
        assert!(
            store
                .page(&generation, receipt.proof(), None, 1, 1024)
                .is_err()
        );
    }

    #[test]
    fn transcript_receipt_changes_with_scope_metadata_and_reactivation() {
        let history = tempfile::tempdir().unwrap();
        let client = tempfile::tempdir().unwrap();
        for (root, domain) in [
            (history.path(), JournalDomain::History),
            (client.path(), JournalDomain::ClientMetadata),
        ] {
            JournalFence::try_acquire(root, domain)
                .unwrap()
                .activate()
                .unwrap();
        }
        let proof = |scope| {
            TranscriptReadFence::acquire(history.path(), client.path(), scope)
                .unwrap()
                .unwrap()
                .proof()
                .to_vec()
        };
        let original = proof("thread-a");
        assert_eq!(original, proof("thread-a"));
        assert_ne!(original, proof("thread-b"));
        let mut writer =
            JournalFence::try_acquire(client.path(), JournalDomain::ClientMetadata).unwrap();
        writer.begin("thread-a").unwrap().finish().unwrap();
        drop(writer);
        let metadata_changed = proof("thread-a");
        assert_ne!(original, metadata_changed);
        JournalFence::try_acquire(history.path(), JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
        assert_ne!(metadata_changed, proof("thread-a"));
        let mut writer =
            JournalFence::try_acquire(client.path(), JournalDomain::ClientMetadata).unwrap();
        drop(writer.begin("thread-a").unwrap());
        drop(writer);
        assert!(
            TranscriptReadFence::acquire(history.path(), client.path(), "thread-a").is_err()
                || TranscriptReadFence::acquire(history.path(), client.path(), "thread-a")
                    .unwrap()
                    .is_none()
        );
    }
}
