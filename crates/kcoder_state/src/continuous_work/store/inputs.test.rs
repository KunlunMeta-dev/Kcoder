//! Rejection and unknown-outcome tests for accepted inputs.

use super::*;
use crate::continuous_work::InputAuthority;
use kcoder_types::continuous_work::WorkInputState;

fn scope() -> WorkScope {
    WorkScope {
        account_id: "a".into(),
        target_id: "t".into(),
        workspace_id: "w".into(),
    }
}

fn source() -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: "target-thread".into(),
        conversation_id: "thread".into(),
    }
}

fn attempt() -> TurnAttemptIdentity {
    TurnAttemptIdentity {
        thread_id: "thread".into(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    }
}

fn work_record() -> WorkRecord {
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "identity": {"scope": scope(), "workId": "work"},
        "origin": {"kind": "foreground", "initialAttempt": attempt()},
        "linkedThreadIds": ["thread"],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1, "controlEpoch": 0,
            "ownerEpoch": 0, "acceptedInputSequence": 1, "requiredInputSequence": 1,
            "appliedInputSequence": 0}
    }))
    .unwrap()
}

fn admit(store: &ContinuousWorkStore) -> Result<()> {
    store.admit(
        &scope(),
        work_record(),
        &source(),
        "initial",
        serde_json::json!({"text": "original"}),
        vec![],
    )?;
    Ok(())
}

#[test]
fn a_queued_input_can_be_rejected_without_advancing_the_watermark() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-input-reject")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    admit(&store)?;
    let _ = store.queue_input(
        &scope(),
        "work",
        &source(),
        1,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        serde_json::json!({"text": "second"}),
        Some(vec![]),
    )?;
    let rejected = store.reject_input(&scope(), "work", &source(), "input-2", None)?;
    assert_eq!(rejected.state, WorkInputState::Rejected);
    // Rejecting twice stays idempotent.
    let again = store.reject_input(&scope(), "work", &source(), "input-2", None)?;
    assert_eq!(again.state, WorkInputState::Rejected);
    let work = store.read_work(&scope(), "work")?.expect("work exists");
    assert_eq!(work.revision.applied_input_sequence, 0);
    assert_eq!(work.revision.accepted_input_sequence, 2);
    Ok(())
}

#[test]
fn a_dispatched_input_cannot_be_rejected() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-input-reject-dispatched")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    admit(&store)?;
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
        &source(),
        "initial",
        "claim",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: attempt(),
            history_uuid: "history-1".into(),
        },
    )?;
    let revision = store
        .read_work(&scope(), "work")?
        .expect("work exists")
        .revision
        .revision;
    store.queue_input(
        &scope(),
        "work",
        &source(),
        revision,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        serde_json::json!({"text": "second"}),
        Some(vec![]),
    )?;
    store.dispatch_input(
        &scope(),
        "work",
        &source(),
        "input-2",
        "claim",
        claim.owner_epoch,
        0,
    )?;
    let error = store
        .reject_input(
            &scope(),
            "work",
            &source(),
            "input-2",
            Some(InputAuthority {
                claim_id: "claim",
                owner_epoch: claim.owner_epoch,
                control_epoch: 0,
            }),
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_INPUT_ALREADY_DISPATCHED"));
    Ok(())
}

#[test]
fn an_unconfirmed_input_keeps_blocking_completion() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-input-unconfirmed")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    admit(&store)?;
    let revision = store
        .read_work(&scope(), "work")?
        .expect("work exists")
        .revision
        .revision;
    store.queue_input(
        &scope(),
        "work",
        &source(),
        revision,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        serde_json::json!({"text": "second"}),
        Some(vec![]),
    )?;
    let marked = store.mark_input_unconfirmed(&scope(), "work", &source(), "input-2", None)?;
    assert_eq!(marked.state, WorkInputState::NeedsReconciliation);
    let again = store.mark_input_unconfirmed(&scope(), "work", &source(), "input-2", None)?;
    assert_eq!(again.state, WorkInputState::NeedsReconciliation);
    Ok(())
}

