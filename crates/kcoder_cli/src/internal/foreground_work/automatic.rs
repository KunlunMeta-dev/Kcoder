//! Automatic continuous-work admission, input handoff and terminal settlement.

use kcoder_engine::continuous_work::coordinator::{PreparedContinuation, acquire_claim};
use kcoder_engine::continuous_work::host_gate::{
    ContinuationScope, HostGateFacts, prepare_host_claim,
};
use kcoder_engine::continuous_work::{Condition, Trigger, TurnObservation, Verification};
use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_state::continuous_work::{
    ClaimOutcome, ClaimSettlement, ContinuousWorkStore, HostWorkScope, WorkInputSource,
};
use kcoder_types::TurnAttemptIdentity;
#[cfg(test)]
use kcoder_types::continuous_work::WorkInputKind;
use kcoder_types::continuous_work::{WorkInputState, WorkRecord, WorkScope};
#[cfg(test)]
use serde_json::json;
#[cfg(test)]
use std::sync::Arc;

/// One durable claim held by a host automatic dispatch.
///
/// The lease settles with the real turn outcome. If the spawned task is aborted
/// before it can report one, dropping the lease releases the claim as abandoned
/// so the work item is not fenced by a dead owner forever; a later dispatch then
/// reconciles instead of silently starting a second loop.
pub struct AutomaticClaimLease {
    store: ContinuousWorkStore,
    scope: WorkScope,
    work_id: String,
    claim_id: String,
    owner_epoch: u64,
    /// Durable facts as they were when the claim was taken. A completed turn
    /// that changes none of them produced nothing the record can prove.
    facts: DurableFacts,
    settled: bool,
}

/// The durable evidence a turn can add to a work item.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableFacts {
    applied_input_sequence: u64,
    requirements_revision: u64,
    native_refs: usize,
    result_id: Option<String>,
}

impl DurableFacts {
    fn capture(work: &WorkRecord) -> Self {
        Self {
            applied_input_sequence: work.revision.applied_input_sequence,
            requirements_revision: work.revision.requirements_revision,
            native_refs: work.native_refs.len(),
            result_id: work.result.as_ref().map(|result| result.result_id.clone()),
        }
    }
}

impl AutomaticClaimLease {
    /// Release the claim with the outcome the host really observed.
    pub fn settle(mut self, settlement: ClaimSettlement) {
        self.release(settlement);
    }

    /// Settle one finished turn from the durable facts it added.
    ///
    /// A completed turn that applied no input, advanced no requirement, pinned
    /// no native object and recorded no result is a stalled round, not progress:
    /// the batch then reaches its no-progress limit instead of looping forever.
    /// A failed turn keeps its own counter. An unreadable record is never
    /// accused of stalling.
    pub fn settle_after_turn(mut self, status: &str) {
        let settlement = match status {
            "completed" => {
                if self.added_durable_facts() {
                    ClaimSettlement::Completed
                } else {
                    tracing::info!(
                        work_id = %self.work_id,
                        claim_id = %self.claim_id,
                        "automatic turn completed without adding a durable fact"
                    );
                    ClaimSettlement::Stalled
                }
            }
            _ => ClaimSettlement::Failed,
        };
        self.release(settlement);
    }

    fn added_durable_facts(&self) -> bool {
        match self.store.read_work(&self.scope, &self.work_id) {
            Ok(Some(work)) => DurableFacts::capture(&work) != self.facts,
            _ => true,
        }
    }

    fn release(&mut self, settlement: ClaimSettlement) {
        if self.settled {
            return;
        }
        self.settled = true;
        if let Err(error) = self.store.release_claim(
            &self.scope,
            &self.work_id,
            &self.claim_id,
            self.owner_epoch,
            settlement,
        ) {
            tracing::warn!(
                %error,
                work_id = %self.work_id,
                claim_id = %self.claim_id,
                "continuous-work claim settlement failed; the claim stays reconcilable"
            );
        }
    }
}

/// One queued requirement the host is about to carry into its next turn.
pub struct QueuedWorkInput {
    pub input_id: String,
    pub source: WorkInputSource,
    pub text: String,
}

