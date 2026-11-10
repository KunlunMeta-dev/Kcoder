//! Host-facing assembly of one automatic continuous-work dispatch decision.
//!
//! The host still owns the durable claim, the original thread gate and the final
//! revalidation. This module only turns the effective settings and the work
//! revision the host already read into the observations that
//! [`super::coordinator::prepare_claim`] requires, so no caller invents limits,
//! counters or missing-value defaults.

use kcoder_config::Settings;
use kcoder_state::continuous_work::ContinuousWorkStore;
use kcoder_types::continuous_work::{WorkRevision, WorkScope};

use super::coordinator::{self, HostObservations, PreparedContinuation};

/// Which existing automatic-continuation policy one dispatch belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuationScope {
    /// A `/goal` continuation keeps its own process-scoped limit.
    Goal,
    /// An orchestrate continuation keeps the orchestrate continuation limits.
    Orchestrate,
    /// Background follow-up, source events and other business batches belong
    /// to a Goal-backed work item and spend the Goal turn budget, so tuning
    /// Orchestrate never changes ordinary sessions.
    Business,
}

impl ContinuationScope {
    /// Host-visible label used in logs and wait notices.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Goal => "goal",
            Self::Orchestrate => "orchestrate",
            Self::Business => "business",
        }
    }
}

/// Resolve the automatic limits of one dispatch from the effective settings.
pub fn automatic_limits(settings: &Settings, scope: ContinuationScope) -> super::AutomaticLimits {
    // Business batches are Goal sidecars, so they read the Goal turn budget.
    // Only orchestrate mode keeps the orchestrate continuation budget.
    let max_turns = match scope {
        ContinuationScope::Goal | ContinuationScope::Business => {
            settings.goal_max_auto_continuations as u64
        }
        ContinuationScope::Orchestrate => settings.orchestrate.continuation.max_auto_turns as u64,
    };
    // Goal has no independent failure or stall setting, so every scope reads the
    // existing bounded batch defaults (3 / 5) instead of inventing new ones.
    super::AutomaticLimits {
        max_turns,
        max_consecutive_failures: settings.orchestrate.continuation.max_consecutive_failures as u64,
        max_stalled_rounds: settings.orchestrate.continuation.max_stalled_rounds as u64,
    }
}

/// Map the durable counters of the exact revision the host read.
pub fn automatic_usage(revision: &WorkRevision) -> super::AutomaticUsage {
    super::AutomaticUsage {
        turns: revision.usage.automatic_turns,
        consecutive_failures: revision.usage.consecutive_failures,
        stalled_rounds: revision.usage.stalled_rounds,
    }
}

/// The host-owned valve. It blocks automatic dispatch only; explicit local input,
/// reads, reconciliation, pause and stop keep their own paths.
pub fn dispatch_enabled(settings: &Settings) -> bool {
    settings.continuous_work.dispatch_enabled
}

/// Facts the host verified itself, never an RPC claim or model output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostGateFacts {
    pub binding: super::Verification,
    pub authority: super::Verification,
    pub turn: super::TurnObservation,
    pub reconciliation: super::Condition,
    pub question: super::Condition,
    pub question_answer_matches: bool,
    pub dependency: super::Condition,
    pub independent_dependency: bool,
}

/// Assemble the single observation set for one `prepare_claim` call.
///
/// `facts` are passed through unchanged: this function never upgrades an
/// unverified binding, authority, turn or wait condition on the caller's behalf,
/// and a missing record reports `NoWork` instead of a fabricated revision.
#[allow(clippy::too_many_arguments)]
pub fn prepare_host_claim(
    store: &ContinuousWorkStore,
    scope: &WorkScope,
    work_id: &str,
    thread_id: &str,
    claim_id: &str,
    trigger: super::Trigger,
    continuation: ContinuationScope,
    settings: &Settings,
    facts: HostGateFacts,
) -> anyhow::Result<PreparedContinuation> {
    let Some(work) = store.read_work(scope, work_id)? else {
        return Ok(PreparedContinuation::NoWork);
    };
    let observations = HostObservations {
        binding: facts.binding,
        authority: facts.authority,
        dispatch_enabled: dispatch_enabled(settings),
        turn: facts.turn,
        reconciliation: facts.reconciliation,
        question: facts.question,
        question_answer_matches: facts.question_answer_matches,
        dependency: facts.dependency,
        independent_dependency: facts.independent_dependency,
        trigger,
        automatic_limits: Some(automatic_limits(settings, continuation)),
        // Taken from this snapshot so the counters cannot disagree with the
        // revision `prepare_claim` re-reads for the same work item.
        automatic_usage: Some(automatic_usage(&work.revision)),
    };
    coordinator::prepare_claim(store, scope, work_id, thread_id, claim_id, observations)
}

#[cfg(test)]
#[path = "host_gate.test.rs"]
mod tests;
