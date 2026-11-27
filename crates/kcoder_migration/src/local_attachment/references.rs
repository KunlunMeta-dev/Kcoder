//! Local supplements retain their authenticated source independently of the selected file.
use super::*;
use kcoder_state::external_history::{
    ExternalHistoryStore,
    lifecycle::{ArchiveReferenceKind, ArchiveReferenceOwner},
};
impl HistoryLocalAttachments {
    fn archives(&self) -> Result<ExternalHistoryStore> {
        self.verify_owner()?;
        ExternalHistoryStore::open_existing(&self.root)?.context("local_attachment_archive_missing")
    }
    pub(super) fn reference_binding(&self, job: &Job) -> Result<String> {
        hash(&(
            "local-attachment-source-reference/1",
            &self.owner,
            &job.operation_id,
            &job.selection,
            &job.reference,
            &job.info,
            &job.revision,
        ))
    }
    fn reference_owner(&self, job: &Job) -> Result<ArchiveReferenceOwner> {
        ArchiveReferenceOwner::new(
            ArchiveReferenceKind::LocalAttachment,
            &job.operation_id,
            &self.reference_binding(job)?,
        )
    }
    pub(super) fn pin_source_reference(
        &self,
        job: &mut Job,
        archive: &ExternalHistoryReader,
    ) -> Result<()> {
        if job.version == 1 {
            return Ok(());
        }
        if job.source_reference.is_some() {
            return self.verify_source_reference(job);
        }
        let archives = self.archives()?;
        let owner = self.reference_owner(job)?;
        let guard = archive.lifecycle_guard();
        ensure!(guard.is_managed(), "local_attachment_reference_changed");
        job.source_reference = Some(match archives.archive_reference_for_owner(&owner)? {
            Some(receipt) => receipt,
            None => archives.retain_archive_reference(owner, &[guard])?,
        });
        self.save_reference_job(job)
    }
    fn save_reference_job(&self, job: &Job) -> Result<()> {
        let bytes = serde_json::to_vec(job)?;
        ensure!(
            bytes.len() as u64 <= META,
            "local_attachment_metadata_budget_exceeded"
        );
        self.directory
            .atomic_replace(OsStr::new(&format!("{}.json", job.operation_id)), &bytes)
    }
    pub(super) fn verify_source_reference(&self, job: &Job) -> Result<()> {
        if job.version == 1 {
            return Ok(());
        }
        let receipt = job
            .source_reference
            .as_ref()
            .context("local_attachment_reference_recovery_required")?;
        let expected = self
            .archives()?
            .archive_reference_for_owner(&self.reference_owner(job)?)?
            .context("local_attachment_reference_changed")?;
        ensure!(*receipt == expected, "local_attachment_reference_changed");
        Ok(())
    }
    /// Retire this producer's pin without deleting shared blobs or changing its
    /// original native copy receipt. The explicit operation is independently idempotent.
    pub fn retire(&self, key: &str, retirement: &str) -> Result<()> {
        id(key)?;
        id(retirement)?;
        self.verify_owner()?;
        let _catalog = self
            .directory
            .try_exclusive_lock(OsStr::new("catalog.lock"))?
            .context("local_attachment_busy")?;
        let mut job = self.load(key)?.context("local_attachment_job_not_found")?;
        ensure!(
            job.version == 2,
            "local_attachment_retirement_legacy_retained"
        );
        let receipt = job
            .source_reference
            .clone()
            .context("local_attachment_reference_recovery_required")?;
        ensure!(
            receipt.matches_owner(
                ArchiveReferenceKind::LocalAttachment,
                key,
                &self.reference_binding(&job)?
            ),
            "local_attachment_reference_changed"
        );
        let archives = self.archives()?;
        if let Some(operation) = &job.retired {
            ensure!(
                operation == retirement,
                "local_attachment_retirement_conflict"
            );
            return archives.release_archive_reference(&receipt);
        }
        self.verify_source_reference(&job)?;
        archives
            .archive_reference_release_guard(&receipt)?
            .commit(|| {
                job.retired = Some(retirement.into());
                self.save_reference_job(&job)
            })
    }
}