impl AutomaticClaimLease {
    /// Control epoch of the work when this lease settles its input.
    fn control_epoch_at_settlement(&self) -> u64 {
        self.store
            .read_work(&self.scope, &self.work_id)
            .ok()
            .flatten()
            .map(|work| work.revision.control_epoch)
            .unwrap_or(0)
    }
}

impl AutomaticClaimLease {
    /// Dispatch the oldest queued requirement of this claim's work and return
    /// the text that must be carried into the turn. A queued body that is not
    /// plain text is left untouched so the host does not invent content.
    pub fn take_next_queued_input(&self) -> Option<QueuedWorkInput> {
        let pending = self
            .store
            .list_pending_inputs(&self.scope, &self.work_id, None)
            .ok()?;
        let entries = pending.inputs;
        let work = self.store.read_work(&self.scope, &self.work_id).ok()??;
        let control_epoch = work.revision.control_epoch;
        for entry in entries {
            if entry.receipt.state != WorkInputState::Queued {
                continue;
            }
            let (_, payload) = self
                .store
                .read_input(
                    &self.scope,
                    &self.work_id,
                    &entry.source,
                    &entry.receipt.input_id,
                )
                .ok()??;
            let Some(text) = payload.get("text").and_then(|value| value.as_str()) else {
                continue;
            };
            self.store
                .dispatch_input(
                    &self.scope,
                    &self.work_id,
                    &entry.source,
                    &entry.receipt.input_id,
                    &self.claim_id,
                    self.owner_epoch,
                    control_epoch,
                )
                .ok()?;
            return Some(QueuedWorkInput {
                input_id: entry.receipt.input_id.clone(),
                source: entry.source.clone(),
                text: text.to_owned(),
            });
        }
        None
    }

    /// Return a dispatched requirement to the queue when the turn never asked
    /// the provider, so a failed start does not block the work forever.
    pub fn requeue_dispatched_input(&self, input: &QueuedWorkInput) {
        if let Err(error) = self.store.requeue_input(
            &self.scope,
            &self.work_id,
            &input.source,
            &input.input_id,
            Some(kcoder_state::continuous_work::InputAuthority {
                claim_id: &self.claim_id,
                owner_epoch: self.owner_epoch,
                control_epoch: self.control_epoch_at_settlement(),
            }),
        ) {
            tracing::warn!(%error, input_id = %input.input_id, "queued input could not be requeued");
        }
    }

    /// Settle a dispatched input once its text really reached the provider, or
    /// record that the outcome could not be observed.
    pub fn settle_dispatched_input(
        &self,
        input: &QueuedWorkInput,
        applied: Option<kcoder_state::continuous_work::AppliedInputReference>,
    ) {
        let Some(work) = self
            .store
            .read_work(&self.scope, &self.work_id)
            .ok()
            .flatten()
        else {
            return;
        };
        let control_epoch = work.revision.control_epoch;
        let input_id = input.input_id.as_str();
        let source = &input.source;
        let outcome: anyhow::Result<()> = match applied {
            Some(reference) => self
                .store
                .settle_input(
                    &self.scope,
                    &self.work_id,
                    source,
                    input_id,
                    &self.claim_id,
                    self.owner_epoch,
                    control_epoch,
                    reference,
                )
                .map(|_| ()),
            None => self
                .store
                .mark_input_unconfirmed(
                    &self.scope,
                    &self.work_id,
                    source,
                    input_id,
                    Some(kcoder_state::continuous_work::InputAuthority {
                        claim_id: &self.claim_id,
                        owner_epoch: self.owner_epoch,
                        control_epoch,
                    }),
                )
                .map(|_| ()),
        };
        if let Err(error) = outcome {
            tracing::warn!(%error, input_id = %input_id, "queued input settlement failed");
        }
    }
}

impl Drop for AutomaticClaimLease {
    fn drop(&mut self) {
        if !self.settled {
            tracing::warn!(
                work_id = %self.work_id,
                claim_id = %self.claim_id,
                "automatic turn ended without a settlement; releasing the claim as abandoned"
            );
            self.release(ClaimSettlement::Abandoned);
        }
    }
}

