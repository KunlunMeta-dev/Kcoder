use super::journal::{JournalDomain, JournalFence};
use anyhow::Result;
use std::path::Path;

/// Native identity of the exact opened input handle; not a permission or freshness decision.
pub fn transcript_input_identity(file: &std::fs::File) -> std::io::Result<(u64, u64)> {
    super::files::file_identity(file)
}

/// A short, request-local copy/validation fence. It owns no tracking epoch or reusable receipt.
/// Source loading, parsing, provider work and async waits must remain outside its lifetime.
pub struct TranscriptObservationFence {
    _history: JournalFence,
    _client: JournalFence,
}

impl TranscriptObservationFence {
    /// Acquire only existing writer fences, in the same order used by indexed publication.
    /// Missing fences mean no proof; this never creates files, roots, journals or tracking tokens.
    pub fn acquire_existing(history: &Path, client: &Path) -> Result<Option<Self>> {
        let Some(history) = JournalFence::try_acquire_existing(history, JournalDomain::History)?
        else {
            return Ok(None);
        };
        let Some(client) =
            JournalFence::try_acquire_existing(client, JournalDomain::ClientMetadata)?
        else {
            return Ok(None);
        };
        Ok(Some(Self {
            _history: history,
            _client: client,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history_index::journal::current_watermark;

    #[test]
    fn transcript_observation_fence_never_creates_or_activates_tracking() {
        let history = tempfile::tempdir().unwrap();
        let client = tempfile::tempdir().unwrap();
        assert!(
            TranscriptObservationFence::acquire_existing(history.path(), client.path())
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_dir(history.path()).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(client.path()).unwrap().count(), 0);
        for (root, domain) in [
            (history.path(), JournalDomain::History),
            (client.path(), JournalDomain::ClientMetadata),
        ] {
            drop(JournalFence::try_acquire(root, domain).unwrap());
        }
        let fence = TranscriptObservationFence::acquire_existing(history.path(), client.path())
            .unwrap()
            .unwrap();
        assert!(
            current_watermark(history.path(), JournalDomain::History)
                .unwrap()
                .is_none()
        );
        assert!(
            current_watermark(client.path(), JournalDomain::ClientMetadata)
                .unwrap()
                .is_none()
        );
        assert!(JournalFence::try_acquire(history.path(), JournalDomain::History).is_err());
        assert!(JournalFence::try_acquire(client.path(), JournalDomain::ClientMetadata).is_err());
        drop(fence);
        assert_eq!(std::fs::read_dir(history.path()).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(client.path()).unwrap().count(), 1);
    }

    #[test]
    fn transcript_observation_fence_releases_history_if_client_fence_is_missing_or_busy() {
        let history = tempfile::tempdir().unwrap();
        let client = tempfile::tempdir().unwrap();
        drop(JournalFence::try_acquire(history.path(), JournalDomain::History).unwrap());
        assert!(
            TranscriptObservationFence::acquire_existing(history.path(), client.path())
                .unwrap()
                .is_none()
        );
        drop(JournalFence::try_acquire(history.path(), JournalDomain::History).unwrap());
        let writer =
            JournalFence::try_acquire(client.path(), JournalDomain::ClientMetadata).unwrap();
        assert!(
            TranscriptObservationFence::acquire_existing(history.path(), client.path()).is_err()
        );
        drop(JournalFence::try_acquire(history.path(), JournalDomain::History).unwrap());
        drop(writer);
    }
}
