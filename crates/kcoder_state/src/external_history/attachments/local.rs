use super::*;
impl HistoricalAttachmentStore {
    pub(crate) fn preflight_local(&self, bytes: u64) -> Result<()> {
        let _writer = self
            ._writer
            .as_ref()
            .context("history_attachment_writer_required")?;
        let available = self
            .directory
            .available_storage()
            .map_err(|_| anyhow::anyhow!("local_attachment_disk_space_unavailable"))?;
        ensure!(
            u128::from(available.bytes) >= u128::from(bytes) + 1024 * 1024,
            "local_attachment_no_space"
        );
        Ok(())
    }
    pub(crate) fn local_payload_exists(&self) -> Result<bool> {
        match self
            .directory
            .open_single_link_regular_file(OsStr::new(PAYLOAD))
        {
            Ok(_) => Ok(true),
            Err(error) if missing(&error) => Ok(false),
            Err(error) => Err(error),
        }
    }
    /// Only a local-selection intent may supply this expectation. Never guess content from an orphan.
    pub(crate) fn reconcile_local(
        &mut self,
        expected: &HistoricalAttachmentReceipt,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Option<HistoricalAttachmentReceipt>> {
        ensure!(self._writer.is_some(), "history_attachment_writer_required");
        ensure!(
            expected.attachment_id == self.binding.attachment_id
                && expected.bytes <= HISTORICAL_ATTACHMENT_MAX_BYTES
                && valid_hash(&expected.sha256)
                && expected.chunk_bytes == HISTORICAL_ATTACHMENT_CHUNK_BYTES as u32,
            "local_attachment_intent_changed"
        );
        if let Some(receipt) = self.load()? {
            ensure!(
                receipt.value == *expected,
                "local_attachment_content_changed"
            );
            self.verify_payload(&receipt, &mut check)?;
            self.settle_receipt_budget(&receipt)?;
            if let Some(owner) = &self.payload_owner {
                owner.seal(&self.directory, || check(receipt.value.bytes))?;
            }
            return Ok(Some(receipt.value));
        }
        let file = match self
            .directory
            .open_single_link_regular_file(OsStr::new(PAYLOAD))
        {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        ensure!(
            file.metadata()?.len() == expected.bytes,
            "local_attachment_content_changed"
        );
        let resource = self.resource_stream(true)?;
        let mut reader = DigestReader {
            input: file,
            check: &mut check,
            maximum: expected.bytes,
            bytes: 0,
            hash: Sha256::new(),
            chunk: Sha256::new(),
            chunk_bytes: 0,
            chunks: Vec::new(),
            resource: resource.as_ref(),
        };
        std::io::copy(&mut reader, &mut std::io::sink())?;
        let receipt = reader.receipt(&self.binding_sha256, &self.binding.attachment_id);
        ensure!(
            receipt.value == *expected,
            "local_attachment_content_changed"
        );
        self.verify_payload(&receipt, &mut check)?;
        ensure!(check(expected.bytes), "local_attachment_cancelled");
        self.publish_receipt(&receipt, || check(expected.bytes))?;
        Ok(Some(receipt.value))
    }
}
