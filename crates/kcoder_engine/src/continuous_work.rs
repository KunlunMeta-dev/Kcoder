//! Read-only continuation decisions for a bound business work item.
//!
//! This module neither grants authority nor starts a turn. The host must obtain
//! these facts from the target's current records, acquire the durable claim and
//! existing thread gate, and recheck the same revisions before dispatching.

pub mod coordinator;
pub mod host_gate;
pub mod input_handoff;
pub mod native_result;

use kcoder_types::continuous_work::{WorkPhase, WorkRevision};

/// Result of checking an actual host-owned binding or an original permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verification {
    Verified,
    Denied,
    Unavailable,
}

/// A missing observation must not be treated as a cleared condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Condition {
    Clear,
    Blocked,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnObservation {
    Idle,
    Active,
    Unknown,
}

/// This describes durable acceptance, not whether a model has consumed input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingInput {
    None,
    Ready,
    Unknown,
}

/// The original event remains with its native owner; this only selects a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    LocalAcceptedInput,
    ExternalAcceptedInput,
    NativeResult,
    AutomaticContinuation,
}

impl Trigger {
    fn is_automatic(self) -> bool {
        !matches!(self, Self::LocalAcceptedInput)
    }

    fn is_input(self) -> bool {
        matches!(self, Self::LocalAcceptedInput | Self::ExternalAcceptedInput)
    }
}

/// Values resolved by the host from the effective existing configuration.
/// Counters belong to the same durable business batch, not a process restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutomaticLimits {
    pub max_turns: u64,
    pub max_consecutive_failures: u64,
    pub max_stalled_rounds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutomaticUsage {
    pub turns: u64,
    pub consecutive_failures: u64,
    pub stalled_rounds: u64,
}

