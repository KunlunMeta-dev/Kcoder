use super::bounded_transcript::TranscriptDecoder;
use crate::HistoryEntry;
use crate::history_index::{HistoryListProjection, HistoryListProjectionReader};
use anyhow::ensure;
use std::path::Path;

/// Decode strict transcript records and list fields from the same validated source read.
pub struct ProjectedTranscriptReader {
    source: HistoryListProjectionReader,
    decoder: TranscriptDecoder,
    projection: Option<HistoryListProjection>,
    finished: bool,
}

impl ProjectedTranscriptReader {
    pub fn open(
        path: &Path,
        max_bytes: usize,
        max_line_bytes: usize,
        max_records: usize,
    ) -> anyhow::Result<Self> {
        let decoder = TranscriptDecoder::new(max_bytes, max_line_bytes, max_records)?;
        Ok(Self {
            source: HistoryListProjection::reader(path, max_line_bytes)?,
            decoder,
            projection: None,
            finished: false,
        })
    }

    pub fn bytes_read(&self) -> u64 {
        self.source.bytes_read()
    }

    pub fn step(&mut self, budget: usize) -> anyhow::Result<Option<Vec<HistoryEntry>>> {
        ensure!(!self.finished, "projected transcript reader has finished");
        ensure!(budget > 0, "transcript step budget must be positive");
        let allowance = budget.min(self.decoder.remaining_bytes() + 1);
        let decoder = &mut self.decoder;
        match self
            .source
            .step_with(allowance as u64, &mut |bytes| decoder.push(bytes))
        {
            Ok(None) => Ok(None),
            Ok(Some(projection)) => {
                self.finished = true;
                let entries = self.decoder.finish()?;
                self.projection = Some(projection);
                Ok(Some(entries))
            }
            Err(error) => {
                self.finished = true;
                Err(error)
            }
        }
    }

    /// Available only after both source validation and strict transcript decoding succeed.
    pub fn take_projection(&mut self) -> Option<HistoryListProjection> {
        self.projection.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projected_transcript_matches_independent_reads_with_single_source_byte_count() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        let entry = serde_json::json!({"session_id":"fixture","timestamp_ms":123,"role":"user","content":[{"type":"text","text":"中文跨片段"}]});
        let source = format!("{entry}\n{entry}\n");
        std::fs::write(&path, &source).unwrap();
        let expected = crate::load_transcript_history_bounded(&path, 4096, 1024, 10).unwrap();
        let metadata = HistoryListProjection::read(&path, 4096, 1024).unwrap();
        let prepared = crate::history_metadata::prepare_session_metadata(&path).unwrap();
        for budget in [1, 3, 17, 1024] {
            let mut reader =
                ProjectedTranscriptReader::open(&path, source.len(), 1024, 10).unwrap();
            assert!(reader.take_projection().is_none());
            let mut before = 0;
            let entries = loop {
                let next = reader.step(budget).unwrap();
                assert!(reader.bytes_read() - before <= budget as u64);
                before = reader.bytes_read();
                if let Some(entries) = next {
                    break entries;
                }
            };
            assert_eq!(
                serde_json::to_value(entries).unwrap(),
                serde_json::to_value(&expected).unwrap()
            );
            let projection = reader.take_projection().unwrap();
            assert_eq!(projection.first_prompt(), metadata.first_prompt());
            assert_eq!(
                projection.timestamps_ms(&prepared),
                metadata.timestamps_ms(&prepared)
            );
            assert_eq!(
                projection.observation().cache_key(),
                metadata.observation().cache_key()
            );
            assert_eq!(reader.bytes_read(), source.len() as u64);
            assert!(reader.step(1).is_err());
            assert!(reader.take_projection().is_none());
        }
    }

    #[test]
    fn projected_transcript_rejects_source_replacement_before_eof() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        let source = b"{\"session_id\":\"fixture\",\"timestamp_ms\":123,\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"valid\"}]}\n";
        std::fs::write(&path, source).unwrap();
        let mut intact = ProjectedTranscriptReader::open(&path, 4096, 1024, 10).unwrap();
        assert!(intact.step(4096).unwrap().is_some());
        let mut reader = ProjectedTranscriptReader::open(&path, 4096, 1024, 10).unwrap();
        assert!(reader.step(1).unwrap().is_none());
        kcoder_config::PrivateDirectory::open_existing(root.path())
            .unwrap()
            .atomic_replace(path.file_name().unwrap(), source)
            .unwrap();
        assert!(reader.step(4096).is_err());
        assert!(reader.take_projection().is_none());
        assert!(reader.step(1).is_err());
    }

    #[test]
    fn projected_transcript_never_exposes_projection_after_invalid_or_over_budget_input() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        for input in [b"{broken}\n".as_slice(), b"{\"type\":\"system\"}", b"\n\n"] {
            std::fs::write(&path, input).unwrap();
            let mut reader = ProjectedTranscriptReader::open(&path, 128, 128, 1).unwrap();
            assert!(reader.step(128).is_err());
            assert!(reader.take_projection().is_none());
            assert!(reader.step(1).is_err());
        }
        std::fs::write(&path, b"\n\n").unwrap();
        let mut reader = ProjectedTranscriptReader::open(&path, 1, 128, 10).unwrap();
        assert!(reader.step(128).is_err());
        assert!(reader.bytes_read() <= 2);
        assert!(reader.take_projection().is_none());
    }
}
