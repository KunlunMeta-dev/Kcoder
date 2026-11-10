//! Target recovery controls never reconnect or claim to observe the source machine.
use super::*;
impl Guide {
    pub(super) async fn target_finish(&mut self) -> Result<()> {
        let observed = self.read_target(true).await?;
        let MigrationSourceNullable::Value(MigrationSourceTransferObservation::Target(state)) =
            observed.result
        else {
            anyhow::bail!("source_transfer_outcome_unknown")
        };
        if let MigrationSourceNullable::Value(_) = state.receipt {
            return Ok(());
        }
        ensure!(
            !state.target_worker_running
                && matches!(&state.progress,MigrationSourceNullable::Value(progress) if progress.parts_complete),
            "source_transfer_parts_incomplete"
        );
        ensure!(
            self.io.yes(
                "transfer_target_finish",
                "原生已确认分片完整。是否仅在目标核验并完成原请求？不连接来源，不宣布配置已发布。"
            )?,
            "migration_transfer_confirmation_required"
        );
        let attempt_id = self
            .draft
            .target_finish_attempt
            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        self.save()?;
        self.scope(false).await?;
        let result: MigrationSourceTransferResult = self
            .post(
                "source-transfer",
                "target-finish",
                &MigrationSourceTransferTargetFinishParams {
                    request_id: self.draft.request_id.clone(),
                    target: self.draft.recovery.clone(),
                    attempt_id,
                },
            )
            .await?;
        validation::observation(&result, &self.draft.request_id)?;
        self.remember(&result)
    }
    pub(super) async fn target_cancel(&mut self) -> Result<()> {
        self.read_target(true).await?;
        ensure!(
            self.io.yes(
                "transfer_target_cancel",
                "是否只向原目标请求取消接收？来源状态仍未知，已确认结果不自动撤销。"
            )?,
            "migration_transfer_confirmation_required"
        );
        let command_id = self
            .draft
            .target_cancel_id
            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        self.save()?;
        self.scope(false).await?;
        let result: MigrationSourceTransferResult = self
            .post(
                "source-transfer",
                "target-cancel",
                &MigrationSourceTransferTargetCancelParams {
                    request_id: self.draft.request_id.clone(),
                    target: self.draft.recovery.clone(),
                    command_id,
                },
            )
            .await?;
        validation::observation(&result, &self.draft.request_id)?;
        self.remember(&result)
    }
    pub(super) async fn target_resume(&mut self) -> Result<()> {
        let observed = self.read_target(true).await?;
        let MigrationSourceNullable::Value(MigrationSourceTransferObservation::Target(state)) =
            observed.result
        else {
            anyhow::bail!("source_transfer_outcome_unknown")
        };
        ensure!(!state.target_worker_running, "source_transfer_busy");
        let MigrationSourceTransferObservedControl::Present(admission) =
            state.target_admission_control
        else {
            anyhow::bail!("source_transfer_outcome_unknown")
        };
        ensure!(
            self.io.yes(
                "transfer_target_resume",
                "是否按刚读到的原生水位恢复目标接收？不连接来源；仍缺分片时不会假称完成。"
            )?,
            "migration_transfer_confirmation_required"
        );
        let params = MigrationSourceTransferTargetResumeParams {
            request_id: self.draft.request_id.clone(),
            target: self.draft.recovery.clone(),
            attempt_id: uuid::Uuid::new_v4().to_string(),
            expected_admission_control: admission,
            expected_operation_control: state.target_state,
        };
        self.draft.target_resume = Some(params.clone());
        self.draft.target_cancel_id = None;
        self.save()?;
        self.scope(false).await?;
        let result: MigrationSourceTransferResult = self
            .post("source-transfer", "target-resume", &params)
            .await?;
        validation::observation(&result, &self.draft.request_id)?;
        self.remember(&result)
    }
}