/// Outcome of the gate that precedes every host automatic dispatch.
// Short-lived and moved once; boxing the large variant buys nothing here.
#[allow(clippy::large_enum_variant)]
pub enum AutomaticDispatchGate {
    /// No continuous-work item is bound to this thread: keep the previous path.
    Unbound,
    /// Hold this claim until the turn really ends, then settle it.
    Claimed(AutomaticClaimLease),
    /// Do not dispatch. The host state does not clear the automatic gate yet.
    Deferred(String),
}

/// Decide one automatic dispatch from host-verified observations.
///
/// Every value comes from the target host's own records: the captured work
/// scope, the durable binding list, the work revision and the caller's real
/// thread/interaction state. RPC assertions and model output are never used.
pub fn automatic_dispatch_gate(
    engine: &QueryEngine,
    thread_id: &str,
    claim_id: &str,
    continuation: ContinuationScope,
    facts: HostGateFacts,
) -> AutomaticDispatchGate {
    let Some(settings_path) = engine.settings_persistence_path() else {
        return AutomaticDispatchGate::Deferred("profile-unavailable".into());
    };
    let Some(profile) = settings_path.parent() else {
        return AutomaticDispatchGate::Deferred("profile-unavailable".into());
    };
    let workspace = engine.state.cwd();
    let principal = std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID").ok();
    let host = match HostWorkScope::capture(profile, &workspace, principal.as_deref()) {
        Ok(host) => host,
        Err(error) => {
            tracing::warn!(%error, "continuous-work scope is unavailable for automatic dispatch");
            return AutomaticDispatchGate::Deferred("scope-unavailable".into());
        }
    };
    let store = match ContinuousWorkStore::open_existing(host.profile_path()) {
        Ok(Some(store)) => store,
        Ok(None) => return AutomaticDispatchGate::Unbound,
        Err(error) => {
            tracing::warn!(%error, "continuous-work store is unreadable for automatic dispatch");
            return AutomaticDispatchGate::Deferred("store-unavailable".into());
        }
    };
    let bound = match store.list_for_thread(host.scope(), thread_id) {
        Ok(bound) => bound,
        Err(error) => {
            tracing::warn!(%error, "continuous-work binding list is unreadable");
            return AutomaticDispatchGate::Deferred("binding-unavailable".into());
        }
    };
    let work_id = match bound.as_slice() {
        [] => return AutomaticDispatchGate::Unbound,
        [single] => single.work_id.clone(),
        _ => {
            // Two legal bindings must be reconciled by the original coordinator
            // instead of picking one here.
            return AutomaticDispatchGate::Deferred("multiple-bindings".into());
        }
    };
    let settings = engine
        .settings
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    // Only an input the target itself deferred to the queue is consumed here.
    // An input still owned by a running foreground turn must not be overtaken,
    // so the automatic trigger keeps its stricter admission rules.
    let queued_ready = store
        .list_pending_inputs(host.scope(), &work_id, None)
        .ok()
        .is_some_and(|page| {
            page.inputs
                .iter()
                .any(|entry| entry.receipt.state == WorkInputState::Queued)
        });
    let trigger = if queued_ready {
        Trigger::LocalAcceptedInput
    } else {
        Trigger::AutomaticContinuation
    };
    let prepared = match prepare_host_claim(
        &store,
        host.scope(),
        &work_id,
        thread_id,
        claim_id,
        trigger,
        continuation,
        &settings,
        facts,
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            tracing::warn!(%error, work_id = %work_id, "continuous-work preparation failed");
            return AutomaticDispatchGate::Deferred("prepare-failed".into());
        }
    };
    match prepared {
        PreparedContinuation::Claim(prepared) => match acquire_claim(&store, &prepared) {
            Ok(ClaimOutcome::Acquired(receipt)) => {
                let facts = match store.read_work(host.scope(), &work_id) {
                    Ok(Some(work)) => DurableFacts::capture(&work),
                    _ => DurableFacts {
                        applied_input_sequence: 0,
                        requirements_revision: 0,
                        native_refs: 0,
                        result_id: None,
                    },
                };
                AutomaticDispatchGate::Claimed(AutomaticClaimLease {
                    store,
                    scope: host.scope().clone(),
                    work_id,
                    claim_id: claim_id.to_string(),
                    owner_epoch: receipt.owner_epoch,
                    facts,
                    settled: false,
                })
            }
            Ok(ClaimOutcome::ExistingActive(existing)) => {
                // The original dispatch must be reconciled; this turn is not it.
                AutomaticDispatchGate::Deferred(format!("existing-active:{}", existing.claim_id))
            }
            Err(error) => {
                // The store answers a different claim id on an active work item
                // with ALREADY_CLAIMED rather than ExistingActive, so classify
                // the refusal instead of reporting an opaque failure.
                let codes: Vec<String> = error.chain().map(ToString::to_string).collect();
                let reason = if codes.iter().any(|code| {
                    code == "CONTINUOUS_WORK_ALREADY_CLAIMED"
                        || code == "CONTINUOUS_WORK_CLAIM_STALE"
                }) {
                    "existing-active"
                } else if codes
                    .iter()
                    .any(|code| code == "CONTINUOUS_WORK_REVISION_CONFLICT")
                {
                    "claim-stale"
                } else {
                    "claim-refused"
                };
                tracing::warn!(%error, work_id = %work_id, reason, "continuous-work claim was refused");
                AutomaticDispatchGate::Deferred(reason.into())
            }
        },
        PreparedContinuation::Wait(reason) => {
            AutomaticDispatchGate::Deferred(format!("wait:{reason:?}"))
        }
        PreparedContinuation::ReconcileOriginal => {
            AutomaticDispatchGate::Deferred("reconcile-original".into())
        }
        PreparedContinuation::ResolveOriginalQuestion => {
            AutomaticDispatchGate::Deferred("original-question".into())
        }
        PreparedContinuation::NoWork => AutomaticDispatchGate::Unbound,
    }
}

