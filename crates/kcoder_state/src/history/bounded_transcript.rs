use crate::HistoryEntry;
use anyhow::{Context, ensure};
use std::io::{BufRead, Read};
use std::path::Path;

/// Incremental strict source reader. Logical bytes are bounded per step; the
/// fixed BufReader may prefetch up to 8 KiB. Each complete record updates replay state.
pub struct BoundedTranscriptReader {
    reader: std::io::BufReader<std::io::Take<std::fs::File>>,
    decoder: TranscriptDecoder,
    finished: bool,
}

pub(super) struct TranscriptDecoder {
    max_bytes: usize,
    max_line_bytes: usize,
    max_records: usize,
    consumed: usize,
    lines: usize,
    pending: Vec<u8>,
    replay: super::incremental_transcript::IncrementalTranscript,
}
impl BoundedTranscriptReader {
    pub fn open(
        path: &Path,
        max_bytes: usize,
        max_line_bytes: usize,
        max_records: usize,
    ) -> anyhow::Result<Self> {
        let decoder = TranscriptDecoder::new(max_bytes, max_line_bytes, max_records)?;
        let parent = path.parent().context("transcript source has no parent")?;
        let name = path
            .file_name()
            .context("transcript source has no filename")?;
        let file =
            kcoder_config::PrivateDirectory::open_existing(parent)?.open_regular_file(name)?;
        Ok(Self {
            reader: std::io::BufReader::with_capacity(8192, file.take(max_bytes as u64 + 1)),
            decoder,
            finished: false,
        })
    }
    pub fn bytes_consumed(&self) -> usize {
        self.decoder.consumed
    }
    pub fn step(&mut self, budget: usize) -> anyhow::Result<Option<Vec<HistoryEntry>>> {
        ensure!(!self.finished, "transcript reader has finished");
        ensure!(budget > 0, "transcript step budget must be positive");
        let result = self.step_inner(budget);
        if result.is_err() {
            self.finished = true;
        }
        result
    }
    fn step_inner(&mut self, budget: usize) -> anyhow::Result<Option<Vec<HistoryEntry>>> {
        let mut remaining = budget;
        while remaining > 0 {
            let available = self.reader.fill_buf()?;
            if available.is_empty() {
                self.finished = true;
                return Ok(Some(self.decoder.finish()?));
            }
            let take = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1)
                .unwrap_or(available.len())
                .min(remaining);
            self.decoder.push(&available[..take])?;
            self.reader.consume(take);
            remaining -= take;
        }
        Ok(None)
    }
}

impl TranscriptDecoder {
    pub(super) fn new(
        max_bytes: usize,
        max_line_bytes: usize,
        max_records: usize,
    ) -> anyhow::Result<Self> {
        ensure!(
            (1..=128 * 1024 * 1024).contains(&max_bytes)
                && (1..=4 * 1024 * 1024).contains(&max_line_bytes)
                && (1..=100_000).contains(&max_records),
            "invalid transcript source budget"
        );
        Ok(Self {
            max_bytes,
            max_line_bytes,
            max_records,
            consumed: 0,
            lines: 0,
            pending: Vec::new(),
            replay: Default::default(),
        })
    }

    pub(super) fn remaining_bytes(&self) -> usize {
        self.max_bytes.saturating_sub(self.consumed)
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        ensure!(
            bytes.len() <= self.remaining_bytes(),
            "transcript source exceeds indexing budget"
        );
        self.consumed += bytes.len();
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            ensure!(
                part.len() <= self.max_line_bytes.saturating_sub(self.pending.len()),
                "transcript source exceeds indexing budget"
            );
            self.pending.extend_from_slice(part);
            if self.pending.last() == Some(&b'\n') {
                self.lines += 1;
                ensure!(
                    self.lines <= self.max_records,
                    "transcript source exceeds record budget"
                );
                let text =
                    std::str::from_utf8(&self.pending).context("transcript source is not UTF-8")?;
                if !text.trim().is_empty() {
                    let value = serde_json::from_str(text).with_context(|| {
                        format!("invalid transcript JSON at line {}", self.lines)
                    })?;
                    self.replay.apply(value, self.lines)?;
                }
                self.pending.clear();
            }
        }
        Ok(())
    }

    pub(super) fn finish(&mut self) -> anyhow::Result<Vec<HistoryEntry>> {
        ensure!(
            self.pending.is_empty(),
            "transcript source has an incomplete tail"
        );
        Ok(std::mem::take(&mut self.replay).finish())
    }
}

