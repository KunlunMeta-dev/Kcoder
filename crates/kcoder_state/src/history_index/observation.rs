use super::files::file_identity;
use crate::history_store::observation_source_stamp;
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// A bounded full-content observation of one read, not freshness authority for a future request.
/// No source bytes, paths, or constructible source-control proofs are exposed.
/// This does not prove directory privacy or grant execution or write authority.
pub struct HistorySourceObservation {
    cache_key: [u8; 32],
    byte_count: u64,
    complete_line_bytes: u64,
    modified: Option<SystemTime>,
    has_known_commit_boundary: bool,
}

impl HistorySourceObservation {
    /// Cheap rejection hint for optional parsing reuse; true never authorizes a cache hit.
    /// A subsequent full observation must still verify the boundary against its own bytes.
    pub fn has_commit_boundary_hint(path: &Path) -> Result<bool> {
        Ok(observation_source_stamp(path)?
            .known_committed_bytes()
            .is_some())
    }

    /// Fully read and hash an existing source through private-file capabilities without repairs.
    /// Existing-directory access preserves permissions; it does not add an ACL or mode audit.
    /// A changed or unavailable source is an error; callers may retry or use their legacy path.
    /// This performs full body I/O on every call, including legacy sources with unknown commits.
    /// Any pending commit is rejected without independently verifying body or metadata authority.
    /// At most one extra byte is probed to detect overflow; it is never hashed or consumed.
    pub fn read(path: &Path, max_bytes: u64) -> Result<Self> {
        read_with(path, max_bytes, |_| Ok(()))
    }

    /// Versioned key binding this stream's digest, size, handle identity, mtime and full SourceStamp.
    /// Equality alone cannot authorize skipping a later source read or certify a separate parse.
    pub fn cache_key(&self) -> &[u8; 32] {
        &self.cache_key
    }

    /// Number of body bytes actually read and hashed, including any incomplete trailing line.
    pub fn byte_count(&self) -> u64 {
        self.byte_count
    }

    /// Whether this read's exact byte count matches an observed, non-pending commit boundary.
    /// This is not immutability or freshness authority for a future read.
    pub fn has_known_commit_boundary(&self) -> bool {
        self.has_known_commit_boundary
    }

    /// Observed offset just after the last newline, or zero. This is NOT a committed watermark.
    pub fn observed_complete_line_bytes(&self) -> u64 {
        self.complete_line_bytes
    }

    /// Handle-derived mtime input for timestamp fallback, not a content immutability guarantee.
    pub fn modified(&self) -> Option<SystemTime> {
        self.modified
    }
}

impl std::fmt::Debug for HistorySourceObservation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HistorySourceObservation")
            .field("byte_count", &self.byte_count)
            .field("observed_complete_line_bytes", &self.complete_line_bytes)
            .finish_non_exhaustive()
    }
}

