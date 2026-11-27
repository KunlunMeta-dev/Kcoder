//! Budget observations and explicit increases never replay an archive or clear a cancellation.
use super::*;
use kcoder_state::external_history::lifecycle::resource_budget::{
    ResourceBudgetReference, ResourcePolicyReceipt,
};
use kcoder_types::migration_resource::{
    MigrationResourceBudgetView, MigrationResourceIncreaseReceipt, MigrationResourceLimits,
    MigrationResourceUsage,
};

fn members(batch: &BatchState) -> Vec<String> {
    batch
        .actions
        .iter()
        .filter_map(|action| match &action.action {
            BatchActionKind::History { plan } => Some(plan.history_job_id.clone()),
            _ => None,
        })
        .collect()
}

fn receipt(job_id: &str, value: ResourcePolicyReceipt) -> MigrationResourceIncreaseReceipt {
    MigrationResourceIncreaseReceipt {
        job_id: job_id.into(),
        request_id: value.request_id,
        previous_revision: value.previous_revision,
        revision: value.revision,
        limits: value.limits.into(),
    }
}

fn request_identity(request: &str) -> Result<()> {
    ensure!(
        !request.is_empty()
            && request.len() <= 128
            && request
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "migration_resource_invalid_request"
    );
    Ok(())
}

impl MigrationStore {
    /// Read under the original parent journal lease; no history namespace or group is created.
    pub fn batch_resource_budget(
        &self,
        job_id: &str,
        request_id: Option<&str>,
    ) -> Result<MigrationResourceBudgetView> {
        if let Some(request) = request_id {
            request_identity(request)?;
        }
        let _lease = self.journal_lock(false)?;
        let job = self.load(job_id)?;
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        if !batch
            .sources
            .iter()
            .any(|source| matches!(source, BatchSource::History(_)))
        {
            return Ok(MigrationResourceBudgetView::NotApplicable { job_id: job.job_id });
        }
        let limits = if let Some(limits) = batch.resource_limits.as_ref() {
            limits.clone()
        } else {
            let original = crate::history_jobs::HistoryJobStore::open_existing(&self.profile)?
                .map(|history| history.recorded_batch_resource_budget(job_id, members(batch)))
                .transpose()?
                .flatten();
            let Some(original) = original else {
                return Ok(MigrationResourceBudgetView::LegacyUntracked { job_id: job.job_id });
            };
            original.initial_limits
        };
        let planned = || MigrationResourceBudgetView::Planned {
            job_id: job.job_id.clone(),
            limits: limits.clone().into(),
        };
        let selected_members = members(batch);
        if selected_members.is_empty() {
            return Ok(if batch.actions.is_empty() {
                planned()
            } else {
                MigrationResourceBudgetView::NotApplicable { job_id: job.job_id }
            });
        }
        let Some(history) = crate::history_jobs::HistoryJobStore::open_existing(&self.profile)?
        else {
            return Ok(planned());
        };
        history.verify_batch_parent(&self.directory)?;
        let archives = history.resource_budget_store();
        let Some(original) =
            archives.recorded_resource_budget_for_plan(job_id, selected_members, limits.clone())?
        else {
            return Ok(planned());
        };
        let snapshot = archives.resource_budget_snapshot(&original, request_id)?;
        Ok(MigrationResourceBudgetView::Active {
            job_id: job.job_id,
            limits: snapshot.policy.limits.into(),
            policy_revision: snapshot.policy.revision,
            usage: MigrationResourceUsage {
                reserved_bytes: snapshot.usage.reserved_bytes,
                committed_bytes: snapshot.usage.committed_bytes,
                reserved_files: snapshot.usage.reserved_files,
                committed_files: snapshot.usage.committed_files,
            },
            requested_receipt: snapshot
                .requested_receipt
                .map(|value| receipt(job_id, value)),
        })
    }

    /// This only changes the born accounting policy. Resuming the original job is a separate action.
    pub fn raise_batch_resource_budget(
        &self,
        job_id: &str,
        plan_id: &str,
        request_id: &str,
        expected_revision: u64,
        limits: MigrationResourceLimits,
        consent: bool,
    ) -> Result<MigrationResourceIncreaseReceipt> {
        ensure!(consent, "migration_resource_consent_required");
        request_identity(request_id)?;
        let _lease = self.write_lock()?;
        let job = self.load(job_id)?;
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        ensure!(
            batch.plan_id.as_deref() == Some(plan_id),
            "migration_plan_changed"
        );
        let selected_members = members(batch);
        ensure!(
            !selected_members.is_empty(),
            "migration_resource_not_started"
        );
        let history = crate::history_jobs::HistoryJobStore::open_existing(&self.profile)?
            .context("migration_resource_not_started")?;
        history.verify_batch_parent(&self.directory)?;
        let archives = history.resource_budget_store();
        let baseline = match batch.resource_limits.as_ref() {
            Some(limits) => limits.clone(),
            None => {
                history
                    .recorded_batch_resource_budget(job_id, selected_members.clone())?
                    .context("migration_resource_legacy_untracked")?
                    .initial_limits
            }
        };
        let original: ResourceBudgetReference = archives
            .recorded_resource_budget_for_plan(job_id, selected_members, baseline.clone())?
            .context("migration_resource_not_started")?;
        // A known original intent remains observable after cancellation/rollback. Only a new
        // intent is rejected in those states; no cancellation is acknowledged or removed here.
        if let Some(known) = archives.history_resource_policy_receipt(&original, request_id)? {
            ensure!(
                known.previous_revision == expected_revision && known.limits == limits,
                "history_resource_policy_request_changed"
            );
            return Ok(receipt(job_id, known));
        }
        if job.status == JobStatus::Completed {
            // A completed import can still own live histories and future derived allocations.
            // Raising their existing policy never resumes any batch action or clears cancellation.
            for action in &batch.actions {
                let BatchActionKind::History { plan } = &action.action else {
                    continue;
                };
                ensure!(
                    action.item_ids.len() == 1,
                    "history_resource_binding_changed"
                );
                let BatchSource::History(source) = batch.source_for(&action.item_ids[0])? else {
                    anyhow::bail!("history_resource_binding_changed")
                };
                ensure!(
                    source.identity() == plan.source_fingerprint
                        && source.revision() == plan.normalization_revision,
                    "history_resource_binding_changed"
                );
                history.verify_batch_budget_member(
                    &plan.history_job_id,
                    source.selection(),
                    &plan.normalization_revision,
                    job_id,
                    &original,
                )?;
            }
        }
        ensure!(
            !matches!(
                job.status,
                JobStatus::CancelRequested
                    | JobStatus::Cancelled
                    | JobStatus::RollingBack
                    | JobStatus::RolledBack
                    | JobStatus::RollbackConflict
            ),
            "migration_resource_job_not_mutable"
        );
        Ok(receipt(
            job_id,
            archives.raise_history_resource_budget(
                &original,
                request_id,
                expected_revision,
                limits,
            )?,
        ))
    }
}
