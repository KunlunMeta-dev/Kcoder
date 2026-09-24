//! List projections under the application-writer / explicit external refresh contract.

use crate::history_metadata::{HistoryTimestampBounds, prepare_session_metadata_bounded};
use crate::history_store::{SourceStamp, committed_source_stamp};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const HEAD_BYTES: usize = 64 * 1024;
const MAX_SIDECAR_BYTES: u64 = 1024 * 1024;

/// Opaque full source-control state; not authority for externally edited files.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct CommittedHistoryStamp(SourceStamp);

/// A bounded projection of complete application-committed records.
/// Application writes advance the control stamp; external edits require `read`, not `update`.
/// Legacy/unknown boundaries and pending commits fail closed without repairing the source.
#[derive(Clone)]
pub struct CommittedListProjection {
    path: PathBuf,
    stamp: CommittedHistoryStamp,
    offset: u64,
    head: Vec<u8>,
    first_timestamp: Option<u64>,
    latest_timestamp: Option<u64>,
    first_prompt: Option<String>,
    base_cwd: Option<PathBuf>,
    session_mode: crate::SessionMode,
    workflow_definition_id: Option<String>,
    timestamps: (u64, u64),
    bytes_read: u64,
}

impl CommittedListProjection {
    /// Rebuild from byte zero. Externally edited lengths first require source-boundary recovery.
    /// Budgets bound this call's body bytes and each raw line (including its newline).
    /// Sidecars consume at most 1 MiB + 1 byte; each source-control read is at most 4097 bytes.
    pub fn read(path: &Path, max_bytes: u64, max_line_bytes: usize) -> Result<Self> {
        Self::read_inner(path, None, max_bytes, max_line_bytes, |_| Ok(()))
    }

    /// Consume only an appended committed suffix; a new body generation forces a full rebuild.
    /// An unchanged stamp performs no body or sidecar I/O. Errors leave this snapshot unchanged.
    pub fn update(&self, max_bytes: u64, max_line_bytes: usize) -> Result<Self> {
        Self::read_inner(
            &self.path,
            Some(self),
            max_bytes,
            max_line_bytes,
            |_| Ok(()),
        )
    }

    /// Actual body bytes consumed by the last successful read/update, excluding control/sidecar.
    pub fn bytes_read(&self) -> u64 {
        self.bytes_read
    }

    pub fn source_stamp(&self) -> &CommittedHistoryStamp {
        &self.stamp
    }

    pub fn committed_offset(&self) -> u64 {
        self.offset
    }

    pub fn first_prompt(&self) -> Option<&str> {
        self.first_prompt.as_deref()
    }

    /// Workspace ownership must be checked by the caller before publishing this projection.
    pub fn base_cwd(&self) -> Option<&Path> {
        self.base_cwd.as_deref()
    }

    pub fn workflow_definition_id(&self) -> Option<&str> { self.workflow_definition_id.as_deref() }

    pub fn session_mode(&self) -> crate::SessionMode {
        self.session_mode
    }

    pub fn timestamps_ms(&self) -> (u64, u64) {
        self.timestamps
    }

