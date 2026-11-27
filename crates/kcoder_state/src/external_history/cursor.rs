//! Pinned, bounded record reads share verified blocks across a normalization batch.
use super::*;

pub struct ExternalHistoryRecordCursor {
    source: ExternalHistoryRecordReader,
    index: ExternalHistoryRecordReader,
    count: u64,
}

pub(super) fn decode_entry(
    entry: &[u8],
    ordinal: u64,
    total: u64,
) -> Result<ExternalHistoryRecord> {
    ensure!(
        entry.len() == ENTRY_BYTES as usize,
        "external_history_invalid_record"
    );
    let offset = u64::from_le_bytes(entry[..8].try_into()?);
    let bytes = u64::from_le_bytes(entry[8..16].try_into()?);
    ensure!(
        bytes > 0
            && offset <= total
            && bytes <= total - offset
            && entry[48] <= 1
            && entry[49..].iter().all(|byte| *byte == 0),
        "external_history_invalid_record"
    );
    Ok(ExternalHistoryRecord {
        ordinal,
        offset,
        bytes,
        sha256: entry[16..48]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        newline_terminated: entry[48] == 1,
    })
}

impl ExternalHistoryReader {
    /// The cursor caches only authenticated block contents and hash tables, never an
    /// entire transcript or record. It does not follow appended source data.
    pub fn record_cursor(&self) -> Result<ExternalHistoryRecordCursor> {
        let receipt = self.receipt()?.context("external_history_not_committed")?;
        let open = |file, table, total, table_sha: &str| -> Result<ExternalHistoryRecordReader> {
            let hashes = self.chunk_table(table, table_sha, total)?;
            let source = self
                .directory
                .open_single_link_regular_file(OsStr::new(file))?;
            ensure!(
                source.metadata()?.len() == total,
                "external_history_stored_content_changed"
            );
            Ok(ExternalHistoryRecordReader {
                _lifecycle: self.lifecycle.clone(),
                source,
                hashes,
                total,
                cursor: 0,
                end: 0,
                block: vec![0; EXTERNAL_HISTORY_CHUNK_BYTES],
                cached_block: None,
            })
        };
        Ok(ExternalHistoryRecordCursor {
            source: open(
                RAW,
                RAW_CHUNKS,
                receipt.source_bytes,
                &receipt.source_chunks_sha256,
            )?,
            index: open(
                INDEX,
                INDEX_CHUNKS,
                receipt.index_bytes,
                &receipt.index_chunks_sha256,
            )?,
            count: receipt.record_count,
        })
    }
}

impl ExternalHistoryRecordCursor {
    /// Bounded metadata reads reuse the authenticated index block for lineage scans.
    pub fn metadata(&mut self, ordinal: u64) -> Result<ExternalHistoryRecord> {
        ensure!(ordinal < self.count, "external_history_record_not_found");
        ensure!(
            self.index.source.metadata()?.len() == self.index.total
                && self.source.source.metadata()?.len() == self.source.total,
            "external_history_stored_content_changed"
        );
        self.index.cursor = ordinal * ENTRY_BYTES;
        self.index.end = self.index.cursor + ENTRY_BYTES;
        let mut entry = [0; ENTRY_BYTES as usize];
        self.index.read_exact(&mut entry)?;
        decode_entry(&entry, ordinal, self.source.total)
    }

    pub fn record(&mut self, ordinal: u64) -> Result<&mut ExternalHistoryRecordReader> {
        let record = self.metadata(ordinal)?;
        self.source.cursor = record.offset;
        self.source.end = record.offset + record.bytes;
        Ok(&mut self.source)
    }
}
