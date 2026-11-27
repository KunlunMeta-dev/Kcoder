//! Rollout automation: proposal → evaluation → canary → promotion or
//! rollback (plan sections 9, 12 and 13.1).
//!
//! - **Entry.** In `auto` mode every safety-scanned overlay proposal of a
//!   skill, tool usage or workflow template target enters the rollout (each
//!   type's own `mode`, which can only narrow the global one); in `propose`
//!   mode only proposals the user accepted
//!   (recorded as approvals in `rollout.json`). Pinned, archived or
//!   unvalidated targets never start a canary.
//! - **Evaluation.** With cases ([`super::eval_cases::eval_cases`]) the
//!   `eval` stage model judges stable against candidate under a job lease;
//!   a passed evaluation moves the proposal to `evaluated`, a failed one to
//!   `rejected` (the result is kept), an incomplete one is retried once.
//!   Without cases, and for tool usage and workflow templates (evaluator
//!   `None`), the target has no offline evaluator.
//! - **Canary.** The candidate is staged and served to the configured
//!   traffic share (≤ 10% without an evaluator); threads keep their channel.
//! - **Decision** at idle polls on same-window data only: `promote` in
//!   `auto` mode promotes (pointer switch); otherwise the canary waits for
//!   the user ("awaiting promotion") and a notification is sent; `rollback`
//!   only switches the pointer back, the candidate content stays.
//!
//! Preference proposals are written directly in `auto` mode after the same
//! safety scan; project knowledge always waits for the user. Every change
//! is reported through the host's change sink (`evolution/changed`).

use super::eval::{EvalLimits, EvalPlan, EvalVersion};
use super::eval_cases::{EvalCase, bundled_catalog, eval_cases, forbidden_patterns};
use super::{EvolutionRuntime, ScopeKind, now_ms};
use crate::QueryEngine;
use kcoder_config::{EvolutionStage, Settings};
use kcoder_evolution::{
    BetaPrior, CanaryWindow, EvolutionStore, OverlaySlotSource, RolloutDecision, RolloutPolicy,
    SignalWeights, promotion_requires_user,
};
use kcoder_tools::evolution_service::{
    EvolutionChange, ProposalAcceptRequest, ServiceResult, apply_changes, guard_overlay_content,
};
use kcoder_types::evolution::{
    Channel, EvolutionJobKind, EvolutionMode, OverlayCandidateState, OverlayContent, Proposal,
    ProposalActor, ProposalLocation, ProposalState, TargetKey, TargetRevision, TargetType,
};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Spacing of the (model-free) rollout and canary checks.
pub(crate) const ROLLOUT_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// Incomplete evaluations retried before a proposal is rejected.
pub(crate) const MAX_EVAL_ATTEMPTS: u32 = 2;

/// One `evolution/changed` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvolutionChangeEvent {
    pub target_key: Option<TargetKey>,
    pub change: EvolutionChange,
}

/// Host callback receiving evolution changes made by background automation.
pub type EvolutionChangeSink = Arc<dyn Fn(EvolutionChangeEvent) + Send + Sync>;

/// A proposal waiting for its evaluation job.
#[derive(Debug, Clone)]
pub(crate) struct PendingEval {
    pub(crate) scope: ScopeKind,
    pub(crate) proposal_id: String,
    pub(crate) plan: EvalPlan,
}

/// Automation state of one runtime.
#[derive(Default)]
pub(crate) struct AutomationState {
    pub(crate) sink: RwLock<Option<EvolutionChangeSink>>,
    pub(crate) eval_limits: Mutex<EvalLimits>,
    pub(crate) last_rollout_check: Mutex<Option<Instant>>,
    pub(crate) last_compaction_check: Mutex<Option<Instant>>,
    pub(crate) next_eval: Mutex<Option<PendingEval>>,
    pub(crate) restored_queues: Mutex<HashSet<PathBuf>>,
}

impl std::fmt::Debug for AutomationState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AutomationState")
            .finish_non_exhaustive()
    }
}

/// Take `slot` when `interval` elapsed since it was last taken.
pub(crate) fn due(slot: &Mutex<Option<Instant>>, interval: Duration) -> bool {
    let mut last = slot.lock().unwrap_or_else(|error| error.into_inner());
    let due = last.is_none_or(|at| at.elapsed() >= interval);
    if due {
        *last = Some(Instant::now());
    }
    due
}

