//! The durable browser grant owns its source pin before any chooser result arrives.
use super::*;
use kcoder_state::external_history::{
    ExternalHistoryStore,
    lifecycle::{ArchiveReferenceKind, ArchiveReferenceOwner, ArchiveReferenceReceipt},
};
#[derive(Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct SourceReference {
    version: u8,
    binding: String,
    receipt: ArchiveReferenceReceipt,
}
#[derive(Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Retired {
    version: u8,
    binding: String,
    sequence: u64,
}
impl Operation<'_> {
    fn archives(&self) -> Result<ExternalHistoryStore> {
        self.store.verify()?;
        ExternalHistoryStore::open_existing(&self.store.root)?
            .context("local_upload_source_missing")
    }
    fn reference_binding(&self) -> Result<String> {
        hash(&("browser-upload-source-reference/1", &self.grant))
    }
    fn reference_owner(&self) -> Result<ArchiveReferenceOwner> {
        ArchiveReferenceOwner::new(
            ArchiveReferenceKind::Upload,
            &self.grant.operation_id,
            &self.reference_binding()?,
        )
    }
    pub(super) fn is_retired(&self) -> Result<bool> {
        let Some(value) = load::<Retired>(&self.directory, "source-retired.json")? else {
            return Ok(false);
        };
        ensure!(
            value.version == 1 && value.binding == self.reference_binding()?,
            "local_upload_source_reference_changed"
        );
        Ok(true)
    }
    fn source_reference(&self) -> Result<SourceReference> {
        let value: SourceReference = load(&self.directory, "source-reference.json")?
            .context("local_upload_source_recovery_required")?;
        ensure!(
            value.version == 1
                && value.binding == self.reference_binding()?
                && value.receipt.matches_owner(
                    ArchiveReferenceKind::Upload,
                    &self.grant.operation_id,
                    &value.binding
                ),
            "local_upload_source_reference_changed"
        );
        Ok(value)
    }
    pub(super) fn pin_source_reference(&self, request: &LocalAttachmentRequest) -> Result<()> {
        ensure!(!self.is_retired()?, "local_upload_retired");
        if self.grant.version == 1 {
            return Ok(());
        }
        ensure!(self._writer.is_some(), "local_upload_busy");
        if load::<SourceReference>(&self.directory, "source-reference.json")?.is_some() {
            return self.verify_source_reference();
        }
        ensure!(
            self.grant.frozen == Frozen::from_request(request),
            "local_upload_request_changed"
        );
        let guard = request._source.archive().lifecycle_guard();
        ensure!(guard.is_managed(), "local_upload_source_reference_changed");
        let archives = self.archives()?;
        let owner = self.reference_owner()?;
        let receipt = match archives.archive_reference_for_owner(&owner)? {
            Some(receipt) => receipt,
            None => archives.retain_archive_reference(owner, &[guard])?,
        };
        exact(
            &self.directory,
            "source-reference.json",
            &SourceReference {
                version: 1,
                binding: self.reference_binding()?,
                receipt,
            },
        )
    }
    pub(super) fn verify_source_reference(&self) -> Result<()> {
        ensure!(!self.is_retired()?, "local_upload_retired");
        if self.grant.version == 1 {
            return Ok(());
        }
        let reference = self.source_reference()?;
        let expected = self
            .archives()?
            .archive_reference_for_owner(&self.reference_owner()?)?
            .context("local_upload_source_reference_changed")?;
        ensure!(
            reference.receipt == expected,
            "local_upload_source_reference_changed"
        );
        Ok(())
    }
}
impl HistoryLocalAttachmentUploads {
    /// Release only this staging operation's source reference. The immutable upload
    /// bytes and audit remain retained and continue counting against the disk budget.
    pub fn retire(&self, operation_id: &str, sequence: u64) -> Result<()> {
        let op = self.operation_inner(operation_id, true)?;
        ensure!(
            matches!(op.grant.version, 2 | 3),
            "local_upload_retirement_legacy_retained"
        );
        let _control = op.control_lock()?;
        let reference = op.source_reference()?;
        let archives = op.archives()?;
        if let Some(value) = load::<Retired>(&op.directory, "source-retired.json")? {
            ensure!(
                value.version == 1
                    && value.binding == reference.binding
                    && value.sequence == sequence,
                "local_upload_retirement_conflict"
            );
            return archives.release_archive_reference(&reference.receipt);
        }
        op.check_sequence(sequence)?;
        op.verify_source_reference()?;
        archives
            .archive_reference_release_guard(&reference.receipt)?
            .commit(|| {
                exact(
                    &op.directory,
                    "source-retired.json",
                    &Retired {
                        version: 1,
                        binding: reference.binding.clone(),
                        sequence,
                    },
                )
            })
    }
}