/// Edge-triggered notice for a deferred automatic dispatch.
///
/// A wait that keeps the same reason is one fact, not a stream: publishing it on
/// every scheduler pass would spam the client with identical copy.
#[derive(Default)]
pub struct GateWaitNotice {
    last: Option<String>,
}

impl GateWaitNotice {
    /// True only when the reason changed since the last published notice.
    pub fn changed(&mut self, reason: &str) -> bool {
        if self.last.as_deref() == Some(reason) {
            return false;
        }
        self.last = Some(reason.to_owned());
        true
    }

    /// A later dispatch attempt proceeded, so the next wait is new information.
    pub fn clear(&mut self) {
        self.last = None;
    }
}

/// User-visible copy for a deferred automatic dispatch.
///
/// The machine tag stays in front so transcripts, logs and client text can be
/// correlated with the internal reason.
pub fn gate_wait_message(reason: &str) -> String {
    let detail = if let Some(wait) = reason.strip_prefix("wait:") {
        match wait {
            "DispatchDisabled" => "the host dispatch valve is off",
            "Paused" => "the work item is paused",
            "Stopped" => "the work item is stopped",
            "ControlPending" => "a pause or stop request has not settled yet",
            "ControlUnobserved" => "the current pause or stop state cannot be read",
            "ActiveTurn" => "another turn is still running",
            "TurnUnobserved" => "the thread's turn state cannot be read",
            "AutomaticTurnLimit" => "this batch used all of its automatic turns",
            "FailureLimit" => "this batch reached its consecutive-failure limit",
            "StallLimit" => "this batch reached its no-progress limit",
            "QuestionPending" | "QuestionUnobserved" => "an original question is still unanswered",
            "InputPending" | "InputUnobserved" => "an accepted input is not applied yet",
            "ReconciliationUnobserved" => "an earlier dispatch still needs reconciliation",
            "BindingDenied" | "BindingUnavailable" => "the work binding cannot be verified",
            "AuthorityDenied" | "AuthorityUnavailable" => {
                "the execution authority cannot be verified"
            }
            "Completed" | "Failed" => "the work item is already terminal",
            "InvalidRevision" => "the work record revision is not consistent",
            "DependencyPending" | "DependencyUnobserved" => {
                "a dependency is still blocking this work"
            }
            "AutomaticPolicyUnobserved" => "the effective automatic limits cannot be read",
            other => other,
        }
    } else if reason.starts_with("existing-active") {
        "an earlier dispatch still holds the claim and must be reconciled"
    } else {
        match reason {
            "multiple-bindings" => "more than one work item is bound to this thread",
            "claim-stale" => "the work record changed before the claim could be taken",
            "claim-refused" => "the work item refused another claim",
            "reconcile-original" => "the original work item needs reconciliation first",
            "original-question" => "the original question must be answered on its own path",
            "profile-unavailable"
            | "scope-unavailable"
            | "store-unavailable"
            | "binding-unavailable"
            | "prepare-failed" => "the host cannot verify the work state right now",
            other => other,
        }
    };
    format!(
        "[continuous_work_dispatch_wait] Automatic continuation is waiting: {detail}. No model turn was started and the work record is unchanged; this notice repeats only when the reason changes."
    )
}