// Future metadata producers must consume this exact hashed stream, never a separate read between
// two matching observations (an ABA change can make that separate parse unrelated to either hash).
// Consumers must stage their result and discard it unless the entire observation succeeds.
pub(super) fn read_with(
    path: &Path,
    max_bytes: u64,
    mut consume: impl FnMut(&[u8]) -> Result<()>,
) -> Result<HistorySourceObservation> {
    let stamp =
        observation_source_stamp(path).context("history source is not ready; retry observation")?;
    let parent = path.parent().context("history source has no parent")?;
    let name = path
        .file_name()
        .context("history source has no file name")?;
    let directory = PrivateDirectory::open_existing(parent)?;
    let mut file = directory.open_regular_file(name)?;
    let identity = file_identity(&file)?;
    let before = file.metadata()?;
    ensure!(
        before.len() <= max_bytes,
        "history observation exceeds byte budget"
    );
    let modified = before.modified().ok();
    let mut digest = Sha256::new();
    let mut byte_count = 0u64;
    let mut complete_line_bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let limit = (max_bytes - byte_count)
            .saturating_add(1)
            .min(buffer.len() as u64) as usize;
        let count = match file.read(&mut buffer[..limit]) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result.context("history source read failed; retry observation")?,
        };
        if count == 0 {
            break;
        }
        let next_count = byte_count
            .checked_add(count as u64)
            .context("history observation exceeds byte budget")?;
        ensure!(
            next_count <= max_bytes,
            "history observation exceeds byte budget"
        );
        let chunk = &buffer[..count];
        if let Some(last_newline) = chunk.iter().rposition(|byte| *byte == b'\n') {
            complete_line_bytes = byte_count + last_newline as u64 + 1;
        }
        digest.update(chunk);
        consume(chunk)?;
        byte_count = next_count;
    }
    ensure!(
        observation_source_stamp(path).context("history source is not ready; retry observation")?
            == stamp,
        "history source control changed; retry observation"
    );
    let after = file.metadata()?;
    ensure!(
        before.len() == byte_count
            && after.len() == byte_count
            && after.modified().ok() == modified,
        "history source size or mtime changed; retry observation"
    );
    // Reopen relative to the pinned directory, then also reject a changed path-to-directory mapping.
    let current = directory
        .open_regular_file(name)
        .context("history source disappeared; retry observation")?;
    let current_path = PrivateDirectory::open_existing(parent)?.open_regular_file(name)?;
    ensure!(
        file_identity(&current)? == identity && file_identity(&current_path)? == identity,
        "history source file identity changed; retry observation"
    );
    // Preserve exact mtime semantics, including unavailable and pre-epoch inputs, without assuming
    // that a matching timestamp proves content remained immutable while this stream was read.
    let mtime_key = modified.map(|value| match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => (false, duration.as_secs(), duration.subsec_nanos()),
        Err(error) => (
            true,
            error.duration().as_secs(),
            error.duration().subsec_nanos(),
        ),
    });
    let content_sha256: [u8; 32] = digest.finalize().into();
    let has_known_commit_boundary = stamp.known_committed_bytes() == Some(byte_count);
    let encoded = serde_json::to_vec(&(
        "kcoder.history-source-observation.v1",
        content_sha256,
        byte_count,
        identity,
        mtime_key,
        stamp,
    ))?;
    Ok(HistorySourceObservation {
        cache_key: Sha256::digest(encoded).into(),
        byte_count,
        complete_line_bytes,
        modified,
        has_known_commit_boundary,
    })
}

/// One pinned observation that may suspend between bounded reads. Failed readers are poisoned.
pub(super) struct SourceObservationReader {
    path: std::path::PathBuf,
    directory: PrivateDirectory,
    file: std::fs::File,
    stamp: crate::history_store::SourceStamp,
    identity: (u64, u64),
    length: u64,
    modified: Option<SystemTime>,
    digest: Sha256,
    byte_count: u64,
    complete_line_bytes: u64,
    unavailable: bool,
}

impl SourceObservationReader {
    pub(super) fn open(path: &Path) -> Result<Self> {
        let path = std::path::absolute(path)?;
        let stamp = observation_source_stamp(&path)?;
        let parent = path.parent().context("history source has no parent")?;
        let directory = PrivateDirectory::open_existing(parent)?;
        let file =
            directory.open_regular_file(path.file_name().context("history source has no name")?)?;
        let identity = file_identity(&file)?;
        let metadata = file.metadata()?;
        Ok(Self {
            path,
            directory,
            file,
            stamp,
            identity,
            length: metadata.len(),
            modified: metadata.modified().ok(),
            digest: Sha256::new(),
            byte_count: 0,
            complete_line_bytes: 0,
            unavailable: false,
        })
    }

    pub(super) fn bytes_read(&self) -> u64 {
        self.byte_count
    }

