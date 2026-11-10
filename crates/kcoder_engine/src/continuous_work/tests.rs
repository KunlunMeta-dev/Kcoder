use super::*;
use kcoder_types::continuous_work::WorkUsage;

const ZERO_USAGE: WorkUsage = WorkUsage {
    automatic_turns: 0,
    consecutive_failures: 0,
    stalled_rounds: 0,
};

const CAUGHT_UP: WorkRevision = WorkRevision {
    revision: 1,
    requirements_revision: 1,
    control_epoch: 0,
    owner_epoch: 0,
    accepted_input_sequence: 1,
    required_input_sequence: 1,
    applied_input_sequence: 1,
    usage: ZERO_USAGE,
};
const PENDING: WorkRevision = WorkRevision {
    revision: 2,
    requirements_revision: 2,
    control_epoch: 0,
    owner_epoch: 0,
    accepted_input_sequence: 2,
    required_input_sequence: 2,
    applied_input_sequence: 1,
    usage: ZERO_USAGE,
};

fn context(phase: &WorkPhase, trigger: Trigger) -> ContinuationContext<'_> {
    ContinuationContext {
        phase,
        revision: if trigger.is_input() {
            &PENDING
        } else {
            &CAUGHT_UP
        },
        binding: Verification::Verified,
        authority: Verification::Verified,
        dispatch_enabled: true,
        turn: TurnObservation::Idle,
        control: Condition::Clear,
        reconciliation: Condition::Clear,
        question: Condition::Clear,
        question_answer_matches: false,
        dependency: Condition::Clear,
        independent_dependency: false,
        pending_input: if trigger.is_input() {
            PendingInput::Ready
        } else {
            PendingInput::None
        },
        trigger,
        automatic_limits: Some(AutomaticLimits {
            max_turns: 8,
            max_consecutive_failures: 3,
            max_stalled_rounds: 5,
        }),
        automatic_usage: Some(AutomaticUsage {
            turns: 0,
            consecutive_failures: 0,
            stalled_rounds: 0,
        }),
    }
}

#[test]
fn accepted_input_waits_for_the_existing_turn_and_precedes_automatic_work() {
    let phase = WorkPhase::Running;
    let mut input = context(&phase, Trigger::LocalAcceptedInput);
    input.turn = TurnObservation::Active;
    assert_eq!(
        evaluate_continuation(&input),
        ContinuationDecision::Wait(WaitReason::ActiveTurn)
    );
    input.turn = TurnObservation::Idle;
    assert_eq!(
        evaluate_continuation(&input),
        ContinuationDecision::EligibleToClaim
    );
    let mut automatic = context(&phase, Trigger::NativeResult);
    automatic.pending_input = PendingInput::Ready;
    automatic.revision = &PENDING;
    assert_eq!(
        evaluate_continuation(&automatic),
        ContinuationDecision::Wait(WaitReason::InputPending)
    );
    automatic.pending_input = PendingInput::Unknown;
    assert_eq!(
        evaluate_continuation(&automatic),
        ContinuationDecision::Wait(WaitReason::InputUnobserved)
    );
}

#[test]
fn stopped_paused_and_unknown_work_cannot_be_resurrected_by_events() {
    for (phase, reason) in [
        (WorkPhase::Paused, WaitReason::Paused),
        (WorkPhase::Stopped, WaitReason::Stopped),
        (WorkPhase::Completed, WaitReason::Completed),
        (WorkPhase::Failed, WaitReason::Failed),
        (
            WorkPhase::Unknown("future".into()),
            WaitReason::UnknownPhase,
        ),
    ] {
        for trigger in [
            Trigger::LocalAcceptedInput,
            Trigger::NativeResult,
            Trigger::ExternalAcceptedInput,
            Trigger::AutomaticContinuation,
        ] {
            assert_eq!(
                evaluate_continuation(&context(&phase, trigger)),
                ContinuationDecision::Wait(reason)
            );
        }
    }
}

#[test]
fn binding_and_authority_are_required_even_when_the_input_is_explicit() {
    let phase = WorkPhase::Pending;
    let mut c = context(&phase, Trigger::LocalAcceptedInput);
    c.binding = Verification::Denied;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::BindingDenied)
    );
    c.binding = Verification::Verified;
    c.authority = Verification::Unavailable;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::AuthorityUnavailable)
    );
}

