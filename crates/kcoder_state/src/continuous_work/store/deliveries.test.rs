//! Delivery confirmation tests for the completion gate.

use super::*;
use kcoder_types::continuous_work::{
    ResultBasis, WorkConfirmationLevel, WorkDelivery, WorkDeliveryRequirement, WorkDeliveryState,
    WorkResult,
};

fn scope() -> WorkScope {
    WorkScope {
        account_id: "a".into(),
        target_id: "t".into(),
        workspace_id: "w".into(),
    }
}

fn requirement() -> WorkDeliveryRequirement {
    WorkDeliveryRequirement {
        delivery_id: "chat".into(),
        minimum_confirmation: WorkConfirmationLevel::Delivered,
    }
}

#[test]
fn a_delivery_must_reference_an_accepted_requirement() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-delivery-unknown")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &scope(),
        delivery_work_record(),
        &delivery_source(),
        "initial",
        serde_json::json!({"text": "original"}),
        vec![requirement()],
    )?;
    let error = store
        .record_delivery(
            &scope(),
            "work",
            WorkDelivery {
                delivery_id: "unknown".into(),
                required_for_completion: true,
                state: WorkDeliveryState::Confirmed,
                minimum_confirmation: WorkConfirmationLevel::Accepted,
                observed_confirmation: Some(WorkConfirmationLevel::Accepted),
                receipt_ref: None,
            },
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_DELIVERY_UNKNOWN"));
    Ok(())
}

#[test]
fn confirmation_below_the_frozen_minimum_is_rejected() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-delivery-minimum")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &scope(),
        delivery_work_record(),
        &delivery_source(),
        "initial",
        serde_json::json!({"text": "original"}),
        vec![requirement()],
    )?;
    let error = store
        .record_delivery(
            &scope(),
            "work",
            WorkDelivery {
                delivery_id: "chat".into(),
                required_for_completion: true,
                state: WorkDeliveryState::Confirmed,
                minimum_confirmation: WorkConfirmationLevel::Delivered,
                observed_confirmation: Some(WorkConfirmationLevel::Accepted),
                receipt_ref: Some("receipt".into()),
            },
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_DELIVERY_CONFIRMATION_TOO_WEAK"));
    Ok(())
}

#[test]
fn completion_waits_for_every_required_delivery() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-delivery-pending")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &scope(),
        delivery_work_record(),
        &delivery_source(),
        "initial",
        serde_json::json!({"text": "original"}),
        vec![requirement()],
    )?;
    let claim = delivery_ready(&store)?;
    let work = store.read_work(&scope(), "work")?.expect("work exists");
    let basis = delivery_basis(&work);
    store.record_result(
        &scope(),
        "work",
        work.revision.revision,
        delivery_result(&basis),
    )?;
    let pending = store
        .complete_work(&scope(), "work", work.revision.revision + 1, basis.clone())
        .unwrap_err();
    assert!(format!("{pending:#}").contains("CONTINUOUS_WORK_DELIVERY_PENDING"));

    store.record_delivery(
        &scope(),
        "work",
        WorkDelivery {
            delivery_id: "chat".into(),
            required_for_completion: true,
            state: WorkDeliveryState::Confirmed,
            minimum_confirmation: WorkConfirmationLevel::Delivered,
            observed_confirmation: Some(WorkConfirmationLevel::Delivered),
            receipt_ref: Some("receipt-1".into()),
        },
    )?;
    let completed = store.complete_work(&scope(), "work", work.revision.revision + 1, basis)?;
    assert_eq!(completed.phase, WorkPhase::Completed);
    drop(claim);
    Ok(())
}

fn delivery_work_record() -> WorkRecord {
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "identity": {"scope": scope(), "workId": "work"},
        "origin": {"kind": "foreground", "initialAttempt": delivery_attempt()},
        "linkedThreadIds": ["thread"],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1, "controlEpoch": 0,
            "ownerEpoch": 0, "acceptedInputSequence": 1, "requiredInputSequence": 1,
            "appliedInputSequence": 0}
    }))
    .unwrap()
}

