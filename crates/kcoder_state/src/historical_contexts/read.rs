use super::*;

pub(super) fn verify_payload(
    directory: &PrivateDirectory,
    index: u32,
    name: &str,
    expected: &HistoricalAttachmentReceipt,
    check: &mut impl FnMut(ContextPreparationProgress) -> bool,
) -> Result<Asset> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        file.metadata()?.len() == expected.bytes,
        "history_context_preparation_payload_changed"
    );
    let mut offset = 0;
    let mut digest = Sha256::new();
    let mut chunks = Vec::new();
    let mut buffer = vec![0u8; HISTORICAL_ATTACHMENT_CHUNK_BYTES];
    while offset < expected.bytes {
        progress(check, Some(index), offset)?;
        let take = (expected.bytes - offset).min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..take])?;
        digest.update(&buffer[..take]);
        chunks.push(hash(&buffer[..take]));
        offset += take as u64;
    }
    ensure!(
        file.metadata()?.len() == expected.bytes
            && format!("{:x}", digest.finalize()) == expected.sha256,
        "history_context_preparation_payload_changed"
    );
    progress(check, Some(index), offset)?;
    Ok(Asset {
        version: 1,
        index,
        receipt: expected.clone(),
        chunks,
    })
}
impl HistoricalContextStore {
    fn metadata(&self, id: &str) -> Result<(PrivateDirectory, PreparedContext, Vec<String>, bool)> {
        let directory = self.directory(id)?;
        let intent = self.intent(&directory, id)?;
        let seal: Seal = read_json(&directory, "receipt.json", META)?;
        ensure!(
            seal.version == 1 && seal.intent_sha256 == hash(&encoded(&intent, META)?),
            "history_context_preparation_receipt_changed"
        );
        let body = optional(&directory, "document.json", HISTORICAL_CONTEXT_MAX_BYTES)?
            .context("history_context_preparation_missing")?;
        let proof = optional(&directory, "binding.json", META)?
            .context("history_context_preparation_missing")?;
        ensure!(
            hash(&body) == intent.document_sha256 && hash(&proof) == intent.binding_sha256,
            "history_context_preparation_content_changed"
        );
        let document: HistoricalContextDocument = serde_json::from_slice(&body)
            .map_err(|_| anyhow::anyhow!("history_context_preparation_invalid_document"))?;
        let binding: HistoricalContextBinding = serde_json::from_slice(&proof)
            .map_err(|_| anyhow::anyhow!("history_context_preparation_invalid_binding"))?;
        let (_, _, attachment_bytes) = Self::expected(&document, &binding)?;
        ensure!(
            seal.asset_receipts_sha256.len() == document.attachments.len(),
            "history_context_preparation_asset_receipt_changed"
        );
        ensure!(
            seal.value
                == PreparedContextReceipt {
                    preparation_id: id.into(),
                    document_sha256: intent.document_sha256,
                    binding_sha256: intent.binding_sha256,
                    attachments: document.attachments.len() as u32,
                    attachment_bytes
                },
            "history_context_preparation_receipt_changed"
        );
        Ok((
            directory,
            PreparedContext {
                document,
                binding,
                receipt: seal.value,
            },
            seal.asset_receipts_sha256,
            intent.delivery_names,
        ))
    }
    /// Verify every payload before any future session can adopt this preparation.
    pub fn verify(
        &self,
        id: &str,
        check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<PreparedContext> {
        Ok(self.reader(id, check)?.prepared)
    }
    /// Verify once, then retain bounded metadata for authenticated chunk access.
    pub fn reader(
        &self,
        id: &str,
        mut check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<PreparedContextReader> {
        progress(&mut check, None, 0)?;
        let source_directory = self.directory(id)?;
        let source_intent = self.intent(&source_directory, id)?;
        let sources = self.source_guards(&source_directory, &source_intent)?;
        let (directory, prepared, asset_receipts_sha256, delivery_names) = self.metadata(id)?;
        for (index, attachment) in prepared.document.attachments.iter().enumerate() {
            let index = index as u32;
            let observed = verify_payload(
                &directory,
                index,
                &payload_for(index, attachment, delivery_names),
                &attachment.receipt,
                &mut check,
            )?;
            ensure!(
                read_asset(&directory, index, &asset_receipts_sha256[index as usize])? == observed,
                "history_context_preparation_asset_receipt_changed"
            );
        }
        progress(&mut check, None, prepared.receipt.attachment_bytes)?;
        Ok(PreparedContextReader {
            directory,
            prepared,
            asset_receipts_sha256,
            path: self.path.join(id),
            delivery_names,
            _sources: sources,
        })
    }
}
impl PreparedContextReader {
    pub fn delivery_filename(&self, index: u32) -> Result<String> {
        let attachment = self
            .prepared
            .document
            .attachments
            .get(index as usize)
            .context("history_context_preparation_attachment_not_found")?;
        Ok(payload_for(index, attachment, true))
    }
    /// Metadata and complete payloads were verified when this reader was opened.
    pub fn context(&self) -> &PreparedContext {
        &self.prepared
    }
    pub fn verify_current(
        &self,
        check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<()> {
        let current = PrivateDirectory::open_existing(&self.path)?;
        ensure!(
            current.directory_identity()? == self.directory.directory_identity()?,
            "history_context_preparation_owner_changed"
        );
        let profile = self
            .path
            .parent()
            .and_then(Path::parent)
            .context("history_context_preparation_owner_changed")?;
        let store = HistoricalContextStore::open_existing(profile)?
            .context("history_context_store_missing")?;
        let verified = store.verify(&self.prepared.receipt.preparation_id, check)?;
        ensure!(
            verified.receipt == self.prepared.receipt && verified.binding == self.prepared.binding,
            "history_context_preparation_content_changed"
        );
        Ok(())
    }
    /// Copy verified bytes into another explicitly owned native profile, such as session attachments.
    pub fn copy_to(
        &self,
        profile: &Path,
        check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<Self> {
        let store = HistoricalContextStore::open(profile)?;
        self.copy_into(store, check)
    }
    /// Compare the target's opened owner before creating any preparation storage.
    pub fn copy_to_bound(
        &self,
        profile: &Path,
        owner: &PrivateDirectory,
        check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<Self> {
        let identity = owner.directory_identity()?;
        let store = HistoricalContextStore::open_at(profile, true, Some(&identity))?
            .context("history_context_store_missing")?;
        self.copy_into(store, check)
    }
    fn copy_into(
        &self,
        store: HistoricalContextStore,
        mut check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<Self> {
        store.prepare_kind(
            &self.prepared.receipt.preparation_id,
            &self.prepared.document,
            &self.prepared.binding,
            true,
            |attachment, offset, limit| {
                let index = self
                    .prepared
                    .document
                    .attachments
                    .iter()
                    .position(|candidate| candidate == attachment)
                    .context("history_context_preparation_attachment_not_found")?;
                self.attachment_chunk(index as u32, offset, limit)
            },
            &mut check,
        )?;
        store.reader(&self.prepared.receipt.preparation_id, check)
    }
    /// This target-local path is never derived from a historical filename or source URL.
    pub fn attachment_path(&self, index: u32) -> Result<PathBuf> {
        let expected = &self
            .prepared
            .document
            .attachments
            .get(index as usize)
            .context("history_context_preparation_attachment_not_found")?
            .receipt;
        let current = PrivateDirectory::open_existing(&self.path)?;
        current.verify_private_directory()?;
        ensure!(
            current.directory_identity()? == self.directory.directory_identity()?,
            "history_context_preparation_owner_changed"
        );
        let name = payload_for(
            index,
            &self.prepared.document.attachments[index as usize],
            self.delivery_names,
        );
        let file = current.open_single_link_regular_file(OsStr::new(&name))?;
        ensure!(
            file.metadata()?.len() == expected.bytes,
            "history_context_preparation_payload_changed"
        );
        Ok(self.path.join(name))
    }
    /// Authenticated bounded access. No caller-supplied path or historical tool is used.
    pub fn attachment_chunk(&self, index: u32, offset: u64, limit: usize) -> Result<Vec<u8>> {
        ensure!(
            (1..=HISTORICAL_ATTACHMENT_CHUNK_BYTES).contains(&limit),
            "history_context_preparation_invalid_range"
        );
        let directory = &self.directory;
        let prepared = &self.prepared;
        let expected = &prepared
            .document
            .attachments
            .get(index as usize)
            .context("history_context_preparation_attachment_not_found")?
            .receipt;
        ensure!(
            offset <= expected.bytes,
            "history_context_preparation_invalid_range"
        );
        let asset = read_asset(
            directory,
            index,
            &self.asset_receipts_sha256[index as usize],
        )?;
        ensure!(
            asset.version == 1
                && asset.index == index
                && asset.receipt == *expected
                && asset.chunks.len() as u64
                    == expected
                        .bytes
                        .div_ceil(HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64),
            "history_context_preparation_asset_receipt_changed"
        );
        let name = payload_for(
            index,
            &prepared.document.attachments[index as usize],
            self.delivery_names,
        );
        let mut file = directory.open_single_link_regular_file(OsStr::new(&name))?;
        ensure!(
            file.metadata()?.len() == expected.bytes,
            "history_context_preparation_payload_changed"
        );
        let end = offset + ((expected.bytes - offset).min(limit as u64));
        let mut cursor = offset;
        let mut result = Vec::with_capacity((end - offset) as usize);
        while cursor < end {
            let block = cursor / HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64;
            let start = block * HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64;
            let mut bytes = vec![
                0;
                ((expected.bytes - start).min(HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64))
                    as usize
            ];
            file.seek(SeekFrom::Start(start))?;
            file.read_exact(&mut bytes)?;
            ensure!(
                hash(&bytes) == asset.chunks[block as usize],
                "history_context_preparation_payload_changed"
            );
            let from = (cursor - start) as usize;
            let take = (end - cursor).min((bytes.len() - from) as u64) as usize;
            result.extend_from_slice(&bytes[from..from + take]);
            cursor += take as u64;
        }
        ensure!(
            file.metadata()?.len() == expected.bytes,
            "history_context_preparation_payload_changed"
        );
        Ok(result)
    }
}
fn read_asset(directory: &PrivateDirectory, index: u32, expected: &str) -> Result<Asset> {
    let bytes = optional(directory, &asset(index), META)?
        .context("history_context_preparation_asset_receipt_missing")?;
    ensure!(
        hash(&bytes) == expected,
        "history_context_preparation_asset_receipt_changed"
    );
    serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("history_context_preparation_invalid_metadata"))
}
