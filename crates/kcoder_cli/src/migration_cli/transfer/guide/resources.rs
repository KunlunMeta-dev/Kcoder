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
                "已核对原提高请求回执。再次提高是新的用户选择，不会恢复或重放作业。",
            )?;
        }
        let params = if let Some(original) = previous.filter(|_| view.requested_receipt().is_none())
        {
            ensure!(self.io.yes("transfer_resource_retry","原提高请求尚无权威回执。是否仅用保存的原UUID、原额度和原policy CAS做幂等核对？不会换身份或自动恢复作业。")?,"migration_transfer_confirmation_required");
            original
        } else {
            let MigrationResourceBudgetView::Active {
                limits,
                policy_revision,
                ..
            } = view
            else {
                self.io.notice("migration_resource_budget_not_active","该作业没有可调整的已计费预算；legacy/不适用/仅计划状态不会伪报剩余0或自动升级。")?;
                return Ok(());
            };
            let max_total_bytes = self.io.number(
                "transfer_resource_bytes",
                "明确总字节上限（bytes）；必须不少于原值，单文件/解码/媒体等硬边界仍独立生效。",
                Some(limits.max_total_bytes),
            )?;
            let max_payload_files = self.io.number(
                "transfer_resource_files",
                "明确payload文件数上限；必须不少于原值。",
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
            ensure!(self.io.yes("transfer_resource_confirm","确认此原生作业预算提高？磁盘余量保留不降低，来源/路径权限不扩大；之后须另行明确resume，不会自动启动解析或模型。")?,"migration_transfer_confirmation_required");
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
