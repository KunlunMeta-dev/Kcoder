//! Preparation and durable claim for one continuous-work continuation.
//!
//! The host supplies observations from its real thread, interaction, source,
//! and policy owners. Preparing and claiming do not start a turn, grant a tool,
//! answer a question, or establish that a claimed process is still alive.

use super::{
    AutomaticLimits, AutomaticUsage, Condition, ContinuationContext, ContinuationDecision,
    PendingInput, Trigger, TurnObservation, Verification, WaitReason, evaluate_continuation,
};
use anyhow::{Context, Result};
use kcoder_state::continuous_work::{ClaimOutcome, ClaimTrigger, ContinuousWorkStore};
use kcoder_types::continuous_work::{
    WorkControlAction, WorkControlState, WorkControlTarget, WorkScope,
};

/// Facts observed by the trusted host; these values must not be copied from an
/// RPC client's authorization claims or inferred from a model response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostObservations {
    pub binding: Verification,
    pub authority: Verification,
    pub dispatch_enabled: bool,
    pub turn: TurnObservation,
    pub reconciliation: Condition,
    pub question: Condition,
    pub question_answer_matches: bool,
    pub dependency: Condition,
    pub independent_dependency: bool,
    pub trigger: Trigger,
    pub automatic_limits: Option<AutomaticLimits>,
    pub automatic_usage: Option<AutomaticUsage>,
}

/// A private snapshot of the exact revision that was evaluated. Acquiring it
/// later uses the State transaction's compare-and-set, so an intervening input
/// or control cannot be overwritten by this preparation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedClaim {
    scope: WorkScope,
    work_id: String,
    thread_id: String,
    claim_id: String,
    revision: u64,
    control_epoch: u64,
    trigger: ClaimTrigger,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparedContinuation {
    Claim(PreparedClaim),
    Wait(WaitReason),
    ReconcileOriginal,
    /// Only a proposed route to the original question. The host must still
    /// atomically verify the current control and original interaction receipt.
    ResolveOriginalQuestion,
    NoWork,
}

/// Inspect one explicitly bound work item without creating or repairing it.
/// No State lock is held while the host later waits for the thread gate.
pub fn prepare_claim(
    store: &ContinuousWorkStore,
    scope: &WorkScope,
    work_id: &str,
    thread_id: &str,
    claim_id: &str,
    observations: HostObservations,
) -> Result<PreparedContinuation> {
    match observations.binding {
        Verification::Denied => return Ok(PreparedContinuation::Wait(WaitReason::BindingDenied)),
        Verification::Unavailable => {
            return Ok(PreparedContinuation::Wait(WaitReason::BindingUnavailable));
        }
        Verification::Verified => {}
    }
    match observations.authority {
        Verification::Denied => return Ok(PreparedContinuation::Wait(WaitReason::AuthorityDenied)),
        Verification::Unavailable => {
            return Ok(PreparedContinuation::Wait(WaitReason::AuthorityUnavailable));
        }
        Verification::Verified => {}
    }
    let work = store
        .read_work(scope, work_id)?
        .context("CONTINUOUS_WORK_NOT_FOUND")?;
    if !work.linked_thread_ids.iter().any(|id| id == thread_id) {
        return Ok(PreparedContinuation::Wait(WaitReason::BindingDenied));
    }
    let control = match store.current_control(scope, work_id)? {
        None if work.revision.control_epoch == 0 => Condition::Clear,
        None => Condition::Unknown,
        Some(control) if control.control_epoch != work.revision.control_epoch => Condition::Unknown,
        Some(control)
            if control.state == WorkControlState::Settled
                && control.action == WorkControlAction::Resume
                && control.target.matches_action(&control.action)
                && matches!(control.target.known(), Some(WorkControlTarget::Work {})) =>
        {
            Condition::Clear
        }
        Some(_) => Condition::Blocked,
    };
    let pending_input =
        if work.revision.applied_input_sequence < work.revision.accepted_input_sequence {
            PendingInput::Ready
        } else {
            PendingInput::None
        };
    let context = ContinuationContext {
        phase: &work.phase,
        revision: &work.revision,
        binding: observations.binding,
        authority: observations.authority,
        dispatch_enabled: observations.dispatch_enabled,
        turn: observations.turn,
        control,
        reconciliation: observations.reconciliation,
        question: observations.question,
        question_answer_matches: observations.question_answer_matches,
        dependency: observations.dependency,
        independent_dependency: observations.independent_dependency,
        pending_input,
        trigger: observations.trigger,
        automatic_limits: observations.automatic_limits,
        automatic_usage: observations.automatic_usage,
    };
    Ok(match evaluate_continuation(&context) {
        ContinuationDecision::EligibleToClaim => PreparedContinuation::Claim(PreparedClaim {
            scope: scope.clone(),
            work_id: work_id.to_owned(),
            thread_id: thread_id.to_owned(),
            claim_id: claim_id.to_owned(),
            revision: work.revision.revision,
            control_epoch: work.revision.control_epoch,
            trigger: if observations.trigger.is_automatic() {
                ClaimTrigger::Automatic
            } else {
                ClaimTrigger::Input
            },
        }),
        ContinuationDecision::Wait(reason) => PreparedContinuation::Wait(reason),
        ContinuationDecision::ReconcileOriginal => PreparedContinuation::ReconcileOriginal,
        ContinuationDecision::ResolveOriginalQuestion => {
            PreparedContinuation::ResolveOriginalQuestion
        }
        ContinuationDecision::NoWork => PreparedContinuation::NoWork,
    })
}

/// Atomically claim only the previously observed revision. `ExistingActive`
/// means reconcile the old claim, never start a second turn. The host must
/// subsequently acquire the original thread gate and revalidate the binding,
/// authorization, owner/control epochs, requirements, and pending input before
/// publishing an active handle or dispatching an operation.
pub fn acquire_claim(
    store: &ContinuousWorkStore,
    prepared: &PreparedClaim,
) -> Result<ClaimOutcome> {
    store.claim(
        &prepared.scope,
        &prepared.work_id,
        prepared.revision,
        prepared.control_epoch,
        &prepared.claim_id,
        &prepared.thread_id,
        prepared.trigger,
    )
}

#[cfg(test)]
#[path = "coordinator/tests.rs"]
mod tests;