#[test]
fn unknown_side_effects_and_wait_conditions_never_start_a_model_turn() {
    let phase = WorkPhase::WaitingEvent;
    let mut c = context(&phase, Trigger::NativeResult);
    c.reconciliation = Condition::Blocked;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::ReconcileOriginal
    );
    c.reconciliation = Condition::Unknown;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::ReconciliationUnobserved)
    );
    c.reconciliation = Condition::Clear;
    c.question = Condition::Blocked;
    c.independent_dependency = true;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::QuestionPending)
    );
    c.question = Condition::Clear;
    c.dependency = Condition::Blocked;
    c.independent_dependency = false;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::DependencyPending)
    );
    c.independent_dependency = true;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::EligibleToClaim
    );
    c.dependency = Condition::Unknown;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::DependencyUnobserved)
    );
}

#[test]
fn disabled_automatic_dispatch_preserves_explicit_local_input() {
    let phase = WorkPhase::Running;
    let mut automatic = context(&phase, Trigger::ExternalAcceptedInput);
    automatic.dispatch_enabled = false;
    assert_eq!(
        evaluate_continuation(&automatic),
        ContinuationDecision::Wait(WaitReason::DispatchDisabled)
    );
    let mut local = context(&phase, Trigger::LocalAcceptedInput);
    local.dispatch_enabled = false;
    local.automatic_limits = None;
    local.automatic_usage = None;
    assert_eq!(
        evaluate_continuation(&local),
        ContinuationDecision::EligibleToClaim
    );
}

#[test]
fn automatic_limits_require_observed_batch_counters_without_fabricating_completion() {
    let phase = WorkPhase::Running;
    let mut c = context(&phase, Trigger::AutomaticContinuation);
    c.automatic_usage = None;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::AutomaticPolicyUnobserved)
    );
    for (usage, reason) in [
        (
            AutomaticUsage {
                turns: 8,
                consecutive_failures: 0,
                stalled_rounds: 0,
            },
            WaitReason::AutomaticTurnLimit,
        ),
        (
            AutomaticUsage {
                turns: 1,
                consecutive_failures: 3,
                stalled_rounds: 0,
            },
            WaitReason::FailureLimit,
        ),
        (
            AutomaticUsage {
                turns: 1,
                consecutive_failures: 0,
                stalled_rounds: 5,
            },
            WaitReason::StallLimit,
        ),
    ] {
        c.automatic_usage = Some(usage);
        assert_eq!(
            evaluate_continuation(&c),
            ContinuationDecision::Wait(reason)
        );
    }
}

#[test]
fn missing_turn_or_input_observations_do_not_create_work() {
    let phase = WorkPhase::Pending;
    let mut c = context(&phase, Trigger::LocalAcceptedInput);
    c.turn = TurnObservation::Unknown;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::TurnUnobserved)
    );
    c.turn = TurnObservation::Idle;
    c.pending_input = PendingInput::None;
    c.revision = &CAUGHT_UP;
    assert_eq!(evaluate_continuation(&c), ContinuationDecision::NoWork);
}

#[test]
fn accepted_input_watermarks_cannot_be_hidden_by_a_missing_queue_observation() {
    let phase = WorkPhase::Running;
    let mut c = context(&phase, Trigger::AutomaticContinuation);
    c.revision = &PENDING;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::InputUnobserved)
    );
    let invalid = WorkRevision {
        required_input_sequence: 3,
        ..PENDING
    };
    c.revision = &invalid;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::InvalidRevision)
    );
}

#[test]
fn only_the_verified_answer_can_settle_the_original_waiting_question() {
    let phase = WorkPhase::WaitingUser;
    let mut c = context(&phase, Trigger::LocalAcceptedInput);
    c.turn = TurnObservation::Active;
    c.question = Condition::Blocked;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::ActiveTurn)
    );
    c.question_answer_matches = true;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::ResolveOriginalQuestion
    );
    c.control = Condition::Blocked;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::ControlPending)
    );
    c.control = Condition::Clear;
    c.pending_input = PendingInput::Unknown;
    assert_eq!(
        evaluate_continuation(&c),
        ContinuationDecision::Wait(WaitReason::InputUnobserved)
    );
}

#[test]
fn reconciliation_is_not_treated_as_a_retry() {
    let phase = WorkPhase::NeedsReconciliation;
    for trigger in [
        Trigger::LocalAcceptedInput,
        Trigger::NativeResult,
        Trigger::AutomaticContinuation,
    ] {
        assert_eq!(
            evaluate_continuation(&context(&phase, trigger)),
            ContinuationDecision::ReconcileOriginal
        );
    }
}
