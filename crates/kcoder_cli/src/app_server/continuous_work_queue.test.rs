//! Queue-consumption tests for the automatic claim lease.

use super::*;
use kcoder_state::continuous_work::{AppliedInputReference, ClaimTrigger};

fn owned_scope() -> WorkScope {
    WorkScope {
        account_id: "owned-account".into(),
        target_id: "owned-target".into(),
        workspace_id: "owned-workspace".into(),
    }
}

fn owned_source() -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: "thread-1".into(),
    }
}

/// Admit the work, apply its initial input under an automatic claim, and return
/// that live lease so the queue helpers can be exercised directly.
fn claimed_work(
    name: &str,
) -> (
    kcoder_config::PrivateTempDir,
    ContinuousWorkStore,
    WorkScope,
    AutomaticClaimLease,
) {
    let directory = kcoder_config::create_private_temp_dir(name).unwrap();
    let store = ContinuousWorkStore::open_or_create(directory.path()).unwrap();
    let scope = owned_scope();
    let source = owned_source();
    let work: WorkRecord = serde_json::from_value(json!({
        "schemaVersion": 1,
        "identity": {"scope": scope, "workId": "work-1"},
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": "thread-1", "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": ["thread-1"],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1,
            "controlEpoch": 0, "ownerEpoch": 0, "acceptedInputSequence": 1,
            "requiredInputSequence": 1, "appliedInputSequence": 0}
    }))
    .unwrap();
    store
        .admit(
            &scope,
            work,
            &source,
            "initial-input",
            json!({"text": "original task"}),
            vec![],
        )
        .unwrap();
    let revision = store.read_work(&scope, "work-1").unwrap().unwrap().revision;
    let ClaimOutcome::Acquired(receipt) = store
        .claim(
            &scope,
            "work-1",
            revision.revision,
            revision.control_epoch,
            "claim-auto",
            "thread-1",
            ClaimTrigger::Automatic,
        )
        .unwrap()
    else {
        panic!("the automatic claim must be acquired")
    };
    store
        .mark_input_applied(
            &scope,
            "work-1",
            &source,
            "initial-input",
            "claim-auto",
            receipt.owner_epoch,
            receipt.control_epoch,
            AppliedInputReference {
                attempt: TurnAttemptIdentity {
                    thread_id: "thread-1".into(),
                    turn_id: "turn-1".into(),
                    attempt_id: "attempt-1".into(),
                },
                history_uuid: "history-1".into(),
            },
        )
        .unwrap();
    let facts = DurableFacts::capture(&store.read_work(&scope, "work-1").unwrap().unwrap());
    let lease = AutomaticClaimLease {
        store: ContinuousWorkStore::open_existing(directory.path())
            .unwrap()
            .unwrap(),
        scope: scope.clone(),
        work_id: "work-1".into(),
        claim_id: receipt.claim_id.clone(),
        owner_epoch: receipt.owner_epoch,
        facts,
        settled: false,
    };
    (directory, store, scope, lease)
}

fn queue(store: &ContinuousWorkStore, scope: &WorkScope, payload: serde_json::Value) {
    let revision = store.read_work(scope, "work-1").unwrap().unwrap().revision;
    store
        .queue_input(
            scope,
            "work-1",
            &owned_source(),
            revision.revision,
            "input-2",
            "request-2",
            WorkInputKind::Requirement,
            payload,
            Some(vec![]),
        )
        .unwrap();
}

#[test]
fn the_lease_dispatches_the_oldest_plain_text_requirement() {
    let (directory, store, scope, lease) = claimed_work("work-queue-oldest");
    queue(&store, &scope, json!({"text": "second requirement"}));

    let queued = lease
        .take_next_queued_input()
        .expect("a queued input exists");
    assert_eq!(queued.input_id, "input-2");
    assert_eq!(queued.text, "second requirement");
    assert_eq!(queued.source.conversation_id, "thread-1");

    // Dispatched is not applied: only a real provider request applies it.
    let work = store.read_work(&scope, "work-1").unwrap().unwrap();
    assert_eq!(work.revision.applied_input_sequence, 1);
    let pending = store.list_pending_inputs(&scope, "work-1", None).unwrap();
    assert_eq!(pending.inputs[0].receipt.state, WorkInputState::Dispatched);

    // Without an observation the input stays unconfirmed and keeps blocking.
    lease.settle_dispatched_input(&queued, None);
    let pending = store.list_pending_inputs(&scope, "work-1", None).unwrap();
    assert_eq!(
        pending.inputs[0].receipt.state,
        WorkInputState::NeedsReconciliation
    );
    drop(directory);
}

#[test]
fn a_non_text_body_is_left_queued_instead_of_guessed() {
    let (directory, store, scope, lease) = claimed_work("work-queue-non-text");
    queue(
        &store,
        &scope,
        json!({"blocks": [{"type": "image", "path": "chart.png"}]}),
    );

    assert!(
        lease.take_next_queued_input().is_none(),
        "a body without plain text must stay queued"
    );
    let pending = store.list_pending_inputs(&scope, "work-1", None).unwrap();
    assert_eq!(pending.inputs[0].receipt.state, WorkInputState::Queued);
    drop(directory);
}

#[test]
fn the_lease_settles_an_observed_request_and_requeues_an_unasked_one() {
    // Observed: the requirement really reached the provider.
    let (directory, store, scope, lease) = claimed_work("work-queue-applied");
    queue(&store, &scope, json!({"text": "third requirement"}));
    let observed = lease.take_next_queued_input().expect("queued input");
    lease.settle_dispatched_input(
        &observed,
        Some(AppliedInputReference {
            attempt: TurnAttemptIdentity {
                thread_id: "thread-1".into(),
                turn_id: "turn-2".into(),
                attempt_id: "attempt-2".into(),
            },
            history_uuid: "history-2".into(),
        }),
    );
    let work = store.read_work(&scope, "work-1").unwrap().unwrap();
    assert_eq!(work.revision.applied_input_sequence, 2);
    drop(directory);

    // Unasked: the turn never reached the provider, so the input goes back.
    let (directory, store, scope, lease) = claimed_work("work-queue-requeued");
    queue(&store, &scope, json!({"text": "third requirement"}));
    let dispatched = lease.take_next_queued_input().expect("queued input");
    lease.requeue_dispatched_input(&dispatched);
    let pending = store.list_pending_inputs(&scope, "work-1", None).unwrap();
    assert_eq!(pending.inputs[0].receipt.state, WorkInputState::Queued);
    drop(directory);
}
