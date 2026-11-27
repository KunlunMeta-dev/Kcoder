//! An explicit new job binds the immutable archived snapshot to a new interpretation.
use super::*;
use crate::{
    history_display::HistoryArchiveView, history_normalization::HISTORY_REINTERPRETATION_REVISION,
};
use kcoder_types::history_reinterpretation::HistoryReinterpretationPreview;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReinterpretedSource {
    job_id: String,
    sequence: u64,
    normalization_revision: String,
    receipt_sha256: String,
    interpretation_revision: String,
}

impl HistoryJobStore {
    fn committed_source_archive(
        &self,
        job: &Job,
    ) -> Result<kcoder_types::external_history::ExternalHistoryReceipt> {
        self.ensure_live(job)?;
        let binding = job
            .binding
            .as_ref()
            .context("history_reinterpret_archive_not_ready")?;
        let archive = self.archives.reader(
            job.view
                .archive_id
                .as_deref()
                .context("history_reinterpret_archive_not_ready")?,
        )?;
        let receipt = archive
            .receipt()?
            .context("history_reinterpret_archive_not_ready")?;
        ensure!(
            receipt.source_sha256 == binding.snapshot().source_sha256,
            "history_job_archive_changed"
        );
        Ok(receipt)
    }

    /// No source bytes, old projections or new directories are read or initialized.
    pub fn reinterpretation_preview(
        &self,
        source_job_id: &str,
    ) -> Result<HistoryReinterpretationPreview> {
        let source = self.load(source_job_id)?;
        let reason = if self.retired(&source)? {
            Some("history_job_retired")
        } else if source.normalization_revision == HISTORY_REINTERPRETATION_REVISION {
            Some("history_reinterpret_already_current")
        } else if self.execution_state(source_job_id)? == HistoryExecutionState::Unknown {
            Some(self.execution_unknown_code(source_job_id)?)
        } else if self.execution_state(source_job_id)? == HistoryExecutionState::Running {
            Some("history_reinterpret_source_busy")
        } else {
            match self.committed_source_archive(&source) {
                Ok(_) => None,
                Err(error)
                    if missing(&error)
                        || error.to_string() == "history_reinterpret_archive_not_ready" =>
                {
                    Some("history_reinterpret_archive_not_ready")
                }
                Err(error) => return Err(error),
            }
        };
        Ok(HistoryReinterpretationPreview {
            source_job_id: source_job_id.into(),
            source_sequence: source.view.sequence,
            source_revision: source.normalization_revision,
            parser_revision: HISTORY_REINTERPRETATION_REVISION.into(),
            can_create: reason.is_none(),
            reason_code: reason.map(str::to_owned),
        })
    }

    pub fn normalization_revision(&self, job_id: &str) -> Result<String> {
        Ok(self.load(job_id)?.normalization_revision)
    }

    pub fn archive_view(&self, job_id: &str) -> Result<HistoryArchiveView> {
        HistoryArchiveView::open_with_revision(
            self.archive_reader(job_id)?,
            &self.normalization_revision(job_id)?,
        )
    }

