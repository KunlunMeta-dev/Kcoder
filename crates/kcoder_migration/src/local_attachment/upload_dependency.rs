//! An upload input can disappear only while its exact native copy cannot change.
use super::*;
use kcoder_config::PrivateLeaseMode;
use kcoder_state::external_history::lifecycle::ArchiveReferenceKind;
pub(super) struct UploadReleaseBinding<'a> {
    pub key: &'a str,
    pub selection: &'a HistoricalAttachmentSelection,
    pub reference: &'a str,
    pub info: &'a HistoricalAttachmentInfo,
    pub revision: &'a str,
    pub selection_revision: Option<&'a str>,
    pub expected: Option<(u64, &'a str)>,
}
impl HistoryLocalAttachments {
    pub(super) fn with_upload_release_guard<T>(
        &self,
        binding: UploadReleaseBinding<'_>,
        mut check: impl FnMut(u64) -> bool,
        action: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let UploadReleaseBinding {
            key,
            selection,
            reference,
            info,
            revision,
            selection_revision,
            expected,
        } = binding;
        self.verify_owner()?;
        let identity = self
            .directory
            .portable_regular_identity(OsStr::new("catalog.lock"))?;
        let _catalog = self
            .directory
            .try_existing_portable_lock(
                OsStr::new("catalog.lock"),
                &identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("local_attachment_busy")?;
        let Some(job) = self.load(key)? else {
            ensure!(
                selection_revision.is_none(),
                "local_upload_collection_local_dependency_unknown"
            );
            return action();
        };
        ensure!(
            job.version == 2
                && job.selection == *selection
                && job.reference == reference
                && job.info == *info
                && job.revision == revision,
            "local_upload_collection_local_dependency_changed"
        );
        let receipt = job
            .source_reference
            .as_ref()
            .context("local_attachment_reference_recovery_required")?;
        ensure!(
            receipt.matches_owner(
                ArchiveReferenceKind::LocalAttachment,
                key,
                &self.reference_binding(&job)?
            ),
            "local_attachment_reference_changed"
        );
        if job.retired.is_some() {
            return action();
        }
        self.verify_source_reference(&job)?;
        let selection_revision =
            selection_revision.context("local_upload_collection_local_dependency_unknown")?;
        let (bytes, sha) = expected.context("local_upload_collection_local_dependency_unknown")?;
        let resolved = target(&self.root, selection, Some(revision))?;
        let local = resolved.reference(selection, &mut check)?;
        Self::verify(&job, &local)?;
        let native = local
            .archive
            .local_attachment_import(key, true)?
            .context("local_upload_collection_local_dependency_unknown")?;
        let current = self.job(key)?;
        Self::verify(&current, &local)?;
        ensure!(
            native.selection_revision(reference)? == selection_revision,
            "local_upload_collection_local_dependency_changed"
        );
        let state = native.view(reference)?;
        ensure!(
            state.stage == HistoricalLocalAttachmentStage::Ready && !state.cancel_requested,
            "local_upload_collection_local_dependency_active"
        );
        let receipt = state
            .receipt
            .context("local_upload_collection_local_dependency_unknown")?;
        ensure!(
            receipt.bytes == bytes && receipt.sha256 == sha,
            "local_upload_collection_local_dependency_changed"
        );
        let mut digest = Sha256::new();
        let mut offset = 0;
        while offset < bytes {
            ensure!(check(offset), "local_upload_collection_cancelled");
            let chunk = native.read_chunk(reference, &receipt, offset, 64 * 1024)?;
            ensure!(
                !chunk.is_empty() && offset + chunk.len() as u64 <= bytes,
                "local_upload_collection_local_dependency_changed"
            );
            offset += chunk.len() as u64;
            digest.update(chunk);
        }
        ensure!(
            format!("{:x}", digest.finalize()) == sha,
            "local_upload_collection_local_dependency_changed"
        );
        // The original raw guard, native writer, and migration catalogue remain held.
        // Ready is rechecked from actual copied bytes, not only a projected status.
        action()
    }
}

#[cfg(test)]
mod tests;
