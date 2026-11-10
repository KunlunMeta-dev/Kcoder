use super::*;

use kcoder_config::Settings;
use kcoder_state::continuous_work::{
    AppliedInputReference, ClaimOutcome, ClaimSettlement, ClaimTrigger, WorkInputSource,
};
use kcoder_types::TurnAttemptIdentity;
use kcoder_types::continuous_work::{WorkRecord, WorkRevision, WorkUsage};
use serde_json::json;

use crate::continuous_work::{
    AutomaticLimits, AutomaticUsage, Condition, Trigger, TurnObservation, Verification, WaitReason,
};

fn source() -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: "thread-1".into(),
    }
}

fn attempt() -> TurnAttemptIdentity {
    TurnAttemptIdentity {
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        attempt_id: "attempt-1".into(),
    }
}

/// One admitted pending work item bound to `thread-1`, in a private store.
fn fixture(
    name: &str,
) -> (
    kcoder_config::PrivateTempDir,
    ContinuousWorkStore,
    WorkScope,
) {
    let directory = kcoder_config::create_private_temp_dir(name).unwrap();
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

fn idle_facts() -> HostGateFacts {
    HostGateFacts {
        binding: Verification::Verified,
        authority: Verification::Verified,
        turn: TurnObservation::Idle,
        reconciliation: Condition::Clear,
        question: Condition::Clear,
        question_answer_matches: false,
        dependency: Condition::Clear,
        independent_dependency: false,
    }
}

fn current_revision(store: &ContinuousWorkStore, scope: &WorkScope) -> WorkRevision {
    store.read_work(scope, "work-1").unwrap().unwrap().revision
}

#[test]
fn goal_and_business_batches_use_the_goal_turn_limit_and_orchestrate_keeps_its_own() {
    let mut settings = Settings {
        goal_max_auto_continuations: 3,
        ..Settings::default()
    };
    settings.orchestrate.continuation.max_auto_turns = 9;
    settings.orchestrate.continuation.max_consecutive_failures = 4;
    settings.orchestrate.continuation.max_stalled_rounds = 6;

    for scope in [ContinuationScope::Goal, ContinuationScope::Business] {
        assert_eq!(
            automatic_limits(&settings, scope),
            AutomaticLimits {
                max_turns: 3,
                max_consecutive_failures: 4,
                max_stalled_rounds: 6,
            },
            "{} must use the goal turn budget",
            scope.as_str()
        );
    }
    assert_eq!(
        automatic_limits(&settings, ContinuationScope::Orchestrate),
        AutomaticLimits {
            max_turns: 9,
            max_consecutive_failures: 4,
            max_stalled_rounds: 6,
        }
    );

    let defaults = Settings::default();
    assert_eq!(
        automatic_limits(&defaults, ContinuationScope::Goal).max_turns,
        8
    );
    assert_eq!(
        automatic_limits(&defaults, ContinuationScope::Business),
        AutomaticLimits {
            max_turns: 8,
            max_consecutive_failures: 3,
            max_stalled_rounds: 5,
        }
    );
    assert_eq!(ContinuationScope::Goal.as_str(), "goal");
    assert_eq!(ContinuationScope::Orchestrate.as_str(), "orchestrate");
    assert_eq!(ContinuationScope::Business.as_str(), "business");
}

#[test]
fn automatic_usage_maps_the_durable_batch_counters() {
    let revision = WorkRevision {
        revision: 4,
        requirements_revision: 2,
        control_epoch: 1,
        owner_epoch: 3,
        accepted_input_sequence: 2,
        required_input_sequence: 2,
        applied_input_sequence: 1,
        usage: WorkUsage {
            automatic_turns: 7,
            consecutive_failures: 2,
            stalled_rounds: 5,
        },
    };
    assert_eq!(
        automatic_usage(&revision),
        AutomaticUsage {
            turns: 7,
            consecutive_failures: 2,
            stalled_rounds: 5,
        }
    );
    let fresh = WorkRevision {
        usage: WorkUsage::default(),
        ..revision
    };
    assert_eq!(
        automatic_usage(&fresh),
        AutomaticUsage {
            turns: 0,
            consecutive_failures: 0,
            stalled_rounds: 0,
        }
    );
}

#[test]
fn dispatch_valve_is_on_by_default_and_follows_the_explicit_setting() {
    assert!(dispatch_enabled(&Settings::default()));
    let mut disabled = Settings::default();
    disabled.continuous_work.dispatch_enabled = false;
    assert!(!dispatch_enabled(&disabled));
}

#[test]
fn a_missing_record_is_reported_without_fabricated_counters() {
    let (_directory, store, scope) = fixture("continuous-host-gate-missing");
    assert_eq!(
        prepare_host_claim(
            &store,
            &scope,
            "work-missing",
            "thread-1",
            "claim-missing",
            Trigger::AutomaticContinuation,
            ContinuationScope::Goal,
            &Settings::default(),
            idle_facts(),
        )
        .unwrap(),
        PreparedContinuation::NoWork
    );
}

#[test]
fn unverified_facts_are_never_upgraded_by_the_gate() {
    let (_directory, store, scope) = fixture("continuous-host-gate-facts");
    let mut facts = idle_facts();
    facts.binding = Verification::Unavailable;
    assert_eq!(
        prepare_host_claim(
            &store,
            &scope,
            "work-1",
            "thread-1",
            "claim-1",
            Trigger::LocalAcceptedInput,
            ContinuationScope::Goal,
            &Settings::default(),
            facts,
        )
        .unwrap(),
        PreparedContinuation::Wait(WaitReason::BindingUnavailable)
    );

    let mut facts = idle_facts();
    facts.turn = TurnObservation::Unknown;
    assert_eq!(
        prepare_host_claim(
            &store,
            &scope,
            "work-1",
            "thread-1",
            "claim-2",
            Trigger::LocalAcceptedInput,
            ContinuationScope::Goal,
            &Settings::default(),
            facts,
        )
        .unwrap(),
        PreparedContinuation::Wait(WaitReason::TurnUnobserved)
    );
}

#[test]
fn a_closed_valve_blocks_automatic_dispatch_but_not_explicit_input() {
    let (_directory, store, scope) = fixture("continuous-host-gate-valve");
    let mut settings = Settings::default();
    settings.continuous_work.dispatch_enabled = false;

    assert_eq!(
        prepare_host_claim(
            &store,
            &scope,
            "work-1",
            "thread-1",
            "claim-automatic",
            Trigger::AutomaticContinuation,
            ContinuationScope::Business,
            &settings,
            idle_facts(),
        )
        .unwrap(),
        PreparedContinuation::Wait(WaitReason::DispatchDisabled)
    );
    assert!(matches!(
        prepare_host_claim(
            &store,
            &scope,
            "work-1",
            "thread-1",
            "claim-input",
            Trigger::LocalAcceptedInput,
            ContinuationScope::Orchestrate,
            &settings,
            idle_facts(),
        )
        .unwrap(),
        PreparedContinuation::Claim(_)
    ));
}

#[test]
fn the_persisted_batch_counters_stop_the_next_automatic_dispatch() {
    let (_directory, store, scope) = fixture("continuous-host-gate-limit");

    // Apply the accepted request under its own claim so the automatic trigger is
    // no longer fenced by unapplied input.
    let revision = current_revision(&store, &scope);
    let ClaimOutcome::Acquired(input) = store
        .claim(
            &scope,
            "work-1",
            revision.revision,
            revision.control_epoch,
            "claim-input",
            "thread-1",
            ClaimTrigger::Input,
        )
        .unwrap()
    else {
        panic!("the explicit input claim must be acquired");
    };
    store
        .mark_input_applied(
            &scope,
            "work-1",
            &source(),
            "initial-input",
            "claim-input",
            input.owner_epoch,
            input.control_epoch,
            AppliedInputReference {
                attempt: attempt(),
                history_uuid: "history-1".into(),
            },
        )
        .unwrap();
    store
        .release_claim(
            &scope,
            "work-1",
            "claim-input",
            input.owner_epoch,
            ClaimSettlement::Abandoned,
        )
        .unwrap();

    // One automatic turn really happened and settled.
    let revision = current_revision(&store, &scope);
    let ClaimOutcome::Acquired(automatic) = store
        .claim(
            &scope,
            "work-1",
            revision.revision,
            revision.control_epoch,
            "claim-auto-1",
            "thread-1",
            ClaimTrigger::Automatic,
        )
        .unwrap()
    else {
        panic!("the automatic claim must be acquired");
    };
    store
        .release_claim(
            &scope,
            "work-1",
            "claim-auto-1",
            automatic.owner_epoch,
            ClaimSettlement::Completed,
        )
        .unwrap();
    assert_eq!(automatic_usage(&current_revision(&store, &scope)).turns, 1);

    let mut settings = Settings {
        goal_max_auto_continuations: 1,
        ..Settings::default()
    };
    assert_eq!(
        prepare_host_claim(
            &store,
            &scope,
            "work-1",
            "thread-1",
            "claim-next",
            Trigger::AutomaticContinuation,
            ContinuationScope::Business,
            &settings,
            idle_facts(),
        )
        .unwrap(),
        PreparedContinuation::Wait(WaitReason::AutomaticTurnLimit)
    );

    // The same durable revision becomes eligible only when the batch budget
    // allows another turn, so the wait came from the counters, not another gate.
    settings.goal_max_auto_continuations = 2;
    assert!(matches!(
        prepare_host_claim(
            &store,
            &scope,
            "work-1",
            "thread-1",
            "claim-next",
            Trigger::AutomaticContinuation,
            ContinuationScope::Business,
            &settings,
            idle_facts(),
        )
        .unwrap(),
        PreparedContinuation::Claim(_)
    ));
}
