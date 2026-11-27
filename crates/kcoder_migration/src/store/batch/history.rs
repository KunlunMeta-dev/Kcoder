//! Execute an archive child through the normal history pipeline, not an alternate parser.
use super::*;
use anyhow::Context;
use kcoder_types::external_history::HistoryImportStage;
use sha2::Digest;

pub(super) struct PreparedHistoryExecution {
    child: kcoder_types::external_history::HistoryImportJobView,
    execution: crate::history_jobs::HistoryExecutionGuard,
}

impl MigrationStore {
    pub(super) fn publish_history_batch_action(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        plan: &crate::batch::history::HistoryBatchAction,
        targets: &BatchTargets<'_>,
        resuming: bool,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<crate::providers::ProviderPublication> {
        let history = targets
            .history
            .context("migration_history_target_required")?;
        self.publish_history_to_target(job, action, plan, history, resuming, check)
    }

    pub(super) fn publish_history_to_target(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        plan: &crate::batch::history::HistoryBatchAction,
        history: &crate::history_jobs::HistoryJobStore,
        resuming: bool,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<crate::providers::ProviderPublication> {
        let prepared = self.prepare_history_execution(job, action, plan, history, resuming)?;
        self.run_prepared_history(job, action, plan, history, prepared, check)
    }

    pub(super) fn prepare_history_execution(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        plan: &crate::batch::history::HistoryBatchAction,
        history: &crate::history_jobs::HistoryJobStore,
        resuming: bool,
    ) -> Result<PreparedHistoryExecution> {
        history.verify_batch_parent(&self.directory)?;
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        ensure!(action.item_ids.len() == 1, "migration_invalid_journal");
        let BatchSource::History(source) = batch.source_for(&action.item_ids[0])? else {
            anyhow::bail!("migration_invalid_batch_resolution")
        };
        source.validate()?;
        ensure!(
            plan.source_fingerprint == source.identity()
                && plan.normalization_revision == source.revision(),
            "migration_history_batch_binding_changed"
        );
        let (mut child, execution) = if let Some(child) =
            history.observe_selected_snapshot(&plan.history_job_id, source.selection())?
        {
            let execution = history.claim_execution(&child.job_id, child.sequence)?;
            (child, execution)
        } else {
            // Serialize acceptance with parent cancellation, but release the parent before IO.
            let _control = self.batch_write_lock()?;
            let current = self.load(&job.job_id)?;
            ensure!(
                !matches!(
                    current.status,
                    JobStatus::CancelRequested | JobStatus::Cancelled
                ),
                "migration_history_batch_cancelled"
            );
            ensure!(
                plan.normalization_revision
                    == crate::history_normalization::HISTORY_NORMALIZATION_REVISION,
                "migration_history_batch_replan_required"
            );
            history.create_selected_owned(&plan.history_job_id, source.selection().clone())?
        };
        self.prepare_history_resources(job, history)?;
        history.bind_existing_resource_budget_owned(&execution)?;
        history.verify_selected_snapshot(&plan.history_job_id, source.selection())?;
        ensure!(
            history.normalization_revision(&plan.history_job_id)? == plan.normalization_revision,
            "migration_history_batch_adapter_changed"
        );
        if child.stage == HistoryImportStage::Cancelled {
            ensure!(resuming, "migration_history_batch_resume_required");
            child = history.resume_owned(&execution, child.sequence)?;
        } else if child.stage == HistoryImportStage::Failed {
            child = history.resume_owned(&execution, child.sequence)?;
        }
        Ok(PreparedHistoryExecution { child, execution })
    }

    pub(super) fn run_prepared_history(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        plan: &crate::batch::history::HistoryBatchAction,
        history: &crate::history_jobs::HistoryJobStore,
        prepared: PreparedHistoryExecution,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<crate::providers::ProviderPublication> {
        let PreparedHistoryExecution {
            mut child,
            execution,
        } = prepared;
        while child.stage != HistoryImportStage::Normalized {
            child = history.step_owned(&execution, child.sequence, 10, |event| {
                check(BatchRunEvent::History {
                    action_id: &action.action_id,
                    event,
                }) && self.read(&job.job_id).is_ok_and(|current| {
                    !matches!(
                        current.status,
                        JobStatus::CancelRequested
                            | JobStatus::Cancelled
                            | JobStatus::RollingBack
                            | JobStatus::RolledBack
                    )
                })
            })?;
            ensure!(
                child.stage != HistoryImportStage::Cancelled,
                "migration_history_batch_cancelled"
            );
            if child.stage == HistoryImportStage::Failed
                && !child.archived
                && child.failure_code.as_deref().is_some_and(|code| {
                    matches!(
                        code,
                        "history_resource_budget_exceeded"
                            | "history_resource_file_budget_exceeded"
                            | "history_resource_disk_space_insufficient"
                            | "history_resource_disk_nodes_insufficient"
                            | "history_resource_disk_space_unavailable"
                    )
                })
            {
                // These failures precede a new archive allocation. They cannot be mistaken
                // for an unknown publication and automatically rerun with the finished request.
                anyhow::bail!("migration_history_resource_admission_failed");
            }
            ensure!(
                child.stage != HistoryImportStage::Failed,
                "migration_history_batch_failed"
            );
        }
        let receipt = history
            .archive_reader(&child.job_id)?
            .receipt()?
            .context("migration_history_batch_receipt_missing")?;
        let revision = format!(
            "{:x}",
            sha2::Sha256::digest(serde_json::to_vec(&(
                "batch-history-receipt/1",
                &receipt,
                &plan.normalization_revision,
                &child.normalization,
            ))?)
        );
        Ok(crate::providers::ProviderPublication {
            target_id: child.job_id,
            target_revision: revision,
            // Archive data may already be shared. This receipt does not confer deletion authority.
            ownership_confirmed: false,
        })
    }

    pub(super) fn record_history_diagnostics(
        &self,
        job: &mut MigrationJob,
        action: &BatchAction,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        let history_job_id = match &action.action {
            BatchActionKind::History { plan } => &plan.history_job_id,
            BatchActionKind::Reuse { proof } => {
                let Some(id) = &proof.history_job_id else {
                    return Ok(());
                };
                id
            }
            _ => return Ok(()),
        };
        let history = targets
            .history
            .context("migration_history_target_required")?;
        let child = history.read(history_job_id)?;
        if child
            .normalization
            .as_ref()
            .is_some_and(|value| value.records_with_diagnostics > 0)
        {
            for item in &mut job.inventory.items {
                if action.item_ids.contains(&item.preview.id)
                    && !item.preview.issues.iter().any(|issue| {
                        issue.code == kcoder_types::migration::MigrationIssueCode::RequiresReview
                    })
                {
                    item.preview
                        .issues
                        .push(kcoder_types::migration::MigrationIssue {
                            code: kcoder_types::migration::MigrationIssueCode::RequiresReview,
                            severity: kcoder_types::migration::MigrationIssueSeverity::Warning,
                            phase: kcoder_types::migration::MigrationIssuePhase::Activation,
                            field: None,
                        });
                }
            }
        }
        Ok(())
    }
}

impl MigrationStore {
    pub(super) fn undo_history_batch_action(
        &self,
        parent: &MigrationJob,
        action: &BatchAction,
        plan: &crate::batch::history::HistoryBatchAction,
        targets: &BatchTargets<'_>,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<()> {
        use kcoder_state::external_history::lifecycle::ArchiveRetirementPhase;
        let history = targets
            .history
            .context("migration_history_target_required")?;
        history.verify_batch_parent(&self.directory)?;
        let batch = parent.batch.as_ref().context("migration_not_a_batch")?;
        ensure!(action.item_ids.len() == 1, "migration_invalid_journal");
        let BatchSource::History(source) = batch.source_for(&action.item_ids[0])? else {
            anyhow::bail!("migration_invalid_batch_resolution")
        };
        let receipt = parent
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == action.action_id)
            .context("migration_commit_receipt_required")?;
        ensure!(
            receipt.target_id == plan.history_job_id
                && source.identity() == plan.source_fingerprint
                && source.revision() == plan.normalization_revision,
            "migration_history_batch_binding_changed"
        );
        history.verify_selected_snapshot(&plan.history_job_id, source.selection())?;
        ensure!(
            history.normalization_revision(&plan.history_job_id)? == plan.normalization_revision,
            "migration_history_batch_adapter_changed"
        );
        let child = history.read(&plan.history_job_id)?;
        let existing = history.retirement_for_job(&plan.history_job_id)?;
        if existing.as_ref().is_none_or(|view| !view.logical_retired) {
            let archived = history
                .archive_reader(&plan.history_job_id)?
                .receipt()?
                .context("migration_history_batch_receipt_missing")?;
            let revision = format!(
                "{:x}",
                sha2::Sha256::digest(serde_json::to_vec(&(
                    "batch-history-receipt/1",
                    &archived,
                    &plan.normalization_revision,
                    &child.normalization,
                ))?)
            );
            ensure!(
                revision == receipt.target_revision,
                "migration_target_changed"
            );
        }
        let prepared = if let Some(existing) = existing {
            existing
        } else {
            let digest = sha2::Sha256::digest(serde_json::to_vec(&(
                "batch-history-retirement/1",
                &parent.job_id,
                &action.action_id,
                &plan.history_job_id,
                &receipt.target_revision,
            ))?);
            let mut bytes = [0; 16];
            bytes.copy_from_slice(&digest[..16]);
            let operation = uuid::Uuid::from_bytes(bytes).to_string();
            match history.prepare_retirement(&operation, &plan.history_job_id, child.sequence) {
                Ok(view) => view,
                Err(error) if error.to_string() == "history_job_retirement_legacy_retained" => {
                    anyhow::bail!("migration_history_retirement_retained")
                }
                Err(error) => return Err(error),
            }
        };
        let retired = history.run_retirement(&prepared.operation_id, prepared.sequence, || {
            check(BatchRunEvent::Checkpoint)
        })?;
        if matches!(retired.phase, ArchiveRetirementPhase::Collected)
            || matches!(retired.phase, ArchiveRetirementPhase::Retired) && !retired.owns_archive
        {
            return Ok(());
        }
        if retired.retained_references > 0
            || retired.failure_code.as_deref().is_some_and(|code| {
                matches!(
                    code,
                    "external_history_retirement_referenced"
                        | "external_history_retirement_readers_busy"
                )
            })
        {
            anyhow::bail!("migration_result_referenced");
        }
        if matches!(retired.phase, ArchiveRetirementPhase::Blocked) && !retired.logical_retired {
            if retired.failure_code.as_deref() == Some("external_history_lifecycle_changed") {
                anyhow::bail!("migration_target_changed");
            }
            anyhow::bail!("migration_history_retirement_retained");
        }
        anyhow::bail!("migration_history_retirement_pending")
    }
}
