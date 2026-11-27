use super::*;
use kcoder_state::continuous_work::{ClaimOutcome, ContinuousWorkStore, WorkInputSource};
use kcoder_types::continuous_work::{
    WorkControlAction, WorkControlTarget, WorkInputKind, WorkRecord, WorkScope,
};
use serde_json::json;

fn source() -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: "thread-1".into(),
    }
}

fn fixture() -> (
    kcoder_config::PrivateTempDir,
    ContinuousWorkStore,
    WorkScope,
) {
    let directory = kcoder_config::create_private_temp_dir("continuous-coordinator").unwrap();
    let store = ContinuousWorkStore::open_or_create(directory.path()).unwrap();
    let scope = WorkScope {
        account_id: "owned-account".into(),
        target_id: "owned-target".into(),
        workspace_id: "owned-workspace".into(),
    };
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
            &source(),
            "initial-input",
            json!({"text":"original task"}),
            vec![],
        )
        .unwrap();
    (directory, store, scope)
}

fn facts() -> HostObservations {
    HostObservations {
        binding: Verification::Verified,
        authority: Verification::Verified,
        dispatch_enabled: true,
        turn: TurnObservation::Idle,
        reconciliation: Condition::Clear,
        question: Condition::Clear,
        question_answer_matches: false,
        dependency: Condition::Clear,
        independent_dependency: false,
        trigger: Trigger::LocalAcceptedInput,
        automatic_limits: None,
        automatic_usage: None,
    }
}

fn prepared(store: &ContinuousWorkStore, scope: &WorkScope, claim: &str) -> PreparedClaim {
    match prepare_claim(store, scope, "work-1", "thread-1", claim, facts()).unwrap() {
        PreparedContinuation::Claim(prepared) => prepared,
        other => panic!("expected a claim preparation, got {other:?}"),
    }
}

#[test]
fn new_input_between_preparation_and_claim_invalidates_the_old_snapshot() {
    let (_directory, store, scope) = fixture();
    let old = prepared(&store, &scope, "claim-old");
    store
        .accept_input(
            &scope,
            "work-1",
            &source(),
            1,
            "input-2",
            "request-2",
            WorkInputKind::Requirement,
            json!({"text":"new requirement"}),
            Some(vec![]),
        )
        .unwrap();
    assert!(acquire_claim(&store, &old).is_err());
    assert!(store.active_claim(&scope, "work-1").unwrap().is_none());
    let current = prepared(&store, &scope, "claim-new");
    assert!(matches!(
        acquire_claim(&store, &current).unwrap(),
        ClaimOutcome::Acquired(_)
    ));
}

#[test]
fn competing_claims_have_one_owner_and_replay_does_not_authorize_a_second_turn() {
    let (_directory, store, scope) = fixture();
    let first = prepared(&store, &scope, "claim-1");
    let competing = prepared(&store, &scope, "claim-2");
    assert!(matches!(
        acquire_claim(&store, &first).unwrap(),
        ClaimOutcome::Acquired(_)
    ));
    assert!(acquire_claim(&store, &competing).is_err());
    assert!(matches!(
        acquire_claim(&store, &first).unwrap(),
        ClaimOutcome::ExistingActive(_)
    ));
}

#[test]
fn replay_of_an_active_claim_after_new_input_does_not_grant_another_dispatch() {
    let (_directory, store, scope) = fixture();
    let first = prepared(&store, &scope, "claim-1");
    let ClaimOutcome::Acquired(original) = acquire_claim(&store, &first).unwrap() else {
        panic!("first claim should be acquired")
    };
    let revision = store
        .read_work(&scope, "work-1")
        .unwrap()
        .unwrap()
        .revision
        .revision;
    store
        .accept_input(
            &scope,
            "work-1",
            &source(),
            revision,
            "input-2",
            "request-2",
            WorkInputKind::Requirement,
            json!({"text":"new requirement"}),
            Some(vec![]),
        )
        .unwrap();
    let ClaimOutcome::ExistingActive(replayed) = acquire_claim(&store, &first).unwrap() else {
        panic!("replay must not create a new claim")
    };
    assert_eq!(replayed, original);
    assert_eq!(
        store.active_claim(&scope, "work-1").unwrap(),
        Some(original)
    );
}

#[test]
fn accepted_pause_fences_a_prepared_claim_before_phase_settles() {
    let (_directory, store, scope) = fixture();
    let old = prepared(&store, &scope, "claim-1");
    store
        .control(
            &scope,
            "work-1",
            1,
            "pause-1",
            WorkControlAction::Pause,
            WorkControlTarget::Work {},
        )
        .unwrap();
    assert!(acquire_claim(&store, &old).is_err());
    assert_eq!(
        prepare_claim(&store, &scope, "work-1", "thread-1", "claim-2", facts()).unwrap(),
        PreparedContinuation::Wait(WaitReason::ControlPending)
    );
    assert!(store.active_claim(&scope, "work-1").unwrap().is_none());
}

#[test]
fn a_caller_cannot_claim_a_different_thread_or_profile() {
    let (_directory, store, scope) = fixture();
    assert_eq!(
        prepare_claim(&store, &scope, "work-1", "other-thread", "claim-1", facts()).unwrap(),
        PreparedContinuation::Wait(WaitReason::BindingDenied)
    );
    let other = WorkScope {
        account_id: "other-account".into(),
        ..scope.clone()
    };
    assert!(prepare_claim(&store, &other, "work-1", "thread-1", "claim-1", facts()).is_err());
    let mut no_authority = facts();
    no_authority.authority = Verification::Unavailable;
    assert_eq!(
        prepare_claim(
            &store,
            &scope,
            "work-1",
            "thread-1",
            "claim-1",
            no_authority
        )
        .unwrap(),
        PreparedContinuation::Wait(WaitReason::AuthorityUnavailable)
    );
}

#[test]
fn exact_question_answer_is_routed_without_claiming_a_competing_turn() {
    let (_directory, store, scope) = fixture();
    let mut answer = facts();
    answer.turn = TurnObservation::Active;
    answer.question = Condition::Blocked;
    answer.question_answer_matches = true;
    assert_eq!(
        prepare_claim(&store, &scope, "work-1", "thread-1", "claim-1", answer).unwrap(),
        PreparedContinuation::ResolveOriginalQuestion
    );
    assert!(store.active_claim(&scope, "work-1").unwrap().is_none());
}