    fn read_inner(
        path: &Path,
        previous: Option<&Self>,
        max_bytes: u64,
        max_line_bytes: usize,
        mut consumed: impl FnMut(usize) -> Result<()>,
    ) -> Result<Self> {
        let path = std::path::absolute(path)?;
        let stamp = committed_source_stamp(&path)?;
        if let Some(previous) = previous
            && previous.path == path
            && previous.stamp.0 == stamp
        {
            let mut result = previous.clone();
            result.bytes_read = 0;
            return Ok(result);
        }
        let end = stamp
            .known_committed_bytes()
            .context("missing commit boundary")?;
        let previous =
            previous.filter(|old| old.path == path && stamp.extends_committed_body(&old.stamp.0));
        let start = previous.map_or(0, |old| old.offset);
        ensure!(
            end - start <= max_bytes,
            "committed projection exceeds byte budget"
        );
        let parent = path.parent().context("history source has no parent")?;
        let name = path
            .file_name()
            .context("history source has no file name")?;
        let directory = PrivateDirectory::open_existing(parent)?;
        let mut file = directory.open_regular_file(name)?;
        let identity = super::files::file_identity(&file)?;
        let before = file.metadata()?;
        ensure!(
            before.len() == end,
            "history length differs from committed boundary"
        );
        let metadata = prepare_session_metadata_bounded(&path, MAX_SIDECAR_BYTES)?;
        let mut result = Self {
            path: path.clone(),
            stamp: CommittedHistoryStamp(stamp.clone()),
            offset: start,
            head: previous.map_or_else(Vec::new, |old| old.head.clone()),
            first_timestamp: previous.and_then(|old| old.first_timestamp),
            latest_timestamp: previous.and_then(|old| old.latest_timestamp),
            first_prompt: None,
            base_cwd: metadata.base_cwd().map(Path::to_path_buf),
            session_mode: metadata.session_mode(),
            workflow_definition_id: metadata.workflow_definition_id().map(str::to_owned),
            timestamps: (0, 0),
            bytes_read: 0,
        };
        file.seek(SeekFrom::Start(start))?;
        let mut buffer = [0u8; 64 * 1024];
        let mut line = Vec::new();
        while result.offset < end {
            let limit = (end - result.offset).min(buffer.len() as u64) as usize;
            let count = match file.read(&mut buffer[..limit]) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            ensure!(count != 0, "history ended before committed boundary");
            result.bytes_read += count as u64;
            consumed(count)?;
            let chunk = &buffer[..count];
            result
                .head
                .extend_from_slice(&chunk[..chunk.len().min(HEAD_BYTES - result.head.len())]);
            for part in chunk.split_inclusive(|byte| *byte == b'\n') {
                ensure!(
                    part.len() <= max_line_bytes.saturating_sub(line.len()),
                    "committed projection exceeds line byte budget"
                );
                line.extend_from_slice(part);
                if part.ends_with(b"\n") {
                    result.observe_line(&line)?;
                    line.clear();
                }
            }
            result.offset += count as u64;
        }
        ensure!(
            line.is_empty(),
            "committed boundary contains an incomplete trailing record"
        );
        let current = directory.open_regular_file(name)?;
        let current_path = PrivateDirectory::open_existing(parent)?.open_regular_file(name)?;
        ensure!(
            super::files::file_identity(&current)? == identity
                && super::files::file_identity(&current_path)? == identity,
            "history source identity changed during projection"
        );
        ensure!(
            file.metadata()?.len() == end,
            "history size changed during projection"
        );
        ensure!(
            committed_source_stamp(&path)? == stamp,
            "history source control changed during projection"
        );
        let mut bounds = HistoryTimestampBounds::default();
        for timestamp in [result.first_timestamp, result.latest_timestamp]
            .into_iter()
            .flatten()
        {
            bounds.observe(&serde_json::json!({"timestamp_ms": timestamp}));
        }
        result.timestamps = metadata.observed_timestamps_ms(&bounds, before.modified().ok());
        result.first_prompt = crate::history::first_prompt_from_head(&result.head, 80);
        Ok(result)
    }

    fn observe_line(&mut self, line: &[u8]) -> Result<()> {
        let line = std::str::from_utf8(line).context("history record is not UTF-8")?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            let timestamp = value
                .get("timestamp_ms")
                .or_else(|| value.get("timestampMs"))
                .and_then(|value| {
                    value
                        .as_u64()
                        .or_else(|| value.as_str()?.parse::<u64>().ok())
                });
            if let Some(timestamp) = timestamp {
                self.first_timestamp.get_or_insert(timestamp);
                self.latest_timestamp = Some(self.latest_timestamp.unwrap_or(0).max(timestamp));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history_store::HistorySource;

    fn fixture(bytes: &[u8]) -> (tempfile::TempDir, PathBuf, HistorySource) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        source.replace(bytes).unwrap();
        (temp, path, source)
    }

    #[test]
    fn committed_projection_unchanged_stamp_reads_no_body() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        source.append(b"{\"timestamp_ms\":42}\n").unwrap();
        let initial = CommittedListProjection::read(&path, 1024, 1024).unwrap();
        assert!(initial.bytes_read() > 0);
        let refreshed = initial.update(0, 0).unwrap();
        assert_eq!(refreshed.bytes_read(), 0);
    }

