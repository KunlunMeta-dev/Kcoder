use crate::session_persistence::{
    load_session_state, parse_session_state, session_id_from_history_path,
    session_state_path_for_history,
};
use crate::{SessionMode, session_state_path};
use anyhow::Context;
use std::fs;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};

mod timestamps;

/// One call's validated sidecar fields, not a reusable cache or an authorization decision.
pub struct PreparedSessionMetadata {
    path: PathBuf,
    base_cwd: Option<PathBuf>,
    session_mode: SessionMode,
    created_at_ms: Option<u64>,
    updated_at_ms: Option<u64>,
}

pub fn prepare_session_metadata(path: &Path) -> anyhow::Result<PreparedSessionMetadata> {
    let state = load_metadata_state(path)?;
    Ok(PreparedSessionMetadata::from_state(path, state))
}

/// Read one validated regular sidecar handle, consuming at most `max_bytes + 1` bytes.
/// The extra byte detects overflow; oversized sidecars are errors, never truncated metadata.
pub fn prepare_session_metadata_bounded(
    path: &Path,
    max_bytes: u64,
) -> anyhow::Result<PreparedSessionMetadata> {
    let sidecar = metadata_state_path(path)?;
    let open = || -> anyhow::Result<std::fs::File> {
        let parent = sidecar.parent().context("session sidecar has no parent")?;
        let name = sidecar
            .file_name()
            .context("session sidecar has no file name")?;
        kcoder_config::PrivateDirectory::open_existing(parent)?.open_regular_file(name)
    };
    let state = match open() {
        Ok(file) => read_bounded_metadata(&sidecar, file, max_bytes)?,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            crate::PersistedSessionState::default()
        }
        Err(error) => return Err(error),
    };
    Ok(PreparedSessionMetadata::from_state(path, state))
}

fn read_bounded_metadata(
    path: &Path,
    reader: impl Read,
    max_bytes: u64,
) -> anyhow::Result<crate::PersistedSessionState> {
    let limit = max_bytes
        .checked_add(1)
        .context("invalid sidecar byte budget")?;
    let mut content = Vec::new();
    reader.take(limit).read_to_end(&mut content)?;
    anyhow::ensure!(
        content.len() as u64 <= max_bytes,
        "session sidecar exceeds byte budget"
    );
    parse_session_state(
        path,
        std::str::from_utf8(&content).context("session sidecar is not UTF-8")?,
    )
}

impl PreparedSessionMetadata {
    fn from_state(path: &Path, state: crate::PersistedSessionState) -> Self {
        Self {
            path: path.to_path_buf(),
            base_cwd: state.base_cwd.or(state.cwd),
            session_mode: state.session_mode,
            created_at_ms: state.created_at_ms,
            updated_at_ms: state.updated_at_ms,
        }
    }

    /// Bind all prepared inputs actually used by list projection, not future sidecar freshness.
    pub fn list_input_key(&self) -> anyhow::Result<[u8; 32]> {
        use sha2::{Digest, Sha256};
        let encoded = serde_json::to_vec(&(
            "kcoder.prepared-list-input.v1",
            &self.path,
            &self.base_cwd,
            self.session_mode,
            self.created_at_ms,
            self.updated_at_ms,
        ))?;
        Ok(Sha256::digest(encoded).into())
    }

    pub fn base_cwd(&self) -> Option<&Path> {
        self.base_cwd.as_deref()
    }
    pub fn session_mode(&self) -> SessionMode {
        self.session_mode
    }

    /// Scan timestamps only after the caller has checked the prepared workspace identity.
    pub fn timestamps_ms(&self) -> anyhow::Result<(u64, u64)> {
        Ok(HistoryTimestampBounds::read(&self.path)?.resolve(
            &self.path,
            self.created_at_ms,
            self.updated_at_ms,
        ))
    }

    pub fn first_prompt(&self, max_chars: usize) -> Option<String> {
        crate::history::session_first_prompt(&self.path, max_chars)
    }

