use super::*;
struct PreparationSources<'a> {
    delivery_names: bool,
    sources: &'a [crate::external_history::lifecycle::ArchiveReadGuard],
}

struct CopyAsset<'a, F, C> {
    expected: &'a HistoricalContextAttachment,
    index: u32,
    source: &'a mut F,
    check: &'a mut C,
    offset: u64,
    buffer: Vec<u8>,
    cursor: usize,
    digest: Sha256,
    chunks: Vec<String>,
    finished: bool,
}
impl<F, C> Read for CopyAsset<'_, F, C>
where
    F: FnMut(&HistoricalContextAttachment, u64, usize) -> Result<Vec<u8>>,
    C: FnMut(ContextPreparationProgress) -> bool,
{
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        (|| -> Result<usize> {
            if output.is_empty() {
                return Ok(0);
            }
            if self.cursor == self.buffer.len() {
                progress(self.check, Some(self.index), self.offset)?;
                if self.offset == self.expected.receipt.bytes {
                    ensure!(
                        format!("{:x}", self.digest.clone().finalize())
                            == self.expected.receipt.sha256,
                        "history_context_preparation_payload_changed"
                    );
                    self.finished = true;
                    return Ok(0);
                }
                let limit = (self.expected.receipt.bytes - self.offset)
                    .min(HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64)
                    as usize;
                self.buffer = (self.source)(self.expected, self.offset, limit)?;
                ensure!(
                    self.buffer.len() == limit,
                    "history_context_preparation_payload_truncated"
                );
                self.digest.update(&self.buffer);
                self.chunks.push(hash(&self.buffer));
                self.offset += limit as u64;
                self.cursor = 0;
            }
            let take = output.len().min(self.buffer.len() - self.cursor);
            output[..take].copy_from_slice(&self.buffer[self.cursor..self.cursor + take]);
            self.cursor += take;
            Ok(take)
        })()
        .map_err(|error| std::io::Error::other(error.to_string()))
    }
}
impl HistoricalContextStore {
    /// Idempotent owned staging only. The host still owns explicit job resume and session publication.
    pub fn prepare(
        &self,
        id: &str,
        document: &HistoricalContextDocument,
        binding: &HistoricalContextBinding,
        source: impl FnMut(&HistoricalContextAttachment, u64, usize) -> Result<Vec<u8>>,
        check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<PreparedContextReceipt> {
        self.prepare_kind(id, document, binding, false, source, check)
    }
    pub fn prepare_referenced(
        &self,
        id: &str,
        document: &HistoricalContextDocument,
        binding: &HistoricalContextBinding,
        sources: &[crate::external_history::lifecycle::ArchiveReadGuard],
        source: impl FnMut(&HistoricalContextAttachment, u64, usize) -> Result<Vec<u8>>,
        check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<PreparedContextReceipt> {
        self.prepare_inner(
            id,
            document,
            binding,
            PreparationSources {
                delivery_names: false,
                sources,
            },
            source,
            check,
        )
    }
    pub(super) fn prepare_kind(
        &self,
        id: &str,
        document: &HistoricalContextDocument,
        binding: &HistoricalContextBinding,
        delivery_names: bool,
        source: impl FnMut(&HistoricalContextAttachment, u64, usize) -> Result<Vec<u8>>,
        check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<PreparedContextReceipt> {
        self.prepare_inner(
            id,
            document,
            binding,
            PreparationSources {
                delivery_names,
                sources: &[],
            },
            source,
            check,
        )
    }
    fn prepare_inner(
        &self,
        id: &str,
        document: &HistoricalContextDocument,
        binding: &HistoricalContextBinding,
        mode: PreparationSources<'_>,
        mut source: impl FnMut(&HistoricalContextAttachment, u64, usize) -> Result<Vec<u8>>,
        mut check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<PreparedContextReceipt> {
        let PreparationSources {
            delivery_names,
            sources,
        } = mode;
        check_id(id)?;
        progress(&mut check, None, 0)?;
        let (body, proof, attachment_bytes) = Self::expected(document, binding)?;
        let source_reference = self.source_binding(id, &hash(&body), &hash(&proof), sources)?;
        let _lease = self
            .directory
            .try_exclusive_lock(OsStr::new("catalog.lock"))?
            .context("history_context_preparation_busy")?;
        let (count, used) = self.inventory(&mut check)?;
        let existing = match self.directory(id) {
            Ok(directory) => Some(directory),
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
        if let Some(directory) = &existing {
            let intent = self.intent(directory, id)?;
            ensure!(
                intent.document_sha256 == hash(&body)
                    && intent.binding_sha256 == hash(&proof)
                    && intent.delivery_names == delivery_names
                    && intent.source_reference == source_reference,
                "history_context_preparation_selection_changed"
            );
            self.pin_sources(directory, &intent, sources)?;
            if optional(directory, "receipt.json", META)?.is_some() {
                return Ok(self.verify(id, check)?.receipt);
            }
        } else {
            ensure!(
                count < MAX_CONTEXT_PREPARATIONS,
                "history_context_preparation_count_budget_exceeded"
            )
        }
        // Reserve missing final files, bounded receipt overhead, and the largest transient copy.
        let mut extra = 4 * META;
        let mut temporary = (body.len().max(proof.len()) as u64).max(META);
        for (name, bytes) in [
            ("document.json", body.len() as u64),
            ("binding.json", proof.len() as u64),
        ] {
            if absent(existing.as_ref(), name)? {
                extra = extra
                    .checked_add(bytes)
                    .context("history_context_store_budget_exceeded")?;
            }
        }
        for (index, attachment) in document.attachments.iter().enumerate() {
            let index = index as u32;
            if absent(
                existing.as_ref(),
                &payload_for(index, attachment, delivery_names),
            )? {
                ensure!(
                    absent(existing.as_ref(), &asset(index))?,
                    "history_context_preparation_payload_missing"
                );
                extra = extra
                    .checked_add(attachment.receipt.bytes)
                    .context("history_context_store_budget_exceeded")?;
                temporary = temporary.max(attachment.receipt.bytes);
            }
            if absent(existing.as_ref(), &asset(index))? {
                extra = extra
                    .checked_add(META)
                    .context("history_context_store_budget_exceeded")?;
            }
        }
        ensure!(
            used.checked_add(extra)
                .and_then(|value| value.checked_add(temporary))
                .is_some_and(|value| value <= MAX_CONTEXT_PREPARATION_BYTES),
            "history_context_store_budget_exceeded"
        );
        let directory = match existing {
            Some(directory) => directory,
            None => {
                let directory = self.directory.create_private_child(OsStr::new(id))?;
                let intent = Intent {
                    version: 1,
                    owner: self.owner.clone(),
                    id: id.into(),
                    directory: directory.directory_identity()?,
                    document_sha256: hash(&body),
                    binding_sha256: hash(&proof),
                    delivery_names,
                    source_reference,
                };
                exact(&directory, "intent.json", &encoded(&intent, META)?)?;
                self.pin_sources(&directory, &intent, sources)?;
                directory
            }
        };
        exact(&directory, "document.json", &body)?;
        exact(&directory, "binding.json", &proof)?;
        let mut asset_receipts_sha256 = Vec::new();
        for (index, attachment) in document.attachments.iter().enumerate() {
            let index = index as u32;
            progress(&mut check, Some(index), 0)?;
            if absent(
                Some(&directory),
                &payload_for(index, attachment, delivery_names),
            )? {
                let mut reader = CopyAsset {
                    expected: attachment,
                    index,
                    source: &mut source,
                    check: &mut check,
                    offset: 0,
                    buffer: Vec::new(),
                    cursor: 0,
                    digest: Sha256::new(),
                    chunks: Vec::new(),
                    finished: false,
                };
                let bytes = directory.atomic_publish_from_reader(
                    OsStr::new(&payload_for(index, attachment, delivery_names)),
                    &mut reader,
                    false,
                    || Ok(None),
                )?;
                ensure!(
                    reader.finished && bytes == attachment.receipt.bytes,
                    "history_context_preparation_payload_truncated"
                );
                let receipt = Asset {
                    version: 1,
                    index,
                    receipt: attachment.receipt.clone(),
                    chunks: reader.chunks,
                };
                exact(&directory, &asset(index), &encoded(&receipt, META)?)?;
            } else {
                let receipt = verify_payload(
                    &directory,
                    index,
                    &payload_for(index, attachment, delivery_names),
                    &attachment.receipt,
                    &mut check,
                )?;
                exact(&directory, &asset(index), &encoded(&receipt, META)?)?;
            }
            asset_receipts_sha256
                .push(hash(&optional(&directory, &asset(index), META)?.context(
                    "history_context_preparation_asset_receipt_missing",
                )?));
        }
        progress(&mut check, None, attachment_bytes)?;
        let intent = self.intent(&directory, id)?;
        let receipt = PreparedContextReceipt {
            preparation_id: id.into(),
            document_sha256: hash(&body),
            binding_sha256: hash(&proof),
            attachments: document.attachments.len() as u32,
            attachment_bytes,
        };
        let seal = Seal {
            version: 1,
            intent_sha256: hash(&encoded(&intent, META)?),
            asset_receipts_sha256,
            value: receipt.clone(),
        };
        exact(&directory, "receipt.json", &encoded(&seal, META)?)?;
        Ok(receipt)
    }
}
fn absent(directory: Option<&PrivateDirectory>, name: &str) -> Result<bool> {
    let Some(directory) = directory else {
        return Ok(true);
    };
    match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(_) => Ok(false),
        Err(error) if missing(&error) => Ok(true),
        Err(error) => Err(error),
    }
}
