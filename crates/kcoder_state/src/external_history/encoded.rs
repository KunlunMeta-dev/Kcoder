use super::*;

const ORIGINAL: &str = "original.bin";
const CHUNKS: &str = "original-chunks.bin";
const RECEIPT: &str = "original.json";

impl ExternalHistoryImport {
    /// Preserve the exact encoded bytes before decoding. This stage can be reused
    /// after cancellation even when the original selected file no longer exists.
    pub fn stage_original_source(
        &mut self,
        source: &mut impl Read,
        check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
    ) -> Result<()> {
        if self.reader.receipt()?.is_some() {
            return self.reader.verify(check);
        }
        ensure!(self.owns_archive, "external_history_reuse_is_read_only");
        let original = self
            .reader
            .binding
            .snapshot
            .original
            .as_ref()
            .context("external_history_original_source_missing")?;
        let existing = match self
            .reader
            .directory
            .open_single_link_regular_file(OsStr::new(ORIGINAL))
        {
            Ok(file) => Some(file),
            Err(error) if missing(&error) => None,
            Err(_) => anyhow::bail!("external_history_unsafe_file"),
        };
        let fingerprint = if let Some(file) = existing {
            fingerprint(file, original.bytes, &original.sha256, check)?
        } else {
            ensure!(
                read_optional(&self.reader.directory, CHUNKS, CHUNK_TABLE_BYTES)?.is_none()
                    && read_optional(&self.reader.directory, RECEIPT, METADATA_BYTES)?.is_none(),
                "external_history_stored_content_changed"
            );
            let controlled = ControlledReader {
                reader: source,
                check,
                phase: ExternalHistoryPhase::CopyingOriginal,
                total: original.bytes,
                processed: 0,
            };
            let mut hashing = HashingReader::new(
                controlled,
                original.bytes,
                Some((original.bytes, original.sha256.clone())),
            );
            publish_archive_file(&self.reader.directory, OsStr::new(ORIGINAL), &mut hashing)?;
            hashing.fingerprint()?
        };
        publish_exact(
            &self.reader.directory,
            CHUNKS,
            &fingerprint.chunks,
            CHUNK_TABLE_BYTES,
        )?;
        let receipt = ExternalHistoryOriginalReceipt {
            source: original.clone(),
            chunks_sha256: hash(&fingerprint.chunks),
        };
        publish_exact(
            &self.reader.directory,
            RECEIPT,
            &serde_json::to_vec(&receipt)?,
            METADATA_BYTES,
        )
    }

    /// Arbitrary caller-provided decoded bytes are not accepted for encoded
    /// snapshots: decoding always reads the preserved, authenticated original.
    pub fn decode_original_source(
        &mut self,
        check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
    ) -> Result<()> {
        if self.reader.receipt()?.is_some() {
            return self.reader.verify(check);
        }
        ensure!(self.owns_archive, "external_history_reuse_is_read_only");
        let original = self
            .reader
            .original_metadata()?
            .context("external_history_original_source_missing")?;
        let source = self.reader.original_reader(&original)?;
        let shared = std::cell::RefCell::new(check);
        let mut encoded_check = |progress| (shared.borrow_mut())(progress);
        let controlled = ControlledReader {
            reader: source,
            check: &mut encoded_check,
            phase: ExternalHistoryPhase::ReadingOriginal,
            total: original.source.bytes,
            processed: 0,
        };
        let mut decoder = match original.source.encoding {
            ExternalHistoryEncoding::Zstd => codec::zstd_decoder(controlled)?,
        };
        let mut decoded_check = |progress| (shared.borrow_mut())(progress);
        self.stage_logical_source(
            &mut decoder,
            ExternalHistoryPhase::Decoding,
            &mut decoded_check,
        )
    }
}

impl ExternalHistoryReader {
    fn original_metadata(&self) -> Result<Option<ExternalHistoryOriginalReceipt>> {
        let Some(expected) = self.binding.snapshot.original.as_ref() else {
            return Ok(None);
        };
        if let Some(receipt) = self.receipt()? {
            return Ok(receipt.original);
        }
        let receipt: ExternalHistoryOriginalReceipt = decode(
            &read_optional(&self.directory, RECEIPT, METADATA_BYTES)?
                .context("external_history_original_metadata_missing")?,
        )?;
        ensure!(
            &receipt.source == expected && valid_hash(&receipt.chunks_sha256),
            "external_history_original_changed"
        );
        Ok(Some(receipt))
    }

    fn original_reader(
        &self,
        receipt: &ExternalHistoryOriginalReceipt,
    ) -> Result<ExternalHistoryRecordReader> {
        let hashes = self.chunk_table(CHUNKS, &receipt.chunks_sha256, receipt.source.bytes)?;
        let source = self
            .directory
            .open_single_link_regular_file(OsStr::new(ORIGINAL))?;
        ensure!(
            source.metadata()?.len() == receipt.source.bytes,
            "external_history_original_changed"
        );
        Ok(ExternalHistoryRecordReader {
            _lifecycle: self.lifecycle.clone(),
            source,
            hashes,
            total: receipt.source.bytes,
            cursor: 0,
            end: receipt.source.bytes,
            block: vec![0; EXTERNAL_HISTORY_CHUNK_BYTES],
            cached_block: None,
        })
    }

    pub(super) fn verify_original(
        &self,
        check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
    ) -> Result<Option<ExternalHistoryOriginalReceipt>> {
        let Some(receipt) = self.original_metadata()? else {
            return Ok(None);
        };
        let actual = fingerprint(
            self.directory
                .open_single_link_regular_file(OsStr::new(ORIGINAL))?,
            receipt.source.bytes,
            &receipt.source.sha256,
            check,
        )?;
        ensure!(
            self.chunk_table(CHUNKS, &receipt.chunks_sha256, receipt.source.bytes)?
                == actual.chunks,
            "external_history_original_changed"
        );
        Ok(Some(receipt))
    }

    pub fn read_original_chunk(&self, offset: u64, limit: usize) -> Result<Vec<u8>> {
        let receipt = self
            .receipt()?
            .context("external_history_not_committed")?
            .original
            .context("external_history_original_source_missing")?;
        self.range(
            ORIGINAL,
            CHUNKS,
            receipt.source.bytes,
            &receipt.chunks_sha256,
            offset,
            limit,
        )
    }
}