impl EvolutionRuntime {
    /// Report a change to the host (no-op without a sink).
    pub(crate) fn notify(&self, target_key: Option<&TargetKey>, change: EvolutionChange) {
        let sink = self
            .automation
            .sink
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(sink) = sink {
            sink(EvolutionChangeEvent {
                target_key: target_key.cloned(),
                change,
            });
        }
    }
}

fn scan_passed(proposal: &Proposal) -> bool {
    proposal
        .safety_scan
        .as_ref()
        .is_some_and(|scan| scan.passed)
}

fn transition(
    store: &EvolutionStore,
    proposal: &Proposal,
    to: ProposalState,
    actor: ProposalActor,
    reason: String,
    now: u64,
) -> Option<Proposal> {
    match store.transition_proposal(
        &proposal.proposal_id,
        proposal.revision,
        to,
        actor,
        Some(reason),
        now,
    ) {
        Ok(next) => Some(next),
        Err(error) => {
            tracing::warn!(%error, proposal = %proposal.proposal_id, "proposal transition failed");
            None
        }
    }
}

/// What the targeted problem of a proposal is, for the judge rubric.
fn targeted_problem(proposal: &Proposal) -> String {
    let changes = &proposal.changes;
    let mut lines: Vec<String> = changes
        .lessons_add
        .iter()
        .map(|lesson| format!("adds: {lesson}"))
        .collect();
    lines.extend(
        changes
            .lessons_revise
            .iter()
            .map(|revision| format!("revises: {} -> {}", revision.from, revision.to)),
    );
    lines.extend(
        changes
            .lessons_remove
            .iter()
            .map(|lesson| format!("removes: {lesson}")),
    );
    lines.extend(
        changes
            .checklist_edits
            .iter()
            .map(|item| format!("checklist: {item}")),
    );
    if lines.is_empty() {
        "The candidate revises the learned notes of this target.".into()
    } else {
        format!(
            "The candidate was proposed from user feedback to make these changes; judge whether \
             the answer reflects them where the task calls for it:\n{}",
            lines.join("\n")
        )
    }
}

impl QueryEngine {
    /// Register the host callback for `evolution/changed`. Replaces a
    /// previous sink; `None` removes it.
    pub fn set_evolution_change_sink(&self, sink: Option<EvolutionChangeSink>) {
        *self
            .evolution
            .automation
            .sink
            .write()
            .unwrap_or_else(|error| error.into_inner()) = sink;
    }

    /// Mode governing the rollout of `target_type` (per-type modes only
    /// narrow the global one).
    fn rollout_mode(settings: &Settings, target_type: TargetType) -> EvolutionMode {
        settings.evolution.effective_mode(target_type)
    }

    /// Target types whose proposals change an overlay that canaries: skills,
    /// tool usage hints and workflow templates. Preferences are written
    /// directly; project knowledge always waits for the user.
    fn canaried(target_type: TargetType) -> bool {
        matches!(
            target_type,
            TargetType::Skill | TargetType::ToolUsage | TargetType::WorkflowTemplate
        )
    }

    /// Model-free automation step of the idle poll: canary decisions,
    /// automatic preference writes, canaries of targets without an
    /// evaluator and the next evaluation to run.
    pub(crate) fn run_evolution_automation(&self, settings: &Settings, force: bool) {
        if !force
            && !due(
                &self.evolution.automation.last_rollout_check,
                ROLLOUT_CHECK_INTERVAL,
            )
        {
            return;
        }
        let now = now_ms();
        let mut next_eval = None;
        for scope in [ScopeKind::User, ScopeKind::Project] {
            let Some(store) = self.evolution.store(scope, &self.cwd) else {
                continue;
            };
            self.decide_canaries(&store, settings, now);
            if scope == ScopeKind::User {
                self.auto_write_preferences(&store, settings, now);
            }
            if let Some(pending) = self.advance_rollouts(&store, scope, settings, now)
                && next_eval.is_none()
            {
                next_eval = Some(pending);
            }
        }
        *self
            .evolution
            .automation
            .next_eval
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = next_eval;
    }

