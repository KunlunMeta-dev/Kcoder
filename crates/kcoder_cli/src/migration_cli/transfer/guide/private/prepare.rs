use super::*;

impl Guide {
    pub(super) async fn private_status(
        &mut self,
        job: &str,
    ) -> Result<MigrationSourceCredentialPreparationResult> {
        let target = self
            .session(MigrationSourceSessionPurpose::TargetRecovery)
            .await?;
        let input = MigrationSourceCredentialPreparationReadParams {
            request_id: self.draft.request_id.clone(),
            job_id: job.into(),
            target,
        };
        let result: MigrationSourceCredentialPreparationResult =
            self.private_post("prepare-status", &input).await?;
        validation::preparation(&result, &input)?;
        let original = self
            .draft
            .private_credentials
            .as_ref()
            .and_then(|journal| journal.preparations.get(job))
            .cloned();
        if let Some(original) = &original {
            if result.phase == MigrationSourceCredentialPreparationPhase::NotStarted {
                ensure!(
                    original.canonical_plan_id.is_none(),
                    "private_credentials_binding_changed"
                );
            } else if matches!(
                result.original_plan_id,
                MigrationSourceCredentialPreparationPlan::Known(_)
            ) {
                matches_intent(original, &result)?;
            }
        }
        if matches!(
            result.phase,
            MigrationSourceCredentialPreparationPhase::Pending
                | MigrationSourceCredentialPreparationPhase::Prepared
        ) {
            let preparation = from_status(&result, input.target)?;
            let journal = self
                .draft
                .private_credentials
                .get_or_insert_with(Default::default);
            ensure!(
                journal.preparations.contains_key(job) || journal.preparations.len() < 4,
                "private_credentials_budget_exceeded"
            );
            journal.preparations.insert(job.into(), preparation);
            self.save()?;
        }
        self.io.state("private_preparation", &result)?;
        Ok(result)
    }
    pub(super) async fn private_prepare(
        &mut self,
        client: &mut runtime::Client,
        job: &str,
        restore: bool,
    ) -> Result<()> {
        let observed = self.private_status(job).await?;
        match observed.phase {
            MigrationSourceCredentialPreparationPhase::Prepared=>return self.io.notice("private_credentials_original_preparation_observed","The original complete prepare intent finished; this does not mean publication or undo finished. Check its original plan in the batch, then explicitly IMPORT/UNDO."),
            MigrationSourceCredentialPreparationPhase::Unknown=>anyhow::bail!("private_credentials_outcome_unknown"),
            MigrationSourceCredentialPreparationPhase::Pending if !restore=>anyhow::bail!("private_credentials_restore_original_preparation_required"),
            MigrationSourceCredentialPreparationPhase::NotStarted if restore=>return self.io.notice("private_credentials_preparation_not_started","Native has no recoverable prepare intent yet; no new set or replacement request was generated."),
            _=>{},
        }
        let mut preparation = if restore {
            from_status(&observed, self.draft.recovery.clone())?
        } else if let Some(saved) = self
            .draft
            .private_credentials
            .as_ref()
            .and_then(|journal| journal.preparations.get(job))
            .cloned()
        {
            saved
        } else {
            let current = self.batch_read(client, job).await?;
            ensure!(!current.worker_running, "private_credentials_busy");
            let plan = current
                .state
                .batch
                .as_ref()
                .and_then(|batch| batch.plan_id.clone())
                .ok_or_else(|| anyhow::anyhow!("private_credentials_saved_plan_required"))?;
            let offers = self
                .draft
                .private_credentials
                .as_ref()
                .map(|journal| {
                    journal
                        .offers
                        .iter()
                        .filter(|row| row.job_id == job && row.included)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            ensure!(
                !offers.is_empty()
                    && offers.len() <= 16
                    && offers
                        .iter()
                        .map(|row| row.input.selections.len())
                        .sum::<usize>()
                        <= 64,
                "private_credentials_explicit_consent_required"
            );
            ensure!(
                offers.iter().all(|row| row.original_plan_id == plan),
                "private_credentials_plan_changed"
            );
            let mut ids = offers
                .iter()
                .map(|row| row.input.locator.offer_id.clone())
                .collect::<Vec<_>>();
            ids.sort();
            for offer in &offers {
                let locator = MigrationSourceCredentialLocator {
                    target: self.draft.recovery.clone(),
                    ..offer.input.locator.clone()
                };
                let result: MigrationSourceCredentialResult =
                    self.private_post("read", &locator).await?;
                validation::observation(&result, &locator, false)?;
                ensure!(
                    result.received
                        && !result.key_released
                        && result.target_worker_running
                            == MigrationSourceCredentialObservedWorker::Observed(false)
                        && matches!(result.target_control,MigrationSourceTransferObservedControl::Present(control) if !control.cancelled),
                    "private_credentials_receive_unconfirmed"
                );
            }
            let consent = MigrationSourceCredentialConsent {
                api_keys: offers
                    .iter()
                    .flat_map(|row| &row.input.selections)
                    .any(|row| matches!(row, MigrationSourceCredentialSelection::Provider { .. })),
                mcp_private_fields: offers
                    .iter()
                    .flat_map(|row| &row.input.selections)
                    .any(|row| matches!(row, MigrationSourceCredentialSelection::Mcp { .. })),
            };
            Preparation {
                original_plan_id: plan,
                canonical_plan_id: None,
                input: MigrationSourceCredentialPrepareParams {
                    locator: MigrationSourceCredentialLocator {
                        request_id: self.draft.request_id.clone(),
                        offer_id: ids[0].clone(),
                        target: self.draft.recovery.clone(),
                    },
                    job_id: job.into(),
                    expected_sequence: current.state.job.sequence,
                    consent,
                    additional_offers: (ids.len() > 1).then(|| ids[1..].to_vec()),
                },
            }
        };
        let ids = validation::offer_set(&preparation.input)?;
        self.io.state("private_prepare_intent",&json!({"jobId":job,"offerIds":ids,"expectedSequence":preparation.input.expected_sequence,"originalPlanId":preparation.original_plan_id,"consent":preparation.input.consent,"restoringOriginal":restore}))?;
        ensure!(self.io.yes(if restore {"transfer_private_restore"}else{"transfer_private_prepare"},if restore {"Restore only the Native complete offer set, original CAS and original consent just read? No UUID replacement, set reduction, batch start or model start."}else{"Prepare explicitly selected complete private bundles into this original batch? This only prepares; original field consent still applies. Publication and Undo require separate batch confirmation."})?,"private_credentials_explicit_consent_required");
        let fresh = self.private_status(job).await?;
        if restore {
            ensure!(
                validation::same_preparation(&fresh, &observed),
                "private_credentials_binding_changed"
            );
            if fresh.phase == MigrationSourceCredentialPreparationPhase::Prepared {
                return Ok(());
            }
            ensure!(
                fresh.phase == MigrationSourceCredentialPreparationPhase::Pending,
                "private_credentials_outcome_unknown"
            );
        } else {
            ensure!(
                fresh.phase == MigrationSourceCredentialPreparationPhase::NotStarted,
                "private_credentials_restore_original_preparation_required"
            );
        }
        preparation.input.locator.target = self.draft.recovery.clone();
        self.draft
            .private_credentials
            .get_or_insert_with(Default::default)
            .preparations
            .insert(job.into(), preparation.clone());
        self.save()?;
        let result: MigrationSourceCredentialPrepareResult =
            self.private_post("prepare", &preparation.input).await?;
        ensure!(
            result.request_id == self.draft.request_id
                && result.offer_id == preparation.input.locator.offer_id
                && result.job.job.job_id == job
                && if ids.len() == 1 {
                    result.offer_ids.is_none()
                } else {
                    result.offer_ids.as_ref() == Some(&ids)
                },
            "private_credentials_invalid_response"
        );
        let confirmed = self.private_status(job).await?;
        ensure!(
            confirmed.phase == MigrationSourceCredentialPreparationPhase::Prepared,
            "private_credentials_receive_unconfirmed"
        );
        matches_intent(&preparation, &confirmed)?;
        self.io.notice("private_credentials_prepared","The original complete bundle was prepared according to its Native receipt. Return to batch, check the new plan and explicitly IMPORT; no model or source tools were invoked automatically.")
    }
}
fn from_status(
    result: &MigrationSourceCredentialPreparationResult,
    target: MigrationSourceSessionParams,
) -> Result<Preparation> {
    let (
        MigrationSourceCredentialPreparationPlan::Known(plan),
        MigrationSourceCredentialPreparationPlan::Known(canonical_plan),
        MigrationSourceCredentialPreparationOffers::Known(ids),
        MigrationSourceCredentialPreparationSequence::Known(sequence),
        MigrationSourceCredentialPreparationConsent::Known(consent),
    ) = (
        &result.original_plan_id,
        &result.plan_id,
        &result.offer_ids,
        &result.expected_sequence,
        &result.consent,
    )
    else {
        anyhow::bail!("private_credentials_receive_unconfirmed")
    };
    ensure!(
        matches!(
            result.phase,
            MigrationSourceCredentialPreparationPhase::Pending
                | MigrationSourceCredentialPreparationPhase::Prepared
        ) && !ids.is_empty(),
        "private_credentials_receive_unconfirmed"
    );
    Ok(Preparation {
        original_plan_id: plan.clone(),
        canonical_plan_id: Some(canonical_plan.clone()),
        input: MigrationSourceCredentialPrepareParams {
            locator: MigrationSourceCredentialLocator {
                request_id: result.request_id.clone(),
                offer_id: ids[0].clone(),
                target,
            },
            job_id: result.job_id.clone(),
            expected_sequence: *sequence,
            consent: consent.clone(),
            additional_offers: (ids.len() > 1).then(|| ids[1..].to_vec()),
        },
    })
}
fn matches_intent(
    original: &Preparation,
    result: &MigrationSourceCredentialPreparationResult,
) -> Result<()> {
    ensure!(
        result.request_id == original.input.locator.request_id
            && result.job_id == original.input.job_id
            && original
                .canonical_plan_id
                .as_ref()
                .is_none_or(|id| result.plan_id
                    == MigrationSourceCredentialPreparationPlan::Known(id.clone()))
            && result.original_plan_id
                == MigrationSourceCredentialPreparationPlan::Known(
                    original.original_plan_id.clone()
                )
            && result.offer_ids
                == MigrationSourceCredentialPreparationOffers::Known(validation::offer_set(
                    &original.input
                )?)
            && result.expected_sequence
                == MigrationSourceCredentialPreparationSequence::Known(
                    original.input.expected_sequence
                )
            && result.consent
                == MigrationSourceCredentialPreparationConsent::Known(
                    original.input.consent.clone()
                ),
        "private_credentials_binding_changed"
    );
    Ok(())
}

#[cfg(test)]
#[path = "prepare/tests.rs"]
mod tests;