/// Facts the resident scheduler can verify before an automatic dispatch.
///
/// The caller holds the shared activity gate and won the idle CAS, so no other
/// turn is running for this thread, and the same branch already required that no
/// background follow-up is still running. Anything the host cannot verify stays
/// `Unknown`/`Blocked` and therefore never dispatches a model request.
pub fn automatic_gate_facts(
    pending_questions: usize,
    reconciliation_pending: bool,
) -> HostGateFacts {
    HostGateFacts {
        // The binding comes from the durable store for this exact captured scope.
        binding: Verification::Verified,
        // The resident engine is the original thread's executor, the caller holds
        // the shared activity gate, and the goal/orchestrate precondition was
        // checked in the same branch that reached this call.
        authority: Verification::Verified,
        turn: TurnObservation::Idle,
        reconciliation: if reconciliation_pending {
            Condition::Blocked
        } else {
            Condition::Clear
        },
        question: if pending_questions == 0 {
            Condition::Clear
        } else {
            Condition::Blocked
        },
        question_answer_matches: false,
        dependency: Condition::Clear,
        independent_dependency: false,
    }
}

#[cfg(test)]
#[path = "../../app_server/continuous_work_admission.test.rs"]
mod tests;

#[cfg(test)]
#[path = "../../app_server/continuous_work_queue.test.rs"]
mod queue_tests;

#[cfg(test)]
#[path = "../../app_server/continuous_work_limits.test.rs"]
mod limits_tests;

/// The exact parent attempt the work record pins for one background run.
///
/// The pin is the only locator that may be handed to the native observer; a
/// mutable current-task field never stands in for it.
pub fn pinned_background_attempt(
    work: &WorkRecord,
    run: &kcoder_types::BackgroundRunKey,
) -> Option<TurnAttemptIdentity> {
    work.native_refs
        .iter()
        .find_map(|reference| match reference {
            kcoder_types::continuous_work::WorkNativeReference::Known(
                kcoder_types::continuous_work::WorkKnownReference::Background {
                    parent_attempt,
                    run: pinned,
                    ..
                },
            ) if pinned == run => Some(parent_attempt.clone()),
            _ => None,
        })
}

/// True when the work record pins this exact workflow run.
///
/// A workflow terminal has no readable output body today, so the pin can only
/// prove identity; it must never stand in for result evidence.
pub fn pins_workflow_run(work: &WorkRecord, run: &kcoder_types::BackgroundRunKey) -> bool {
    work.native_refs.iter().any(|reference| match reference {
        kcoder_types::continuous_work::WorkNativeReference::Known(
            kcoder_types::continuous_work::WorkKnownReference::Workflow {
                thread_id, run_id, ..
            },
        ) => run_id == &run.run_id && thread_id == &run.parent_session_id,
        _ => false,
    })
}