    /// Proposals that may enter the rollout from `store`.
    fn rollout_candidates(&self, store: &EvolutionStore, settings: &Settings) -> Vec<Proposal> {
        let ledger = store.read_rollout_ledger().unwrap_or_default();
        store
            .list_proposals()
            .unwrap_or_default()
            .into_iter()
            .filter(|proposal| {
                let target_type = proposal.target_key.target_type();
                let mode = Self::rollout_mode(settings, target_type);
                Self::canaried(target_type)
                    && mode >= EvolutionMode::Propose
                    && proposal.location == ProposalLocation::Overlay
                    && matches!(
                        proposal.state,
                        ProposalState::Draft | ProposalState::Evaluated
                    )
                    && scan_passed(proposal)
                    && super::target_active(&settings.evolution, &proposal.target_key)
                    && !ledger.archived_targets.contains(&proposal.target_key)
                    && (mode == EvolutionMode::Auto
                        || ledger.approved.contains_key(&proposal.proposal_id))
            })
            .collect()
    }

    /// Start canaries that need no evaluation and return the first
    /// proposal that does.
    fn advance_rollouts(
        &self,
        store: &Arc<EvolutionStore>,
        scope: ScopeKind,
        settings: &Settings,
        now: u64,
    ) -> Option<PendingEval> {
        let ledger = store.read_rollout_ledger().unwrap_or_default();
        let limits = *self
            .evolution
            .automation
            .eval_limits
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut pending = None;
        let mut busy: HashSet<TargetKey> = HashSet::new();
        for proposal in self.rollout_candidates(store, settings) {
            let key = proposal.target_key.clone();
            if busy.contains(&key) {
                continue;
            }
            let Some((target_scope, body, base_revision)) = self.evolution_distill_target(&key)
            else {
                continue;
            };
            if target_scope != scope {
                continue;
            }
            if proposal.base_revision != base_revision {
                if let Some(rejected) = transition(
                    store,
                    &proposal,
                    ProposalState::Rejected,
                    ProposalActor::Auto,
                    "the target changed since the proposal was made".into(),
                    now,
                ) {
                    let _ =
                        store.update_rollout_ledger(|ledger| ledger.settle(&rejected.proposal_id));
                    self.evolution.notify(Some(&key), EvolutionChange::Proposal);
                }
                continue;
            }
            let document = store.overlay_document(&key).ok().flatten();
            if document.as_ref().is_some_and(|document| {
                document.pinned_stable
                    || document.needs_revalidation
                    || document
                        .candidate
                        .as_ref()
                        .is_some_and(|candidate| candidate.state == OverlayCandidateState::Canary)
            }) {
                busy.insert(key);
                continue;
            }
            busy.insert(key.clone());
            if proposal.state == ProposalState::Evaluated {
                self.start_canary(store, &proposal, true, settings, now);
                continue;
            }
            let attempts = ledger
                .eval_attempts
                .get(&proposal.proposal_id)
                .copied()
                .unwrap_or(0);
            if attempts >= MAX_EVAL_ATTEMPTS {
                self.reject(
                    store,
                    &proposal,
                    format!("evaluation incomplete after {attempts} attempts"),
                    now,
                );
                continue;
            }
            match self.eval_plan(store, &proposal, &body, now, limits.max_cases) {
                Some(plan) => {
                    if pending.is_none() {
                        pending = Some(PendingEval {
                            scope,
                            proposal_id: proposal.proposal_id.clone(),
                            plan,
                        });
                    }
                }
                // No offline evaluator: canary at reduced traffic.
                None => {
                    self.start_canary(store, &proposal, false, settings, now);
                }
            }
        }
        pending
    }

    fn eval_plan(
        &self,
        store: &EvolutionStore,
        proposal: &Proposal,
        body: &str,
        now: u64,
        max_cases: usize,
    ) -> Option<EvalPlan> {
        let key = &proposal.target_key;
        // Only skills have an offline evaluator; tool usage hints and
        // workflow templates canary at reduced traffic (evaluator `None`).
        if key.target_type() != TargetType::Skill {
            return None;
        }
        let (skill_dir, declaration, bundled_copy) = self.evolution_skill_declaration(key);
        let (_, cases): (_, Vec<EvalCase>) = eval_cases(
            skill_dir.as_deref(),
            declaration.as_ref(),
            bundled_catalog(key, bundled_copy),
            store,
            key,
            now,
            max_cases,
        )?;
        let stable = store
            .read_overlay(key)
            .ok()
            .flatten()
            .and_then(|view| view.stable)
            .unwrap_or_default();
        let candidate = apply_changes(&stable, &proposal.changes);
        let procedure = declaration
            .as_ref()
            .is_some_and(|declaration| declaration.profile.iter().any(|item| item == "procedure"))
            || self.mostly_procedural(store, key);
        Some(EvalPlan {
            key: key.clone(),
            proposal_id: proposal.proposal_id.clone(),
            cases,
            forbidden: forbidden_patterns(&candidate),
            stable: EvalVersion {
                body: body.to_string(),
                overlay: stable,
            },
            candidate: EvalVersion {
                body: body.to_string(),
                overlay: candidate,
            },
            targeted_problem: targeted_problem(proposal),
            procedure,
            creative: declaration
                .as_ref()
                .and_then(|declaration| declaration.creative),
        })
    }

