use super::*;

impl Guide {
    pub(super) async fn private_read(
        &mut self,
        job: &str,
        source_only: bool,
    ) -> Result<MigrationSourceCredentialResult> {
        let mut locator = self.private_locator(job)?;
        let result: MigrationSourceCredentialResult = if source_only {
            let source = self.session(MigrationSourceSessionPurpose::Source).await?;
            self.scope(true).await?;
            self.private_post(
                "source-read",
                &MigrationSourceCredentialSourceReadParams {
                    locator: locator.clone(),
                    source,
                },
            )
            .await?
        } else {
            locator.target = self
                .session(MigrationSourceSessionPurpose::TargetRecovery)
                .await?;
            self.private_post("read", &locator).await?
        };
        if source_only {
            self.scope(true).await?;
        }
        validation::observation(&result, &locator, source_only)?;
        self.io.state("private_transfer", &result)?;
        Ok(result)
    }
    pub(super) async fn private_include(&mut self, job: &str, included: bool) -> Result<()> {
        let offer = self.private_selected(job)?;
        if included {
            let result = self.private_read(job, false).await?;
            ensure!(
                result.received
                    && !result.key_released
                    && result.target_worker_running
                        == MigrationSourceCredentialObservedWorker::Observed(false)
                    && matches!(result.target_control,MigrationSourceTransferObservedControl::Present(control) if !control.cancelled),
                "private_credentials_receive_unconfirmed"
            );
        }
        let journal = self.draft.private_credentials.as_mut().unwrap();
        if included && !offer.included {
            ensure!(
                journal
                    .offers
                    .iter()
                    .filter(|row| row.job_id == job && row.included)
                    .count()
                    < 16,
                "private_credentials_budget_exceeded"
            );
        }
        journal
            .offers
            .iter_mut()
            .find(|row| row.input.locator.offer_id == offer.input.locator.offer_id)
            .unwrap()
            .included = included;
        self.save()
    }
    pub(super) async fn private_continue(&mut self, job: &str) -> Result<()> {
        let result = self.private_read(job, false).await?;
        if result.received || result.key_released {
            return Ok(());
        }
        let offer = self.private_selected(job)?;
        ensure!(
            result.target_worker_running
                == MigrationSourceCredentialObservedWorker::Observed(false)
                && matches!(result.target_control,MigrationSourceTransferObservedControl::Present(control) if !control.cancelled),
            "private_credentials_busy"
        );
        ensure!(self.io.yes("transfer_private_continue","Original target progress has been read. Reconcile the original encrypted receipt using only the saved identical offer/selection/consent? Source runtime state is still determined by Native authoritative locks. busy/unknown may be returned; identities and selected fields are not replaced.")?,"private_credentials_explicit_consent_required");
        let source = self.session(MigrationSourceSessionPurpose::Source).await?;
        let target = self.session(MigrationSourceSessionPurpose::Target).await?;
        let mut input = offer.input;
        input.source = source;
        input.locator.target = target;
        self.scope(true).await?;
        let result: MigrationSourceCredentialResult = self.private_post("run", &input).await?;
        self.scope(true).await?;
        validation::observation(&result, &input.locator, false)?;
        self.io.state("private_transfer", &result)
    }
    pub(super) async fn private_control(
        &mut self,
        job: &str,
        side: MigrationSourceCredentialSide,
        resume: bool,
    ) -> Result<()> {
        let mut locator = self.private_locator(job)?;
        let fresh = self
            .private_read(job, side == MigrationSourceCredentialSide::Source)
            .await?;
        let (control, worker) = match side {
            MigrationSourceCredentialSide::Source => {
                (fresh.source_control, fresh.source_worker_running)
            }
            MigrationSourceCredentialSide::Target => {
                (fresh.target_control, fresh.target_worker_running)
            }
        };
        let MigrationSourceTransferObservedControl::Present(control) = control else {
            anyhow::bail!("private_credentials_outcome_unknown")
        };
        let expected = MigrationSourceCredentialExpectedControl {
            sequence: control.sequence,
            cancel_watermark: control.cancel_watermark,
        };
        if resume {
            ensure!(
                worker == MigrationSourceCredentialObservedWorker::Observed(false),
                "private_credentials_busy"
            );
            if !control.cancelled {
                return self.io.notice(
                    "private_credentials_control_observed",
                    "Current Native progress has no cancellation marker. This does not mean this client completed recovery; receipt is not restarted automatically.",
                );
            }
        } else if control.cancelled {
            return Ok(());
        }
        ensure!(self.io.yes(if resume {"transfer_private_resume"}else{"transfer_private_cancel"},if resume {"Explicitly resume this side using the original sequence/cancel progress just read? Source programs, models and batches are not run automatically. Explicitly use continue afterward to check the original receipt."}else{"Cancel only this side of the original offer? Peer resources are not deleted and published groups are not undone. A cancellation request is not treated as completion."})?,"private_credentials_explicit_consent_required");
        let target_role = if side == MigrationSourceCredentialSide::Source {
            MigrationSourceSessionPurpose::Target
        } else {
            MigrationSourceSessionPurpose::TargetRecovery
        };
        let target = self.session(target_role).await?;
        locator.target = target;
        let source = if side == MigrationSourceCredentialSide::Source {
            Some(self.session(MigrationSourceSessionPurpose::Source).await?)
        } else {
            None
        };
        if source.is_some() {
            self.scope(true).await?;
        }
        let result: MigrationSourceCredentialControlResult = if resume {
            self.private_post(
                "resume",
                &MigrationSourceCredentialResumeParams {
                    locator: locator.clone(),
                    side,
                    source,
                    expected_control: expected.clone(),
                },
            )
            .await?
        } else {
            let key = match side {
                MigrationSourceCredentialSide::Source => "source",
                MigrationSourceCredentialSide::Target => "target",
            };
            let key = format!("{}:{key}", locator.offer_id);
            let controls = &mut self.draft.private_credentials.as_mut().unwrap().controls;
            let command_id = if let Some(intent) = controls
                .get(&key)
                .filter(|intent| intent.expected == expected)
            {
                intent.command_id.clone()
            } else {
                let id = uuid::Uuid::new_v4().to_string();
                controls.insert(
                    key,
                    CancelIntent {
                        command_id: id.clone(),
                        expected: expected.clone(),
                    },
                );
                id
            };
            self.save()?;
            self.private_post(
                "cancel",
                &MigrationSourceCredentialCancelParams {
                    locator: locator.clone(),
                    side,
                    source,
                    command_id,
                },
            )
            .await?
        };
        if side == MigrationSourceCredentialSide::Source {
            self.scope(true).await?;
        }
        ensure!(
            result.request_id == locator.request_id
                && result.offer_id == locator.offer_id
                && result.side == side
                && result.control.sequence >= expected.sequence
                && result.control.cancel_watermark >= expected.cancel_watermark,
            "private_credentials_invalid_response"
        );
        self.io.state("private_control", &result)
    }
    pub(super) async fn private_release(
        &mut self,
        client: &mut runtime::Client,
        job: &str,
    ) -> Result<()> {
        let mut locator = self.private_locator(job)?;
        let observed = self.private_read(job, false).await?;
        if observed.key_released {
            return Ok(());
        }
        let status = self.private_status(job).await?;
        let publication = if !validation::key_bound_to_preparation(&status, &locator.offer_id)? {
            MigrationSourceCredentialJob::Unused(())
        } else {
            ensure!(
                status.phase == MigrationSourceCredentialPreparationPhase::Prepared,
                "private_credentials_receive_unconfirmed"
            );
            let state = self.batch_read(client, job).await?;
            ensure!(
                !state.worker_running
                    && state.state.job.status
                        == kcoder_types::migration::MigrationJobStatus::RolledBack
                    && !state.state.job.has_unconfirmed_outcomes,
                "private_credentials_undo_required"
            );
            MigrationSourceCredentialJob::Publication(job.into())
        };
        ensure!(self.io.yes("transfer_private_release","Release only the original offer transfer key? Published groups must first be undone by their original batch. Native still checks the original key fingerprint and ownership. Accounts and other offers are not deleted.")?,"private_credentials_explicit_consent_required");
        let target = self
            .session(MigrationSourceSessionPurpose::TargetRecovery)
            .await?;
        locator.target = target;
        let result: MigrationSourceCredentialResult = self
            .private_post(
                "release",
                &MigrationSourceCredentialReleaseParams {
                    locator: locator.clone(),
                    job_id: publication,
                },
            )
            .await?;
        validation::observation(&result, &locator, false)?;
        ensure!(
            result.key_released,
            "private_credentials_receive_unconfirmed"
        );
        self.io.state("private_transfer", &result)
    }
}