/// True only for the terminal background payloads.
fn terminal_background_event(event: &EngineEvent) -> bool {
    matches!(
        event.background_payload(),
        EngineEvent::BackgroundJobCompleted { .. }
            | EngineEvent::BackgroundJobFailed { .. }
            | EngineEvent::BackgroundJobCancelled { .. }
            | EngineEvent::BackgroundJobHalted { .. }
    )
}

/// Record one terminal native run against the work item bound to this thread.
///
/// Nothing is replayed and nothing is completed here: completion is a separate
/// CAS. An unproven observation, a mismatched pin or a lagging basis only
/// registers a reason and leaves the record untouched.
pub fn record_terminal_background_result(
    engine: &QueryEngine,
    event: &EngineEvent,
) -> Option<String> {
    let identity = event.background_identity()?;
    if !terminal_background_event(event) {
        return None;
    }
    let settings_path = engine.settings_persistence_path()?;
    let profile = settings_path.parent()?;
    let workspace = engine.state.cwd();
    let principal = std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID").ok();
    let host = match HostWorkScope::capture(profile, &workspace, principal.as_deref()) {
        Ok(host) => host,
        Err(error) => {
            tracing::warn!(%error, "continuous-work scope unavailable for result handoff");
            return None;
        }
    };
    let store = match ContinuousWorkStore::open_existing(host.profile_path()) {
        Ok(Some(store)) => store,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(%error, "continuous-work store unreadable for result handoff");
            return None;
        }
    };
    let thread_id = engine.session_id();
    let bound = store.list_for_thread(host.scope(), &thread_id).ok()?;
    let [single] = bound.as_slice() else {
        return None;
    };
    let work_id = single.work_id.clone();
    let work = store.read_work(host.scope(), &work_id).ok()??;
    let Some(attempt) = pinned_background_attempt(&work, &identity.run) else {
        if pins_workflow_run(&work, &identity.run) {
            // The workflow reached a terminal state, but this host cannot read a
            // workflow output body, so no basis-backed result may be recorded.
            tracing::info!(
                work_id = %work_id,
                run_id = %identity.run.run_id,
                "continuous-work workflow result waits for output evidence"
            );
        }
        return None;
    };
    let observation = match kcoder_engine::continuous_work::native_result::observe_run(
        &engine.state,
        &identity.run,
        Some(&attempt),
        Some(identity),
    ) {
        Ok(observation) => observation,
        Err(error) => {
            tracing::debug!(?error, "background run is not observable for the work item");
            return None;
        }
    };
    match kcoder_engine::continuous_work::native_result::plan_bound_result_handoff(
        &work,
        &observation,
    ) {
        kcoder_engine::continuous_work::native_result::ResultHandoff::Record(draft) => {
            let required_delivery_ids = store
                .accepted_deliveries(host.scope(), &work_id)
                .ok()
                .flatten()
                .unwrap_or_default()
                .into_iter()
                .map(|delivery| delivery.delivery_id)
                .collect();
            let result = kcoder_types::continuous_work::WorkResult {
                result_id: draft.result_id.clone(),
                basis: draft.basis,
                artifact_refs: Vec::new(),
                evidence_refs: vec![format!("background:{}", draft.event_id)],
                required_delivery_ids,
            };
            match store.record_result(host.scope(), &work_id, work.revision.revision, result) {
                Ok(record) => Some(format!(
                    "recorded {} at revision {}",
                    draft.result_id, record.revision.revision
                )),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        work_id = %work_id,
                        result_id = %draft.result_id,
                        "continuous-work result was not recorded"
                    );
                    None
                }
            }
        }
        kcoder_engine::continuous_work::native_result::ResultHandoff::Reconcile(reason) => {
            tracing::info!(
                ?reason,
                work_id = %work_id,
                run_id = %identity.run.run_id,
                "continuous-work result needs reconciliation"
            );
            None
        }
        kcoder_engine::continuous_work::native_result::ResultHandoff::Wait(wait) => {
            tracing::debug!(
                ?wait,
                work_id = %work_id,
                "continuous-work result handoff waits"
            );
            None
        }
    }
}