#[test]
fn a_paused_work_keeps_new_results_but_refuses_a_new_claim() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-control-pause")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    admit(&store)?;
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
        &source(),
        "initial",
        "claim",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: attempt(),
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

    // Pause arrives before the result does.
    let revision = store
        .read_work(&scope(), "work")?
        .expect("work exists")
        .revision
        .revision;
    store.control(
        &scope(),
        "work",
        revision,
        "pause-1",
        WorkControlAction::Pause,
        WorkControlTarget::Work {},
    )?;

    // A late result is still recorded: pausing never discards observed work.
    let work = store.read_work(&scope(), "work")?.expect("work exists");
    let basis = kcoder_types::continuous_work::ResultBasis {
        requirements_revision: work.revision.requirements_revision,
        control_epoch: work.revision.control_epoch,
        owner_epoch: work.revision.owner_epoch,
        applied_input_sequence: work.revision.applied_input_sequence,
    };
    let recorded = store.record_result(
        &scope(),
        "work",
        work.revision.revision,
        kcoder_types::continuous_work::WorkResult {
            result_id: "result-pause".into(),
            basis: basis.clone(),
            artifact_refs: vec![],
            evidence_refs: vec![],
            required_delivery_ids: vec![],
        },
    )?;
    assert!(recorded.result.is_some());

    // No new turn may start while the pause is pending.
    let error = store
        .claim(
            &scope(),
            "work",
            recorded.revision.revision,
            recorded.revision.control_epoch,
            "claim-paused",
            "thread",
            ClaimTrigger::Automatic,
        )
        .unwrap_err();
    let text = format!("{error:#}");
    assert!(
        text.contains("CONTINUOUS_WORK_CONTROL_PENDING")
            || text.contains("CONTINUOUS_WORK_REVISION_CONFLICT"),
        "{text}"
    );
    // Completion stays fenced by the pending control.
    let error = store
        .complete_work(&scope(), "work", recorded.revision.revision, basis)
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_COMPLETION_FENCED"));
    Ok(())
}

fn child_claim_then_exit(profile: &std::ffi::OsStr) -> Result<()> {
    let store = ContinuousWorkStore::open_existing(Path::new(profile))?.expect("store exists");
    let _ = store.claim(
        &scope(),
        "work",
        1,
        0,
        "claim-orphan",
        "thread",
        ClaimTrigger::Input,
    )?;
    println!("CONTINUOUS_CHILD_CLAIMED");
    Ok(())
}

/// A claim held by a process that exited must stay visible and blocking: the
/// next process may not silently take the work over.
#[test]
fn a_claim_from_an_exited_process_still_blocks_a_new_claim() -> Result<()> {
    if let Some(profile) = std::env::var_os("KCODER_TEST_CONTINUOUS_ORPHAN_PROFILE") {
        return child_claim_then_exit(&profile);
    }
    let temp = kcoder_config::create_private_temp_dir("continuous-work-orphan-claim")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    admit(&store)?;
    let output = std::process::Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "continuous_work::store::inputs::tests::a_claim_from_an_exited_process_still_blocks_a_new_claim",
            "--nocapture",
        ])
        .env("KCODER_TEST_CONTINUOUS_ORPHAN_PROFILE", temp.path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()?;
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("CONTINUOUS_CHILD_CLAIMED"));

    let reopened = ContinuousWorkStore::open_existing(temp.path())?.expect("store exists");
    let active = reopened.active_claim(&scope(), "work")?;
    assert_eq!(
        active.as_ref().map(|receipt| receipt.claim_id.as_str()),
        Some("claim-orphan")
    );
    let error = reopened
        .claim(
            &scope(),
            "work",
            1,
            0,
            "claim-next",
            "thread",
            ClaimTrigger::Automatic,
        )
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("ALREADY_CLAIMED"),
        "{error:#}"
    );
    Ok(())
}

#[test]
fn a_transient_dispatch_can_return_to_the_queue_but_a_recorded_outcome_cannot() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-input-requeue")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    admit(&store)?;
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
        &source(),
        "initial",
        "claim",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: attempt(),
            history_uuid: "history-1".into(),
        },
    )?;
    let revision = store
        .read_work(&scope(), "work")?
        .expect("work exists")
        .revision
        .revision;
    store.queue_input(
        &scope(),
        "work",
        &source(),
        revision,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        serde_json::json!({"text": "second"}),
        Some(vec![]),
    )?;
    store.dispatch_input(
        &scope(),
        "work",
        &source(),
        "input-2",
        "claim",
        claim.owner_epoch,
        0,
    )?;

    // A bare dispatch can go back to the queue when no request was made.
    let requeued = store.requeue_input(
        &scope(),
        "work",
        &source(),
        "input-2",
        Some(InputAuthority {
            claim_id: "claim",
            owner_epoch: claim.owner_epoch,
            control_epoch: 0,
        }),
    )?;
    assert_eq!(requeued.state, WorkInputState::Queued);
    let again = store.requeue_input(
        &scope(),
        "work",
        &source(),
        "input-2",
        Some(InputAuthority {
            claim_id: "claim",
            owner_epoch: claim.owner_epoch,
            control_epoch: 0,
        }),
    )?;
    assert_eq!(again.state, WorkInputState::Queued);

    // Once the outcome is recorded, it stays recorded.
    store.dispatch_input(
        &scope(),
        "work",
        &source(),
        "input-2",
        "claim",
        claim.owner_epoch,
        0,
    )?;
    store.mark_input_unconfirmed(
        &scope(),
        "work",
        &source(),
        "input-2",
        Some(InputAuthority {
            claim_id: "claim",
            owner_epoch: claim.owner_epoch,
            control_epoch: 0,
        }),
    )?;
    let error = store
        .requeue_input(
            &scope(),
            "work",
            &source(),
            "input-2",
            Some(InputAuthority {
                claim_id: "claim",
                owner_epoch: claim.owner_epoch,
                control_epoch: 0,
            }),
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_INPUT_NOT_REQUEUEABLE"));
    Ok(())
}

