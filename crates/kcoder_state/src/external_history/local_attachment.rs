//! Explicit host-selected files become immutable owned archive attachments, never path grants from history.
use super::*;
use kcoder_types::{historical_attachment::*, local_attachment::*};
mod source;
pub use source::{SelectedLocalFile, StagedUploadFileIdentity, StagedUploadSource};
const META: u64 = 32 * 1024;
const MAX_OPERATIONS: usize = 4096;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    archive_id: String,
    archive_identity: String,
    directory_identity: String,
    operation_id: String,
    reference: String,
    source: source::Binding,
    expected: HistoricalAttachmentReceipt,
    writer_identity: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Control {
    revision: u64,
    acknowledged: u64,
    sequence: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Progress {
    sequence: u64,
    stage: HistoricalLocalAttachmentStage,
    bytes: u64,
    cancel_watermark: u64,
    error: Option<String>,
}
type StagedSourceResolver<'a> =
    Box<dyn FnOnce(&StagedUploadSource) -> Result<SelectedLocalFile> + 'a>;
pub struct LocalAttachmentImport<'a> {
    archive: &'a ExternalHistoryReader,
    directory: PrivateDirectory,
    operation_id: String,
    writer: Option<PrivateFileLock>,
    payload_owner: Option<lifecycle::PayloadNode>,
}
fn hash_value(value: &impl Serialize) -> Result<String> {
    Ok(hash(&serde_json::to_vec(value)?))
}
fn operation(id: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id),
        "local_attachment_invalid_operation"
    );
    Ok(())
}
fn safe(error: &anyhow::Error) -> String {
    for cause in error.chain() {
        if let Some(error) = cause.downcast_ref::<std::io::Error>() {
            let full = error.kind() == std::io::ErrorKind::StorageFull;
            #[cfg(unix)]
            let full = full || error.raw_os_error() == Some(libc::ENOSPC);
            #[cfg(windows)]
            let full = full || matches!(error.raw_os_error(), Some(39 | 112));
            if full {
                return "local_attachment_no_space".into();
            }
        }
        let code = match cause.to_string().as_str() {
            "local_attachment_no_space"
            | "history_resource_disk_space_insufficient"
            | "history_resource_disk_nodes_insufficient" => "local_attachment_no_space",
            "local_attachment_cancelled" | "history_attachment_cancelled" => {
                "local_attachment_cancelled"
            }
            "local_attachment_selection_expired" => "local_attachment_selection_expired",
            "local_attachment_source_changed" | "local_attachment_unsafe_selection" => {
                "local_attachment_source_changed"
            }
            "local_attachment_source_unavailable" => "local_attachment_source_unavailable",
            "local_attachment_source_budget_exceeded"
            | "history_attachment_budget_exceeded"
            | "history_attachment_count_budget_exceeded"
            | "local_attachment_operation_budget_exceeded"
            | "history_resource_budget_exceeded"
            | "history_resource_file_budget_exceeded" => "local_attachment_budget_exceeded",
            "local_attachment_content_changed" | "history_attachment_content_changed" => {
                "local_attachment_content_changed"
            }
            _ => continue,
        };
        return code.into();
    }
    "local_attachment_outcome_unknown".into()
}
fn existing_writer(directory: &PrivateDirectory, expected: &str) -> Result<File> {
    let lock = directory
        .open_single_link_regular_file(OsStr::new("writer.lock"))
        .map_err(|_| anyhow::anyhow!("local_attachment_lock_missing"))?;
    ensure!(
        directory.history_matches_file_identity(OsStr::new("writer.lock"), expected)?,
        "local_attachment_lock_changed"
    );
    Ok(lock)
}
fn try_writer(directory: &PrivateDirectory, expected: &str) -> Result<Option<PrivateFileLock>> {
    let lock = existing_writer(directory, expected)?;
    match fs2::FileExt::try_lock_exclusive(&lock) {
        Ok(()) => {
            // Recheck the path after acquiring the existing handle; never adopt a replacement lock.
            let lock = PrivateFileLock::from_locked(lock);
            existing_writer(directory, expected)?;
            Ok(Some(lock))
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.raw_os_error().is_some_and(|code| {
                    fs2::lock_contended_error().raw_os_error() == Some(code)
                }) =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}
impl ExternalHistoryReader {
    pub fn local_attachment_import(
        &self,
        id: &str,
        writable: bool,
    ) -> Result<Option<LocalAttachmentImport<'_>>> {
        operation(id)?;
        self.receipt()?.context("external_history_not_committed")?;
        let Some(parent) = self.payload_root("local-attachments-v1", writable)? else {
            return Ok(None);
        };
        parent.verify_private_directory()?;
        let _catalog = if writable {
            Some(parent.lock("catalog.lock")?)
        } else {
            None
        };
        if writable {
            let mut count = 0;
            let mut found = false;
            parent.visit_entry_names_bounded(MAX_OPERATIONS + 2, |name| {
                if name
                    .to_str()
                    .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok())
                {
                    count += 1;
                    if name == OsStr::new(id) {
                        found = true;
                    }
                }
                Ok(())
            })?;
            ensure!(
                count < MAX_OPERATIONS || (found && count == MAX_OPERATIONS),
                "local_attachment_operation_budget_exceeded"
            );
        }
        let Some(directory) = self.payload_child(&parent, id, writable)? else {
            return Ok(None);
        };
        directory.verify_private_directory()?;
        let writer = if writable {
            let existing = read_optional(&directory, "intent.json", META)?;
            let lock = if let Some(bytes) = existing {
                let intent: Intent = serde_json::from_slice(&bytes)
                    .map_err(|_| anyhow::anyhow!("local_attachment_invalid_metadata"))?;
                try_writer(&directory, &intent.writer_identity)?
            } else {
                directory.try_exclusive_lock_guard(OsStr::new("writer.lock"))?
            };
            Some(lock.context("local_attachment_busy")?)
        } else {
            None
        };
        Ok(Some(LocalAttachmentImport {
            archive: self,
            payload_owner: directory.node,
            directory: directory.directory,
            operation_id: id.into(),
            writer,
        }))
    }
}
impl LocalAttachmentImport<'_> {
    fn load<T: serde::de::DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        read_optional(&self.directory, name, META)?
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|_| anyhow::anyhow!("local_attachment_invalid_metadata"))
            })
            .transpose()
    }
    fn save(&self, name: &str, value: &impl Serialize) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        ensure!(
            bytes.len() as u64 <= META,
            "local_attachment_metadata_budget_exceeded"
        );
        if let Some(owner) = &self.payload_owner {
            owner.replace(&self.directory, name, &bytes, META)
        } else {
            self.directory.atomic_replace(OsStr::new(name), &bytes)
        }
    }
    fn intent(&self, reference: &str) -> Result<Intent> {
        ensure!(valid_hash(reference), "local_attachment_invalid_reference");
        let intent: Intent = self
            .load("intent.json")?
            .context("local_attachment_selection_required")?;
        let named_writer = existing_writer(&self.directory, &intent.writer_identity)?;
        ensure!(
            self.writer
                .as_ref()
                .map(|lock| source::file_identity(lock.file()))
                .transpose()?
                .is_none_or(
                    |held| source::file_identity(&named_writer).is_ok_and(|actual| actual == held)
                ),
            "local_attachment_lock_changed"
        );
        ensure!(
            intent.version == 1
                && intent.operation_id == self.operation_id
                && intent.reference == reference
                && intent.archive_id == self.archive.binding.archive_id
                && self
                    .archive
                    .directory
                    .history_matches_directory(&intent.archive_identity)?
                && self
                    .directory
                    .history_matches_directory(&intent.directory_identity)?
                && intent.expected.bytes <= HISTORICAL_ATTACHMENT_MAX_BYTES
                && intent.expected.chunk_bytes == HISTORICAL_ATTACHMENT_CHUNK_BYTES as u32
                && valid_hash(&intent.expected.attachment_id)
                && valid_hash(&intent.expected.sha256),
            "local_attachment_intent_changed"
        );
        ensure!(
            intent.expected.bytes == intent.source.bytes()
                && intent.expected.sha256 == intent.source.sha256
                && intent.expected.attachment_id
                    == hash_value(&(
                        "authorized-local/1",
                        &intent.archive_id,
                        &intent.archive_identity,
                        &intent.operation_id,
                        reference,
                        hash_value(&intent.source)?
                    ))?,
            "local_attachment_intent_changed"
        );
        Ok(intent)
    }
    fn control(&self) -> Result<Control> {
        let control = self.load::<Control>("control.json")?.unwrap_or_default();
        ensure!(
            control.acknowledged <= control.revision,
            "local_attachment_invalid_metadata"
        );
        Ok(control)
    }
    fn progress(&self) -> Result<Progress> {
        Ok(self.load::<Progress>("state.json")?.unwrap_or(Progress {
            sequence: self.control()?.sequence,
            stage: HistoricalLocalAttachmentStage::OutcomeUnknown,
            bytes: 0,
            cancel_watermark: 0,
            error: Some("local_attachment_outcome_unknown".into()),
        }))
    }
    fn checkpoint(&self, progress: &mut Progress) -> Result<()> {
        let _control = self
            .directory
            .try_exclusive_lock_guard(OsStr::new("control.lock"))?
            .context("local_attachment_busy")?;
        let mut control = self.control()?;
        progress.sequence = progress
            .sequence
            .max(control.sequence)
            .checked_add(1)
            .context("local_attachment_sequence_exhausted")?;
        control.sequence = progress.sequence;
        self.save("control.json", &control)?;
        self.save("state.json", progress)
    }
    pub fn authorize(
        &self,
        reference: &str,
        selected: &SelectedLocalFile,
    ) -> Result<HistoricalLocalAttachmentState> {
        ensure!(self.writer.is_some(), "local_attachment_writer_required");
        ensure!(valid_hash(reference), "local_attachment_invalid_reference");
        selected.verify()?;
        let expected = HistoricalAttachmentReceipt {
            attachment_id: hash_value(&(
                "authorized-local/1",
                &self.archive.binding.archive_id,
                self.archive.directory.history_owner_seed()?,
                &self.operation_id,
                reference,
                selected.revision()?,
            ))?,
            bytes: selected.bytes(),
            sha256: selected.binding.sha256.clone(),
            chunk_bytes: HISTORICAL_ATTACHMENT_CHUNK_BYTES as u32,
        };
        let intent = Intent {
            version: 1,
            archive_id: self.archive.binding.archive_id.clone(),
            archive_identity: self.archive.directory.history_owner_seed()?,
            directory_identity: self.directory.history_owner_seed()?,
            operation_id: self.operation_id.clone(),
            reference: reference.into(),
            source: selected.binding.clone(),
            expected,
            writer_identity: source::file_identity(
                self.writer
                    .as_ref()
                    .context("local_attachment_writer_required")?,
            )?,
        };
        let encoded = serde_json::to_vec(&intent)?;
        let fresh = read_optional(&self.directory, "intent.json", META)?.is_none();
        if fresh {
            ensure!(
                read_optional(&self.directory, "state.json", META)?.is_none()
                    && read_optional(&self.directory, "control.json", META)?.is_none(),
                "local_attachment_authority_missing"
            );
        }
        if let Some(owner) = &self.payload_owner {
            owner.exact(&self.directory, "intent.json", &encoded, META, || true)?;
        } else {
            publish_exact(&self.directory, "intent.json", &encoded, META)?;
        }
        if fresh {
            self.save(
                "state.json",
                &Progress {
                    sequence: self.control()?.sequence,
                    stage: HistoricalLocalAttachmentStage::Authorized,
                    bytes: 0,
                    cancel_watermark: 0,
                    error: None,
                },
            )?;
        }
        self.view(reference)
    }
    fn receipt(&self, intent: &Intent) -> Result<Option<HistoricalAttachmentReceipt>> {
        let receipt = self
            .archive
            .attachment_blob(&intent.expected.attachment_id, false)?
            .map(|blob| blob.receipt())
            .transpose()?
            .flatten();
        if let Some(receipt) = &receipt {
            ensure!(
                *receipt == intent.expected,
                "local_attachment_content_changed"
            );
        }
        Ok(receipt)
    }
    pub fn view(&self, reference: &str) -> Result<HistoricalLocalAttachmentState> {
        let intent = self.intent(reference)?;
        let progress = self.progress()?;
        let control = self.control()?;
        let receipt = self.receipt(&intent)?;
        let pending = self
            .archive
            .attachment_blob(&intent.expected.attachment_id, false)?
            .is_some_and(|blob| blob.local_payload_exists().unwrap_or(true));
        let stage = if receipt.is_some() {
            HistoricalLocalAttachmentStage::Ready
        } else if pending
            || progress.stage == HistoricalLocalAttachmentStage::Ready
            || (progress.stage == HistoricalLocalAttachmentStage::Copying
                && self.writer.is_none()
                && self.writer_free(&intent)?)
        {
            HistoricalLocalAttachmentStage::OutcomeUnknown
        } else {
            progress.stage
        };
        Ok(HistoricalLocalAttachmentState {
            operation_id: self.operation_id.clone(),
            sequence: progress.sequence,
            stage,
            processed_bytes: receipt
                .as_ref()
                .map_or(progress.bytes, |receipt| receipt.bytes),
            receipt,
            failure_code: if stage == HistoricalLocalAttachmentStage::Ready {
                None
            } else {
                progress.error
            },
            cancel_requested: stage != HistoricalLocalAttachmentStage::Ready
                && control.revision > control.acknowledged,
            cancel_revision: control.revision,
        })
    }
    fn writer_free(&self, intent: &Intent) -> Result<bool> {
        Ok(try_writer(&self.directory, &intent.writer_identity)?.is_some())
    }
    pub fn cancel(&self, reference: &str) -> Result<HistoricalLocalAttachmentState> {
        if self.view(reference)?.stage == HistoricalLocalAttachmentStage::Ready {
            return self.view(reference);
        }
        let _control = self
            .directory
            .try_exclusive_lock_guard(OsStr::new("control.lock"))?
            .context("local_attachment_busy")?;
        let mut control = self.control()?;
        control.revision = control
            .revision
            .checked_add(1)
            .context("local_attachment_sequence_exhausted")?;
        self.save("control.json", &control)?;
        drop(_control);
        if self.writer.is_none()
            && let Some(_writer) =
                try_writer(&self.directory, &self.intent(reference)?.writer_identity)?
        {
            let mut progress = self.progress()?;
            progress.cancel_watermark = control.revision;
            if !matches!(
                progress.stage,
                HistoricalLocalAttachmentStage::Copying
                    | HistoricalLocalAttachmentStage::OutcomeUnknown
            ) {
                progress.stage = HistoricalLocalAttachmentStage::Cancelled;
            }
            self.checkpoint(&mut progress)?;
        }
        self.view(reference)
    }
    pub fn run(
        &self,
        reference: &str,
        sequence: u64,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalLocalAttachmentState> {
        self.run_inner(reference, sequence, None, check)
    }
    /// Resolves an owned staged upload only after existing completion receipts are reconciled.
    pub fn run_with_source(
        &self,
        reference: &str,
        sequence: u64,
        resolve: impl FnOnce(&StagedUploadSource) -> Result<SelectedLocalFile>,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalLocalAttachmentState> {
        self.run_inner(reference, sequence, Some(Box::new(resolve)), check)
    }
    /// Returns only a runtime resolver request for a native-owned durable upload binding.
    pub fn staged_upload_source(&self, reference: &str) -> Result<Option<StagedUploadSource>> {
        let intent = self.intent(reference)?;
        source::SelectedLocalFile::staged_upload_source(&intent.source)
    }
    fn run_inner(
        &self,
        reference: &str,
        sequence: u64,
        mut source_resolver: Option<StagedSourceResolver<'_>>,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalLocalAttachmentState> {
        ensure!(self.writer.is_some(), "local_attachment_writer_required");
        let intent = self.intent(reference)?;
        let initial = self
            .view(reference)
            .context("local_attachment_initial_observation_unavailable")?;
        ensure!(
            initial.sequence == sequence,
            "local_attachment_revision_conflict"
        );
        if initial.stage == HistoricalLocalAttachmentStage::Ready {
            return Ok(initial);
        }
        let mut progress = self.progress()?;
        {
            let _control = self
                .directory
                .try_exclusive_lock_guard(OsStr::new("control.lock"))?
                .context("local_attachment_busy")?;
            let mut control = self.control()?;
            control.acknowledged = control.acknowledged.max(progress.cancel_watermark);
            self.save("control.json", &control)
                .context("local_attachment_control_checkpoint_unavailable")?;
        }
        progress.stage = HistoricalLocalAttachmentStage::Copying;
        progress.error = None;
        progress.bytes = 0;
        self.checkpoint(&mut progress)
            .context("local_attachment_copy_checkpoint_unavailable")?;
        let mut callback_failed = false;
        let mut poll = |bytes| -> bool {
            let result: Result<bool> = (|| {
                self.intent(reference)?;
                let control = self.control()?;
                if control.revision > control.acknowledged {
                    progress.cancel_watermark = control.revision;
                    return Ok(false);
                }
                if !check(bytes) {
                    return Ok(false);
                }
                if bytes.saturating_sub(progress.bytes) >= 1024 * 1024 {
                    progress.bytes = bytes;
                    self.checkpoint(&mut progress)?;
                }
                Ok(true)
            })();
            match result {
                Ok(value) => value,
                Err(_) => {
                    callback_failed = true;
                    false
                }
            }
        };
        let result = (|| {
            let mut blob = self
                .archive
                .attachment_blob_with_check(&intent.expected.attachment_id, true, || poll(0))?
                .context("local_attachment_store_missing")?;
            blob.mark_local_resource();
            if let Some(receipt) = blob.reconcile_local(&intent.expected, &mut poll)? {
                return Ok(receipt);
            }
            ensure!(poll(0), "local_attachment_cancelled");
            blob.preflight_local(intent.expected.bytes)?;
            let mut source = match source_resolver.take() {
                Some(resolve) => {
                    let staged = source::SelectedLocalFile::staged_upload_source(&intent.source)?
                        .context("local_attachment_invalid_staged_selection")?;
                    let selected = resolve(&staged)?;
                    ensure!(
                        selected.matches_binding(&intent.source),
                        "local_attachment_source_changed"
                    );
                    selected.reader()?
                }
                None => SelectedLocalFile::reopen(&intent.source)?.reader()?,
            };
            let receipt = blob.publish(&mut source, intent.expected.bytes, &mut poll)?;
            ensure!(
                receipt == intent.expected,
                "local_attachment_content_changed"
            );
            Ok(receipt)
        })();
        match result {
            Ok(receipt) => {
                progress.stage = HistoricalLocalAttachmentStage::Ready;
                progress.bytes = receipt.bytes;
                progress.error = None;
            }
            Err(error) => {
                let code = if callback_failed {
                    "local_attachment_checkpoint_unavailable".into()
                } else {
                    safe(&error)
                };
                progress.stage = match code.as_str() {
                    "local_attachment_cancelled" => HistoricalLocalAttachmentStage::Cancelled,
                    "local_attachment_source_changed" => {
                        HistoricalLocalAttachmentStage::SourceChanged
                    }
                    "local_attachment_selection_expired"
                    | "local_attachment_source_unavailable" => {
                        HistoricalLocalAttachmentStage::SelectionRequired
                    }
                    "local_attachment_budget_exceeded" => HistoricalLocalAttachmentStage::Failed,
                    _ => HistoricalLocalAttachmentStage::OutcomeUnknown,
                };
                progress.error = Some(code);
            }
        }
        self.checkpoint(&mut progress)
            .context("local_attachment_final_checkpoint_unavailable")?;
        self.view(reference)
            .context("local_attachment_final_observation_unavailable")
    }
    /// Observe the original authorization proof without reopening its selected source.
    pub fn expected_receipt(&self, reference: &str) -> Result<HistoricalAttachmentReceipt> {
        Ok(self.intent(reference)?.expected)
    }
    pub fn selection_revision(&self, reference: &str) -> Result<String> {
        hash_value(&self.intent(reference)?.source)
    }
    pub fn read_chunk(
        &self,
        reference: &str,
        expected: &HistoricalAttachmentReceipt,
        offset: u64,
        limit: usize,
    ) -> Result<Vec<u8>> {
        let intent = self.intent(reference)?;
        ensure!(
            *expected == intent.expected && self.receipt(&intent)?.as_ref() == Some(expected),
            "local_attachment_not_ready"
        );
        self.archive
            .attachment_blob(&intent.expected.attachment_id, false)?
            .context("local_attachment_not_ready")?
            .read_chunk(offset, limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observer_treats_the_native_writer_lock_as_busy_without_changing_its_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_or_create(&temporary.path().join("owned")).unwrap();
        let writer = directory
            .open_read_write_file(OsStr::new("writer.lock"), true)
            .unwrap();
        let identity = source::file_identity(&writer).unwrap();
        fs2::FileExt::lock_exclusive(&writer).unwrap();
        assert!(try_writer(&directory, &identity).unwrap().is_none());
        assert_eq!(source::file_identity(&writer).unwrap(), identity);
        drop(writer);
        assert!(try_writer(&directory, &identity).unwrap().is_some());
    }
    #[test]
    fn arbitrary_error_text_cannot_claim_cancellation_or_disk_full() {
        for message in [
            "failed opening cancelled-report.bin",
            "unknown IO for No space left.txt",
            "context: local_attachment_cancelled",
            "my-budget_exceeded-file",
        ] {
            assert_eq!(
                safe(&anyhow::anyhow!(message)),
                "local_attachment_outcome_unknown"
            );
        }
        assert_eq!(
            safe(&std::io::Error::other("No space left on device").into()),
            "local_attachment_outcome_unknown"
        );
        assert_eq!(
            safe(&anyhow::anyhow!("history_attachment_cancelled")),
            "local_attachment_cancelled"
        );
        assert_eq!(
            safe(&anyhow::anyhow!("local_attachment_source_changed")),
            "local_attachment_source_changed"
        );
        assert_eq!(
            safe(&std::io::Error::from(std::io::ErrorKind::StorageFull).into()),
            "local_attachment_no_space"
        );
    }
}
