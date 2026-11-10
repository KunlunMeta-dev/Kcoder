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
            MigrationSourceCredentialPreparationPhase::Prepared=>return self.io.notice("private_credentials_original_preparation_observed","原完整prepare意图已完成；这不表示已发布或已撤销。回批次核对原计划，再明确IMPORT/UNDO。"),
            MigrationSourceCredentialPreparationPhase::Unknown=>anyhow::bail!("private_credentials_outcome_unknown"),
            MigrationSourceCredentialPreparationPhase::Pending if !restore=>anyhow::bail!("private_credentials_restore_original_preparation_required"),
            MigrationSourceCredentialPreparationPhase::NotStarted if restore=>return self.io.notice("private_credentials_preparation_not_started","原生尚无可恢复的prepare意图；未生成新set或替代请求。"),
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
        ensure!(self.io.yes(if restore {"transfer_private_restore"}else{"transfer_private_prepare"},if restore {"确认仅恢复刚读取的Native完整offer set、原CAS和原同意？不换UUID、不缩减set、不启动批次或模型。"}else{"确认将明确勾选的完整私密bundle准备到此原批次？这里只准备，原字段同意仍适用；发布和Undo须在批次中另确认。"})?,"private_credentials_explicit_consent_required");
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
        self.io.notice("private_credentials_prepared","原完整bundle已按Native回执准备。返回batch核对新计划后明确IMPORT；未自动发送模型或来源工具。")
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