fn delivery_source() -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: "target-thread".into(),
        conversation_id: "thread".into(),
    }
}

fn delivery_attempt() -> TurnAttemptIdentity {
    TurnAttemptIdentity {
        thread_id: "thread".into(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    }
}

fn delivery_basis(work: &WorkRecord) -> ResultBasis {
    ResultBasis {
        requirements_revision: work.revision.requirements_revision,
        control_epoch: work.revision.control_epoch,
        owner_epoch: work.revision.owner_epoch,
        applied_input_sequence: work.revision.applied_input_sequence,
    }
}

fn delivery_result(basis: &ResultBasis) -> WorkResult {
    WorkResult {
        result_id: "result-1".into(),
        basis: basis.clone(),
        artifact_refs: vec![],
        evidence_refs: vec![],
        required_delivery_ids: vec!["chat".into()],
    }
}

fn delivery_ready(store: &ContinuousWorkStore) -> Result<ClaimReceipt> {
    let ClaimOutcome::Acquired(claim) = store.claim(
        &scope(),
        "work",
        1,
        0,
        "claim",
        "thread",
        ClaimTrigger::Input,
    )?
    else {
        panic!("claim must be acquired")
    };
    store.mark_input_applied(
        &scope(),
        "work",
        &delivery_source(),
        "initial",
        "claim",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: delivery_attempt(),
            history_uuid: "history-1".into(),
        },
    )?;
    store.release_claim(
        &scope(),
        "work",
        "claim",
        claim.owner_epoch,
        ClaimSettlement::Completed,
    )?;
    Ok(claim)
}

fn requirement_for(id: &str) -> WorkDeliveryRequirement {
    WorkDeliveryRequirement {
        delivery_id: id.into(),
        minimum_confirmation: WorkConfirmationLevel::Delivered,
    }
}

fn confirmed_delivery(id: &str) -> WorkDelivery {
    WorkDelivery {
        delivery_id: id.into(),
        required_for_completion: true,
        state: WorkDeliveryState::Confirmed,
        minimum_confirmation: WorkConfirmationLevel::Delivered,
        observed_confirmation: Some(WorkConfirmationLevel::Delivered),
        receipt_ref: Some(format!("receipt-{id}")),
    }
}

/// One confirmed delivery is not enough when another required one is still
/// pending, and completion opens only after the last one is confirmed.
#[test]
fn a_partially_delivered_work_cannot_complete() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-delivery-partial")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &scope(),
        delivery_work_record(),
        &delivery_source(),
        "initial",
        serde_json::json!({"text": "original"}),
        vec![requirement_for("chat"), requirement_for("email")],
    )?;
    let _claim = delivery_ready(&store)?;
    let work = store.read_work(&scope(), "work")?.expect("work exists");
    let basis = delivery_basis(&work);
    store.record_result(
        &scope(),
        "work",
        work.revision.revision,
        WorkResult {
            result_id: "result-1".into(),
            basis: basis.clone(),
            artifact_refs: vec![],
            evidence_refs: vec![],
            required_delivery_ids: vec!["chat".into(), "email".into()],
        },
    )?;

    store.record_delivery(&scope(), "work", confirmed_delivery("chat"))?;
    let pending = store
        .complete_work(&scope(), "work", work.revision.revision + 1, basis.clone())
        .unwrap_err();
    assert!(format!("{pending:#}").contains("CONTINUOUS_WORK_DELIVERY_PENDING"));

    store.record_delivery(&scope(), "work", confirmed_delivery("email"))?;
    let completed = store.complete_work(&scope(), "work", work.revision.revision + 1, basis)?;
    assert_eq!(completed.phase, WorkPhase::Completed);
    Ok(())
}