/// All observations are supplied by the native host. `independent_dependency`
/// is true only when the original execution authority has established that the
/// selected step does not depend on the blocked dependency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContinuationContext<'a> {
    pub phase: &'a WorkPhase,
    /// The current target-owned watermarks; never supplied by the model.
    pub revision: &'a WorkRevision,
    pub binding: Verification,
    pub authority: Verification,
    pub dispatch_enabled: bool,
    pub turn: TurnObservation,
    /// A durable pause/stop intent fences dispatch before its resources settle.
    pub control: Condition,
    pub reconciliation: Condition,
    pub question: Condition,
    /// The host verified that this exact accepted input answers the original
    /// pending interaction. Similar text or an arbitrary message is not proof.
    pub question_answer_matches: bool,
    pub dependency: Condition,
    pub independent_dependency: bool,
    pub pending_input: PendingInput,
    pub trigger: Trigger,
    /// Missing counters or policy block automatic dispatch rather than resetting it.
    pub automatic_limits: Option<AutomaticLimits>,
    pub automatic_usage: Option<AutomaticUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitReason {
    BindingDenied,
    BindingUnavailable,
    AuthorityDenied,
    AuthorityUnavailable,
    DispatchDisabled,
    Paused,
    Stopped,
    Completed,
    Failed,
    UnknownPhase,
    InvalidRevision,
    ControlPending,
    ControlUnobserved,
    ActiveTurn,
    TurnUnobserved,
    ReconciliationUnobserved,
    QuestionPending,
    QuestionUnobserved,
    DependencyPending,
    DependencyUnobserved,
    InputPending,
    InputUnobserved,
    AutomaticPolicyUnobserved,
    AutomaticTurnLimit,
    FailureLimit,
    StallLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuationDecision {
    /// A subsequent atomic claim and revalidation are still required.
    EligibleToClaim,
    /// Keep already accepted input/results; do not create a model turn.
    Wait(WaitReason),
    /// Inspect the original operation; do not replay its side effect.
    ReconcileOriginal,
    /// Deliver the verified answer to its original interaction, without
    /// starting a competing turn. Its receipt still requires native settlement.
    ResolveOriginalQuestion,
    /// No accepted input exists for the selected input trigger.
    NoWork,
}

/// Choose whether the selected work may compete for the existing execution gate.
/// This read-only decision cannot by itself establish uniqueness or completion.
pub fn evaluate_continuation(context: &ContinuationContext<'_>) -> ContinuationDecision {
    use ContinuationDecision::{
        EligibleToClaim, NoWork, ReconcileOriginal, ResolveOriginalQuestion, Wait,
    };
    use WaitReason as Why;

    match context.binding {
        Verification::Denied => return Wait(Why::BindingDenied),
        Verification::Unavailable => return Wait(Why::BindingUnavailable),
        Verification::Verified => {}
    }
    match context.authority {
        Verification::Denied => return Wait(Why::AuthorityDenied),
        Verification::Unavailable => return Wait(Why::AuthorityUnavailable),
        Verification::Verified => {}
    }
    match context.phase {
        WorkPhase::Paused => return Wait(Why::Paused),
        WorkPhase::Stopped => return Wait(Why::Stopped),
        WorkPhase::Completed => return Wait(Why::Completed),
        WorkPhase::Failed => return Wait(Why::Failed),
        WorkPhase::Unknown(_) => return Wait(Why::UnknownPhase),
        WorkPhase::NeedsReconciliation => return ReconcileOriginal,
        WorkPhase::Pending
        | WorkPhase::Running
        | WorkPhase::WaitingUser
        | WorkPhase::WaitingEvent => {}
    }
    if context.revision.validate_shape().is_err() {
        return Wait(Why::InvalidRevision);
    }
    match context.control {
        Condition::Blocked => return Wait(Why::ControlPending),
        Condition::Unknown => return Wait(Why::ControlUnobserved),
        Condition::Clear => {}
    }
    match context.reconciliation {
        Condition::Blocked => return ReconcileOriginal,
        Condition::Unknown => return Wait(Why::ReconciliationUnobserved),
        Condition::Clear => {}
    }
    if context.trigger.is_automatic() && !context.dispatch_enabled {
        return Wait(Why::DispatchDisabled);
    }
    let has_unapplied_input =
        context.revision.applied_input_sequence < context.revision.accepted_input_sequence;
    match (context.pending_input, has_unapplied_input) {
        (PendingInput::Unknown, _) | (PendingInput::None, true) | (PendingInput::Ready, false) => {
            return Wait(Why::InputUnobserved);
        }
        (PendingInput::None, false) | (PendingInput::Ready, true) => {}
    }
    if context.question == Condition::Blocked
        && context.question_answer_matches
        && context.trigger.is_input()
        && context.pending_input == PendingInput::Ready
    {
        return ResolveOriginalQuestion;
    }
    match context.turn {
        TurnObservation::Active => return Wait(Why::ActiveTurn),
        TurnObservation::Unknown => return Wait(Why::TurnUnobserved),
        TurnObservation::Idle => {}
    }
    match context.question {
        Condition::Blocked => return Wait(Why::QuestionPending),
        Condition::Unknown => return Wait(Why::QuestionUnobserved),
        Condition::Clear => {}
    }
    match context.dependency {
        Condition::Blocked if !context.independent_dependency => {
            return Wait(Why::DependencyPending);
        }
        Condition::Unknown => return Wait(Why::DependencyUnobserved),
        Condition::Blocked | Condition::Clear => {}
    }
    match (context.pending_input, context.trigger.is_input()) {
        (PendingInput::Unknown, _) => return Wait(Why::InputUnobserved),
        (PendingInput::Ready, false) => return Wait(Why::InputPending),
        (PendingInput::None, true) => return NoWork,
        (PendingInput::Ready, true) | (PendingInput::None, false) => {}
    }
    if context.trigger.is_automatic() {
        let (Some(limits), Some(usage)) = (context.automatic_limits, context.automatic_usage)
        else {
            return Wait(Why::AutomaticPolicyUnobserved);
        };
        if usage.turns >= limits.max_turns {
            return Wait(Why::AutomaticTurnLimit);
        }
        if usage.consecutive_failures >= limits.max_consecutive_failures {
            return Wait(Why::FailureLimit);
        }
        if usage.stalled_rounds >= limits.max_stalled_rounds {
            return Wait(Why::StallLimit);
        }
    }
    EligibleToClaim
}

#[cfg(test)]
#[path = "continuous_work/tests.rs"]
mod tests;
