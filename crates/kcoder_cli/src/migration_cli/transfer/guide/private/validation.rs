use super::*;
pub(super) fn atom(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
pub(super) fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn offer_set(input: &MigrationSourceCredentialPrepareParams) -> Result<Vec<String>> {
    let mut offers = vec![input.locator.offer_id.clone()];
    if let Some(additional) = &input.additional_offers {
        offers.extend(additional.clone());
    }
    offers.sort();
    ensure!(
        !offers.is_empty() && offers.len() <= 16 && offers.windows(2).all(|pair| pair[0] < pair[1]),
        "private_credentials_binding_changed"
    );
    Ok(offers)
}
pub(super) fn observation(
    result: &MigrationSourceCredentialResult,
    locator: &MigrationSourceCredentialLocator,
    source_only: bool,
) -> Result<()> {
    ensure!(
        result.request_id == locator.request_id && result.offer_id == locator.offer_id,
        "private_credentials_invalid_response"
    );
    let known = |control: &MigrationSourceTransferObservedControl,
                 worker: &MigrationSourceCredentialObservedWorker,
                 observed: bool| {
        matches!(control, MigrationSourceTransferObservedControl::Present(_)) == observed
            && matches!(worker, MigrationSourceCredentialObservedWorker::Observed(_)) == observed
    };
    ensure!(
        known(
            &result.source_control,
            &result.source_worker_running,
            result.source_observed
        ) && known(
            &result.target_control,
            &result.target_worker_running,
            result.target_observed
        ),
        "private_credentials_invalid_response"
    );
    if source_only {
        ensure!(
            result.source_observed
                && !result.target_observed
                && !result.received
                && !result.key_released,
            "private_credentials_invalid_response"
        );
        let MigrationSourceTransferObservedControl::Present(control) = &result.source_control
        else {
            anyhow::bail!("private_credentials_invalid_response")
        };
        let running =
            result.source_worker_running == MigrationSourceCredentialObservedWorker::Observed(true);
        let expected = if control.cancelled {
            if running {
                MigrationSourceCredentialPhase::Cancelling
            } else {
                MigrationSourceCredentialPhase::Cancelled
            }
        } else if running {
            MigrationSourceCredentialPhase::Running
        } else if control.ready {
            MigrationSourceCredentialPhase::Sealed
        } else {
            MigrationSourceCredentialPhase::Offered
        };
        ensure!(
            result.phase == expected,
            "private_credentials_invalid_response"
        );
    } else {
        ensure!(
            result.target_observed
                && matches!(&result.target_control,MigrationSourceTransferObservedControl::Present(control) if control.ready==result.received),
            "private_credentials_invalid_response"
        );
        let running = result.source_worker_running
            == MigrationSourceCredentialObservedWorker::Observed(true)
            || result.target_worker_running
                == MigrationSourceCredentialObservedWorker::Observed(true);
        let cancelled=[&result.source_control,&result.target_control].iter().any(|state|matches!(state,MigrationSourceTransferObservedControl::Present(control) if control.cancelled));
        let expected = if cancelled {
            if running {
                MigrationSourceCredentialPhase::Cancelling
            } else {
                MigrationSourceCredentialPhase::Cancelled
            }
        } else if running {
            MigrationSourceCredentialPhase::Running
        } else if result.key_released {
            MigrationSourceCredentialPhase::Released
        } else if result.received {
            MigrationSourceCredentialPhase::Received
        } else if matches!(&result.source_control,MigrationSourceTransferObservedControl::Present(control) if control.ready)
        {
            MigrationSourceCredentialPhase::Sealed
        } else {
            MigrationSourceCredentialPhase::Offered
        };
        ensure!(
            result.phase == expected,
            "private_credentials_invalid_response"
        );
    }
    Ok(())
}
pub(super) fn preparation(
    result: &MigrationSourceCredentialPreparationResult,
    request: &MigrationSourceCredentialPreparationReadParams,
) -> Result<()> {
    ensure!(
        result.request_id == request.request_id && result.job_id == request.job_id,
        "private_credentials_invalid_response"
    );
    let complete = matches!(&result.original_plan_id,MigrationSourceCredentialPreparationPlan::Known(plan) if atom(plan))
        && matches!(&result.plan_id,MigrationSourceCredentialPreparationPlan::Known(plan) if atom(plan))
        && matches!(&result.offer_ids,MigrationSourceCredentialPreparationOffers::Known(ids) if !ids.is_empty() && ids.len()<=16 && ids.iter().all(|id|uuid::Uuid::parse_str(id).is_ok()) && ids.windows(2).all(|pair|pair[0]<pair[1]))
        && matches!(
            result.expected_sequence,
            MigrationSourceCredentialPreparationSequence::Known(_)
        )
        && matches!(
            result.consent,
            MigrationSourceCredentialPreparationConsent::Known(_)
        );
    let empty = matches!(
        result.original_plan_id,
        MigrationSourceCredentialPreparationPlan::Unknown(())
    ) && matches!(
        result.plan_id,
        MigrationSourceCredentialPreparationPlan::Unknown(())
    ) && matches!(
        result.offer_ids,
        MigrationSourceCredentialPreparationOffers::Unknown(())
    ) && matches!(
        result.expected_sequence,
        MigrationSourceCredentialPreparationSequence::Unknown(())
    ) && matches!(
        result.consent,
        MigrationSourceCredentialPreparationConsent::Unknown(())
    );
    ensure!(
        match result.phase {
            MigrationSourceCredentialPreparationPhase::NotStarted => empty,
            MigrationSourceCredentialPreparationPhase::Unknown => empty || complete,
            MigrationSourceCredentialPreparationPhase::Pending =>
                complete
                    && matches!(result.expected_sequence,MigrationSourceCredentialPreparationSequence::Known(sequence) if sequence==result.sequence),
            MigrationSourceCredentialPreparationPhase::Prepared =>
                complete
                    && matches!(result.expected_sequence,MigrationSourceCredentialPreparationSequence::Known(sequence) if sequence<result.sequence),
        },
        "private_credentials_invalid_response"
    );
    Ok(())
}
pub(super) fn same_preparation(
    left: &MigrationSourceCredentialPreparationResult,
    right: &MigrationSourceCredentialPreparationResult,
) -> bool {
    left.request_id == right.request_id
        && left.job_id == right.job_id
        && left.original_plan_id == right.original_plan_id
        && left.plan_id == right.plan_id
        && left.offer_ids == right.offer_ids
        && left.expected_sequence == right.expected_sequence
        && left.consent == right.consent
        && left.sequence >= right.sequence
}

/// A different offer in the same client job is not implicitly part of the canonical bundle.
pub(super) fn key_bound_to_preparation(
    result: &MigrationSourceCredentialPreparationResult,
    offer_id: &str,
) -> Result<bool> {
    match result.phase {
        MigrationSourceCredentialPreparationPhase::NotStarted => Ok(false),
        MigrationSourceCredentialPreparationPhase::Pending
        | MigrationSourceCredentialPreparationPhase::Prepared => {
            let MigrationSourceCredentialPreparationOffers::Known(ids) = &result.offer_ids else {
                anyhow::bail!("private_credentials_receive_unconfirmed")
            };
            Ok(ids.iter().any(|id| id == offer_id))
        }
        MigrationSourceCredentialPreparationPhase::Unknown => {
            anyhow::bail!("private_credentials_outcome_unknown")
        }
    }
}
