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
                "Native confirmed all chunks are complete. Verify and finish the original request on the target only? The source is not connected and configuration is not declared published."
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
                "Request cancellation of receipt on the original target only? Source state remains unknown and confirmed results are not automatically undone."
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
                "Resume target receipt using the Native progress just read? The source is not connected; missing chunks will not be reported as complete."
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