    /// Most recorded usages of `key` ran commands.
    fn mostly_procedural(&self, store: &EvolutionStore, key: &TargetKey) -> bool {
        let Ok(usages) = store.read_amended_usages() else {
            return false;
        };
        let own: Vec<_> = usages
            .records
            .iter()
            .rev()
            .filter(|usage| &usage.target_key == key)
            .take(50)
            .collect();
        !own.is_empty()
            && own
                .iter()
                .filter(|usage| usage.profile_hints.ran_commands)
                .count()
                * 2
                > own.len()
    }

    fn reject(&self, store: &EvolutionStore, proposal: &Proposal, reason: String, now: u64) {
        if let Some(rejected) = transition(
            store,
            proposal,
            ProposalState::Rejected,
            ProposalActor::Auto,
            reason,
            now,
        ) {
            let _ = store.update_rollout_ledger(|ledger| ledger.settle(&rejected.proposal_id));
            self.evolution
                .notify(Some(&proposal.target_key), EvolutionChange::Proposal);
        }
    }

    /// Stage the proposal's candidate and start its canary.
    pub(crate) fn start_canary(
        &self,
        store: &EvolutionStore,
        proposal: &Proposal,
        has_evaluator: bool,
        settings: &Settings,
        now: u64,
    ) -> bool {
        let key = &proposal.target_key;
        let view = store.read_overlay(key).ok().flatten();
        let skill_file = self.evolution_skill_file_target(key, settings);
        // In skill-file mode the stable overlay is empty after promotions
        // (the learned block lives in the file); the canary serves the
        // proposal's additions on top of the stable file.
        let base = match (&skill_file, &view) {
            (Some(_), _) => OverlayContent::default(),
            (None, Some(view)) => view.stable.clone().unwrap_or_default(),
            (None, None) => OverlayContent::default(),
        };
        let next = match guard_overlay_content(&apply_changes(&base, &proposal.changes)) {
            Ok(next) => next,
            Err(error) => {
                self.reject(
                    store,
                    proposal,
                    format!("safety scan: {}", error.message),
                    now,
                );
                return false;
            }
        };
        let staged = match store.stage_candidate(
            key,
            view.as_ref().map(|view| view.document.revision),
            &proposal.base_revision,
            &next,
            &proposal.proposal_id,
            now,
        ) {
            Ok(staged) => staged,
            Err(error) => {
                self.evolution
                    .note_diagnostic(format!("candidate not staged for {key}: {error}"));
                return false;
            }
        };
        if let Some(target) = &skill_file
            && let Err(reason) =
                super::skill_file::stage(target, &proposal.changes, &proposal.proposal_id, now)
        {
            let _ = store.rollback_candidate(key, staged.revision, now);
            self.reject(
                store,
                proposal,
                format!("skill file candidate: {reason}"),
                now,
            );
            return false;
        }
        let policy = RolloutPolicy::from_settings(&settings.evolution, has_evaluator);
        if let Err(error) = store.start_canary(key, staged.revision, policy.candidate_traffic, now)
        {
            self.evolution
                .note_diagnostic(format!("canary not started for {key}: {error}"));
            return false;
        }
        let reason = format!(
            "canary started at {:.0}% traffic{}",
            policy.candidate_traffic * 100.0,
            if has_evaluator {
                ""
            } else {
                " (no offline evaluator)"
            }
        );
        if transition(
            store,
            proposal,
            ProposalState::Canary,
            ProposalActor::Auto,
            reason,
            now,
        )
        .is_none()
        {
            let _ = store
                .overlay_document(key)
                .ok()
                .flatten()
                .map(|document| store.rollback_candidate(key, document.revision, now));
            return false;
        }
        let _ = store.update_rollout_ledger(|ledger| {
            ledger.approved.remove(&proposal.proposal_id);
        });
        self.evolution.notify(Some(key), EvolutionChange::Proposal);
        true
    }