    /// Creation is the explicit confirmation; neither observation nor parser upgrades call this.
    /// The original source file and its old derived rows are never opened by this operation.
    pub fn reinterpret(
        &self,
        request_id: &str,
        source_job_id: &str,
        expected_source_sequence: u64,
    ) -> Result<HistoryImportJobView> {
        valid_id(request_id)?;
        valid_id(source_job_id)?;
        ensure!(
            request_id != source_job_id,
            "history_reinterpret_request_conflict"
        );
        let _catalog = self.lock("catalog.lock")?;
        if let Some(existing) = self.load_optional(request_id)? {
            ensure!(
                existing
                    .reinterpreted_from
                    .as_ref()
                    .is_some_and(|source| source.job_id == source_job_id
                        && source.sequence == expected_source_sequence),
                "history_reinterpret_request_conflict"
            );
            return self.observe(existing);
        }
        let source = self.load(source_job_id)?;
        ensure!(
            source.view.sequence == expected_source_sequence,
            "history_job_revision_conflict"
        );
        let source_execution = self.claim_execution(source_job_id, expected_source_sequence)?;
        let _source_runner = self.execution_run_lock(&source_execution)?;
        ensure!(
            source.normalization_revision != HISTORY_REINTERPRETATION_REVISION,
            "history_reinterpret_already_current"
        );
        let binding = source
            .binding
            .as_ref()
            .context("history_reinterpret_archive_not_ready")?;
        let archive_id = source
            .view
            .archive_id
            .as_deref()
            .context("history_reinterpret_archive_not_ready")?;
        let receipt = self.committed_source_archive(&source)?;
        let mut count = 0;
        self.directory
            .visit_entry_names_bounded(MAX_JOB_ENTRIES, |name| {
                if name
                    .to_str()
                    .is_some_and(|name| name.ends_with(".json") && !name.ends_with(".cancel.json"))
                {
                    count += 1;
                }
                Ok(())
            })?;
        ensure!(count < MAX_JOBS, "history_job_count_budget_exceeded");
        let _runner = self.lock(&format!("{request_id}.run.lock"))?;
        let storage = if source.managed() {
            resources::HistoryBudgetStorage::Managed
        } else {
            resources::HistoryBudgetStorage::Legacy
        };
        // Reinterpretation owns only new derived allocations. The source job and its metadata
        // remain unchanged, and the original physical archive retains its original charge.
        let resource_budget = self.birth_standalone_resource_budget(
            request_id,
            &source.binding_sha256,
            None,
            storage,
        )?;
        if source.managed() {
            ensure!(
                self.archives
                    .reserve_managed_archive(request_id, binding.snapshot())?
                    == archive_id,
                "history_reinterpret_binding_changed"
            );
        }
        let view = HistoryImportJobView {
            job_id: request_id.into(),
            sequence: 0,
            source: source.view.source,
            stage: HistoryImportStage::Normalizing,
            archive_id: Some(archive_id.into()),
            archived: true,
            normalization: None,
            failure_code: None,
            cancel_requested: false,
        };
        let mut job = Job {
            version: 4,
            owner: self.owner.clone(),
            binding: Some(binding.clone()),
            binding_sha256: source.binding_sha256,
            selection: None,
            selection_sha256: None,
            normalization_revision: HISTORY_REINTERPRETATION_REVISION.into(),
            archive_stage_completed: true,
            reinterpreted_from: Some(ReinterpretedSource {
                job_id: source_job_id.into(),
                sequence: expected_source_sequence,
                normalization_revision: source.normalization_revision,
                receipt_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&receipt)?)),
                interpretation_revision: HISTORY_REINTERPRETATION_REVISION.into(),
            }),
            execution_identity: None,
            execution_birth_sha256: None,
            resource_budget: Some(resource_budget),
            view: view.clone(),
        };
        let _execution = self.birth_execution(&mut job, &_runner)?;
        self.save(&job)?;
        // No new projection is initialized until an explicit runner starts.
        Ok(view)
    }

    pub(super) fn validate_reinterpretation(job: &Job) -> Result<()> {
        if let Some(source) = &job.reinterpreted_from {
            valid_id(&source.job_id)?;
            ensure!(
                source.job_id != job.view.job_id
                    && job.archive_stage_completed
                    && job.binding.is_some()
                    && job.view.archived
                    && job.normalization_revision == source.interpretation_revision
                    && source.normalization_revision != source.interpretation_revision
                    && !source.normalization_revision.is_empty()
                    && source.receipt_sha256.len() == 64,
                "history_reinterpret_binding_changed"
            );
        }
        Ok(())
    }

    pub(super) fn validate_reinterpretation_receipt(
        job: &Job,
        receipt: &kcoder_types::external_history::ExternalHistoryReceipt,
    ) -> Result<()> {
        if let Some(source) = &job.reinterpreted_from {
            ensure!(
                source.receipt_sha256
                    == format!("{:x}", Sha256::digest(serde_json::to_vec(receipt)?)),
                "history_reinterpret_archive_changed"
            );
        }
        Ok(())
    }
}