    pub(super) fn step(
        &mut self,
        max_bytes: u64,
        consume: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<Option<HistorySourceObservation>> {
        ensure!(
            max_bytes > 0,
            "observation step byte budget must be positive"
        );
        ensure!(
            !self.unavailable,
            "observation reader is completed or failed"
        );
        self.unavailable = true;
        let result = self.read_step(max_bytes, consume);
        if matches!(&result, Ok(None)) {
            self.unavailable = false;
        }
        result
    }

    fn read_step(
        &mut self,
        mut remaining: u64,
        consume: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<Option<HistorySourceObservation>> {
        let mut buffer = [0u8; 64 * 1024];
        while remaining > 0 {
            let limit = remaining
                .min(
                    self.length
                        .saturating_sub(self.byte_count)
                        .saturating_add(1),
                )
                .min(buffer.len() as u64) as usize;
            let count = match self.file.read(&mut buffer[..limit]) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            if count == 0 {
                return self.finish().map(Some);
            }
            let before = self.byte_count;
            self.byte_count = self
                .byte_count
                .checked_add(count as u64)
                .context("observation byte count overflow")?;
            remaining -= count as u64;
            ensure!(
                self.byte_count <= self.length,
                "history source grew during observation"
            );
            let chunk = &buffer[..count];
            if let Some(last_newline) = chunk.iter().rposition(|byte| *byte == b'\n') {
                self.complete_line_bytes = before + last_newline as u64 + 1;
            }
            self.digest.update(chunk);
            consume(chunk)?;
        }
        Ok(None)
    }

    /// Recheck the pinned EOF observation without reading any body bytes.
    pub(super) fn validate_source(&self) -> Result<()> {
        ensure!(
            observation_source_stamp(&self.path)? == self.stamp,
            "history source control changed during observation"
        );
        let after = self.file.metadata()?;
        ensure!(
            self.length == self.byte_count
                && after.len() == self.byte_count
                && after.modified().ok() == self.modified,
            "history source size or mtime changed during observation"
        );
        let parent = self.path.parent().context("history source has no parent")?;
        let name = self
            .path
            .file_name()
            .context("history source has no name")?;
        let pinned = self.directory.open_regular_file(name)?;
        let current = PrivateDirectory::open_existing(parent)?.open_regular_file(name)?;
        ensure!(
            file_identity(&pinned)? == self.identity && file_identity(&current)? == self.identity,
            "history source file identity changed during observation"
        );
        Ok(())
    }

    fn finish(&self) -> Result<HistorySourceObservation> {
        self.validate_source()?;
        let mtime_key = self
            .modified
            .map(|value| match value.duration_since(UNIX_EPOCH) {
                Ok(duration) => (false, duration.as_secs(), duration.subsec_nanos()),
                Err(error) => (
                    true,
                    error.duration().as_secs(),
                    error.duration().subsec_nanos(),
                ),
            });
        let content_sha256: [u8; 32] = self.digest.clone().finalize().into();
        let encoded = serde_json::to_vec(&(
            "kcoder.history-source-observation.v1",
            content_sha256,
            self.byte_count,
            self.identity,
            mtime_key,
            &self.stamp,
        ))?;
        Ok(HistorySourceObservation {
            cache_key: Sha256::digest(encoded).into(),
            byte_count: self.byte_count,
            complete_line_bytes: self.complete_line_bytes,
            modified: self.modified,
            has_known_commit_boundary: self.stamp.known_committed_bytes() == Some(self.byte_count),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::PrivateDirectory;
    use std::ffi::OsStr;
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use std::time::{Duration, UNIX_EPOCH};

    fn fixture(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = PrivateDirectory::open_or_create(directory.path()).unwrap();
        root.atomic_replace(OsStr::new("secret-session.jsonl"), bytes)
            .unwrap();
        let path = directory.path().join("secret-session.jsonl");
        (directory, path)
    }

    fn control(path: &Path, value: &serde_json::Value) {
        let root = PrivateDirectory::open_existing(path.parent().unwrap()).unwrap();
        let directory = root
            .open_child(path.with_extension("hctl").file_name().unwrap(), true)
            .unwrap();
        directory
            .atomic_replace(
                OsStr::new("source.json"),
                &serde_json::to_vec(value).unwrap(),
            )
            .unwrap();
    }

    fn legacy_control() -> serde_json::Value {
        serde_json::json!({
            "schema_version": 1, "incarnation": uuid::Uuid::new_v4(), "deleted": false
        })
    }

    fn during_read(
        path: &Path,
        max_bytes: u64,
        mutation: impl FnOnce(),
    ) -> Result<HistorySourceObservation> {
        let mut mutation = Some(mutation);
        read_with(path, max_bytes, |_| {
            if let Some(mutation) = mutation.take() {
                mutation();
            }
            Ok(())
        })
    }

    #[test]
    fn observation_stable_key_and_redacted_debug() {
        let (_directory, path) = fixture(b"private prompt\npartial");
        let first = HistorySourceObservation::read(&path, 100).unwrap();
        let second = HistorySourceObservation::read(&path, 100).unwrap();
        assert_eq!(first.cache_key(), second.cache_key());
        assert_eq!(first.cache_key().len(), 32);
        assert_eq!(first.byte_count(), 22);
        assert_eq!(first.observed_complete_line_bytes(), 15);
        assert_eq!(
            first.modified(),
            fs::metadata(&path).unwrap().modified().ok()
        );
        let debug = format!("{first:?}");
        assert!(!debug.contains("private prompt"));
        assert!(!debug.contains("secret-session"));
        assert!(!debug.contains("cache_key"));
    }

    #[test]
    fn observation_commit_boundary_requires_known_exact_length_not_a_hint() {
        let (_directory, path) = fixture(b"body\n");
        assert!(!HistorySourceObservation::has_commit_boundary_hint(&path).unwrap());
        assert!(
            !HistorySourceObservation::read(&path, 100)
                .unwrap()
                .has_known_commit_boundary()
        );
        let mut record = legacy_control();
        control(&path, &record);
        assert!(!HistorySourceObservation::has_commit_boundary_hint(&path).unwrap());
        assert!(
            !HistorySourceObservation::read(&path, 100)
                .unwrap()
                .has_known_commit_boundary()
        );
        record["schema_version"] = 2.into();
        record["commit"] = serde_json::json!({
            "revision": 0, "generation": record["incarnation"],
            "committed_bytes": null, "pending": null, "last_operation": null
        });
        for (boundary, expected) in [
            (None, false),
            (Some(4), false),
            (Some(5), true),
            (Some(6), false),
        ] {
            record["commit"]["committed_bytes"] = serde_json::json!(boundary);
            control(&path, &record);
            assert_eq!(
                HistorySourceObservation::has_commit_boundary_hint(&path).unwrap(),
                boundary.is_some()
            );
            assert_eq!(
                HistorySourceObservation::read(&path, 100)
                    .unwrap()
                    .has_known_commit_boundary(),
                expected
            );
        }
    }

    #[test]
    fn observation_rehashes_same_length_rewrite_with_restored_mtime() {
        let (_directory, path) = fixture(b"old prefix\n");
        let first = HistorySourceObservation::read(&path, 100).unwrap();
        fs::write(&path, b"new prefix\n").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(first.modified().unwrap())
            .unwrap();
        let second = HistorySourceObservation::read(&path, 100).unwrap();
        assert_eq!(first.modified(), second.modified());
        assert_eq!(first.byte_count(), second.byte_count());
        assert_ne!(first.cache_key(), second.cache_key());
    }

    #[test]
    fn observation_key_binds_mtime_fallback_even_with_identical_content() {
        let (_directory, path) = fixture(b"body\n");
        let first = HistorySourceObservation::read(&path, 100).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(42))
            .unwrap();
        let second = HistorySourceObservation::read(&path, 100).unwrap();
        assert_ne!(first.cache_key(), second.cache_key());
    }

    #[test]
    fn observation_append_truncate_replace_delete() {
        let (_directory, path) = fixture(b"body\n");
        let first = HistorySourceObservation::read(&path, 100).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"next\n")
            .unwrap();
        let appended = HistorySourceObservation::read(&path, 100).unwrap();
        assert_ne!(first.cache_key(), appended.cache_key());
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(2)
            .unwrap();
        let truncated = HistorySourceObservation::read(&path, 100).unwrap();
        assert_ne!(appended.cache_key(), truncated.cache_key());
        let root = PrivateDirectory::open_existing(path.parent().unwrap()).unwrap();
        root.atomic_replace(path.file_name().unwrap(), b"bo")
            .unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(truncated.modified().unwrap())
            .unwrap();
        assert_ne!(
            truncated.cache_key(),
            HistorySourceObservation::read(&path, 100)
                .unwrap()
                .cache_key()
        );
        fs::remove_file(&path).unwrap();
        assert!(HistorySourceObservation::read(&path, 100).is_err());
    }

    #[test]
    fn observation_budget_and_complete_line_boundaries() {
        for (bytes, boundary) in [
            (b"".as_slice(), 0),
            (b"tail", 0),
            (b"a\nb\npart", 4),
            (b"\n", 1),
        ] {
            let (_directory, path) = fixture(bytes);
            let observed = HistorySourceObservation::read(&path, bytes.len() as u64).unwrap();
            assert_eq!(observed.byte_count(), bytes.len() as u64);
            assert_eq!(observed.observed_complete_line_bytes(), boundary);
            if !bytes.is_empty() {
                assert!(HistorySourceObservation::read(&path, 0).is_err());
                assert!(HistorySourceObservation::read(&path, bytes.len() as u64 - 1).is_err());
            }
        }
        let mut bytes = vec![b'x'; 64 * 1024 + 12];
        bytes[64 * 1024] = b'\n';
        let (_directory, path) = fixture(&bytes);
        let observed = HistorySourceObservation::read(&path, bytes.len() as u64).unwrap();
        assert_eq!(observed.byte_count(), bytes.len() as u64);
        assert_eq!(observed.observed_complete_line_bytes(), 64 * 1024 + 1);
    }

    #[test]
    fn observation_growth_cannot_bypass_actual_read_budget() {
        let (_directory, path) = fixture(b"1234");
        let error = during_read(&path, 4, || {
            OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(b"5")
                .unwrap();
        })
        .unwrap_err();
        assert!(error.to_string().contains("budget"), "{error:#}");
    }

    #[test]
    fn observation_legacy_never_creates_or_upgrades_authority() {
        let (directory, path) = fixture(b"legacy\ntail");
        HistorySourceObservation::read(&path, 100).unwrap();
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        assert_eq!(fs::read(&path).unwrap(), b"legacy\ntail");
        let record = legacy_control();
        control(&path, &record);
        let control_path = path.with_extension("hctl").join("source.json");
        let before = fs::read(&control_path).unwrap();
        HistorySourceObservation::read(&path, 100).unwrap();
        assert_eq!(fs::read(&control_path).unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), b"legacy\ntail");
    }

    #[test]
    fn observation_key_binds_full_control_state_not_only_incarnation() {
        let (_directory, path) = fixture(b"body\n");
        let mut record = legacy_control();
        control(&path, &record);
        let first = HistorySourceObservation::read(&path, 100).unwrap();
        record["schema_version"] = 2.into();
        record["commit"] = serde_json::json!({
            "revision": 0, "generation": record["incarnation"],
            "committed_bytes": null, "pending": null, "last_operation": null
        });
        control(&path, &record);
        let second = HistorySourceObservation::read(&path, 100).unwrap();
        assert_ne!(first.cache_key(), second.cache_key());
        record["commit"]["committed_bytes"] = 5.into();
        control(&path, &record);
        assert_ne!(
            second.cache_key(),
            HistorySourceObservation::read(&path, 100)
                .unwrap()
                .cache_key()
        );
    }

    #[test]
    fn observation_deleted_and_unresolved_pending_reject_before_body_read() {
        let (_directory, path) = fixture(b"body\n");
        let mut record = legacy_control();
        record["deleted"] = true.into();
        control(&path, &record);
        let mut reads = 0;
        assert!(
            read_with(&path, 100, |_| {
                reads += 1;
                Ok(())
            })
            .is_err()
        );
        assert_eq!(reads, 0);
        record["deleted"] = false.into();
        record["schema_version"] = 2.into();
        record["commit"] = serde_json::json!({
            "revision": 0, "generation": record["incarnation"], "committed_bytes": 5,
            "pending": {"next_revision": 1, "operation": {
                "kind": "append", "start": 5, "end": 6, "sha256": "0".repeat(64)
            }}, "last_operation": null
        });
        control(&path, &record);
        assert!(
            read_with(&path, 100, |_| {
                reads += 1;
                Ok(())
            })
            .is_err()
        );
        assert_eq!(reads, 0);
    }

    fn completed_pending(path: &Path, kind: &str, bytes: &[u8]) {
        let root = PrivateDirectory::open_existing(path.parent().unwrap()).unwrap();
        root.atomic_replace(OsStr::new(".kcoder-history.lock"), b"")
            .unwrap();
        let digest = format!("{:x}", Sha256::digest(bytes));
        let operation = match kind {
            "append" => serde_json::json!({
                "kind": "append", "start": 0, "end": bytes.len(), "sha256": digest
            }),
            "replace" => serde_json::json!({
                "kind": "replace", "length": bytes.len(), "generation": uuid::Uuid::new_v4(),
                "sha256": digest
            }),
            "metadata" => {
                let sidecar = crate::session_state_path(path.parent().unwrap(), "secret-session");
                PrivateDirectory::open_or_create(sidecar.parent().unwrap())
                    .unwrap()
                    .atomic_replace(sidecar.file_name().unwrap(), bytes)
                    .unwrap();
                let relative: Vec<_> = sidecar
                    .strip_prefix(path.parent().unwrap())
                    .unwrap()
                    .iter()
                    .map(|part| part.to_str().unwrap())
                    .collect();
                serde_json::json!({
                    "kind": "metadata", "relative_path": relative, "length": bytes.len(),
                    "sha256": digest
                })
            }
            _ => unreachable!(),
        };
        let mut record = legacy_control();
        record["schema_version"] = 2.into();
        record["commit"] = serde_json::json!({
            "revision": 0, "generation": record["incarnation"], "committed_bytes": null,
            "pending": {"next_revision": 1, "operation": operation}, "last_operation": null
        });
        control(path, &record);
        // Prove this is a valid completed authority write, not a missing-lock or invalid-digest case.
        crate::history_store::prepare_source_stamp(path).unwrap();
    }

    #[test]
    fn chunked_observation_rejects_pending_between_steps_without_repair() {
        let (_directory, path) = fixture(b"body\n");
        let mut reader = SourceObservationReader::open(&path).unwrap();
        assert!(reader.step(2, &mut |_| Ok(())).unwrap().is_none());
        completed_pending(&path, "append", b"body\n");
        let control = path.with_extension("hctl").join("source.json");
        let before = fs::read(&control).unwrap();
        let error = reader.step(100, &mut |_| Ok(())).unwrap_err();
        assert!(format!("{error:#}").contains("pending commit"));
        assert_eq!(reader.bytes_read(), 5);
        assert_eq!(fs::read(control).unwrap(), before);
        assert!(reader.step(100, &mut |_| Ok(())).is_err());
        assert!(SourceObservationReader::open(&path).is_err());
    }

    #[test]
    fn observation_rejects_completed_pending_body_before_budget_or_consumption() {
        for kind in ["append", "replace"] {
            let bytes = vec![b'x'; 128 * 1024];
            let (_directory, path) = fixture(&bytes);
            completed_pending(&path, kind, &bytes);
            let record_path = path.with_extension("hctl").join("source.json");
            let before = fs::read(&record_path).unwrap();
            for budget in [0, bytes.len() as u64] {
                let mut consumed = 0;
                let result = read_with(&path, budget, |chunk| {
                    consumed += chunk.len();
                    Ok(())
                });
                assert!(result.is_err(), "completed pending {kind} must be rejected");
                let error = result.unwrap_err();
                assert!(format!("{error:#}").contains("pending commit"), "{error:#}");
                assert_eq!(consumed, 0);
            }
            assert_eq!(fs::read(record_path).unwrap(), before);
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }

    #[test]
    fn observation_rejects_completed_pending_metadata_with_zero_body_budget() {
        let (_directory, path) = fixture(b"");
        let metadata = vec![b'x'; 128 * 1024];
        completed_pending(&path, "metadata", &metadata);
        let result = HistorySourceObservation::read(&path, 0);
        assert!(
            result.is_err(),
            "pending metadata must not be verified outside the body budget"
        );
        assert!(format!("{:#}", result.unwrap_err()).contains("pending commit"));
    }

    #[test]
    fn observation_rejects_completed_pending_introduced_at_eof_without_verifying_authority() {
        let (_directory, path) = fixture(b"body\n");
        let error =
            during_read(&path, 5, || completed_pending(&path, "append", b"body\n")).unwrap_err();
        assert!(format!("{error:#}").contains("pending commit"), "{error:#}");
    }

    #[test]
    fn observation_control_change_during_read_requires_retry() {
        let (_directory, path) = fixture(b"body\n");
        control(&path, &legacy_control());
        assert!(during_read(&path, 100, || control(&path, &legacy_control())).is_err());
    }

    #[test]
    fn observation_leaf_replacement_and_deletion_during_read_require_retry() {
        let (_directory, path) = fixture(b"body\n");
        assert!(
            during_read(&path, 100, || {
                PrivateDirectory::open_existing(path.parent().unwrap())
                    .unwrap()
                    .atomic_replace(path.file_name().unwrap(), b"body\n")
                    .unwrap();
            })
            .is_err()
        );
        assert!(during_read(&path, 100, || fs::remove_file(&path).unwrap()).is_err());
    }

    #[test]
    fn observation_visible_size_or_mtime_change_during_read_requires_retry() {
        for operation in ["append", "truncate", "mtime"] {
            let (_directory, path) = fixture(b"body\n");
            assert!(
                during_read(&path, 100, || {
                    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
                    match operation {
                        "append" => file.write_all(b"more\n").unwrap(),
                        "truncate" => file.set_len(1).unwrap(),
                        _ => file
                            .set_modified(UNIX_EPOCH + Duration::from_secs(7))
                            .unwrap(),
                    }
                })
                .is_err(),
                "{operation}"
            );
        }
    }

    #[test]
    fn observation_consumer_uses_exact_hashed_stream_and_discards_failed_results() {
        let bytes = vec![b'x'; 64 * 1024 + 20];
        let (_directory, path) = fixture(&bytes);
        let first = HistorySourceObservation::read(&path, bytes.len() as u64).unwrap();
        let mut consumed = Vec::new();
        let second = read_with(&path, bytes.len() as u64, |chunk| {
            consumed.extend_from_slice(chunk);
            Ok(())
        })
        .unwrap();
        assert_eq!(consumed, bytes);
        assert_eq!(first.cache_key(), second.cache_key());
        assert!(
            read_with(&path, bytes.len() as u64, |_| anyhow::bail!(
                "consumer rejected bytes"
            ))
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn observation_preserves_existing_directory_permissions_and_rejects_symlink_leaf() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let (directory, path) = fixture(b"body\n");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755)).unwrap();
        HistorySourceObservation::read(&path, 100).unwrap();
        assert_eq!(
            fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
            0o755
        );
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let alias = directory.path().join("alias.jsonl");
        symlink(&path, &alias).unwrap();
        assert!(HistorySourceObservation::read(&alias, 100).is_err());
    }
}
