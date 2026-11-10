//! Private immutable attachment payloads derived from one already committed archive.
use super::*;
use kcoder_types::historical_attachment::*;
use std::io::Write;
mod local;
use lifecycle::resource_budget::{ResourceKind, ResourceStream};

const META: u64 = 256 * 1024;
const PAYLOAD: &str = "payload.bin";
const MAX_BLOBS: usize = 10_000;
const TOTAL_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BlobBinding {
    version: u32,
    archive_id: String,
    source_sha256: String,
    archive_directory: String,
    blob_directory: String,
    attachment_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    binding_sha256: String,
    value: HistoricalAttachmentReceipt,
    chunks: Vec<String>,
}

pub struct HistoricalAttachmentStore {
    _lifecycle: lifecycle::ArchiveReadGuard,
    directory: PrivateDirectory,
    binding: BlobBinding,
    binding_sha256: String,
    _writer: Option<lifecycle::PayloadLease>,
    _budget: Option<lifecycle::PayloadLease>,
    payload_owner: Option<lifecycle::PayloadNode>,
    available: u64,
    resource_kind: ResourceKind,
}

impl ExternalHistoryReader {
    /// The native adapter derives the identity from its authenticated normalized reference.
    /// No caller-supplied source path or external filename is used as a path component.
    pub fn attachment_blob(
        &self,
        id: &str,
        writable: bool,
    ) -> Result<Option<HistoricalAttachmentStore>> {
        self.attachment_blob_with_check(id, writable, || true)
    }
    pub fn attachment_blob_with_check(
        &self,
        id: &str,
        writable: bool,
        mut check: impl FnMut() -> bool,
    ) -> Result<Option<HistoricalAttachmentStore>> {
        ensure!(check(), "history_attachment_cancelled");
        ensure!(valid_hash(id), "history_attachment_invalid_id");
        let receipt = self.receipt()?.context("external_history_not_committed")?;
        let Some(parent) = self.payload_root("attachments-v1", writable)? else {
            return Ok(None);
        };
        parent.verify_private_directory()?;
        let budget = if writable {
            Some(parent.lock("budget.lock")?)
        } else {
            None
        };
        let mut available = HISTORICAL_ATTACHMENT_MAX_BYTES;
        if writable {
            let mut count = 0;
            let mut found = false;
            let mut bytes = 0u64;
            let mut owned_payload = 0u64;
            parent.visit_entry_names_bounded(MAX_BLOBS + 4, |name| {
                ensure!(check(), "history_attachment_cancelled");
                if !name.to_str().is_some_and(valid_hash) {
                    return Ok(());
                }
                count += 1;
                if name == OsStr::new(id) {
                    found = true;
                }
                let child = parent.open_child(name, false)?;
                child.verify_private_directory()?;
                child.visit_entry_names_bounded(32, |file_name| {
                    ensure!(check(), "history_attachment_cancelled");
                    let file = child.open_single_link_regular_file(file_name)?;
                    let length = file.metadata()?.len();
                    if name == OsStr::new(id) && file_name == OsStr::new(PAYLOAD) {
                        owned_payload = length;
                    }
                    bytes = bytes
                        .checked_add(length)
                        .context("history_attachment_budget_exceeded")?;
                    ensure!(bytes <= TOTAL_BYTES, "history_attachment_budget_exceeded");
                    Ok(())
                })?;
                Ok(())
            })?;
            ensure!(
                count < MAX_BLOBS || (found && count == MAX_BLOBS),
                "history_attachment_count_budget_exceeded"
            );
            available = TOTAL_BYTES
                .saturating_sub(bytes)
                .saturating_add(owned_payload)
                .saturating_sub(1024 * 1024);
        }
        let Some(directory) = self.payload_child(&parent, id, writable)? else {
            return Ok(None);
        };
        directory.verify_private_directory()?;
        let writer = if writable {
            Some(directory.lock("writer.lock")?)
        } else {
            None
        };
        let binding = BlobBinding {
            version: 1,
            archive_id: receipt.archive_id,
            source_sha256: receipt.source_sha256,
            archive_directory: self.directory.directory_identity()?,
            blob_directory: directory.directory_identity()?,
            attachment_id: id.into(),
        };
        let encoded = serde_json::to_vec(&binding)?;
        if writable {
            if read_optional(&directory, "binding.json", META)?.is_none() {
                match directory.open_single_link_regular_file(OsStr::new(PAYLOAD)) {
                    Err(error) if missing(&error) => {}
                    _ => anyhow::bail!("history_attachment_ownership_unknown"),
                }
            }
            if let Some(owner) = &directory.node {
                owner.exact(&directory, "binding.json", &encoded, META, || true)?;
            } else {
                publish_exact(&directory, "binding.json", &encoded, META)?;
            }
        } else {
            if let Some(owner) = &directory.node
                && !owner.verified_file(&directory, "binding.json", false)?
            {
                return Ok(None);
            }
            ensure!(
                read_optional(&directory, "binding.json", META)?.as_deref() == Some(&encoded),
                "history_attachment_binding_changed"
            );
        }
        Ok(Some(HistoricalAttachmentStore {
            _lifecycle: self.lifecycle.clone(),
            payload_owner: directory.node,
            directory: directory.directory,
            binding,
            binding_sha256: hash(&encoded),
            _writer: writer,
            _budget: budget,
            available,
            resource_kind: ResourceKind::EmbeddedAttachment,
        }))
    }
}