    /// Decide every running canary of `store` on same-window data.
    pub(crate) fn decide_canaries(&self, store: &EvolutionStore, settings: &Settings, now: u64) {
        let Ok(documents) = store.list_overlay_documents() else {
            return;
        };
        let running: Vec<_> = documents
            .into_iter()
            .filter(|document| {
                document
                    .candidate
                    .as_ref()
                    .is_some_and(|candidate| candidate.state == OverlayCandidateState::Canary)
            })
            .collect();
        if running.is_empty() {
            return;
        }
        let weights = SignalWeights::from_settings(&settings.evolution.signals);
        let (Ok(scored), Ok(stats)) = (store.scored_usages(&weights), store.stats(&weights)) else {
            return;
        };
        for document in running {
            let key = document.target_key.clone();
            let mode = Self::rollout_mode(settings, key.target_type());
            let candidate = document.candidate.clone().expect("filtered above");
            let Some(proposal) = candidate
                .proposal_id
                .as_deref()
                .and_then(|id| store.read_proposal(id).ok().flatten())
                .filter(|proposal| proposal.state == ProposalState::Canary)
            else {
                continue;
            };
            let stable = TargetRevision::new(
                document.base_revision.clone(),
                document
                    .stable
                    .as_ref()
                    .map(|slot| slot.revision)
                    .unwrap_or(0),
            );
            let candidate_revision =
                TargetRevision::new(document.base_revision.clone(), candidate.revision);
            let window = CanaryWindow::collect(
                &scored,
                &key,
                &stable,
                &candidate_revision,
                candidate.canary_started_at_ms.unwrap_or(0),
            );
            let prior = stats
                .bucket(&key, &stable, Channel::Stable)
                .map(|bucket| {
                    BetaPrior::from_previous_stable(&bucket.posterior(BetaPrior::default()))
                })
                .unwrap_or_default();
            let evaluated = proposal
                .evaluation
                .as_ref()
                .is_some_and(|evaluation| evaluation.completed && evaluation.passed);
            match RolloutPolicy::from_settings(&settings.evolution, evaluated)
                .decide(&window, prior)
            {
                RolloutDecision::Promote { probability } => {
                    if promotion_requires_user(mode, document.pinned_stable) {
                        let ledger = store.read_rollout_ledger().unwrap_or_default();
                        if !ledger
                            .awaiting_promotion
                            .contains_key(&proposal.proposal_id)
                        {
                            let _ = store.update_rollout_ledger(|ledger| {
                                ledger.awaiting_promotion.insert(
                                    proposal.proposal_id.clone(),
                                    kcoder_evolution::AwaitingPromotion {
                                        target_key: key.clone(),
                                        probability,
                                        since_ms: now,
                                    },
                                );
                            });
                            self.evolution.notify(Some(&key), EvolutionChange::Proposal);
                        }
                    } else {
                        self.promote_canary(
                            store,
                            &proposal,
                            ProposalActor::Auto,
                            format!(
                                "promoted automatically: P(candidate better) = {probability:.2}"
                            ),
                            now,
                        );
                    }
                }
                RolloutDecision::Rollback(reason) => {
                    let reason = match reason {
                        kcoder_evolution::RollbackReason::Probability(probability) => {
                            format!("rolled back: P(candidate better) = {probability:.2}")
                        }
                        kcoder_evolution::RollbackReason::ExplicitNegative => {
                            "rolled back: explicit negative rating on the candidate".into()
                        }
                        kcoder_evolution::RollbackReason::HardFailure => {
                            "rolled back: hard failure on the candidate".into()
                        }
                    };
                    self.rollback_canary(store, &proposal, reason, now);
                }
                RolloutDecision::Continue { .. } => {}
            }
        }
    }

