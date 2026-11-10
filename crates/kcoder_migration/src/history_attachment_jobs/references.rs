//! A producer intent precedes its native source pin; only explicit retirement releases it.
use super::*;
use kcoder_state::external_history::{
    ExternalHistoryReader, ExternalHistoryStore,
    lifecycle::{ArchiveReferenceKind, ArchiveReferenceOwner},
};
impl Target {
    pub(super) fn archive(&self) -> &ExternalHistoryReader {
        match self {
            Self::Raw { view, .. } => view.archive(),
            Self::Selected(value) => value.local_archive(),
            Self::Tool { catalog, .. } => catalog.local_archive(),
        }
    }
}
impl HistoryAttachmentJobs {
    fn archives(&self) -> Result<ExternalHistoryStore> {
        ensure!(
            PrivateDirectory::open_existing(&self.root)?.directory_identity()?
                == self.profile.directory_identity()?,
            "history_attachment_owner_changed"
        );
        ExternalHistoryStore::open_existing(&self.root)?
            .context("history_attachment_source_missing")
    }
    fn reference_binding(&self, job: &Job) -> Result<String> {
        Ok(hash(&serde_json::to_vec(&(
            "attachment-source-reference/1",
            &self.owner,
            &job.view.id,
            &job.selection,
            &job.content,
        ))?))
    }
    fn reference_owner(&self, job: &Job) -> Result<ArchiveReferenceOwner> {
        ArchiveReferenceOwner::new(
            ArchiveReferenceKind::AttachmentJob,
            &job.view.id,
            &self.reference_binding(job)?,
        )
    }
    pub(super) fn pin_source_reference(&self, job: &mut Job, target: &Target) -> Result<()> {
        if job.version == 1 {
            return Ok(());
        }
        let archives = self.archives()?;
        if job.source_reference.is_some() {
            return self.verify_source_reference(job);
        }
        ensure!(job.retirement.is_none(), "history_attachment_job_retired");
        let guard = target.archive().lifecycle_guard();
        ensure!(guard.is_managed(), "history_attachment_source_changed");
        // The already saved original job fixes the owner before a native pin is created.
        // A lost pin acknowledgement is recovered by the same owner, not a new operation.
        let owner = self.reference_owner(job)?;
        let receipt = match archives.archive_reference_for_owner(&owner)? {
            Some(receipt) => receipt,
            None => archives.retain_archive_reference(owner, &[guard])?,
        };
        job.source_reference = Some(receipt);
        self.save(&format!("{}.json", job.view.id), job)
    }
    pub(super) fn verify_source_reference(&self, job: &Job) -> Result<()> {
        if job.version == 1 {
            return Ok(());
        }
        let receipt = job
            .source_reference
            .as_ref()
            .context("history_attachment_reference_recovery_required")?;
        let owner = self.reference_owner(job)?;
        let expected = self
            .archives()?
            .archive_reference_for_owner(&owner)?
            .context("history_attachment_source_reference_changed")?;
        ensure!(
            *receipt == expected,
            "history_attachment_source_reference_changed"
        );
        Ok(())
    }
    /// Retire only this extraction job. Shared blobs and its audit metadata remain
    /// retained; source collection is separately authorized by the archive lifecycle.
    pub fn retire(&self, id: &str, expected_sequence: u64) -> Result<()> {
        ensure!(
            id.len() == 64
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
            "history_attachment_job_invalid"
        );
        let _runner = self.lock(&format!("{id}.run.lock"))?;
        let _catalog = self.lock("catalog.lock")?;
        let saved: Job = self
            .optional(&format!("{id}.json"))?
            .context("history_attachment_job_missing")?;
        let mut job = self
            .load(id, &saved.content, &saved.selection)?
            .context("history_attachment_job_missing")?;
        ensure!(
            job.version == 2,
            "history_attachment_retirement_legacy_retained"
        );
        let receipt = job
            .source_reference
            .clone()
            .context("history_attachment_reference_recovery_required")?;
        let archives = self.archives()?;
        ensure!(
            receipt.matches_owner(
                ArchiveReferenceKind::AttachmentJob,
                &job.view.id,
                &self.reference_binding(&job)?
            ),
            "history_attachment_source_reference_changed"
        );
        if let Some(sequence) = job.retirement {
            ensure!(
                sequence == expected_sequence,
                "history_attachment_retirement_conflict"
            );
            return archives.release_archive_reference(&receipt);
        }
        ensure!(
            job.view.sequence == expected_sequence,
            "history_attachment_revision_conflict"
        );
        self.verify_source_reference(&job)?;
        let claim = archives.archive_reference_release_guard(&receipt)?;
        claim.commit(|| {
            job.retirement = Some(expected_sequence);
            self.checkpoint(&mut job)
        })
    }
}
