use super::{HistorySourceObservation, observation};
use crate::history_metadata::{HistoryTimestampBounds, PreparedSessionMetadata};
use anyhow::{Result, ensure};
use std::path::Path;

const HEAD_BYTES: usize = 64 * 1024;

/// List fields derived from the exact stream hashed by one successful observation.
/// This is not a cache hit or authority to skip a subsequent source read.
pub struct HistoryListProjection {
    observation: HistorySourceObservation,
    bounds: HistoryTimestampBounds,
    first_prompt: Option<String>,
}

impl HistoryListProjection {
    pub fn reader(path: &Path, max_line_bytes: usize) -> Result<HistoryListProjectionReader> {
        Ok(HistoryListProjectionReader {
            reader: observation::SourceObservationReader::open(path)?,
            max_line_bytes,
            head: Vec::with_capacity(HEAD_BYTES),
            line: Vec::new(),
            bounds: HistoryTimestampBounds::default(),
            failed: false,
            completed: false,
        })
    }
    /// Read the entire body with explicit total and raw-line byte budgets.
    /// A line's budget includes CR/LF bytes; an unterminated tail is also parsed.
    /// Invalid JSON is ignored, but invalid UTF-8, overflow and source errors fail
    /// the whole projection. Storage is bounded by the head, current line and result.
    pub fn read(path: &Path, max_bytes: u64, max_line_bytes: usize) -> Result<Self> {
        project_stream(max_line_bytes, |consume| {
            observation::read_with(path, max_bytes, consume)
        })
    }

    pub fn observation(&self) -> &HistorySourceObservation {
        &self.observation
    }

    pub fn first_prompt(&self) -> Option<&str> {
        self.first_prompt.as_deref()
    }

    /// Combine with this session's current validated sidecar; no body or mtime reread.
    /// The caller must prepare metadata for the same session and check workspace identity.
    pub fn timestamps_ms(&self, metadata: &PreparedSessionMetadata) -> (u64, u64) {
        metadata.observed_timestamps_ms(&self.bounds, self.observation.modified())
    }
}

/// A fixed-handle, bounded-memory full observation. No projection escapes before verified EOF.
pub struct HistoryListProjectionReader {
    reader: observation::SourceObservationReader,
    max_line_bytes: usize,
    head: Vec<u8>,
    line: Vec<u8>,
    bounds: HistoryTimestampBounds,
    failed: bool,
    completed: bool,
}

impl HistoryListProjectionReader {
    /// Revalidate a completed observation's source before delayed reuse, without body reads.
    /// A failed revalidation permanently invalidates this reader's completed proof.
    pub fn validate_completed(&mut self) -> Result<()> {
        ensure!(
            self.completed,
            "projection reader has no reusable completed observation"
        );
        let result = self.reader.validate_source();
        if result.is_err() {
            self.completed = false;
        }
        result
    }
    /// Cumulative actual bytes, including bytes consumed before a failure; never resets per step.
    pub fn bytes_read(&self) -> u64 {
        self.reader.bytes_read()
    }

    /// Read at most `max_bytes`; None means suspended, never an incomplete successful projection.
    pub fn step(&mut self, max_bytes: u64) -> Result<Option<HistoryListProjection>> {
        self.step_with(max_bytes, &mut |_| Ok(()))
    }