    /// Promote a proposal's candidate (pointer switch; skill-file targets
    /// also publish the staged file revision).
    pub(crate) fn promote_canary(
        &self,
        store: &EvolutionStore,
        proposal: &Proposal,
        actor: ProposalActor,
        reason: String,
        now: u64,
    ) -> bool {
        let key = &proposal.target_key;
        let settings = recover_settings(self);
        let skill_file = self.evolution_skill_file_target(key, &settings);
        let new_base = match &skill_file {
            Some(target) => match super::skill_file::promote(target, &proposal.proposal_id) {
                Ok(base) => base,
                Err(reason) => {
                    self.rollback_canary(
                        store,
                        proposal,
                        format!("skill file promotion failed: {reason}"),
                        now,
                    );
                    return false;
                }
            },
            None => None,
        };
        let Some(document) = store.overlay_document(key).ok().flatten() else {
            return false;
        };
        let own = document.candidate.as_ref().is_some_and(|candidate| {
            candidate.proposal_id.as_deref() == Some(proposal.proposal_id.as_str())
                && matches!(
                    candidate.state,
                    OverlayCandidateState::Staged | OverlayCandidateState::Canary
                )
        });
        let promoted = if own {
            match store.promote_candidate(key, document.revision, now) {
                Ok(promoted) => promoted,
                Err(error) => {
                    self.evolution
                        .note_diagnostic(format!("promotion of {key} failed: {error}"));
                    return false;
                }
            }
        } else {
            document
        };
        if let Some(base) = new_base {
            // The learned block now lives in the skill file: the overlay
            // restarts empty for the new base revision.
            let _ = store.write_stable_overlay(
                key,
                Some(promoted.revision),
                &base,
                &OverlayContent::default(),
                OverlaySlotSource::Proposal,
                now,
            );
            self.reload_skills_after_promotion();
        }
        if transition(store, proposal, ProposalState::Promoted, actor, reason, now).is_none() {
            return false;
        }
        let _ = store.update_rollout_ledger(|ledger| ledger.settle(&proposal.proposal_id));
        self.evolution.notify(Some(key), EvolutionChange::Promoted);
        true
    }

    fn reload_skills_after_promotion(&self) {
        let context = self.base_tool_context(100_000, 60_000, 40_000, None);
        if let Err(error) = context.reload_skill_registry() {
            self.evolution
                .note_diagnostic(format!("skill registry not reloaded: {error}"));
        }
    }

    /// Roll a running canary back: pointer switch only, content kept.
    pub(crate) fn rollback_canary(
        &self,
        store: &EvolutionStore,
        proposal: &Proposal,
        reason: String,
        now: u64,
    ) {
        let key = &proposal.target_key;
        if let Some(document) = store.overlay_document(key).ok().flatten()
            && document.candidate.as_ref().is_some_and(|candidate| {
                candidate.proposal_id.as_deref() == Some(proposal.proposal_id.as_str())
                    && matches!(
                        candidate.state,
                        OverlayCandidateState::Staged | OverlayCandidateState::Canary
                    )
            })
            && let Err(error) = store.rollback_candidate(key, document.revision, now)
        {
            self.evolution
                .note_diagnostic(format!("rollback of {key} failed: {error}"));
            return;
        }
        let settings = recover_settings(self);
        if let Some(target) = self.evolution_skill_file_target(key, &settings) {
            super::skill_file::discard(&target, &proposal.proposal_id);
        }
        if transition(
            store,
            proposal,
            ProposalState::RolledBack,
            ProposalActor::Auto,
            reason,
            now,
        )
        .is_some()
        {
            let _ = store.update_rollout_ledger(|ledger| ledger.settle(&proposal.proposal_id));
            self.evolution
                .notify(Some(key), EvolutionChange::RolledBack);
        }
    }

    /// `auto` mode: write safety-scanned preference proposals directly.
    fn auto_write_preferences(&self, store: &EvolutionStore, settings: &Settings, now: u64) {
        if !settings
            .evolution
            .targets
            .type_enabled(TargetType::Preference)
            || settings.evolution.effective_mode(TargetType::Preference) != EvolutionMode::Auto
        {
            return;
        }
        for proposal in store.list_proposals().unwrap_or_default() {
            if proposal.target_key.target_type() != TargetType::Preference
                || proposal.state != ProposalState::Draft
                || !scan_passed(&proposal)
                || !super::target_active(&settings.evolution, &proposal.target_key)
            {
                continue;
            }
            let Some(value) = proposal.changes.lessons_add.first() else {
                continue;
            };
            let key = format!("pref.{}", proposal.target_key.name());
            if kcoder_evolution::parse_preference_key(&key).is_err() {
                continue;
            }
            let (value, _) = kcoder_tools::session_read::redact_secrets(value);
            let Ok(document) = store.read_preferences() else {
                continue;
            };
            if document
                .items
                .get(&key)
                .is_none_or(|entry| entry.value != value)
                && store
                    .set_learned_preference(
                        &key,
                        &value,
                        &proposal.evidence_ids,
                        document.revision,
                        now,
                    )
                    .is_err()
            {
                continue;
            }
            let Some(canary) = transition(
                store,
                &proposal,
                ProposalState::Canary,
                ProposalActor::Auto,
                "written automatically (auto mode)".into(),
                now,
            ) else {
                continue;
            };
            if transition(
                store,
                &canary,
                ProposalState::Promoted,
                ProposalActor::Auto,
                "written automatically (auto mode)".into(),
                now,
            )
            .is_some()
            {
                self.evolution
                    .notify(Some(&proposal.target_key), EvolutionChange::Promoted);
            }
        }
    }