struct DigestReader<'a, R, C> {
    input: R,
    check: &'a mut C,
    maximum: u64,
    bytes: u64,
    hash: Sha256,
    chunk: Sha256,
    chunk_bytes: usize,
    chunks: Vec<String>,
    resource: Option<&'a ResourceStream>,
}
impl<R: Read, C: FnMut(u64) -> bool> Read for DigestReader<'_, R, C> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if !(self.check)(self.bytes) {
            return Err(std::io::Error::other("history_attachment_cancelled"));
        }
        let take = output
            .len()
            .min(64 * 1024)
            .min((self.maximum.saturating_sub(self.bytes) + 1) as usize);
        let count = self.input.read(&mut output[..take])?;
        if count == 0 {
            return Ok(0);
        }
        let next = self
            .bytes
            .checked_add(count as u64)
            .ok_or_else(|| std::io::Error::other("history_attachment_budget_exceeded"))?;
        if next > self.maximum {
            return Err(std::io::Error::other("history_attachment_budget_exceeded"));
        }
        if let Some(resource) = self.resource {
            resource
                .ensure_extent(next)
                .map_err(std::io::Error::other)?;
        }
        self.bytes = next;
        self.hash.update(&output[..count]);
        let mut pending = &output[..count];
        while !pending.is_empty() {
            let take = pending
                .len()
                .min(HISTORICAL_ATTACHMENT_CHUNK_BYTES - self.chunk_bytes);
            self.chunk.update(&pending[..take]);
            self.chunk_bytes += take;
            pending = &pending[take..];
            if self.chunk_bytes == HISTORICAL_ATTACHMENT_CHUNK_BYTES {
                self.chunks
                    .push(format!("{:x}", self.chunk.finalize_reset()));
                self.chunk_bytes = 0;
            }
        }
        Ok(count)
    }
}
impl<R, C> DigestReader<'_, R, C> {
    fn receipt(mut self, binding: &str, id: &str) -> Receipt {
        if self.chunk_bytes > 0 {
            self.chunks.push(format!("{:x}", self.chunk.finalize()));
        }
        Receipt {
            binding_sha256: binding.into(),
            value: HistoricalAttachmentReceipt {
                attachment_id: id.into(),
                bytes: self.bytes,
                sha256: format!("{:x}", self.hash.finalize()),
                chunk_bytes: HISTORICAL_ATTACHMENT_CHUNK_BYTES as u32,
            },
            chunks: self.chunks,
        }
    }
}

