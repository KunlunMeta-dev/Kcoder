//! Read-only previews and observations reuse the original managed archive catalogue.
use super::*;
use kcoder_state::external_history::lifecycle::{
    ArchiveRetirementExecutionState, ArchiveRetirementView,
};

pub struct HistoryRetirementPreview {
    pub job_id: String,
    pub job_sequence: u64,
    pub archive_id: Option<String>,
    pub can_prepare: bool,
    pub owns_archive: bool,
    pub retained_references: u64,
    pub readers_idle: Option<bool>,
    pub reason_code: Option<String>,
    pub existing: Option<ArchiveRetirementView>,
}

impl HistoryJobStore {
    pub fn request_retirement_cancel(&self, operation: &str) -> Result<ArchiveRetirementView> {
        self.read_retirement(operation)?;
        self.archives.request_archive_retirement_cancel(operation)
    }
    pub fn retirement_preview(&self, job_id: &str) -> Result<HistoryRetirementPreview> {
        let job = self.load(job_id)?;
        let mut result = HistoryRetirementPreview {
            job_id: job_id.into(),
            job_sequence: job.view.sequence,
            archive_id: job.view.archive_id.clone(),
            can_prepare: false,
            owns_archive: false,
            retained_references: 0,
            readers_idle: None,
            reason_code: None,
            existing: None,
        };
        if !job.managed() {
            result.reason_code = Some("history_job_retirement_legacy_retained".into());
        } else if !job.view.archived {
            result.reason_code = Some("history_job_retirement_archive_not_ready".into());
        } else {
            let view = self.archives.preview_archive_retirement(job_id)?;
            ensure!(
                Some(&view.archive_id) == job.view.archive_id.as_ref(),
                "history_job_retirement_binding_changed"
            );
            result.can_prepare = true;
            result.owns_archive = view.owns_archive;
            result.retained_references = view.retained_references;
            result.readers_idle = Some(view.readers_idle);
            result.existing = self.retirement_for_job(job_id)?;
        }
        Ok(result)
    }

    pub fn observe_retirement(
        &self,
        operation: &str,
    ) -> Result<(ArchiveRetirementView, ArchiveRetirementExecutionState)> {
        let (view, execution) = self.archives.observe_archive_retirement(operation)?;
        let job = self.load(&view.source_operation_id)?;
        ensure!(
            job.managed() && job.view.archive_id.as_deref() == Some(&view.archive_id),
            "history_job_retirement_binding_changed"
        );
        Ok((view, execution))
    }

    pub fn retirement_records(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<ArchiveRetirementView>, Option<String>)> {
        let (views, next) = self.archives.archive_retirements(after)?;
        for view in &views {
            let job = self.load(&view.source_operation_id)?;
            ensure!(
                job.managed() && job.view.archive_id.as_deref() == Some(&view.archive_id),
                "history_job_retirement_binding_changed"
            );
        }
        Ok((views, next))
    }
}