    /// Spawn the evaluation found by the last automation step.
    pub(crate) fn spawn_pending_evaluation(&self, settings: &Settings) -> bool {
        let Some(pending) = self
            .evolution
            .automation
            .next_eval
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        else {
            return false;
        };
        let Some(store) = self.evolution.store(pending.scope, &self.cwd) else {
            return false;
        };
        let model = match self.resolve_evolution_model(EvolutionStage::Eval) {
            Ok(model) => model,
            Err(_) => {
                // No fallback model: keep the work for later.
                self.evolution.lock_state().paused =
                    Some(kcoder_types::evolution::EvolutionDisabledReason::ModelUnavailable);
                *self
                    .evolution
                    .automation
                    .next_eval
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(pending);
                return false;
            }
        };
        self.evolution.lock_state().paused = None;
        let limits = *self
            .evolution
            .automation
            .eval_limits
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let engine = self.clone();
        let key = pending.plan.key.clone();
        let job_store = Arc::clone(&store);
        let settings = settings.clone();
        self.spawn_job(EvolutionJobKind::Eval, Some(key), &store, move |token| {
            Box::pin(async move {
                let (result, usage) = engine
                    .run_evaluation(&model, &pending.plan, limits, &token)
                    .await;
                if let Some(user) = engine.evolution.store(ScopeKind::User, &engine.cwd) {
                    let _ =
                        user.record_model_usage(now_ms(), usage.input_tokens, usage.output_tokens);
                }
                if token.is_cancelled() {
                    return;
                }
                engine.finish_evaluation(&job_store, &pending.proposal_id, result, &settings);
            })
        })
    }

    /// Record an evaluation (failures are kept) and move the proposal on.
    pub(crate) fn finish_evaluation(
        &self,
        store: &EvolutionStore,
        proposal_id: &str,
        result: kcoder_types::evolution::EvaluationResult,
        settings: &Settings,
    ) {
        let now = now_ms();
        let current = recover_settings(self);
        let Ok(Some(proposal)) = store.read_proposal(proposal_id) else {
            return;
        };
        if proposal.state != ProposalState::Draft
            || !super::collection_allowed(&current, false, true)
            || !super::target_active(&current.evolution, &proposal.target_key)
        {
            return;
        }
        let Ok(proposal) = store.record_proposal_review(
            proposal_id,
            proposal.revision,
            None,
            Some(result.clone()),
            now,
        ) else {
            return;
        };
        if !result.completed {
            let _ = store.update_rollout_ledger(|ledger| {
                *ledger
                    .eval_attempts
                    .entry(proposal_id.to_string())
                    .or_default() += 1;
            });
            self.evolution
                .notify(Some(&proposal.target_key), EvolutionChange::Proposal);
            return;
        }
        if !result.passed {
            self.reject(
                store,
                &proposal,
                format!(
                    "evaluation failed: {}",
                    result.reason.clone().unwrap_or_default()
                ),
                now,
            );
            return;
        }
        let Some(evaluated) = transition(
            store,
            &proposal,
            ProposalState::Evaluated,
            ProposalActor::Auto,
            format!(
                "evaluation passed: {} wins, {} losses, {} ties",
                result.wins, result.losses, result.ties
            ),
            now,
        ) else {
            return;
        };
        self.start_canary(store, &evaluated, true, settings, now);
    }