impl HistoricalAttachmentStore {
    fn resource_stream(&self, existing: bool) -> Result<Option<ResourceStream>> {
        self._lifecycle.resource_stream(
            self.resource_kind,
            &self.binding_sha256,
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            1,
            existing,
        )
    }
    fn settle_receipt_budget(&self, receipt: &Receipt) -> Result<()> {
        if let Some(resource) = self.resource_stream(true)? {
            resource.settle(receipt.value.bytes, 1, &hash(&serde_json::to_vec(receipt)?))?;
        }
        Ok(())
    }
    pub(crate) fn mark_local_resource(&mut self) {
        self.resource_kind = ResourceKind::LocalAttachment;
    }
    fn load(&self) -> Result<Option<Receipt>> {
        self.directory.verify_private_directory()?;
        if let Some(owner) = &self.payload_owner
            && !owner.verified_file(&self.directory, "receipt.json", true)?
        {
            return Ok(None);
        }
        let Some(bytes) = read_optional(&self.directory, "receipt.json", META)? else {
            return Ok(None);
        };
        let receipt: Receipt = decode(&bytes)?;
        ensure!(
            receipt.binding_sha256 == self.binding_sha256
                && receipt.value.attachment_id == self.binding.attachment_id
                && receipt.value.bytes <= HISTORICAL_ATTACHMENT_MAX_BYTES
                && receipt.value.chunk_bytes == HISTORICAL_ATTACHMENT_CHUNK_BYTES as u32
                && valid_hash(&receipt.value.sha256)
                && receipt.chunks.len() as u64
                    == receipt
                        .value
                        .bytes
                        .div_ceil(HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64)
                && receipt.chunks.iter().all(|value| valid_hash(value)),
            "history_attachment_receipt_changed"
        );
        Ok(Some(receipt))
    }
    pub fn receipt(&self) -> Result<Option<HistoricalAttachmentReceipt>> {
        let Some(receipt) = self.load()? else {
            return Ok(None);
        };
        let file = self
            .directory
            .open_single_link_regular_file(OsStr::new(PAYLOAD))?;
        ensure!(
            file.metadata()?.len() == receipt.value.bytes,
            "history_attachment_content_changed"
        );
        Ok(Some(receipt.value))
    }
    /// Payload publication precedes its receipt. A lost receipt is recovered only by
    /// comparing a new derivation with the existing owned payload, never by overwriting it.
    pub fn publish(
        &mut self,
        input: &mut impl Read,
        maximum: u64,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalAttachmentReceipt> {
        ensure!(self._writer.is_some(), "history_attachment_writer_required");
        ensure!(
            maximum <= HISTORICAL_ATTACHMENT_MAX_BYTES,
            "history_attachment_invalid_budget"
        );
        let maximum = maximum.min(self.available);
        ensure!(check(0), "history_attachment_cancelled");
        if let Some(receipt) = self.load()? {
            ensure!(
                receipt.value.bytes <= maximum,
                "history_attachment_budget_exceeded"
            );
            self.verify_payload(&receipt, &mut |_| check(receipt.value.bytes))?;
            self.settle_receipt_budget(&receipt)?;
            ensure!(check(receipt.value.bytes), "history_attachment_cancelled");
            if let Some(owner) = &self.payload_owner {
                owner.seal(&self.directory, || check(receipt.value.bytes))?;
            }
            return Ok(receipt.value);
        }
        let existing = match self
            .directory
            .open_single_link_regular_file(OsStr::new(PAYLOAD))
        {
            Ok(file) => Some(file),
            Err(error) if missing(&error) => None,
            Err(_) => anyhow::bail!("history_attachment_unsafe_payload"),
        };
        let resource = self.resource_stream(existing.is_some())?;
        let receipt = {
            let polling = std::cell::RefCell::new(&mut check);
            let current = std::cell::Cell::new(0);
            let mut stream_check = |bytes| {
                current.set(bytes);
                (polling.borrow_mut())(bytes)
            };
            let mut stream = DigestReader {
                input,
                check: &mut stream_check,
                maximum,
                bytes: 0,
                hash: Sha256::new(),
                chunk: Sha256::new(),
                chunk_bytes: 0,
                chunks: Vec::new(),
                resource: resource.as_ref(),
            };
            if existing.is_some() {
                std::io::copy(&mut stream, &mut std::io::sink())?;
            } else if let Some(owner) = &self.payload_owner {
                owner.publish(&self.directory, PAYLOAD, &mut stream, false, || {
                    (polling.borrow_mut())(current.get())
                })?;
            } else {
                self.directory.atomic_publish_from_reader(
                    OsStr::new(PAYLOAD),
                    &mut stream,
                    false,
                    || Ok(None),
                )?;
            }
            stream.receipt(&self.binding_sha256, &self.binding.attachment_id)
        };
        self.verify_payload(&receipt, &mut |_| check(receipt.value.bytes))?;
        ensure!(check(receipt.value.bytes), "history_attachment_cancelled");
        self.publish_receipt(&receipt, || check(receipt.value.bytes))?;
        Ok(receipt.value)
    }
    fn publish_receipt(&self, receipt: &Receipt, mut check: impl FnMut() -> bool) -> Result<()> {
        let bytes = serde_json::to_vec(receipt)?;
        // The payload is already fully verified. Charge its actual allocation before publishing
        // the domain receipt, so a visible completion never leaves an unaccounted allocation.
        self.settle_receipt_budget(receipt)?;
        if let Some(owner) = &self.payload_owner {
            owner.exact(&self.directory, "receipt.json", &bytes, META, &mut check)?;
            owner.seal(&self.directory, check)
        } else {
            publish_exact(&self.directory, "receipt.json", &bytes, META)
        }
    }
    fn verify_payload(&self, receipt: &Receipt, check: &mut impl FnMut(u64) -> bool) -> Result<()> {
        let mut file = self
            .directory
            .open_single_link_regular_file(OsStr::new(PAYLOAD))?;
        ensure!(
            file.metadata()?.len() == receipt.value.bytes,
            "history_attachment_content_changed"
        );
        let mut buffer = vec![0; HISTORICAL_ATTACHMENT_CHUNK_BYTES];
        let mut bytes = 0;
        let mut digest = Sha256::new();
        for expected in &receipt.chunks {
            ensure!(check(bytes), "history_attachment_cancelled");
            let take = (receipt.value.bytes - bytes).min(buffer.len() as u64) as usize;
            file.read_exact(&mut buffer[..take])?;
            ensure!(
                hash(&buffer[..take]) == *expected,
                "history_attachment_content_changed"
            );
            digest.update(&buffer[..take]);
            bytes += take as u64;
        }
        ensure!(
            bytes == receipt.value.bytes
                && format!("{:x}", digest.finalize()) == receipt.value.sha256,
            "history_attachment_content_changed"
        );
        Ok(())
    }
    pub fn read_chunk(&self, offset: u64, limit: usize) -> Result<Vec<u8>> {
        let receipt = self.load()?.context("history_attachment_not_ready")?;
        ensure!(
            offset <= receipt.value.bytes
                && (1..=HISTORICAL_ATTACHMENT_CHUNK_BYTES).contains(&limit),
            "history_attachment_invalid_range"
        );
        let mut file = self
            .directory
            .open_single_link_regular_file(OsStr::new(PAYLOAD))?;
        ensure!(
            file.metadata()?.len() == receipt.value.bytes,
            "history_attachment_content_changed"
        );
        let end = receipt.value.bytes.min(offset.saturating_add(limit as u64));
        let mut output = Vec::with_capacity((end - offset) as usize);
        let mut block = vec![0; HISTORICAL_ATTACHMENT_CHUNK_BYTES];
        let mut at = offset;
        while at < end {
            let index = at / HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64;
            let start = index * HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64;
            let bytes = (receipt.value.bytes - start).min(block.len() as u64) as usize;
            file.seek(SeekFrom::Start(start))?;
            file.read_exact(&mut block[..bytes])?;
            ensure!(
                hash(&block[..bytes]) == receipt.chunks[index as usize],
                "history_attachment_content_changed"
            );
            let begin = (at - start) as usize;
            let take = (end - at).min((bytes - begin) as u64) as usize;
            output.write_all(&block[begin..begin + take])?;
            at += take as u64;
        }
        Ok(output)
    }
}