    pub(crate) fn step_with(
        &mut self,
        max_bytes: u64,
        consume: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<Option<HistoryListProjection>> {
        ensure!(!self.failed, "projection reader is completed or failed");
        self.failed = true;
        let head = &mut self.head;
        let line = &mut self.line;
        let bounds = &mut self.bounds;
        let max_line_bytes = self.max_line_bytes;
        let observation = self.reader.step(max_bytes, &mut |chunk| {
            consume(chunk)?;
            head.extend_from_slice(&chunk[..chunk.len().min(HEAD_BYTES - head.len())]);
            for part in chunk.split_inclusive(|byte| *byte == b'\n') {
                ensure!(
                    part.len() <= max_line_bytes.saturating_sub(line.len()),
                    "history projection exceeds line byte budget"
                );
                line.extend_from_slice(part);
                if part.ends_with(b"\n") {
                    observe_line(bounds, line)?;
                    line.clear();
                }
            }
            Ok(())
        })?;
        let Some(observation) = observation else {
            self.failed = false;
            return Ok(None);
        };
        if !self.line.is_empty() {
            observe_line(&mut self.bounds, &self.line)?;
        }
        self.completed = true;
        Ok(Some(HistoryListProjection {
            observation,
            bounds: std::mem::take(&mut self.bounds),
            first_prompt: crate::history::first_prompt_from_head(&self.head, 80),
        }))
    }
}

fn project_stream(
    max_line_bytes: usize,
    read: impl FnOnce(&mut dyn FnMut(&[u8]) -> Result<()>) -> Result<HistorySourceObservation>,
) -> Result<HistoryListProjection> {
    let mut head = Vec::with_capacity(HEAD_BYTES);
    let mut line = Vec::new();
    let mut bounds = HistoryTimestampBounds::default();
    let observation = read(&mut |chunk| {
        head.extend_from_slice(&chunk[..chunk.len().min(HEAD_BYTES - head.len())]);
        for part in chunk.split_inclusive(|byte| *byte == b'\n') {
            ensure!(
                part.len() <= max_line_bytes.saturating_sub(line.len()),
                "history projection exceeds line byte budget"
            );
            line.extend_from_slice(part);
            if part.ends_with(b"\n") {
                observe_line(&mut bounds, &line)?;
                line.clear();
            }
        }
        Ok(())
    })?;
    if !line.is_empty() {
        observe_line(&mut bounds, &line)?;
    }
    Ok(HistoryListProjection {
        observation,
        bounds,
        first_prompt: crate::history::first_prompt_from_head(&head, 80),
    })
}

fn observe_line(bounds: &mut HistoryTimestampBounds, line: &[u8]) -> Result<()> {
    let line = std::str::from_utf8(line)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    bounds.observe_line(line);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::session_first_prompt;
    use crate::history_metadata::{HistoryTimestampBounds, prepare_session_metadata};
    use kcoder_config::PrivateDirectory;
    use std::fs;
    use std::io::BufRead;

    #[test]
    fn chunked_projection_completed_revalidation_never_reads_body() {
        let (directory, path) = fixture(b"{\"timestamp_ms\":42}\n");
        let mut reader = HistoryListProjection::reader(&path, 128).unwrap();
        assert!(reader.validate_completed().is_err());
        while reader.step(3).unwrap().is_none() {}
        let bytes = reader.bytes_read();
        for _ in 0..3 {
            reader.validate_completed().unwrap();
            assert_eq!(reader.bytes_read(), bytes);
        }
        PrivateDirectory::open_existing(directory.path())
            .unwrap()
            .atomic_replace(path.file_name().unwrap(), b"{\"timestamp_ms\":42}\n")
            .unwrap();
        assert!(reader.validate_completed().is_err());
        assert_eq!(reader.bytes_read(), bytes);
        assert!(reader.validate_completed().is_err());
        assert_eq!(reader.bytes_read(), bytes);
    }

    #[test]
    fn chunked_projection_reader_is_bounded_and_matches_one_shot() {
        let body = "{\"timestamp_ms\":4,\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"中文 prompt\"}]}\r\n{\"timestamp_ms\":9}\n";
        let (_root, path) = fixture(body.as_bytes());
        let expected = HistoryListProjection::read(&path, body.len() as u64, 1024).unwrap();
        let mut reader = HistoryListProjection::reader(&path, 1024).unwrap();
        let mut completed = None;
        for _ in 0..body.len() + 1 {
            let before = reader.bytes_read();
            completed = reader
                .step(3)
                .expect("a bounded step must suspend instead of rejecting the full source");
            assert!(reader.bytes_read() - before <= 3);
            if completed.is_some() {
                break;
            }
        }
        let completed = completed.expect("reader reaches verified EOF");
        assert_eq!(reader.bytes_read(), body.len() as u64);
        assert_eq!(completed.first_prompt(), expected.first_prompt());
        assert_eq!(
            completed.observation().cache_key(),
            expected.observation().cache_key()
        );
        assert_eq!(
            completed.timestamps_ms(&prepare_session_metadata(&path).unwrap()),
            (4, 9)
        );
        assert!(reader.step(3).is_err());
        assert_eq!(reader.bytes_read(), body.len() as u64);
    }

    #[test]
    fn chunked_projection_reader_counts_failed_chunks_and_stays_poisoned() {
        for bytes in [b"\xff\n".as_slice(), b"xxxxxxxxxxxxxxxx\n"] {
            let (_directory, path) = fixture(bytes);
            let mut reader = HistoryListProjection::reader(&path, 4).unwrap();
            assert!(reader.step(8).is_err());
            assert_eq!(reader.bytes_read(), bytes.len().min(8) as u64);
            assert!(reader.head.len() <= HEAD_BYTES);
            assert!(reader.line.len() <= 4);
            let before = reader.bytes_read();
            assert!(reader.step(1000).is_err());
            assert_eq!(reader.bytes_read(), before);
        }
    }

    #[test]
    fn chunked_projection_reader_rejects_replacement_growth_truncation_and_deletion_at_eof() {
        for mutation in 0..4 {
            let (directory, path) = fixture(b"{\"timestamp_ms\":42}\n");
            let length = std::fs::metadata(&path).unwrap().len();
            let mut reader = HistoryListProjection::reader(&path, 128).unwrap();
            assert!(reader.step(2).unwrap().is_none());
            match mutation {
                0 => PrivateDirectory::open_existing(directory.path())
                    .unwrap()
                    .atomic_replace(path.file_name().unwrap(), b"{\"timestamp_ms\":42}\n")
                    .unwrap(),
                1 => {
                    use std::io::Write;
                    std::fs::OpenOptions::new()
                        .append(true)
                        .open(&path)
                        .unwrap()
                        .write_all(b"{}\n")
                        .unwrap();
                }
                2 => std::fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_len(1)
                    .unwrap(),
                _ => std::fs::remove_file(&path).unwrap(),
            }
            let before = reader.bytes_read();
            assert!(reader.step(128).is_err());
            assert!(reader.bytes_read() - before <= 128);
            if mutation == 0 || mutation == 3 {
                assert_eq!(reader.bytes_read(), length);
            }
            assert!(reader.step(128).is_err());
        }
    }

    #[test]
    fn chunked_projection_reader_crosses_head_and_line_boundaries_without_prefix_replay() {
        let mut body = vec![b'\n'; HEAD_BYTES - 5];
        body.extend_from_slice("{\"timestamp_ms\":42,\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"跨边界\"}]}\r\n".as_bytes());
        let (_directory, path) = fixture(&body);
        let expected = HistoryListProjection::read(&path, body.len() as u64, 1024).unwrap();
        let mut reader = HistoryListProjection::reader(&path, 1024).unwrap();
        let actual = loop {
            let before = reader.bytes_read();
            let result = reader.step(13).unwrap();
            assert!(reader.bytes_read() - before <= 13);
            assert!(reader.head.len() <= HEAD_BYTES && reader.line.len() <= 1024);
            if let Some(projection) = result {
                break projection;
            }
        };
        assert_eq!(reader.bytes_read(), body.len() as u64);
        assert_eq!(
            actual.observation().cache_key(),
            expected.observation().cache_key()
        );
        assert_eq!(actual.first_prompt(), expected.first_prompt());
    }

    fn fixture(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = PrivateDirectory::open_or_create(directory.path()).unwrap();
        root.atomic_replace(std::ffi::OsStr::new("session.jsonl"), bytes)
            .unwrap();
        let path = directory.path().join("session.jsonl");
        (directory, path)
    }

    // This oracle retains the old independent Value-based full-file scan.
    fn legacy_timestamps(path: &Path, created: Option<u64>, updated: Option<u64>) -> (u64, u64) {
        let mut bounds = HistoryTimestampBounds::default();
        for line in std::io::BufReader::new(fs::File::open(path).unwrap()).lines() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line.unwrap()) {
                bounds.observe(&value);
            }
        }
        bounds.resolve(path, created, updated)
    }

    fn compare(bytes: &[u8]) {
        let (_directory, path) = fixture(bytes);
        let projection =
            HistoryListProjection::read(&path, bytes.len() as u64, bytes.len()).unwrap();
        assert_eq!(
            projection.first_prompt(),
            session_first_prompt(&path, 80).as_deref()
        );
        assert_eq!(
            projection.timestamps_ms(&prepare_session_metadata(&path).unwrap()),
            legacy_timestamps(&path, None, None)
        );
        assert_eq!(projection.observation().byte_count(), bytes.len() as u64);
        assert_eq!(
            projection.observation().cache_key(),
            HistorySourceObservation::read(&path, bytes.len() as u64)
                .unwrap()
                .cache_key()
        );
    }

    #[test]
    fn matches_legacy_title_and_timestamp_oracles() {
        compare(concat!(
            "\r\ninvalid\n",
            "{\"role\":\"assistant\",\"timestamp_ms\":null,\"timestampMs\":999}\n",
            "{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\"}],\"timestamp_ms\":\"+40\"}\r\n",
            "{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"  中文\\n request  \"},{\"type\":\"text\",\"text\":\" next \"}],\"timestamp_ms\":20,\"timestamp_ms\":30}\n",
            "{\"timestampMs\":100,\"timestampMs\":80}\n",
            "{\"timestamp_ms\":900,\"body\":[1,]}\n",
            "{\"timestamp_ms\":700} trailing\n",
            "{\"timestamp_ms\":0}\n",
            "{\"timestamp\\u005fms\":\"90\"}"
        ).as_bytes());
        for body in [
            "{\"role\":\"user\"}\n{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"later\"}]}",
            "{\"role\":\"user\",\"content\":[]}\n{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"later\"}]}",
            "{\"timestamp_ms\":1}\n{\"timestamp_ms\":9",
        ] {
            compare(body.as_bytes());
        }
        compare(serde_json::json!({"role":"user","content":[{"type":"text","text":"内容".repeat(100)}]}).to_string().as_bytes());
    }

    #[test]
    fn title_matrix_preserves_fixed_legacy_expectations() {
        let text = |value: &str| {
            serde_json::json!({"role":"user","content":[{"type":"text","text":value}]}).to_string()
        };
        for (prefix, expected) in [
            ("{\"role\":\"user\"}\n", None),
            ("{\"role\":\"user\",\"content\":false}\n", None),
            ("{\"role\":\"user\",\"content\":[]}\n", Some("real prompt")),
            (
                "{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\"}]}\n",
                Some("real prompt"),
            ),
            (
                "{\"role\":\"user\",\"type\":\"system\",\"content\":[{\"type\":\"text\",\"text\":\"hidden\"}]}\n",
                Some("real prompt"),
            ),
            (
                "{\"role\":\"user\",\"subtype\":\"compact_boundary\",\"content\":[{\"type\":\"text\",\"text\":\"hidden\"}]}\n",
                Some("real prompt"),
            ),
        ] {
            let body = format!("{prefix}{}", text("real prompt"));
            let (_directory, path) = fixture(body.as_bytes());
            assert_eq!(
                HistoryListProjection::read(&path, 1000, 1000)
                    .unwrap()
                    .first_prompt(),
                expected
            );
            assert_eq!(session_first_prompt(&path, 80).as_deref(), expected);
        }
        for (body, expected) in [
            (r#"{"role":"user","content":[{"type":"text","text":"  中文\n request  "},{"type":"text","text":" next "}]}"#.to_owned(), "中文 request next".to_owned()),
            (text(&"界".repeat(81)), format!("{}…", "界".repeat(80))),
            (text(&"界".repeat(80)), "界".repeat(80)),
        ] {
            let (_directory, path) = fixture(body.as_bytes());
            assert_eq!(HistoryListProjection::read(&path, 1000, 1000).unwrap().first_prompt(), Some(expected.as_str()));
            assert_eq!(session_first_prompt(&path, 80).as_deref(), Some(expected.as_str()));
        }
    }

    #[test]
    fn timestamp_numeric_candidates_match_value_oracle() {
        for value in [
            "0",
            "-0",
            "-1",
            "1.0",
            "1e0",
            "1e300",
            "18446744073709551615",
            "18446744073709551616",
            "null",
            "false",
            "[]",
            "{}",
            r#""+3""#,
            r#""0003""#,
            r#"" 3""#,
            r#""3 ""#,
            r#""-0""#,
            r#""18446744073709551616""#,
        ] {
            compare(
                format!(
                    "{{\"timestamp_ms\":{value},\"timestampMs\":7}}\n{{\"timestampMs\":{value}}}"
                )
                .as_bytes(),
            );
        }
    }

    #[test]
    fn crosses_head_and_chunk_boundaries_without_changing_legacy_semantics() {
        for prefix_len in [65_534, 65_535, 65_536, 65_537] {
            let mut body = vec![b' '; prefix_len];
            body.extend_from_slice("中文\r\n".as_bytes());
            body.extend_from_slice(b"{\"timestamp_ms\":40,\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"after head\"}]}");
            compare(&body);
        }
        let mut body = b"{\"body\":\"".to_vec();
        body.resize(65_535, b'x');
        body.extend_from_slice("中文\",\"timestamp_ms\":42}\r\n{\"timestampMs\":90}".as_bytes());
        compare(&body);
        let mut body = vec![b'\n'; 65_535];
        body.extend_from_slice(b"\r\n{\"timestamp_ms\":42}");
        compare(&body);
    }

    #[test]
    fn short_chunks_accumulate_head_and_enforce_long_line_budget() {
        let record = "{\"timestamp_ms\":42,\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"中文 prompt\"}]}";
        for extra in [0, 1] {
            let body = format!("{}{record}", " ".repeat(HEAD_BYTES - record.len() + extra));
            let (_directory, path) = fixture(body.as_bytes());
            let projection = project_stream(body.len(), |consume| {
                observation::read_with(&path, body.len() as u64, |chunk| {
                    for short in chunk.chunks(13) {
                        consume(short)?;
                    }
                    Ok(())
                })
            })
            .unwrap();
            let expected = (extra == 0).then_some("中文 prompt");
            assert_eq!(projection.first_prompt(), expected);
            assert_eq!(session_first_prompt(&path, 80).as_deref(), expected);
            assert_eq!(
                projection.timestamps_ms(&prepare_session_metadata(&path).unwrap()),
                (42, 42)
            );
            assert_eq!(
                projection.observation().cache_key(),
                HistorySourceObservation::read(&path, body.len() as u64)
                    .unwrap()
                    .cache_key()
            );
            assert!(HistoryListProjection::read(&path, body.len() as u64, body.len() - 1).is_err());
        }
    }

    #[test]
    fn explicit_body_and_raw_line_budgets_never_truncate() {
        let (_directory, path) = fixture(b"");
        assert!(HistoryListProjection::read(&path, 0, 0).is_ok());
        for body in [b"{}".as_slice(), b"{}\n", b"{}\r\n", b"\n", b"{}\n{}"] {
            let (_directory, path) = fixture(body);
            let longest = body
                .split_inclusive(|b| *b == b'\n')
                .map(<[u8]>::len)
                .max()
                .unwrap();
            assert!(HistoryListProjection::read(&path, body.len() as u64, longest).is_ok());
            for (max_bytes, max_line) in [
                (0, longest),
                (body.len() as u64 - 1, longest),
                (body.len() as u64, 0),
                (body.len() as u64, longest - 1),
            ] {
                assert!(HistoryListProjection::read(&path, max_bytes, max_line).is_err());
            }
        }
    }

    #[test]
    fn invalid_utf8_fails_even_after_successful_records_or_in_tail() {
        for suffix in [b"\xff\n".as_slice(), b"\xe4\xb8", b"{\"body\":\"\xff\"}\n"] {
            let mut body = b"{\"timestamp_ms\":1,\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"valid\"}]}\n".to_vec();
            body.extend_from_slice(suffix);
            let (_directory, path) = fixture(&body);
            assert!(HistoryListProjection::read(&path, body.len() as u64, body.len()).is_err());
        }
    }

    #[test]
    fn current_sidecar_combines_with_observed_bounds_without_reopening_body() {
        let (_directory, path) = fixture(b"{\"timestamp_ms\":40}\n{\"timestampMs\":90}");
        let projection = HistoryListProjection::read(&path, 100, 100).unwrap();
        let sidecar = crate::session_state_path(path.parent().unwrap(), "session");
        fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        for (created, updated) in [
            (None, Some(150)),
            (Some(5), Some(80)),
            (Some(300), Some(200)),
            (Some(0), None),
        ] {
            fs::write(&sidecar, serde_json::to_vec(&serde_json::json!({"schema_version":1,"created_at_ms":created,"updated_at_ms":updated})).unwrap()).unwrap();
            let expected = legacy_timestamps(&path, created, updated);
            assert_eq!(
                projection.timestamps_ms(&prepare_session_metadata(&path).unwrap()),
                expected
            );
        }
        let metadata = prepare_session_metadata(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(projection.timestamps_ms(&metadata), (0, 90));
    }

    #[test]
    fn missing_timestamp_fallback_uses_observation_mtime() {
        let (_directory, path) = fixture(b"invalid json\n");
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(42))
            .unwrap();
        let metadata = prepare_session_metadata(&path).unwrap();
        let projection = HistoryListProjection::read(&path, 100, 100).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(projection.timestamps_ms(&metadata), (42_000, 42_000));
    }

    #[test]
    fn stream_failure_after_consumption_never_delivers_projection() {
        let (_directory, path) = fixture(b"{\"timestamp_ms\":42}\n");
        let mut consumed = false;
        let result = project_stream(100, |consume| {
            observation::read_with(&path, 100, |chunk| {
                consume(chunk)?;
                consumed = true;
                fs::remove_file(&path).unwrap();
                Ok(())
            })
        });
        assert!(consumed);
        assert!(result.is_err());
    }

    #[test]
    fn consumer_failure_after_valid_chunk_never_delivers_projection() {
        let (_directory, path) = fixture(b"{\"timestamp_ms\":42}\n");
        for suffix in [b"\xff\n".as_slice(), &[b'x'; 101]] {
            let result = project_stream(100, |consume| {
                let observation = observation::read_with(&path, 100, &mut *consume)?;
                consume(suffix)?;
                Ok(observation)
            });
            assert!(result.is_err());
        }
    }
}