    #[test]
    fn committed_projection_append_reads_only_new_committed_bytes() {
        let first = b"{\"timestamp_ms\":42,\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first prompt\"}]}\n";
        let (_temp, path, source) = fixture(first);
        let initial = CommittedListProjection::read(&path, 1024, 1024).unwrap();
        let suffix = b"{\"timestamp_ms\":90}\n";
        source.append(suffix).unwrap();
        let mut observed_bytes = 0;
        let updated = CommittedListProjection::read_inner(
            &path,
            Some(&initial),
            suffix.len() as u64,
            suffix.len(),
            |bytes| {
                observed_bytes += bytes;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(observed_bytes, suffix.len());
        assert_eq!(updated.bytes_read(), suffix.len() as u64);
        assert_eq!(
            updated.committed_offset(),
            (first.len() + suffix.len()) as u64
        );
        assert_eq!(updated.timestamps_ms(), (42, 90));
        assert_eq!(updated.first_prompt(), Some("first prompt"));
        assert_ne!(initial.source_stamp(), updated.source_stamp());
        assert_eq!(initial.committed_offset(), first.len() as u64);
        assert!(initial.update(suffix.len() as u64 - 1, 1024).is_err());
    }

    #[test]
    fn committed_projection_replacement_rebuilds_even_when_length_matches() {
        let (_temp, path, source) = fixture(b"{\"timestamp_ms\":42}\n");
        let initial = CommittedListProjection::read(&path, 1024, 1024).unwrap();
        source.replace(b"{\"timestamp_ms\":99}\n").unwrap();
        assert!(initial.update(0, 1024).is_err());
        let updated = initial.update(1024, 1024).unwrap();
        assert_eq!(updated.bytes_read(), initial.committed_offset());
        assert_eq!(updated.timestamps_ms(), (99, 99));
        assert_ne!(updated.source_stamp(), initial.source_stamp());
    }

    #[test]
    fn committed_projection_metadata_revision_updates_without_reading_body() {
        let (temp, path, source) = fixture(b"{\"timestamp_ms\":42}\n");
        let initial = CommittedListProjection::read(&path, 1024, 1024).unwrap();
        let sidecar = crate::session_state_path(temp.path(), "session");
        source.write_metadata(&sidecar, || Ok(serde_json::to_vec(&serde_json::json!({
            "schema_version": 1, "base_cwd": temp.path(), "created_at_ms": 10, "updated_at_ms": 100
        }))?)).unwrap();
        let updated = initial.update(0, 0).unwrap();
        assert_eq!(updated.bytes_read(), 0);
        assert_eq!(updated.committed_offset(), initial.committed_offset());
        assert_eq!(updated.timestamps_ms(), (10, 100));
        assert_eq!(updated.base_cwd(), Some(temp.path()));
        assert_eq!(updated.session_mode(), crate::SessionMode::default());
        assert_ne!(updated.source_stamp(), initial.source_stamp());
    }

    #[test]
    fn committed_projection_discards_results_if_source_changes_during_read() {
        let (_temp, path, source) = fixture(b"{\"timestamp_ms\":42}\n");
        for replacement in [false, true] {
            let result = CommittedListProjection::read_inner(&path, None, 1024, 1024, |_| {
                if replacement {
                    source.replace(b"{\"timestamp_ms\":99}\n")
                } else {
                    source.append(b"{\"timestamp_ms\":90}\n")
                }
            });
            assert!(result.is_err());
        }
    }

    #[test]
    fn committed_projection_rejects_unknown_deleted_and_half_line_sources() {
        let (temp, path, source) = fixture(b"{\"timestamp_ms\":42}\n");
        let initial = CommittedListProjection::read(&path, 1024, 1024).unwrap();
        // Even a same-length external edit cannot publish an incomplete committed record.
        std::fs::write(&path, b"{\"timestamp_ms\":42} ").unwrap();
        assert!(CommittedListProjection::read(&path, 1024, 1024).is_err());
        assert_eq!(initial.committed_offset(), 20);
        source.replace(b"{}\n").unwrap();
        crate::history_store::delete_records(&path).unwrap();
        assert!(initial.update(1024, 1024).is_err());
        let legacy = temp.path().join("legacy.jsonl");
        std::fs::write(&legacy, b"{}\n").unwrap();
        assert!(CommittedListProjection::read(&legacy, 1024, 1024).is_err());
        assert!(!temp.path().join("legacy.hctl").exists());
    }

    #[test]
    fn committed_projection_explicit_rebuild_observes_same_size_same_mtime_edit() {
        let (_temp, path, _source) = fixture(b"{\"timestamp_ms\":42}\n");
        let initial = CommittedListProjection::read(&path, 1024, 1024).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::write(&path, b"{\"timestamp_ms\":99}\n").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(initial.update(0, 0).unwrap().timestamps_ms(), (42, 42));
        let rebuilt = CommittedListProjection::read(&path, 1024, 1024).unwrap();
        assert_eq!(rebuilt.timestamps_ms(), (99, 99));
        assert_eq!(initial.source_stamp(), rebuilt.source_stamp());
    }

    #[test]
    fn committed_projection_budgets_are_exact_and_failed_updates_preserve_snapshot() {
        let (_temp, path, source) = fixture(b"{}\n");
        let initial = CommittedListProjection::read(&path, 3, 3).unwrap();
        let mut consumed_bytes = 0;
        assert!(
            CommittedListProjection::read_inner(&path, None, 2, 3, |count| {
                consumed_bytes += count;
                Ok(())
            })
            .is_err()
        );
        assert_eq!(
            consumed_bytes, 0,
            "reject impossible byte budgets before body I/O"
        );
        for (bytes, line) in [(2, 3), (3, 2), (0, 0)] {
            assert!(CommittedListProjection::read(&path, bytes, line).is_err());
        }
        source.append(b"\xff\n").unwrap();
        assert!(initial.update(2, 2).is_err());
        assert_eq!(initial.committed_offset(), 3);
        assert_eq!(initial.bytes_read(), 3);
        source.replace(b"").unwrap();
        let empty = initial.update(0, 0).unwrap();
        assert_eq!(empty.committed_offset(), 0);
        assert_eq!(empty.bytes_read(), 0);
    }

    #[test]
    fn committed_projection_does_not_wait_for_mutation_lock() {
        let (temp, path, _source) = fixture(b"{}\n");
        let lock = std::fs::File::open(temp.path().join(".kcoder-history.lock")).unwrap();
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        assert_eq!(
            CommittedListProjection::read(&path, 3, 3)
                .unwrap()
                .bytes_read(),
            3
        );
    }

    #[test]
    fn committed_projection_cross_chunk_incremental_projection_matches_full_rebuild() {
        let first = b"{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first\"}],\"timestamp_ms\":40}\n";
        let (_temp, path, source) = fixture(first);
        let initial = CommittedListProjection::read(&path, 1024, 1024).unwrap();
        let suffix = format!(
            "{{\"ignored\":\"{}\",\"timestampMs\":90}}\n{{\"timestamp_ms\":20}}\n",
            "界".repeat(30_000)
        );
        source.append(suffix.as_bytes()).unwrap();
        let updated = initial.update(suffix.len() as u64, suffix.len()).unwrap();
        let rebuilt =
            CommittedListProjection::read(&path, (first.len() + suffix.len()) as u64, suffix.len())
                .unwrap();
        assert_eq!(updated.bytes_read(), suffix.len() as u64);
        assert_eq!(updated.timestamps_ms(), rebuilt.timestamps_ms());
        assert_eq!(updated.timestamps_ms(), (40, 90));
        assert_eq!(updated.first_prompt(), rebuilt.first_prompt());
        assert_eq!(updated.source_stamp(), rebuilt.source_stamp());
        assert_eq!(updated.head.len(), HEAD_BYTES);
    }

    #[test]
    fn committed_projection_discards_body_if_metadata_revision_changes_during_read() {
        let (temp, path, source) = fixture(b"{\"timestamp_ms\":42}\n");
        let sidecar = crate::session_state_path(temp.path(), "session");
        let result = CommittedListProjection::read_inner(&path, None, 1024, 1024, |_| {
            source.write_metadata(&sidecar, || {
                Ok(b"{\"schema_version\":1,\"updated_at_ms\":90}".to_vec())
            })
        });
        assert!(result.is_err());
        assert_eq!(
            CommittedListProjection::read(&path, 1024, 1024)
                .unwrap()
                .timestamps_ms(),
            (42, 90)
        );
    }
}