#[test]
fn a_requeued_input_still_holds_its_place_in_the_queue() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-input-requeue-order")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    admit(&store)?;
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
        &source(),
        "initial",
        "claim",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: attempt(),
            history_uuid: "history-1".into(),
        },
    )?;
    let revision = store
        .read_work(&scope(), "work")?
        .expect("work exists")
        .revision
        .revision;
    store.queue_input(
        &scope(),
        "work",
        &source(),
        revision,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        serde_json::json!({"text": "second"}),
        Some(vec![]),
    )?;
    let revision = store
        .read_work(&scope(), "work")?
        .expect("work exists")
        .revision
        .revision;
    store.queue_input(
        &scope(),
        "work",
        &source(),
        revision,
        "input-3",
        "request-3",
        WorkInputKind::Requirement,
        serde_json::json!({"text": "third"}),
        Some(vec![]),
    )?;

    store.dispatch_input(
        &scope(),
        "work",
        &source(),
        "input-2",
        "claim",
        claim.owner_epoch,
        0,
    )?;
    store.requeue_input(
        &scope(),
        "work",
        &source(),
        "input-2",
        Some(InputAuthority {
            claim_id: "claim",
            owner_epoch: claim.owner_epoch,
            control_epoch: 0,
        }),
    )?;

    // The later requirement must not overtake the requeued one.
    let error = store
        .dispatch_input(
            &scope(),
            "work",
            &source(),
            "input-3",
            "claim",
            claim.owner_epoch,
            0,
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_INPUT_ORDER_CONFLICT"));

    store.dispatch_input(
        &scope(),
        "work",
        &source(),
        "input-2",
        "claim",
        claim.owner_epoch,
        0,
    )?;
    store.dispatch_input(
        &scope(),
        "work",
        &source(),
        "input-3",
        "claim",
        claim.owner_epoch,
        0,
    )?;
    Ok(())
}

#[test]
fn only_the_last_unsettled_input_may_be_rejected() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-input-reject-tail")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    admit(&store)?;
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
        &source(),
        "initial",
        "claim",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: attempt(),
            history_uuid: "history-1".into(),
        },
    )?;
    for (id, text) in [("input-2", "second"), ("input-3", "third")] {
        let revision = store
            .read_work(&scope(), "work")?
            .expect("work exists")
            .revision
            .revision;
        store.queue_input(
            &scope(),
            "work",
            &source(),
            revision,
            id,
            id,
            WorkInputKind::Requirement,
            serde_json::json!({ "text": text }),
            Some(vec![]),
        )?;
    }

    // A middle rejection would leave a hole the applied watermark can never
    // cross, so only the tail may be rejected first.
    let error = store
        .reject_input(
            &scope(),
            "work",
            &source(),
            "input-2",
            Some(InputAuthority {
                claim_id: "claim",
                owner_epoch: claim.owner_epoch,
                control_epoch: 0,
            }),
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_INPUT_REJECT_NOT_TAIL"));

    store.reject_input(
        &scope(),
        "work",
        &source(),
        "input-3",
        Some(InputAuthority {
            claim_id: "claim",
            owner_epoch: claim.owner_epoch,
            control_epoch: 0,
        }),
    )?;
    // With the tail rejected, the earlier one becomes the tail.
    store.reject_input(
        &scope(),
        "work",
        &source(),
        "input-2",
        Some(InputAuthority {
            claim_id: "claim",
            owner_epoch: claim.owner_epoch,
            control_epoch: 0,
        }),
    )?;
    let work = store.read_work(&scope(), "work")?.expect("work exists");
    assert_eq!(work.revision.applied_input_sequence, 1);
    let inputs = store.list_inputs(&scope(), "work", None)?;
    assert!(
        inputs
            .inputs
            .iter()
            .filter(|entry| entry.receipt.input_id.starts_with("input-"))
            .all(|entry| entry.receipt.state == WorkInputState::Rejected)
    );
    Ok(())
}

#[test]
fn a_foreign_caller_cannot_touch_a_claimed_input() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("work-input-foreign")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    admit(&store)?;
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
        &source(),
        "initial",
        "claim",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: attempt(),
            history_uuid: "history-1".into(),
        },
    )?;
    let revision = store
        .read_work(&scope(), "work")?
        .expect("work exists")
        .revision
        .revision;
    store.queue_input(
        &scope(),
        "work",
        &source(),
        revision,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        serde_json::json!({"text": "second"}),
        Some(vec![]),
    )?;

    // Without naming the live claim, another owner cannot reject or requeue it.
    let error = store
        .reject_input(&scope(), "work", &source(), "input-2", None)
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_OWNER_CONFLICT"));
    let error = store
        .requeue_input(&scope(), "work", &source(), "input-2", None)
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_OWNER_CONFLICT"));
    let error = store
        .mark_input_unconfirmed(&scope(), "work", &source(), "input-2", None)
        .unwrap_err();
    assert!(format!("{error:#}").contains("CONTINUOUS_WORK_OWNER_CONFLICT"));
    Ok(())
}
