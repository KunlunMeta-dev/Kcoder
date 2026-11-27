//! Public observation and explicit controls never infer completion from a dropped transport.
use super::*;

impl Guide {
    pub(super) async fn reconnect(&mut self, paired: bool) -> Result<()> {
        self.scope(paired).await?;
        ensure!(
            !paired
                || self.draft.copy_prepared
                || self.draft.instruction_capture.is_none()
                    && self
                        .draft
                        .source_views
                        .as_ref()
                        .is_none_or(|views| !views.discovery_started && views.directory.is_none()),
            "migration_transfer_source_reselection_required"
        );
        ensure!(self.io.yes("transfer_reconnect","Establish a new owned connection under the same target and account scope? Only connection leases are updated; original requestId/adoptionId/checkpoints are preserved. Old-account connections are not taken over or closed.")?,"migration_transfer_confirmation_required");
        self.draft.recovery.session_id = uuid::Uuid::new_v4().to_string();
        if paired {
            self.draft.source.session_id = uuid::Uuid::new_v4().to_string();
            self.draft.target.session_id = uuid::Uuid::new_v4().to_string();
        }
        self.save()?;
        self.io.notice(
            "migration_transfer_connection_selected",
            "Connection identity is fixed. Read its original receipt before explicitly resuming; data selections and business operation identities were not replaced.",
        )
    }
    pub(super) async fn session(
        &mut self,
        role: MigrationSourceSessionPurpose,
    ) -> Result<MigrationSourceSessionParams> {
        self.scope(role == MigrationSourceSessionPurpose::Source)
            .await?;
        let mut session = match role {
            MigrationSourceSessionPurpose::Source => self.draft.source.clone(),
            MigrationSourceSessionPurpose::Target => self.draft.target.clone(),
            MigrationSourceSessionPurpose::TargetRecovery => self.draft.recovery.clone(),
        };
        let state: MigrationSourceSessionStateResult =
            self.post("source-session", "read", &session).await?;
        if state.status == MigrationSourceSessionState::Ready {
            return Ok(session);
        }
        ensure!(
            !state.launching && state.owned_children == 0,
            "source_transfer_session_busy"
        );
        if role == MigrationSourceSessionPurpose::Source {
            ensure!(
                self.draft.instruction_capture.is_none()
                    && self
                        .draft
                        .source_views
                        .as_ref()
                        .is_none_or(|views| !views.discovery_started && views.directory.is_none())
                    || self.draft.copy_prepared,
                "migration_transfer_source_reselection_required"
            );
        }
        session.session_id = uuid::Uuid::new_v4().to_string();
        match role {
            MigrationSourceSessionPurpose::Source => {
                self.draft.source = session.clone();
                if let Some(views) = &mut self.draft.source_views
                    && !views.discovery_started
                    && views.directory.is_none()
                {
                    views.session_id = session.session_id.clone();
                }
            }
            MigrationSourceSessionPurpose::Target => self.draft.target = session.clone(),
            MigrationSourceSessionPurpose::TargetRecovery => self.draft.recovery = session.clone(),
        };
        self.save()?;
        self.scope(role == MigrationSourceSessionPurpose::Source)
            .await?;
        let open: MigrationSourceSessionOpenParams =
            serde_json::from_value(serde_json::to_value(&session)?)?;
        let state: MigrationSourceSessionStateResult =
            self.post("source-session", "open", &open).await?;
        ensure!(
            state.status == MigrationSourceSessionState::Ready
                && !state.launching
                && state.owned_children > 0,
            "source_transfer_session_busy"
        );
        Ok(session)
    }
    pub(super) async fn select(&mut self) -> Result<()> {
        ensure!(
            !self.draft.copy_prepared,
            "migration_transfer_selection_frozen_read_original"
        );
        let session = self.session(MigrationSourceSessionPurpose::Source).await?;
        self.prepare_directory(&session).await?;
        let selected = self.choose_source_views(&session).await?;
        self.scope(true).await?;
        self.draft.selections = selected;
        self.save()?;
        self.io.state(
            "transfer_selection",
            &json!({"selected":self.draft.selections.len(),"requestId":self.draft.request_id}),
        )
    }
    fn pair(&self) -> MigrationSourceTransferReadParams {
        MigrationSourceTransferReadParams {
            request_id: self.draft.request_id.clone(),
            source: self.draft.source.clone(),
            target: self.draft.target.clone(),
        }
    }
    async fn read_pair(&self) -> Result<MigrationSourceTransferResult> {
        self.scope(true).await?;
        let result: MigrationSourceTransferResult =
            self.post("source-transfer", "read", &self.pair()).await?;
        validation::observation(&result, &self.draft.request_id)?;
        self.scope(true).await?;
        Ok(result)
    }
    pub(super) fn remember(&mut self, result: &MigrationSourceTransferResult) -> Result<()> {
        self.io.state("transfer_state", result)?;
        let receipt = match &result.result {
            MigrationSourceNullable::Value(MigrationSourceTransferObservation::Paired(value)) => {
                &value.receipt
            }
            MigrationSourceNullable::Value(MigrationSourceTransferObservation::Target(value)) => {
                &value.receipt
            }
            _ => return Ok(()),
        };
        if let MigrationSourceNullable::Value(receipt) = receipt {
            ensure!(
                self.draft
                    .manifest_sha256
                    .as_ref()
                    .is_none_or(|old| old == &receipt.manifest_sha256),
                "migration_transfer_receipt_changed"
            );
            self.draft.manifest_sha256 = Some(receipt.manifest_sha256.clone());
            self.save()?;
        }
        Ok(())
    }
    pub(super) async fn read_target(
        &mut self,
        show: bool,
    ) -> Result<MigrationSourceTransferResult> {
        let target = self
            .session(MigrationSourceSessionPurpose::TargetRecovery)
            .await?;
        let result: MigrationSourceTransferResult = self
            .post(
                "source-transfer",
                "target-read",
                &MigrationSourceTransferTargetReadParams {
                    request_id: self.draft.request_id.clone(),
                    target,
                },
            )
            .await?;
        validation::observation(&result, &self.draft.request_id)?;
        self.scope(false).await?;
        if show {
            self.remember(&result)?;
        }
        Ok(result)
    }
    pub(super) async fn copy(&mut self, retry: bool) -> Result<()> {
        ensure!(
            !self.draft.selections.is_empty(),
            "migration_transfer_no_sources_selected"
        );
        if self.draft.copy_prepared && !retry {
            self.read_target(true).await?;
            return self.io.notice(
                "migration_transfer_request_already_prepared",
                "The request is fixed. Check its original receipt first; use retry or resume when explicitly needed, without creating a replacement request.",
            );
        }
        self.session(MigrationSourceSessionPurpose::Source).await?;
        self.session(MigrationSourceSessionPurpose::Target).await?;
        if retry {
            let result = self.read_pair().await?;
            self.remember(&result)?;
            if ready(&result) {
                return Ok(());
            }
        }
        ensure!(self.io.yes("transfer_copy_confirm","Transfer explicitly selected data? Only archives and static content are received; target configuration is not published by this action. Saved request and attempt identities are reused.")?,"migration_transfer_confirmation_required");
        self.scope(true).await?;
        self.draft.copy_prepared = true;
        self.save()?;
        let params = MigrationSourceTransferRunParams {
            request_id: self.draft.request_id.clone(),
            attempt_id: self.draft.attempt_id.clone(),
            source: self.draft.source.clone(),
            target: self.draft.target.clone(),
            selections: if self.draft.resume.is_some() {
                None
            } else {
                Some(self.draft.selections.clone())
            },
            resume: self.draft.resume.clone(),
        };
        let result: MigrationSourceTransferResult =
            self.post("source-transfer", "run", &params).await?;
        validation::observation(&result, &self.draft.request_id)?;
        self.remember(&result)?;
        self.wait_copy(result).await
    }
    async fn wait_copy(&mut self, mut result: MigrationSourceTransferResult) -> Result<()> {
        let deadline = std::time::Instant::now() + Duration::from_secs(300);
        while result.coordinator_state == MigrationSourceCoordinatorState::Running
            && std::time::Instant::now() < deadline
        {
            self.io.active()?;
            tokio::time::sleep(Duration::from_millis(500)).await;
            result = self.read_pair().await?;
            self.remember(&result)?;
        }
        if ready(&result) {
            self.io.notice(
                "migration_transfer_received",
                "The Native receipt confirms data was received. Adoption previews and target publication still require explicit selection and confirmation.",
            )?;
        }
        Ok(())
    }
    pub(super) async fn cancel_copy(&mut self) -> Result<()> {
        ensure!(
            self.draft.copy_prepared,
            "migration_transfer_request_not_prepared"
        );
        ensure!(
            self.io.yes(
                "transfer_cancel_confirm",
                "Cancel the original transfer? Confirmed receipts or published content are not undone automatically."
            )?,
            "migration_transfer_confirmation_required"
        );
        self.scope(true).await?;
        let command_id = self
            .draft
            .cancel_command_id
            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        self.save()?;
        let result: MigrationSourceTransferResult = self
            .post(
                "source-transfer",
                "cancel",
                &MigrationSourceTransferCancelParams {
                    request_id: self.draft.request_id.clone(),
                    command_id,
                    source: self.draft.source.clone(),
                    target: self.draft.target.clone(),
                },
            )
            .await?;
        validation::observation(&result, &self.draft.request_id)?;
        self.remember(&result)
    }
    pub(super) async fn resume_copy(&mut self) -> Result<()> {
        ensure!(
            self.draft.copy_prepared,
            "migration_transfer_request_not_prepared"
        );
        self.session(MigrationSourceSessionPurpose::Source).await?;
        self.session(MigrationSourceSessionPurpose::Target).await?;
        let observed = self.read_pair().await?;
        self.remember(&observed)?;
        if ready(&observed) {
            return Ok(());
        }
        ensure!(
            observed.coordinator_state != MigrationSourceCoordinatorState::Running,
            "source_transfer_busy"
        );
        let MigrationSourceNullable::Value(MigrationSourceTransferObservation::Paired(value)) =
            observed.result
        else {
            anyhow::bail!("source_transfer_outcome_unknown")
        };
        ensure!(!value.target_worker_running, "source_transfer_busy");
        let MigrationSourceTransferObservedControl::Present(source) = value.source_state else {
            anyhow::bail!("source_transfer_outcome_unknown")
        };
        let MigrationSourceTransferObservedControl::Present(admission) =
            value.target_admission_control
        else {
            anyhow::bail!("source_transfer_outcome_unknown")
        };
        ensure!(self.io.yes("transfer_resume_confirm","Resume the same transfer using the Native progress just read? Keep the original requestId; only this explicit resume gets a new attempt identity.")?,"migration_transfer_confirmation_required");
        self.draft.resume = Some(MigrationSourceTransferResume {
            source: Some(MigrationSourceTransferSourceResume {
                sequence: source.sequence,
                cancel_watermark: source.cancel_watermark,
                snapshot_control: value.source_snapshot_control,
            }),
            target: Some(MigrationSourceTransferTargetResume {
                sequence: match &value.target_state {
                    MigrationSourceTransferObservedControl::Present(v) => Some(v.sequence),
                    _ => None,
                },
                cancel_watermark: match &value.target_state {
                    MigrationSourceTransferObservedControl::Present(v) => Some(v.cancel_watermark),
                    _ => None,
                },
                admission_control: admission,
            }),
        });
        self.draft.attempt_id = uuid::Uuid::new_v4().to_string();
        self.draft.cancel_command_id = None;
        self.save()?;
        self.copy(true).await
    }
    pub(super) async fn release(&mut self) -> Result<()> {
        ensure!(self.io.yes("transfer_release_confirm","Release the source, target and recovery connections owned by this record? Active work may be interrupted. Retain records and Native checkpoints; this does not declare cancellation or completion.")?,"migration_transfer_confirmation_required");
        self.scope(false).await?;
        for session in [&self.draft.source, &self.draft.target, &self.draft.recovery] {
            let result: Result<MigrationSourceSessionCloseResult> =
                self.post("source-session", "close", session).await;
            match result {
                Ok(result) => self.io.state("connection_release", &result)?,
                Err(error) => self.io.notice(
                    &safe_error(&error),
                    "Release of owned connections is not confirmed; the record was not cleared.",
                )?,
            }
        }
        Ok(())
    }
}
fn ready(result: &MigrationSourceTransferResult) -> bool {
    match &result.result {
        MigrationSourceNullable::Value(MigrationSourceTransferObservation::Paired(value)) => {
            value.phase == MigrationSourceTransferPhase::Ready
                && matches!(value.receipt, MigrationSourceNullable::Value(_))
                && !value.target_worker_running
                && result.coordinator_state != MigrationSourceCoordinatorState::Running
        }
        MigrationSourceNullable::Value(MigrationSourceTransferObservation::Target(value)) => {
            value.phase == MigrationSourceTransferPhase::Ready
                && matches!(value.receipt, MigrationSourceNullable::Value(_))
                && !value.target_worker_running
                && result.coordinator_state != MigrationSourceCoordinatorState::Running
        }
        _ => false,
    }
}
