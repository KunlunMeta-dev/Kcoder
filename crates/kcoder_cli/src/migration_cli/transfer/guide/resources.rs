//! Explicit target quota changes retain their original request, policy CAS and receipt.
use super::*;

fn job_of(view: &MigrationResourceBudgetView) -> &str {
    match view {
        MigrationResourceBudgetView::NotApplicable { job_id }
        | MigrationResourceBudgetView::LegacyUntracked { job_id }
        | MigrationResourceBudgetView::Planned { job_id, .. }
        | MigrationResourceBudgetView::Active { job_id, .. } => job_id,
    }
}

impl Guide {
    async fn resource_read(
        &self,
        client: &mut runtime::Client,
        job: &str,
        request_id: Option<String>,
    ) -> Result<MigrationResourceBudgetView> {
        client.require(CAPABILITY_MIGRATION_RESOURCE_BUDGET_V1)?;
        let result: MigrationResourceBudgetView = self
            .rpc(
                client,
                method::MIGRATION_BATCH_RESOURCES_READ,
                &MigrationResourceBudgetReadParams {
                    job_id: job.into(),
                    request_id: request_id.clone(),
                },
            )
            .await?;
        ensure!(job_of(&result) == job, "migration_remote_invalid_response");
        if let Some(receipt) = result.requested_receipt() {
            ensure!(
                receipt.job_id == job && Some(&receipt.request_id) == request_id.as_ref(),
                "migration_remote_invalid_response"
            );
        }
        self.io.state("resource_budget", &result)?;
        Ok(result)
    }
    pub(super) async fn resource_budget(
        &self,
        client: &mut runtime::Client,
        job: &str,
    ) -> Result<()> {
        self.resource_read(
            client,
            job,
            self.draft
                .resource_increases
                .get(job)
                .map(|intent| intent.request_id.clone()),
        )
        .await?;
        Ok(())
    }
    pub(super) async fn resource_increase(
        &mut self,
        client: &mut runtime::Client,
        job: &str,
        state: &MigrationBatchStateResult,
    ) -> Result<()> {
        ensure!(!state.worker_running, "source_transfer_busy");
        let previous = self.draft.resource_increases.get(job).cloned();
        let view = self
            .resource_read(
                client,
                job,
                previous.as_ref().map(|intent| intent.request_id.clone()),
            )
            .await?;
        if let (Some(previous), Some(receipt)) = (&previous, view.requested_receipt()) {
            check_receipt(previous, receipt)?;
            self.io.notice(
                "migration_resource_original_receipt",
                "The original increase request receipt has been checked. A further increase is a new user choice; it does not resume or replay jobs.",
            )?;
        }
        let params = if let Some(original) = previous.filter(|_| view.requested_receipt().is_none())
        {
            ensure!(self.io.yes("transfer_resource_retry","The original increase request has no authoritative receipt yet. Idempotently check only the saved original UUID, limits and policy CAS? No identity replacement or automatic job resume.")?,"migration_transfer_confirmation_required");
            original
        } else {
            let MigrationResourceBudgetView::Active {
                limits,
                policy_revision,
                ..
            } = view
            else {
                self.io.notice("migration_resource_budget_not_active","This job has no adjustable billed budget. Legacy/inapplicable/plan-only states do not falsely report zero remaining or automatically upgrade.")?;
                return Ok(());
            };
            let max_total_bytes = self.io.number(
                "transfer_resource_bytes",
                "Explicit total byte limit (bytes); it must not be below the original value. Per-file/decoding/media hard limits still apply independently.",
                Some(limits.max_total_bytes),
            )?;
            let max_payload_files = self.io.number(
                "transfer_resource_files",
                "Explicit payload file count limit; it must not be below the original value.",
                Some(u64::from(limits.max_payload_files)),
            )?;
            let desired = MigrationResourceLimits {
                max_total_bytes,
                max_payload_files: u32::try_from(max_payload_files)
                    .map_err(|_| anyhow::anyhow!("migration_resource_invalid_limits"))?,
                min_free_bytes: limits.min_free_bytes,
                min_free_file_nodes: limits.min_free_file_nodes,
            };
            ensure!(
                desired.is_supported()
                    && desired.max_total_bytes >= limits.max_total_bytes
                    && desired.max_payload_files >= limits.max_payload_files,
                "migration_resource_invalid_limits"
            );
            let params = MigrationResourceIncreaseParams {
                job_id: job.into(),
                plan_id: state
                    .state
                    .batch
                    .as_ref()
                    .and_then(|batch| batch.plan_id.clone())
                    .ok_or_else(|| anyhow::anyhow!("migration_transfer_preview_required"))?,
                request_id: uuid::Uuid::new_v4().to_string(),
                expected_policy_revision: policy_revision,
                limits: desired,
                confirm: true,
            };
            self.io.state("resource_increase_intent", &params)?;
            ensure!(self.io.yes("transfer_resource_confirm","Increase this Native job budget? Reserved disk headroom is not reduced and source/path permissions are not expanded. Explicit resume is required afterward; parsing and models do not start automatically.")?,"migration_transfer_confirmation_required");
            self.draft
                .resource_increases
                .insert(job.into(), params.clone());
            self.save()?;
            params
        };
        let receipt: MigrationResourceIncreaseReceipt = self
            .rpc(client, method::MIGRATION_BATCH_RESOURCES_INCREASE, &params)
            .await?;
        check_receipt(&params, &receipt)?;
        self.io.state("resource_increase_receipt", &receipt)
    }
}
fn check_receipt(
    params: &MigrationResourceIncreaseParams,
    receipt: &MigrationResourceIncreaseReceipt,
) -> Result<()> {
    ensure!(
        receipt.job_id == params.job_id
            && receipt.request_id == params.request_id
            && receipt.previous_revision == params.expected_policy_revision
            && receipt.revision
                == receipt
                    .previous_revision
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("migration_remote_invalid_response"))?
            && receipt.limits == params.limits.clone().into(),
        "migration_remote_invalid_response"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_quota_reply_cannot_claim_another_request_or_silently_change_the_original_limits() {
        let params = MigrationResourceIncreaseParams {
            job_id: "mig-owned".into(),
            plan_id: "plan-owned".into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            expected_policy_revision: 3,
            limits: MigrationResourceLimits::default(),
            confirm: true,
        };
        let mut receipt = MigrationResourceIncreaseReceipt {
            job_id: params.job_id.clone(),
            request_id: params.request_id.clone(),
            previous_revision: 3,
            revision: 4,
            limits: params.limits.clone().into(),
        };
        check_receipt(&params, &receipt).unwrap();
        receipt.request_id = uuid::Uuid::new_v4().to_string();
        assert!(check_receipt(&params, &receipt).is_err());
        receipt.request_id = params.request_id.clone();
        receipt.limits.max_total_bytes += 1;
        assert!(check_receipt(&params, &receipt).is_err());
    }
}
