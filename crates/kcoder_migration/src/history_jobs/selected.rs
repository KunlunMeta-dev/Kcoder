//! Selection acceptance is metadata-only; capture belongs to a cancellable leased stage.
use super::*;

impl HistoryJobStore {
    pub(crate) fn verify_batch_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        parent.verify_private_directory()?;
        let expected = parent.open_child(OsStr::new("history"), false)?;
        expected.verify_private_directory()?;
        self.directory.verify_private_directory()?;
        ensure!(
            expected.directory_identity()? == self.directory.directory_identity()?,
            "migration_wrong_target"
        );
        Ok(())
    }
    pub(crate) fn observe_selected_snapshot(
        &self,
        job_id: &str,
        selection: &HistoryPendingSelection,
    ) -> Result<Option<HistoryImportJobView>> {
        let Some(job) = self.load_optional(job_id)? else {
            return Ok(None);
        };
        ensure!(
            job.selection_sha256.as_deref()
                == Some(format!("{:x}", Sha256::digest(serde_json::to_vec(selection)?)).as_str()),
            "history_job_request_conflict"
        );
        Ok(Some(self.observe(job)?))
    }
    pub(crate) fn verify_selected_snapshot(
        &self,
        job_id: &str,
        selection: &HistoryPendingSelection,
    ) -> Result<()> {
        let job = self.load(job_id)?;
        ensure!(
            job.selection_sha256.as_deref()
                == Some(format!("{:x}", Sha256::digest(serde_json::to_vec(selection)?)).as_str()),
            "history_job_request_conflict"
        );
        Ok(())
    }
    pub fn create_selected(
        &self,
        request_id: &str,
        selection: HistoryPendingSelection,
    ) -> Result<HistoryImportJobView> {
        self.create_selected_with_resource_limits(request_id, selection, None)
    }

    pub fn create_selected_with_resource_limits(
        &self,
        request_id: &str,
        selection: HistoryPendingSelection,
        resource_limits: Option<kcoder_types::migration_resource::MigrationResourceLimits>,
    ) -> Result<HistoryImportJobView> {
        self.create_selected_inner(request_id, selection, false, resource_limits)
            .map(|(view, _)| view)
    }

    pub(crate) fn create_selected_owned(
        &self,
        request_id: &str,
        selection: HistoryPendingSelection,
    ) -> Result<(HistoryImportJobView, HistoryExecutionGuard)> {
        let (view, guard) = self.create_selected_inner(request_id, selection, true, None)?;
        Ok((
            view,
            guard.context("history_job_execution_recovery_required")?,
        ))
    }

    fn create_selected_inner(
        &self,
        request_id: &str,
        selection: HistoryPendingSelection,
        retain_execution: bool,
        resource_limits: Option<kcoder_types::migration_resource::MigrationResourceLimits>,
    ) -> Result<(HistoryImportJobView, Option<HistoryExecutionGuard>)> {
        valid_id(request_id)?;
        selection.verify_history_directory(&self.directory)?;
        let _lock = self.lock("catalog.lock")?;
        if let Some(job) = self.load_optional(request_id)? {
            let identity = selection.selection_identity()?;
            ensure!(
                job.selection
                    .as_ref()
                    .map(HistoryPendingSelection::selection_identity)
                    .transpose()?
                    .as_deref()
                    == Some(identity.as_str()),
                "history_job_request_conflict"
            );
            if let Some(limits) = resource_limits {
                ensure!(
                    job.resource_budget
                        .as_ref()
                        .is_some_and(|budget| budget.initial_limits == limits),
                    "history_resource_initial_limits_changed"
                );
            }
            let view = self.observe(job)?;
            let execution = retain_execution
                .then(|| self.claim_execution(request_id, view.sequence))
                .transpose()?;
            return Ok((view, execution));
        }
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
        let _run = self.lock(&format!("{request_id}.run.lock"))?;
        let resource_budget = if retain_execution {
            None
        } else {
            Some(self.birth_standalone_resource_budget(
                request_id,
                &selection.selection_identity()?,
                resource_limits,
                resources::HistoryBudgetStorage::Managed,
            )?)
        };
        let view = HistoryImportJobView {
            job_id: request_id.into(),
            sequence: 0,
            source: selection.source(),
            stage: HistoryImportStage::Capturing,
            archive_id: None,
            archived: false,
            normalization: None,
            failure_code: None,
            cancel_requested: false,
        };
        let mut job = Job {
            version: if resource_budget.is_some() { 4 } else { 3 },
            owner: self.owner.clone(),
            binding: None,
            binding_sha256: String::new(),
            selection_sha256: Some(format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&selection)?)
            )),
            selection: Some(selection),
            normalization_revision: HISTORY_NORMALIZATION_REVISION.into(),
            archive_stage_completed: false,
            reinterpreted_from: None,
            execution_identity: None,
            execution_birth_sha256: None,
            resource_budget,
            view: view.clone(),
        };
        let execution = self.birth_execution(&mut job, &_run)?;
        self.save(&job)?;
        Ok((view, retain_execution.then_some(execution)))
    }

    pub(super) fn valid_source(job: &Job) -> Result<bool> {
        let selected_valid = match &job.selection {
            Some(selection) => {
                matches!(job.version, 2..=4)
                    && job.view.source == selection.source()
                    && job.selection_sha256.as_deref()
                        == Some(
                            format!("{:x}", Sha256::digest(serde_json::to_vec(selection)?))
                                .as_str(),
                        )
            }
            None => job.selection_sha256.is_none(),
        };
        Ok(selected_valid
            && match &job.binding {
                Some(binding) => {
                    job.view.source == binding.snapshot().origin.source
                        && job.view.stage != HistoryImportStage::Capturing
                        && if job.managed() {
                            job.view.archive_id.as_deref().is_some_and(|id| {
                                id.strip_prefix("archive-").is_some_and(|digest| {
                                    digest.len() == 64
                                        && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                                })
                            })
                        } else {
                            job.view.archive_id.as_deref()
                                == Some(
                                    ExternalHistoryStore::archive_id_for_snapshot(
                                        binding.snapshot(),
                                    )?
                                    .as_str(),
                                )
                        }
                        && job.binding_sha256
                            == format!("{:x}", Sha256::digest(serde_json::to_vec(binding)?))
                        && job
                            .selection
                            .as_ref()
                            .is_none_or(|selection| selection.matches_binding(binding))
                }
                None => {
                    job.selection.is_some()
                        && job.binding_sha256.is_empty()
                        && !job.archive_stage_completed
                        && !job.view.archived
                        && job.view.archive_id.is_none()
                        && job.view.normalization.is_none()
                        && matches!(
                            job.view.stage,
                            HistoryImportStage::Capturing
                                | HistoryImportStage::Cancelled
                                | HistoryImportStage::Failed
                        )
                }
            })
    }

    pub(super) fn step_capture(
        &self,
        mut job: Job,
        mut check: impl FnMut(HistoryImportEvent) -> bool,
    ) -> Result<HistoryImportJobView> {
        job.view.stage = HistoryImportStage::Capturing;
        self.advance(&mut job)?;
        let mut cancelled = false;
        let mut control_error = false;
        let result = job
            .selection
            .as_ref()
            .context("history_job_binding_missing")?
            .capture(&mut |processed_bytes, total_bytes| {
                self.allow_step(&job.view.job_id, &mut cancelled, &mut control_error, || {
                    check(HistoryImportEvent::Capture {
                        processed_bytes,
                        total_bytes,
                    })
                })
            });
        match result {
            Ok(binding) => {
                job.view.archive_id = Some(if job.managed() {
                    self.archives
                        .reserve_managed_archive(&job.view.job_id, binding.snapshot())?
                } else {
                    ExternalHistoryStore::archive_id_for_snapshot(binding.snapshot())?
                });
                job.binding_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&binding)?));
                job.binding = Some(binding);
                job.view.stage = HistoryImportStage::Planned;
                job.view.failure_code = None;
            }
            Err(error) => {
                job.view.stage = if cancelled && !control_error {
                    HistoryImportStage::Cancelled
                } else {
                    HistoryImportStage::Failed
                };
                job.view.failure_code = if control_error {
                    Some("history_job_invalid_control".into())
                } else {
                    (!cancelled).then(|| failure_code(&error))
                };
            }
        }
        self.persist_observed(job)
    }
}