    /// The engine's part of a user's acceptance of a skill overlay
    /// proposal. `None` leaves the acceptance to the default (direct)
    /// behaviour: evolution off, a pinned target or a proposal the
    /// automation does not handle.
    pub(crate) fn accept_skill_proposal(
        &self,
        request: &ProposalAcceptRequest<'_>,
    ) -> Option<ServiceResult<()>> {
        let proposal = request.proposal;
        let settings = recover_settings(self);
        if !Self::canaried(proposal.target_key.target_type())
            || proposal.location != ProposalLocation::Overlay
            || !super::collection_allowed(&settings, false, true)
            || Self::rollout_mode(&settings, proposal.target_key.target_type())
                < EvolutionMode::Propose
            || request
                .document
                .is_some_and(|document| document.pinned_stable)
        {
            return None;
        }
        match proposal.state {
            // Approve for evaluation and canary; the idle poll runs them.
            ProposalState::Draft | ProposalState::Evaluated if scan_passed(proposal) => {
                let result = request
                    .store
                    .update_rollout_ledger(|ledger| {
                        ledger
                            .approved
                            .insert(proposal.proposal_id.clone(), request.now_ms);
                    })
                    .map(|_| ())
                    .map_err(Into::into);
                if result.is_ok() {
                    *self
                        .evolution
                        .automation
                        .last_rollout_check
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) = None;
                }
                Some(result)
            }
            // Promote a canary the user confirms.
            ProposalState::Canary => {
                let promoted = self.promote_canary(
                    request.store,
                    proposal,
                    ProposalActor::User,
                    "promoted by user".into(),
                    request.now_ms,
                );
                Some(if promoted {
                    Ok(())
                } else {
                    Err(kcoder_tools::evolution_service::EvolutionServiceError::new(
                        "evolution_invalid_transition",
                        "the canary could not be promoted",
                    ))
                })
            }
            _ => None,
        }
    }

    /// Curator: the skill behind `key` was archived or restored. Archiving
    /// stops a running canary (pointer switch only) and keeps the overlay
    /// under the target key, so restoring serves it again.
    pub(crate) fn evolution_target_archived(&self, key: &TargetKey, archived: bool) {
        let now = now_ms();
        for scope in [ScopeKind::Project, ScopeKind::User] {
            let Some(store) = self.evolution.store(scope, &self.cwd) else {
                continue;
            };
            let known = store.overlay_document(key).ok().flatten().is_some()
                || store
                    .read_rollout_ledger()
                    .is_ok_and(|ledger| ledger.archived_targets.contains(key));
            if !known && scope == ScopeKind::User {
                continue;
            }
            let _ = store.update_rollout_ledger(|ledger| {
                if archived {
                    ledger.archived_targets.insert(key.clone());
                } else {
                    ledger.archived_targets.remove(key);
                }
            });
            if archived
                && let Some(document) = store.overlay_document(key).ok().flatten()
                && let Some(proposal) = document
                    .candidate
                    .as_ref()
                    .filter(|candidate| candidate.state == OverlayCandidateState::Canary)
                    .and_then(|candidate| candidate.proposal_id.as_deref())
                    .and_then(|id| store.read_proposal(id).ok().flatten())
                    .filter(|proposal| proposal.state == ProposalState::Canary)
            {
                self.rollback_canary(&store, &proposal, "rolled back: skill archived".into(), now);
            }
        }
    }

    /// Curator: stable-channel score of `key` (latest stable revision).
    pub(crate) fn evolution_curation_signal(
        &self,
        key: &TargetKey,
    ) -> Option<kcoder_tools::skill_evolution::SkillCurationSignal> {
        let settings = recover_settings(self);
        let weights = SignalWeights::from_settings(&settings.evolution.signals);
        for scope in [ScopeKind::Project, ScopeKind::User] {
            let Some(store) = self.evolution.store(scope, &self.cwd) else {
                continue;
            };
            let Ok(stats) = store.stats(&weights) else {
                continue;
            };
            if let Some((_, evidence)) = stats.latest_bucket(key, Channel::Stable) {
                let posterior = evidence.posterior(BetaPrior::default());
                let (_, upper) = posterior.credible_interval(kcoder_evolution::CREDIBLE_LEVEL);
                return Some(kcoder_tools::skill_evolution::SkillCurationSignal {
                    observations: evidence.observations,
                    mean: posterior.mean(),
                    upper,
                });
            }
        }
        None
    }
}

pub(crate) fn recover_settings(engine: &QueryEngine) -> Settings {
    crate::recover_read_lock(&engine.settings, "settings").clone()
}
