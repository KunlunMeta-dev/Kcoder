//! Producer release keeps the actual raw-resource claims alive through its durable tombstone.
use super::*;
pub struct ArchiveReferenceReleaseGuard {
    base: PrivateDirectory,
    receipt: ArchiveReferenceReceipt,
    _leases: Vec<VerifiedPrivateLease>,
}
impl ArchiveReferenceReleaseGuard {
    /// Run the owning domain's durable retirement once, then release only this
    /// original private receipt. A lost callback acknowledgement never reruns here.
    pub fn commit(self, retire: impl FnOnce() -> Result<()>) -> Result<()> {
        retire()?;
        Catalog::open(&self.base, false)?
            .context("external_history_lifecycle_missing")?
            .release(&self.receipt)
    }
}
impl Catalog<'_> {
    pub fn reference_release_guard(
        &self,
        receipt: &ArchiveReferenceReceipt,
    ) -> Result<ArchiveReferenceReleaseGuard> {
        self.verify_reference(receipt)?;
        ensure!(
            matches!(
                receipt.owner.kind,
                ArchiveReferenceKind::AttachmentJob
                    | ArchiveReferenceKind::LocalAttachment
                    | ArchiveReferenceKind::Upload
                    | ArchiveReferenceKind::Preparation
                    | ArchiveReferenceKind::Continuation
            ),
            "external_history_reference_release_unsupported"
        );
        let dependent = self.document.references.values().any(|reference| {
            if reference.released
                || reference.receipt.reference_id == receipt.reference_id
                || !reference
                    .receipt
                    .archives
                    .iter()
                    .any(|id| receipt.archives.contains(id))
            {
                return false;
            }
            match receipt.owner.kind {
                ArchiveReferenceKind::Preparation | ArchiveReferenceKind::Continuation => matches!(
                    reference.receipt.owner.kind,
                    ArchiveReferenceKind::Continuation | ArchiveReferenceKind::NativeSession
                ),
                ArchiveReferenceKind::Upload => matches!(
                    reference.receipt.owner.kind,
                    ArchiveReferenceKind::LocalAttachment
                        | ArchiveReferenceKind::Preparation
                        | ArchiveReferenceKind::Continuation
                        | ArchiveReferenceKind::NativeSession
                ),
                _ => matches!(
                    reference.receipt.owner.kind,
                    ArchiveReferenceKind::Preparation
                        | ArchiveReferenceKind::Continuation
                        | ArchiveReferenceKind::NativeSession
                ),
            }
        });
        ensure!(!dependent, "external_history_reference_still_used");
        let mut leases = Vec::new();
        for id in &receipt.archives {
            let archive = self
                .document
                .archives
                .get(id)
                .context("external_history_lifecycle_changed")?;
            ensure!(
                archive.phase == ArchivePhase::Active,
                "external_history_lifecycle_retiring"
            );
            let control = self.directory.open_child(OsStr::new(id), false)?;
            let header: ArchiveHeader = load(&control, "identity.json", 4096)?;
            ensure!(
                header.scope == self.document.scope
                    && header.archive == archive.id
                    && header.generation == archive.generation
                    && header.directory == archive.directory
                    && header.lease == archive.lease,
                "external_history_lifecycle_changed"
            );
            leases.push(lease::exclusive(&control, &header)?);
        }
        Ok(ArchiveReferenceReleaseGuard {
            base: self.base.duplicate_handle()?,
            receipt: receipt.clone(),
            _leases: leases,
        })
    }
}