/// Strict cold input for derived indexes. Legacy tolerant replay remains unchanged.
/// Budgets include physical blank lines and LF bytes; incomplete tails are not publishable.
pub fn load_transcript_history_bounded(
    path: &Path,
    max_bytes: usize,
    max_line_bytes: usize,
    max_records: usize,
) -> anyhow::Result<Vec<HistoryEntry>> {
    let mut reader = BoundedTranscriptReader::open(path, max_bytes, max_line_bytes, max_records)?;
    loop {
        if let Some(entries) = reader.step(max_bytes)? {
            return Ok(entries);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transcript_reader_applies_and_rejects_invalid_records_before_eof() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        let bad = "{\"role\":\"invalid\"}\n";
        std::fs::write(&path, format!("{bad}\n")).unwrap();
        let mut reader = BoundedTranscriptReader::open(&path, 4096, 1024, 10).unwrap();
        assert!(reader.step(bad.len()).is_err());
        assert!(reader.step(1).is_err());
    }
    #[test]
    fn transcript_reader_splits_utf8_and_lines_across_bounded_steps() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        let entry = serde_json::json!({"session_id":"test","timestamp_ms":1,"role":"user","content":[{"type":"text","text":"中文跨片段"}]});
        let bytes = format!("{entry}\n{entry}\n");
        std::fs::write(&path, &bytes).unwrap();
        let expected =
            serde_json::to_value(load_transcript_history_bounded(&path, 4096, 1024, 10).unwrap())
                .unwrap();
        for budget in [1, 3, 17, 1024] {
            let mut reader = BoundedTranscriptReader::open(&path, 4096, 1024, 10).unwrap();
            let mut before = 0;
            let output = loop {
                let next = reader.step(budget).unwrap();
                assert!(reader.bytes_consumed() - before <= budget);
                before = reader.bytes_consumed();
                if let Some(output) = next {
                    break output;
                }
            };
            assert_eq!(serde_json::to_value(output).unwrap(), expected);
            assert_eq!(before, bytes.len());
            assert!(reader.step(budget).is_err());
        }
    }
    #[test]
    fn indexed_transcript_rejects_incomplete_source_instead_of_publishing_prefix() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        std::fs::write(&path, b"{\"type\":\"system\"}").unwrap();
        assert!(load_transcript_history_bounded(&path, 1024, 128, 10).is_err());
    }

    #[test]
    fn indexed_transcript_preserves_legacy_projection_and_rejects_budget_overflow() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        let entry = HistoryEntry {
            session_id: "fixture".into(),
            timestamp_ms: 123,
            uuid: None,
            parent_uuid: None,
            message: kcoder_types::Message::user_text("中文 content"),
        };
        let mut source = serde_json::to_vec(&entry).unwrap();
        source.push(b'\n');
        std::fs::write(&path, &source).unwrap();
        assert_eq!(
            serde_json::to_value(
                load_transcript_history_bounded(&path, source.len(), source.len(), 1).unwrap()
            )
            .unwrap(),
            serde_json::to_value(super::super::load_transcript_history(&path).unwrap()).unwrap()
        );
        assert!(load_transcript_history_bounded(&path, source.len() - 1, source.len(), 1).is_err());
        assert!(load_transcript_history_bounded(&path, source.len(), source.len() - 1, 1).is_err());
        source.extend_from_slice(b"\n");
        std::fs::write(&path, &source).unwrap();
        assert!(load_transcript_history_bounded(&path, source.len(), source.len(), 1).is_err());
        std::fs::write(&path, b"{broken}\n").unwrap();
        assert!(load_transcript_history_bounded(&path, 1024, 128, 10).is_err());
    }
}
