//! A withheld result is not evidence that its body reached the model.
use super::{AppState, FileReadSnapshot, ReadRangeKey, normalize_read_snapshot_path};
use std::path::Path;

impl AppState {
    /// Called only with a trusted Native read receipt's original cache coordinates.
    /// Retain physical-read/stale-write facts, but force the next Read to return a body.
    pub fn revoke_unpublished_read_result(
        &self,
        path: &Path,
        offset: Option<usize>,
        limit: Option<usize>,
        covers_entire_file: bool,
    ) {
        let mut inner = self.write_inner();
        let path = normalize_read_snapshot_path(path, &inner.cwd);
        let range = ReadRangeKey::new(offset, limit);
        if let Some(snapshot) = inner.file_reads.get_mut(&path)
            && ReadRangeKey::new(snapshot.offset, snapshot.limit) == range
        {
            revoke(snapshot);
        }
        if (covers_entire_file || range.is_full())
            && let Some(snapshot) = inner.full_file_reads.get_mut(&path)
        {
            revoke(snapshot);
        }
    }
}
fn revoke(snapshot: &mut FileReadSnapshot) {
    snapshot.from_read_tool = false;
    snapshot.anchor_pending = false;
    snapshot.full_body_compacted = false;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn withheld_body_retains_stale_write_bytes_without_hiding_a_peer_result() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let rejected = root.path().join("rejected.txt");
        let peer = root.path().join("peer.txt");
        for path in [&rejected, &peer] {
            state.record_read_tool_snapshot_with_encoding(
                path.clone(),
                Some("original observed bytes".into()),
                None,
                None,
                None,
                "auto",
            );
        }
        state.revoke_unpublished_read_result(&rejected, None, None, true);
        let saved = state.full_file_read_snapshot(&rejected).unwrap();
        assert_eq!(saved.content.as_deref(), Some("original observed bytes"));
        assert!(!saved.from_read_tool);
        assert!(!saved.anchor_pending && !saved.full_body_compacted);
        assert!(state.full_file_read_snapshot(&peer).unwrap().from_read_tool);
    }
    #[test]
    fn a_rejected_range_does_not_revoke_a_separately_published_full_read() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let path = root.path().join("range.txt");
        state.record_read_tool_snapshot_with_encoding(
            path.clone(),
            Some("entire body".into()),
            None,
            None,
            None,
            "auto",
        );
        state.record_read_tool_snapshot_with_encoding(
            path.clone(),
            None,
            None,
            Some(2),
            Some(1),
            "auto",
        );
        state.revoke_unpublished_read_result(&path, Some(2), Some(1), false);
        assert!(state.full_file_read_snapshot(&path).unwrap().from_read_tool);
        assert!(
            !state
                .file_read_snapshot_for_request(&path, Some(2), Some(1))
                .unwrap()
                .from_read_tool
        );
    }
}