    pub(crate) fn observed_timestamps_ms(
        &self,
        bounds: &HistoryTimestampBounds,
        modified: Option<std::time::SystemTime>,
    ) -> (u64, u64) {
        bounds.resolve_with_fallback(self.created_at_ms, self.updated_at_ms, || {
            modified
                .and_then(|timestamp| timestamp.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default()
        })
    }
}

pub(super) fn load_metadata_state(path: &Path) -> anyhow::Result<crate::PersistedSessionState> {
    load_session_state(&metadata_state_path(path)?)
}

fn metadata_state_path(path: &Path) -> anyhow::Result<PathBuf> {
    let session_id = session_id_from_history_path(path)?;
    let primary = path
        .parent()
        .map(|dir| session_state_path(dir, &session_id))
        .unwrap_or_else(|| session_state_path_for_history(path));
    let legacy = session_state_path_for_history(path);
    Ok(if primary.exists() || !legacy.exists() {
        primary
    } else {
        legacy
    })
}

#[derive(Default)]
pub(super) struct HistoryTimestampBounds {
    first: Option<u64>,
    latest: Option<u64>,
}

impl HistoryTimestampBounds {
    pub(super) fn observe(&mut self, value: &serde_json::Value) {
        let timestamp = value
            .get("timestamp_ms")
            .or_else(|| value.get("timestampMs"));
        self.observe_timestamp(timestamp.and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.parse::<u64>().ok())
        }));
    }

    fn observe_timestamp(&mut self, timestamp: Option<u64>) {
        if let Some(timestamp) = timestamp {
            self.first.get_or_insert(timestamp);
            self.latest = Some(self.latest.unwrap_or(0).max(timestamp));
        }
    }

    pub(crate) fn observe_line(&mut self, line: &str) {
        if let Ok(timestamp) = timestamps::timestamp_from_line(line) {
            self.observe_timestamp(timestamp);
        }
    }

    pub(super) fn read(path: &Path) -> anyhow::Result<Self> {
        let _span = tracing::debug_span!("history.timestamp_replay").entered();
        let mut bounds = Self::default();
        let mut reader = std::io::BufReader::new(fs::File::open(path)?);
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                break;
            }
            bounds.observe_line(&line);
        }
        Ok(bounds)
    }

    pub(super) fn resolve(
        &self,
        path: &Path,
        created_at_ms: Option<u64>,
        updated_at_ms: Option<u64>,
    ) -> (u64, u64) {
        self.resolve_with_fallback(created_at_ms, updated_at_ms, || {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|timestamp| timestamp.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default()
        })
    }

    fn resolve_with_fallback(
        &self,
        created_at_ms: Option<u64>,
        updated_at_ms: Option<u64>,
        fallback: impl FnOnce() -> u64,
    ) -> (u64, u64) {
        let created = created_at_ms.or(self.first).unwrap_or_else(fallback);
        let updated = self
            .latest
            .into_iter()
            .chain(updated_at_ms)
            .chain(self.first)
            .max()
            .unwrap_or(created)
            .max(created);
        (created, updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bounded_metadata_rejects_oversize_sidecar_without_changing_legacy_reads() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let sidecar = session_state_path_for_history(&history);
        let bytes = br#"{"schema_version":1,"cwd":"project"}"#;
        fs::write(&sidecar, bytes).unwrap();
        assert!(prepare_session_metadata(&history).is_ok());
        assert!(prepare_session_metadata_bounded(&history, bytes.len() as u64).is_ok());
        assert!(prepare_session_metadata_bounded(&history, bytes.len() as u64 - 1).is_err());
    }

    #[test]
    fn bounded_metadata_reads_at_most_budget_plus_one_from_its_handle() {
        let mut input = std::io::Cursor::new(vec![b' '; 1024]);
        assert!(read_bounded_metadata(Path::new("state.json"), &mut input, 7).is_err());
        assert_eq!(input.position(), 8);
    }

    #[test]
    fn bounded_metadata_uses_shared_schema_validation_and_primary_selection() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let legacy = session_state_path_for_history(&history);
        let primary = session_state_path(temp.path(), "session");
        fs::write(&legacy, br#"{"schema_version":1,"cwd":"legacy"}"#).unwrap();
        assert_eq!(
            prepare_session_metadata_bounded(&history, 1024)
                .unwrap()
                .base_cwd(),
            Some(Path::new("legacy"))
        );
        fs::create_dir_all(primary.parent().unwrap()).unwrap();
        for bytes in [
            br#"{"schema_version":4294967295}"#.as_slice(),
            br#"{"schema_version":2,"delivery_format":"invalid"}"#,
            b"{",
            b"\xff",
        ] {
            fs::write(&primary, bytes).unwrap();
            assert!(prepare_session_metadata(&history).is_err());
            assert!(prepare_session_metadata_bounded(&history, 1024).is_err());
        }
        fs::write(
            &primary,
            br#"{"schema_version":2,"delivery_format":"lease_ack_v1","base_cwd":"primary"}"#,
        )
        .unwrap();
        assert_eq!(
            prepare_session_metadata_bounded(&history, 1024)
                .unwrap()
                .base_cwd(),
            Some(Path::new("primary"))
        );
    }

    #[test]
    fn prepared_list_input_key_binds_each_used_field() {
        let original = || PreparedSessionMetadata {
            path: PathBuf::from("session.jsonl"),
            base_cwd: Some(PathBuf::from("workspace")),
            session_mode: SessionMode::Default,
            created_at_ms: Some(1),
            updated_at_ms: Some(2),
        };
        let key = original().list_input_key().unwrap();
        assert_eq!(key, original().list_input_key().unwrap());
        for field in 0..5 {
            let mut prepared = original();
            match field {
                0 => prepared.path = PathBuf::from("other.jsonl"),
                1 => prepared.base_cwd = Some(PathBuf::from("other")),
                2 => prepared.session_mode = SessionMode::Orchestrate,
                3 => prepared.created_at_ms = None,
                _ => prepared.updated_at_ms = Some(3),
            }
            assert_ne!(key, prepared.list_input_key().unwrap(), "field {field}");
        }
    }

    #[test]
    #[ignore = "explicit isolated timestamp scan baseline; not a timing assertion"]
    fn metadata_timestamp_scan_warm_baseline() {
        const SESSIONS: usize = 10;
        const RECORDS: usize = 2_000;
        const SAMPLES: usize = 21;
        let temp = tempfile::tempdir().unwrap();
        let text = "中文工具输出与上下文 ".repeat(32);
        let mut body = String::new();
        for ordinal in 1..=RECORDS {
            let record = json!({
                "timestamp_ms": ordinal,
                "role": if ordinal % 2 == 0 { "assistant" } else { "user" },
                "content": [{"type": "text", "text": text}],
            });
            body.push_str(&record.to_string());
            body.push('\n');
        }
        let paths: Vec<_> = (0..SESSIONS)
            .map(|index| {
                let id = format!("baseline-{index}");
                let path = temp.path().join(format!("{id}.jsonl"));
                fs::write(&path, body.as_bytes()).unwrap();
                let sidecar = session_state_path(temp.path(), &id);
                fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
                fs::write(
                    &sidecar,
                    serde_json::to_vec(&json!({
                        "schema_version": 1, "base_cwd": temp.path(),
                    }))
                    .unwrap(),
                )
                .unwrap();
                path
            })
            .collect();
        let scan = || {
            for path in &paths {
                let metadata = prepare_session_metadata(path).unwrap();
                assert_eq!(metadata.base_cwd(), Some(temp.path()));
                assert_eq!(metadata.timestamps_ms().unwrap(), (1, RECORDS as u64));
            }
        };
        // Warm this fixture only; do not evict host caches or read personal histories.
        scan();
        let mut samples = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let start = std::time::Instant::now();
            scan();
            samples.push(start.elapsed().as_micros());
        }
        samples.sort_unstable();
        let percentile = |p: usize| samples[(SAMPLES * p).div_ceil(100) - 1];
        eprintln!(
            "{}",
            json!({
                "benchmark": "prepared_metadata_timestamp_scan",
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "debug_assertions": cfg!(debug_assertions),
                "cache": "fixture-warmed",
                "sessions": SESSIONS,
                "records_per_session": RECORDS,
                "fixture_body_bytes": body.len() * SESSIONS,
                "samples": SAMPLES,
                "p50_us": percentile(50),
                "p95_us": percentile(95),
                "p99_us": percentile(99),
                "min_us": samples[0],
                "max_us": samples[SAMPLES - 1],
            })
        );
        for path in paths {
            assert_eq!(fs::read(path).unwrap(), body.as_bytes());
        }
    }

    #[test]
    fn metadata_preparation_preserves_primary_legacy_selection_and_validation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let legacy = session_state_path_for_history(&path);
        let primary = session_state_path(temp.path(), "session");
        let old_cwd = temp.path().join("legacy-project");
        let base_cwd = temp.path().join("base-project");
        fs::write(
            &legacy,
            serde_json::to_vec(&json!({"schema_version":1,"cwd":old_cwd})).unwrap(),
        )
        .unwrap();
        let metadata = prepare_session_metadata(&path).unwrap();
        assert_eq!(metadata.base_cwd(), Some(old_cwd.as_path()));
        fs::create_dir_all(primary.parent().unwrap()).unwrap();
        fs::write(
            &primary,
            serde_json::to_vec(&json!({
                "schema_version":1,"cwd":old_cwd,"base_cwd":base_cwd,"session_mode":"orchestrate"
            }))
            .unwrap(),
        )
        .unwrap();
        let metadata = prepare_session_metadata(&path).unwrap();
        assert_eq!(metadata.base_cwd(), Some(base_cwd.as_path()));
        assert_eq!(metadata.session_mode(), SessionMode::Orchestrate);
        fs::write(&primary, br#"{"schema_version":4294967295}"#).unwrap();
        assert!(
            prepare_session_metadata(&path)
                .err()
                .unwrap()
                .to_string()
                .contains("future schema")
        );
        fs::remove_file(&primary).unwrap();
        assert_eq!(
            prepare_session_metadata(&path).unwrap().base_cwd(),
            Some(old_cwd.as_path())
        );
    }

    #[test]
    fn metadata_preparation_retains_all_record_timestamps_during_resume() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let records = [
            json!({"session_id":"session","timestamp_ms":100,"uuid":"user-1","role":"user","content":[{"type":"text","text":"first request"}]}),
            json!({"type":"system","subtype":"compact_boundary","timestampMs":"900"}),
            json!({"session_id":"session","timestamp_ms":500,"uuid":"summary","isCompactSummary":true,"role":"user","content":[{"type":"text","text":"Earlier conversation summary: compacted"}]}),
            json!({"type":"system","subtype":"rewind_boundary","timestamp_ms":700,"rewindMetadata":{"anchorUuid":"summary"}}),
        ];
        let raw = records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>();
        fs::write(&path, raw).unwrap();
        let before = fs::read(&path).unwrap();
        let expected = crate::session_timestamps_ms(&path).unwrap();
        assert_eq!(expected, (100, 900));
        let resumed = crate::AppState::new(temp.path());
        resumed.resume_from_history(&path).unwrap();
        assert_eq!(resumed.session_timestamps_ms(), expected);
        assert_eq!(resumed.messages().len(), 1);
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn metadata_preparation_uses_file_mtime_only_when_all_timestamps_are_absent() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        fs::write(&path, b"{\"type\":\"system\",\"subtype\":\"notice\"}\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(42))
            .unwrap();
        assert_eq!(
            crate::session_timestamps_ms(&path).unwrap(),
            (42_000, 42_000)
        );
        let resumed = crate::AppState::new(temp.path());
        resumed.resume_from_history(&path).unwrap();
        assert_eq!(resumed.session_timestamps_ms(), (42_000, 42_000));
    }

    #[test]
    fn metadata_timestamp_resolution_preserves_field_precedence_and_state_bounds() {
        let mut bounds = HistoryTimestampBounds::default();
        for value in [
            json!({"timestamp_ms":null,"timestampMs":9999}),
            json!({"timestamp_ms":"20"}),
            json!({"timestampMs":10}),
            json!({"timestamp_ms":100}),
        ] {
            bounds.observe(&value);
        }
        let temp = tempfile::tempdir().unwrap();
        let unused = temp.path().join("not-read.jsonl");
        assert_eq!(bounds.resolve(&unused, None, None), (20, 100));
        assert_eq!(bounds.resolve(&unused, Some(5), Some(200)), (5, 200));
        assert_eq!(bounds.resolve(&unused, Some(300), Some(200)), (300, 300));
    }

    #[test]
    fn metadata_timestamp_read_matches_value_lines_and_sidecar_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let raw = concat!(
            "\r\n \t\r\n",
            "{\"timestamp_ms\":null,\"timestampMs\":9999}\r\n",
            "{\"timestamp_ms\":20,\"timestamp_ms\":\"+40\"}\r\n",
            "{\"timestamp_ms\":9000,\"body\":[1,]}\n",
            "{\"timestamp_ms\":8000} trailing\n",
            "[{\"timestamp_ms\":7000}]\n",
            "{\"timestampMs\":100,\"body\":{\"timestamp_ms\":6000}}\n",
            "{\"timestamp_ms\":0}\r\n",
            "{\"timestamp\\u005fms\":\"80\"}"
        );
        fs::write(&path, raw).unwrap();
        let mut oracle = HistoryTimestampBounds::default();
        for line in std::io::BufReader::new(raw.as_bytes()).lines() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line.unwrap()) {
                oracle.observe(&value);
            }
        }
        let actual = HistoryTimestampBounds::read(&path).unwrap();
        assert_eq!((oracle.first, oracle.latest), (Some(40), Some(100)));
        assert_eq!((actual.first, actual.latest), (oracle.first, oracle.latest));
        assert_eq!(
            prepare_session_metadata(&path)
                .unwrap()
                .timestamps_ms()
                .unwrap(),
            (40, 100)
        );
        let sidecar = session_state_path(temp.path(), "session");
        fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        for (created, updated, expected) in [
            (None, Some(150), (40, 150)),
            (Some(5), Some(90), (5, 100)),
            (Some(300), Some(200), (300, 300)),
            (Some(0), None, (0, 100)),
        ] {
            fs::write(
                &sidecar,
                serde_json::to_vec(&json!({
                    "schema_version": 1,
                    "created_at_ms": created,
                    "updated_at_ms": updated,
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(
                actual.resolve(&path, created, updated),
                oracle.resolve(&path, created, updated)
            );
            assert_eq!(
                prepare_session_metadata(&path)
                    .unwrap()
                    .timestamps_ms()
                    .unwrap(),
                expected
            );
        }
        assert_eq!(fs::read(&path).unwrap(), raw.as_bytes());
    }

    #[test]
    fn metadata_timestamp_read_propagates_io_and_utf8_errors() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        assert!(HistoryTimestampBounds::read(&path).is_err());
        assert!(HistoryTimestampBounds::read(temp.path()).is_err());
        fs::write(&path, b"{\"timestamp_ms\":1}\n\xff\n{\"timestamp_ms\":9}\n").unwrap();
        let error = HistoryTimestampBounds::read(&path).err().unwrap();
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::InvalidData
        );
    }
}
