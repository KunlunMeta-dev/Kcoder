//! Managed births never reinterpret the identity or deletion authority of an older job.
use super::*;
pub(crate) struct HistoryReferenceFences {
    _leases: Vec<std::fs::File>,
}
impl HistoryJobStore {
    pub(crate) fn reference_fences(&self, jobs: &[&str]) -> Result<HistoryReferenceFences> {
        ensure!(jobs.len() <= 256, "history_job_reference_budget_exceeded");
        let mut ids = jobs.to_vec();
        ids.sort();
        ids.dedup();
        let mut leases = Vec::new();
        for id in ids {
            valid_id(id)?;
            let lease = self.lock(&format!("{id}.run.lock"))?;
            self.ensure_live(&self.load(id)?)?;
            leases.push(lease);
        }
        Ok(HistoryReferenceFences { _leases: leases })
    }
    pub(crate) fn reference_cleanup_fence(&self, job: &str) -> Result<HistoryReferenceFences> {
        valid_id(job)?;
        let lease = self.lock(&format!("{job}.run.lock"))?;
        self.load(job)?;
        Ok(HistoryReferenceFences {
            _leases: vec![lease],
        })
    }
    pub(crate) fn retain_batch_reference(
        &self,
        job_id: &str,
        operation: &str,
        binding: &str,
    ) -> Result<Option<kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt>> {
        let _fence = self.reference_fences(&[job_id])?;
        let reader = self.archive_reader(job_id)?;
        let guard = reader.lifecycle_guard();
        if !guard.is_managed() {
            return Ok(None);
        }
        Ok(Some(self.archives.retain_archive_reference(
            kcoder_state::external_history::lifecycle::ArchiveReferenceOwner::new(
                kcoder_state::external_history::lifecycle::ArchiveReferenceKind::BatchReference,
                operation,
                binding,
            )?,
            &[guard],
        )?))
    }
    pub(crate) fn verify_batch_reference(
        &self,
        job_id: &str,
        operation: &str,
        binding: &str,
        receipt: Option<&kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt>,
    ) -> Result<()> {
        let job = self.load(job_id)?;
        if !job.managed() {
            ensure!(receipt.is_none(), "history_job_reference_changed");
            return Ok(());
        }
        let receipt = receipt.context("history_job_reference_missing")?;
        ensure!(
            receipt.matches_owner(
                kcoder_state::external_history::lifecycle::ArchiveReferenceKind::BatchReference,
                operation,
                binding,
            ) && job
                .view
                .archive_id
                .as_deref()
                .is_some_and(|id| receipt.contains_archive(id)),
            "history_job_reference_changed"
        );
        self.archives.verify_archive_reference(receipt)
    }
    pub(crate) fn release_batch_reference(
        &self,
        operation: &str,
        binding: &str,
        receipt: &kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt,
    ) -> Result<()> {
        ensure!(
            receipt.matches_owner(
                kcoder_state::external_history::lifecycle::ArchiveReferenceKind::BatchReference,
                operation,
                binding,
            ),
            "history_job_reference_changed"
        );
        self.archives.release_archive_reference(receipt)
    }
    pub(super) fn seal_normalization(
        &self,
        job: &Job,
        cancelled: &mut bool,
        control_error: &mut bool,
        check: &mut impl FnMut(HistoryImportEvent) -> bool,
    ) -> Result<()> {
        if !job.managed() {
            return Ok(());
        }
        let archive = self.reader_for_job(job)?;
        let projection = archive
            .projection(&job.normalization_revision, true)?
            .context("history_job_projection_missing")?;
        let progress = projection.progress()?;
        projection.seal_for_collection(|| {
            self.allow_step(&job.view.job_id, cancelled, control_error, || {
                check(HistoryImportEvent::Normalize(
                    HistoryNormalizationProgress {
                        committed: progress.clone(),
                        current_record: None,
                        current_record_bytes: 0,
                    },
                ))
            })
        })
    }
    /// Only a native domain's private, still-live receipt can override the
    /// retired-job creation fence. No public request accepts this receipt.
    pub fn archive_reader_with_reference(
        &self,
        job_id: &str,
        receipt: &kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt,
    ) -> Result<kcoder_state::external_history::ExternalHistoryReader> {
        let job = self.load(job_id)?;
        ensure!(job.view.archived, "history_display_archive_not_ready");
        if !job.managed() {
            return self.archive_reader(job_id);
        }
        let reader = self.archives.reader_with_reference(
            job.view
                .archive_id
                .as_deref()
                .context("history_job_binding_missing")?,
            receipt,
        )?;
        self.bind_reader_budget(&job, reader)
    }
    /// Prepare only the native birth owned by this profile's exact source job. Import
    /// facts remain historical; the separate retirement receipt is authoritative.
    pub fn prepare_retirement(
        &self,
        operation: &str,
        job_id: &str,
        expected_sequence: u64,
    ) -> Result<kcoder_state::external_history::lifecycle::ArchiveRetirementView> {
        valid_id(operation)?;
        valid_id(job_id)?;
        let _runner = self.lock(&format!("{job_id}.run.lock"))?;
        let job = self.load(job_id)?;
        ensure!(job.managed(), "history_job_retirement_legacy_retained");
        ensure!(
            job.view.sequence == expected_sequence,
            "history_job_revision_conflict"
        );
        ensure!(
            job.view.archived,
            "history_job_retirement_archive_not_ready"
        );
        self.archives.prepare_archive_retirement(operation, job_id)
    }
    pub fn retirement_for_job(
        &self,
        job_id: &str,
    ) -> Result<Option<kcoder_state::external_history::lifecycle::ArchiveRetirementView>> {
        let job = self.load(job_id)?;
        if !job.managed() {
            return Ok(None);
        }
        self.archives.archive_retirement_for_source(job_id)
    }
    pub fn read_retirement(
        &self,
        operation: &str,
    ) -> Result<kcoder_state::external_history::lifecycle::ArchiveRetirementView> {
        let view = self.archives.read_archive_retirement(operation)?;
        let job = self.load(&view.source_operation_id)?;
        ensure!(
            job.managed() && job.view.archive_id.as_deref() == Some(&view.archive_id),
            "history_job_retirement_binding_changed"
        );
        Ok(view)
    }
    pub fn run_retirement(
        &self,
        operation: &str,
        sequence: u64,
        check: impl FnMut() -> bool,
    ) -> Result<kcoder_state::external_history::lifecycle::ArchiveRetirementView> {
        let view = self.read_retirement(operation)?;
        let _runner = self.lock(&format!("{}.run.lock", view.source_operation_id))?;
        // No global migration or archive catalogue lease survives the long body hash.
        self.archives
            .run_archive_retirement(operation, sequence, check)
    }
    pub fn cancel_retirement(
        &self,
        operation: &str,
        sequence: u64,
    ) -> Result<kcoder_state::external_history::lifecycle::ArchiveRetirementView> {
        self.read_retirement(operation)?;
        self.archives.cancel_archive_retirement(operation, sequence)
    }
    pub fn resume_retirement(
        &self,
        operation: &str,
        sequence: u64,
    ) -> Result<kcoder_state::external_history::lifecycle::ArchiveRetirementView> {
        let view = self.read_retirement(operation)?;
        let _runner = self.lock(&format!("{}.run.lock", view.source_operation_id))?;
        self.archives.resume_archive_retirement(operation, sequence)
    }
    pub(super) fn validate_managed(&self, job: &Job) -> Result<()> {
        if !job.managed() {
            return Ok(());
        }
        let Some(binding) = &job.binding else {
            return Ok(());
        };
        let recorded = self
            .archives
            .recorded_managed_archive(&job.view.job_id, binding.snapshot())?;
        ensure!(
            recorded.as_deref() == job.view.archive_id.as_deref() && recorded.is_some(),
            "history_job_managed_binding_changed"
        );
        Ok(())
    }
    pub(super) fn retired(&self, job: &Job) -> Result<bool> {
        Ok(job.managed()
            && self
                .archives
                .managed_archive_operation_retired(&job.view.job_id)?)
    }
    pub(super) fn ensure_live(&self, job: &Job) -> Result<()> {
        ensure!(!self.retired(job)?, "history_job_retired");
        Ok(())
    }
}
