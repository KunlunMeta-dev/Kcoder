use super::*;
use kcoder_state::history_index::HistoryCatalogRecoveryRequired;

impl HistoryJobStore {
    /// Called only while the explicit runner owns this job's exclusive run lease.
    pub(super) fn refresh_for_run(&self, job: &mut Job) -> Result<()> {
        match self.refresh(job) {
            Ok(()) => return Ok(()),
            Err(error) if HistoryCatalogRecoveryRequired::from_error(&error).is_some() => {}
            Err(error) => return Err(error),
        }
        // The failed read verified the receipt and source binding before reaching SQLite.
        // The projection's writer lease and private VFS let SQLite perform its own rollback.
        let reader = self.reader_for_job(job)?;
        let projection = reader
            .projection(&job.normalization_revision, true)?
            .context("history_job_projection_missing")?;
        let recovered = projection.progress()?;
        if let Some(checkpoint) = &job.view.normalization {
            ensure!(
                recovered.normalized_records >= checkpoint.normalized_records,
                "history_job_projection_regressed"
            );
        }
        drop(projection);
        self.refresh(job)?;
        Ok(())
    }
}
