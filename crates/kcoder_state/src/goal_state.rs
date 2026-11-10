use super::*;

const MAX_GOAL_OBSERVATION_ID_BYTES: usize = 1024;
// Windows supports long paths; OsStr length counts platform-encoded bytes.
const MAX_GOAL_OBSERVATION_PATH_BYTES: usize = 128 * 1024;

/// A point-in-time resident view, not a persistence receipt or authorization.
#[derive(Clone)]
pub struct ResidentGoalObservation {
    pub session_id: String,
    pub artifact_session_id: String,
    pub cwd: PathBuf,
    pub history_path: Option<PathBuf>,
    pub goal: Option<(String, u64, GoalStatus)>,
    pub goal_created_at_ms: Option<u64>,
    pub lifecycle: AppStateLifecycleIdentity,
}

/// A weak, non-authorizing view that does not retain the original State.
#[derive(Clone)]
pub struct WeakGoalObservation {
    inner: std::sync::Weak<PrivateStateLock<AppStateInner>>,
    persistence: std::sync::Weak<Mutex<()>>,
}

impl WeakGoalObservation {
    /// Briefly upgrades the original State for in-memory try-locks only.
    /// Busy, poison, a closed owner or oversized metadata is unavailable.
    pub fn try_snapshot(&self) -> Option<ResidentGoalObservation> {
        let state = self.inner.upgrade()?;
        let persistence = self.persistence.upgrade()?;
        let _persist = persistence.try_lock().ok()?;
        let inner = state.try_read().ok()?;
        let oversized_path = |path: &Path| path.as_os_str().len() > MAX_GOAL_OBSERVATION_PATH_BYTES;
        if inner.history_write_fault.is_some()
            || inner.session_id.len() > MAX_GOAL_OBSERVATION_ID_BYTES
            || oversized_path(&inner.cwd)
            || inner.history_path.as_deref().is_some_and(oversized_path)
            || inner
                .history_path
                .as_deref()
                .and_then(Path::file_stem)
                .is_some_and(|name| name.len() > MAX_GOAL_OBSERVATION_ID_BYTES)
            || (inner.history_path.is_none()
                && inner
                    .session_artifact_override
                    .as_ref()
                    .is_some_and(|location| {
                        location.session_id.len() > MAX_GOAL_OBSERVATION_ID_BYTES
                            || oversized_path(&location.project_dir)
                    }))
            || inner
                .goal
                .as_ref()
                .is_some_and(|goal| goal.goal_id.len() > MAX_GOAL_OBSERVATION_ID_BYTES)
        {
            return None;
        }
        Some(ResidentGoalObservation {
            session_id: inner.session_id.clone(),
            artifact_session_id: AppState::session_artifact_project_dir_and_id(&inner)
                .map(|(_, session_id)| session_id)
                .unwrap_or_else(|| inner.session_id.clone()),
            cwd: inner.cwd.clone(),
            history_path: inner.history_path.clone(),
            goal: inner
                .goal
                .as_ref()
                .map(|goal| (goal.goal_id.clone(), goal.revision, goal.status)),
            goal_created_at_ms: inner.goal.as_ref().map(|goal| goal.created_at_ms),
            lifecycle: crate::history_append_context::lifecycle_identity_from_identity_locked(
                AppStateIdentity(self.inner.clone()),
                &inner,
            ),
        })
    }
}

impl AppState {
    /// Construct a weak observer without locking or retaining this State.
    pub fn weak_goal_observation(&self) -> WeakGoalObservation {
        WeakGoalObservation {
            inner: Arc::downgrade(&self.inner),
            persistence: Arc::downgrade(&self.session_state_persist_lock),
        }
    }

    /// Observe the original lifecycle and goal without waiting for either lock.
    /// This is an in-memory observation, not a persistence receipt.
    pub fn try_goal_observation_snapshot(&self) -> Option<ResidentGoalObservation> {
        self.weak_goal_observation().try_snapshot()
    }

    /// Get the current `/goal`, if any.
    pub fn goal(&self) -> Option<Goal> {
        self.read_inner().goal.clone()
    }

    /// Get terminal `/goal` entries archived for this session.
    pub fn goal_history(&self) -> Vec<Goal> {
        self.read_inner().goal_history.clone()
    }

    /// Create or replace the current `/goal`.
    pub fn set_goal(&self, objective: impl Into<String>, token_budget: Option<u64>) -> Goal {
        self.set_goal_prepared(objective.into(), None, token_budget)
    }

    /// Create or replace the current `/goal` using a preprocessed
    /// objective. Long objectives may point at an attachment file.
    pub fn set_goal_prepared(
        &self,
        objective: impl Into<String>,
        objective_file: Option<PathBuf>,
        token_budget: Option<u64>,
    ) -> Goal {
        self.set_goal_prepared_with_mode(
            objective,
            objective_file,
            token_budget,
            GoalMode::Standard,
        )
    }

    /// Compatibility convenience for infallible/in-memory callers.
    /// Panics on storage failure; interactive and tool entry points must use
    /// `set_goal_prepared_with_mode_and_verification` and handle its Result.
    pub fn set_goal_prepared_with_mode(
        &self,
        objective: impl Into<String>,
        objective_file: Option<PathBuf>,
        token_budget: Option<u64>,
        mode: GoalMode,
    ) -> Goal {
        self.set_goal_prepared_with_mode_and_verification(
            objective,
            objective_file,
            token_budget,
            mode,
            GoalVerificationKind::Artifact,
        )
        .expect("goal creation requires valid configuration and writable session storage; use the fallible goal API")
    }

    pub fn set_goal_prepared_with_mode_and_verification(
        &self,
        objective: impl Into<String>,
        objective_file: Option<PathBuf>,
        token_budget: Option<u64>,
        mode: GoalMode,
        verification_kind: GoalVerificationKind,
    ) -> anyhow::Result<Goal> {
        self.set_goal_prepared_with_mode_and_verification_and_verifier(
            objective,
            objective_file,
            token_budget,
            mode,
            verification_kind,
            GoalVerifierSelection::default(),
        )
    }

    pub fn set_goal_prepared_with_mode_and_verification_and_verifier(
        &self,
        objective: impl Into<String>,
        objective_file: Option<PathBuf>,
        token_budget: Option<u64>,
        mode: GoalMode,
        verification_kind: GoalVerificationKind,
        verifier_selection: GoalVerifierSelection,
    ) -> anyhow::Result<Goal> {
        let _persist = self.lock_session_state_persistence();
        let mut goal = Goal::new_with_file_mode_and_verification_and_verifier(
            objective,
            objective_file,
            token_budget,
            mode,
            verification_kind,
            verifier_selection,
        )?;
        if self.session_mode().is_orchestrate() {
            let store = crate::orchestrate_store::PlanStore::for_workspace(&self.cwd());
            if let Ok(Some(work_id)) = store.active_work_id()
                && store.read_work(&work_id).is_ok()
            {
                goal.orchestrate_work_id = Some(work_id);
            }
        }
        let previous_state = {
            let mut inner = self.write_inner();
            let previous_state = (inner.goal.clone(), inner.goal_history.clone());
            if let Some(previous) = inner.goal.take() {
                archive_goal(&mut inner.goal_history, previous);
            }
            inner.goal = Some(goal.clone());
            previous_state
        };
        if let Err(error) = self.try_persist_latest_session_state_locked() {
            let mut inner = self.write_inner();
            if crate::history_store::is_uncertain_mutation(&error) {
                inner.history_write_fault = Some(format!("{error:#}"));
            } else {
                inner.goal = previous_state.0;
                inner.goal_history = previous_state.1;
            }
            return Err(error).context("goal persistence failed");
        }
        Ok(goal)
    }

    /// Save bounded semantic context at goal creation so a strict verifier does not see only references such as “continue.”
    pub fn set_goal_context_snapshot(&self, context_snapshot: Option<String>) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            goal.context_snapshot = context_snapshot;
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    /// Write a private verifier baseline for a HEAD-less workspace only once at goal creation.
    pub fn set_goal_workspace_baseline_if_matches(
        &self,
        expected_goal_id: &str,
        expected_revision: u64,
        baseline: GoalWorkspaceBaseline,
    ) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            if goal.goal_id != expected_goal_id || goal.revision != expected_revision {
                return None;
            }
            goal.workspace_baseline = Some(baseline);
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    /// Bind the current goal to orchestration work that passed manifest and SHA validation.
    pub fn bind_goal_orchestrate_work(
        &self,
        work_id: Option<&str>,
    ) -> anyhow::Result<Option<Goal>> {
        if let Some(work_id) = work_id {
            crate::orchestrate_store::PlanStore::for_workspace(&self.cwd()).read_work(work_id)?;
        }
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let Some(goal) = inner.goal.as_mut() else {
                return Ok(None);
            };
            goal.orchestrate_work_id = work_id.map(str::to_string);
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Ok(Some(goal))
    }

    /// Clear the current `/goal`. Returns the removed goal, if one existed.
    pub fn clear_goal(&self) -> Option<Goal> {
        self.clear_goal_inner()
    }

    /// Explicit user removal records cancellation before removing the current goal.
    pub fn clear_goal_by_user(&self) -> anyhow::Result<Option<Goal>> {
        let _persist = self.lock_session_state_persistence();
        let removed = {
            let mut inner = self.write_inner();
            let mut removed = inner.goal.take();
            if let Some(goal) = removed.as_mut() {
                if goal.status.is_unfinished() || goal.status.is_user_resumable() {
                    refresh_goal_wall_elapsed(goal, now_millis());
                    goal.status = GoalStatus::Cancelled;
                    goal.push_event(GoalEventKind::Cancelled, "goal explicitly cleared by user");
                    goal.touch();
                }
                archive_goal(&mut inner.goal_history, goal.clone());
            }
            removed
        };
        // Never restore an active goal after the user asked to stop it.
        self.try_persist_latest_session_state_locked().context(
            "Goal stopped in memory, but clearing was not saved. Repair storage and retry clear before restarting.",
        )?;
        Ok(removed)
    }

    pub fn cancel_goal_by_user(&self) -> anyhow::Result<Option<Goal>> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let Some(goal) = inner.goal.as_mut() else {
                return Ok(None);
            };
            if !goal.status.is_unfinished()
                && !goal.status.is_user_resumable()
                && goal.status != GoalStatus::Cancelled
            {
                return Ok(None);
            }
            if goal.status != GoalStatus::Cancelled {
                refresh_goal_wall_elapsed(goal, now_millis());
                goal.status = GoalStatus::Cancelled;
                goal.push_event(
                    GoalEventKind::Cancelled,
                    "goal explicitly cancelled by user",
                );
                goal.touch();
            }
            let goal = goal.clone();
            archive_goal(&mut inner.goal_history, goal.clone());
            goal
        };
        self.try_persist_latest_session_state_locked().context(
            "Goal stopped in memory, but cancellation was not saved. Repair storage and retry cancel before restarting.",
        )?;
        Ok(Some(goal))
    }

    fn clear_goal_inner(&self) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let removed = {
            let mut inner = self.write_inner();
            let removed = inner.goal.take();
            if let Some(goal) = removed.clone() {
                archive_goal(&mut inner.goal_history, goal);
            }
            removed
        };
        self.persist_latest_session_state_locked();
        removed
    }

    /// Edit the current `/goal` objective and pause it for user review.
    pub fn edit_goal(
        &self,
        objective: impl Into<String>,
        objective_file: Option<PathBuf>,
        token_budget: Option<u64>,
    ) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            crate::goal_remote_budget::note_explicit_goal_change(goal)?;
            goal.objective = objective.into();
            goal.objective_file = objective_file;
            if let Some(token_budget) = token_budget {
                goal.token_budget = Some(token_budget);
            }
            goal.status = GoalStatus::Paused;
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    /// Update the current `/goal` status.
    pub fn update_goal_status(&self, status: GoalStatus) -> Option<Goal> {
        self.update_goal_status_inner(status, None)
    }

    /// Model verdicts cannot overwrite a concurrent user cancellation/edit/replacement.
    pub fn commit_goal_model_status(
        &self,
        goal_id: &str,
        revision: u64,
        status: GoalStatus,
    ) -> Option<Goal> {
        if !matches!(status, GoalStatus::Complete | GoalStatus::Blocked) {
            return None;
        }
        self.update_goal_status_inner(status, Some((goal_id, revision)))
    }

    fn update_goal_status_inner(
        &self,
        status: GoalStatus,
        expected: Option<(&str, u64)>,
    ) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            if let Some((id, revision)) = expected
                && (goal.goal_id != id
                    || goal.revision != revision
                    || !matches!(goal.status, GoalStatus::Active | GoalStatus::BudgetLimited))
            {
                return None;
            }
            crate::goal_remote_budget::note_explicit_goal_change(goal)?;
            let now = now_millis();
            refresh_goal_wall_elapsed(goal, now);
            if status == GoalStatus::Active && goal.status != GoalStatus::Active {
                goal.blocked_candidate_fingerprint = None;
                goal.blocked_candidate_id = None;
                goal.blocked_candidate_reason = None;
                goal.blocked_candidate_count = 0;
                goal.blocked_candidate_last_turn = None;
                goal.push_event(GoalEventKind::Resumed, "goal resumed");
            } else {
                let event = match status {
                    GoalStatus::Paused => Some((GoalEventKind::Paused, "goal paused")),
                    GoalStatus::Blocked => Some((GoalEventKind::Blocked, "goal blocked")),
                    GoalStatus::UsageLimited => {
                        Some((GoalEventKind::UsageLimited, "usage limit reached"))
                    }
                    GoalStatus::BudgetLimited => {
                        Some((GoalEventKind::BudgetLimited, "token budget reached"))
                    }
                    GoalStatus::Complete => Some((GoalEventKind::Complete, "goal completed")),
                    GoalStatus::Cancelled => Some((
                        GoalEventKind::Cancelled,
                        "goal explicitly cancelled by user",
                    )),
                    GoalStatus::Active => None,
                };
                if let Some((kind, summary)) = event {
                    goal.push_event(kind, summary);
                }
            }
            goal.status = status;
            goal.touch_at(now);
            let goal = goal.clone();
            archive_goal(&mut inner.goal_history, goal.clone());
            goal
        };
        self.persist_latest_session_state_locked();
        if matches!(
            status,
            GoalStatus::Blocked | GoalStatus::BudgetLimited | GoalStatus::Complete
        ) {
            info!(
                goal_id = %goal.goal_id,
                mode = goal.mode.as_str(),
                status = goal.status.as_str(),
                turn_count = goal.turn_count,
                tokens_used = goal.tokens_used,
                "goal status transitioned"
            );
        }
        Some(goal)
    }

    /// Replace the current goal's token budget while preserving its identity,
    /// usage accounting, objective, and status. `None` means unlimited.
    pub fn update_goal_token_budget(&self, token_budget: Option<u64>) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            crate::goal_remote_budget::note_explicit_goal_change(goal)?;
            goal.token_budget = token_budget;
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    /// Update the current `/goal` status only if it is still active.
    pub fn update_active_goal_status(&self, status: GoalStatus) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            if !goal.status.is_active() {
                return None;
            }
            let now = now_millis();
            refresh_goal_wall_elapsed(goal, now);
            goal.native_hold_budget_limit_cause = if status == GoalStatus::BudgetLimited {
                crate::goal_remote_budget::budget_limit_cause(goal)
            } else {
                None
            };
            goal.status = status;
            goal.touch_at(now);
            let goal = goal.clone();
            archive_goal(&mut inner.goal_history, goal.clone());
            goal
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    /// Account resource usage against the current `/goal`.
    pub fn account_goal_usage(&self, token_delta: u64, elapsed_seconds: u64) -> Option<Goal> {
        self.account_goal_usage_inner(token_delta, elapsed_seconds, false)
    }

    /// Count one admitted outer Engine execution, not an API retry or tool round.
    /// A goal created during an execution starts at epoch zero; each later execution
    /// advances this epoch once. Only this boundary defines consecutive audit turns.
    pub fn record_goal_turn_start(&self, goal_id: &str) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            if goal.goal_id != goal_id || !goal.status.is_active() {
                return None;
            }
            goal.turn_count = goal.turn_count.saturating_add(1);
            if goal
                .blocked_candidate_last_turn
                .is_some_and(|last| last.saturating_add(1) < goal.turn_count)
            {
                goal.blocked_candidate_count = 0;
                goal.blocked_candidate_last_turn = None;
                goal.blocked_candidate_fingerprint = None;
                goal.blocked_candidate_id = None;
                goal.blocked_candidate_reason = None;
            }
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    /// Count host-scheduled automatic continuations separately from execution epochs.
    pub fn record_goal_continuation_start(&self, goal_id: &str) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = {
                let goal = inner.goal.as_mut()?;
                if goal.goal_id != goal_id || !goal.status.is_active() {
                    return None;
                }
                goal.continuation_count = goal.continuation_count.saturating_add(1);
                goal.push_event(
                    GoalEventKind::Continuation,
                    format!("continuation {} started", goal.continuation_count),
                );
                goal.touch();
                goal.clone()
            };
            archive_goal(&mut inner.goal_history, goal.clone());
            goal
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    /// Record a model-proposed blocked candidate at most once per goal turn.
    pub fn record_goal_blocked_candidate(&self, fingerprint: &str) -> Option<Goal> {
        self.record_goal_blocked_candidate_details(fingerprint, None, None, None)
    }

    pub fn record_goal_blocked_candidate_details(
        &self,
        fingerprint: &str,
        blocker_id: Option<&str>,
        reason: Option<&str>,
        expected: Option<(&str, u64)>,
    ) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            if expected
                .is_some_and(|(id, revision)| goal.goal_id != id || goal.revision != revision)
            {
                return None;
            }
            if !matches!(goal.status, GoalStatus::Active | GoalStatus::BudgetLimited) {
                return None;
            }
            let same_reason = goal.blocked_candidate_fingerprint.as_deref() == Some(fingerprint);
            if !same_reason {
                goal.blocked_candidate_fingerprint = Some(fingerprint.to_string());
                goal.blocked_candidate_count = 0;
                goal.blocked_candidate_last_turn = None;
            }
            goal.blocked_candidate_id = blocker_id.map(|id| id.chars().take(128).collect());
            goal.blocked_candidate_reason =
                reason.map(|text| text.chars().filter(|c| !c.is_control()).take(512).collect());
            if goal.blocked_candidate_last_turn != Some(goal.turn_count) {
                let consecutive = goal
                    .blocked_candidate_last_turn
                    .and_then(|turn| turn.checked_add(1))
                    == Some(goal.turn_count);
                goal.blocked_candidate_count = if consecutive {
                    goal.blocked_candidate_count.saturating_add(1)
                } else {
                    1
                };
                goal.blocked_candidate_last_turn = Some(goal.turn_count);
                goal.push_event(
                    GoalEventKind::BlockedCandidate,
                    format!(
                        "turn {} blocked candidate {}/3 [{}]: {}",
                        goal.turn_count,
                        goal.blocked_candidate_count,
                        goal.blocked_candidate_id
                            .as_deref()
                            .unwrap_or("reason")
                            .chars()
                            .take(64)
                            .collect::<String>(),
                        goal.blocked_candidate_reason
                            .as_deref()
                            .unwrap_or("no reason supplied")
                    ),
                );
            }
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    pub fn record_goal_completion_rejected(&self, summary: &str) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            goal.complete_rejected_count = goal.complete_rejected_count.saturating_add(1);
            goal.push_event(GoalEventKind::CompletionRejected, summary);
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    pub fn commit_goal_verification(
        &self,
        expected_goal_id: &str,
        expected_revision: u64,
        verdict: GoalVerificationVerdict,
        summary: &str,
    ) -> GoalVerificationCommitOutcome {
        let _persist = self.lock_session_state_persistence();
        let outcome = {
            let mut inner = self.write_inner();
            let Some(goal) = inner.goal.as_mut() else {
                return GoalVerificationCommitOutcome::Stale(None);
            };
            if goal.goal_id != expected_goal_id
                || goal.revision != expected_revision
                || !matches!(goal.status, GoalStatus::Active | GoalStatus::BudgetLimited)
            {
                return GoalVerificationCommitOutcome::Stale(Some(goal.clone()));
            }
            goal.push_event(
                if verdict.passed() {
                    GoalEventKind::VerificationPassed
                } else {
                    GoalEventKind::VerificationRejected
                },
                format!("verdict={}: {summary}", verdict.as_str()),
            );
            if verdict.passed() {
                refresh_goal_wall_elapsed(goal, now_millis());
                goal.status = GoalStatus::Complete;
                goal.push_event(GoalEventKind::Complete, "goal completed");
            } else {
                goal.complete_rejected_count = goal.complete_rejected_count.saturating_add(1);
                if verdict.is_semantic_rejection() {
                    apply_semantic_completion_rejection(goal);
                }
            }
            goal.touch();
            let goal = goal.clone();
            if verdict.passed() || goal.status == GoalStatus::Blocked {
                archive_goal(&mut inner.goal_history, goal.clone());
            }
            GoalVerificationCommitOutcome::Applied(goal)
        };
        self.persist_latest_session_state_locked();
        outcome
    }

    pub fn record_goal_completion_rejected_if_matches(
        &self,
        expected_goal_id: &str,
        expected_revision: u64,
        summary: &str,
        semantic_rejection: bool,
    ) -> GoalVerificationCommitOutcome {
        let _persist = self.lock_session_state_persistence();
        let outcome = {
            let mut inner = self.write_inner();
            let Some(goal) = inner.goal.as_mut() else {
                return GoalVerificationCommitOutcome::Stale(None);
            };
            if goal.goal_id != expected_goal_id || goal.revision != expected_revision {
                return GoalVerificationCommitOutcome::Stale(Some(goal.clone()));
            }
            goal.complete_rejected_count = goal.complete_rejected_count.saturating_add(1);
            goal.push_event(GoalEventKind::CompletionRejected, summary);
            if semantic_rejection {
                apply_semantic_completion_rejection(goal);
            }
            goal.touch();
            let goal = goal.clone();
            if goal.status == GoalStatus::Blocked {
                archive_goal(&mut inner.goal_history, goal.clone());
            }
            GoalVerificationCommitOutcome::Applied(goal)
        };
        self.persist_latest_session_state_locked();
        outcome
    }

    /// Advance the primary-agent model-escalation ladder by one rung only when the
    /// goal is active and the current rung equals `expected_rung`, using CAS semantics
    /// to avoid interleaving with verifier revision changes.
    pub fn advance_goal_model_escalation(&self, expected_rung: u32) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            if !goal.status.is_active() || goal.model_escalation_rung != expected_rung {
                return None;
            }
            goal.model_escalation_rung = goal.model_escalation_rung.saturating_add(1);
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    /// Update the cross-turn progress fingerprint; callers skip pure chat turns without tool calls.
    pub fn record_goal_progress_fingerprint(&self, fingerprint: &str) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            if !goal.status.is_active() {
                return None;
            }
            if goal.last_progress_fingerprint.as_deref() == Some(fingerprint) {
                goal.stall_count = goal.stall_count.saturating_add(1);
            } else {
                goal.last_progress_fingerprint = Some(fingerprint.to_string());
                goal.stall_count = 0;
            }
            if goal.stall_count >= 2 {
                goal.push_event(
                    GoalEventKind::Stall,
                    format!(
                        "same progress fingerprint repeated {} times",
                        goal.stall_count + 1
                    ),
                );
            }
            goal.touch();
            goal.clone()
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }

    /// Account resource usage only while the current `/goal` is active.
    pub fn account_active_goal_usage(
        &self,
        token_delta: u64,
        elapsed_seconds: u64,
    ) -> Option<Goal> {
        self.account_goal_usage_inner(token_delta, elapsed_seconds, true)
    }

    fn account_goal_usage_inner(
        &self,
        token_delta: u64,
        elapsed_seconds: u64,
        active_only: bool,
    ) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = {
                let goal = inner.goal.as_mut()?;
                if active_only && !goal.status.is_active() {
                    return None;
                }
                goal.tokens_used = goal.tokens_used.saturating_add(token_delta);
                goal.time_used_seconds = goal.time_used_seconds.saturating_add(elapsed_seconds);
                goal.touch();
                goal.clone()
            };
            archive_goal(&mut inner.goal_history, goal.clone());
            goal
        };
        self.persist_latest_session_state_locked();
        Some(goal)
    }
}

fn apply_semantic_completion_rejection(goal: &mut Goal) {
    goal.semantic_completion_rejected_count =
        goal.semantic_completion_rejected_count.saturating_add(1);
    if let Some(limit) = goal.verifier_selection.completion_rejection_limit
        && goal.semantic_completion_rejected_count >= limit.max(1)
    {
        refresh_goal_wall_elapsed(goal, now_millis());
        goal.status = GoalStatus::Blocked;
        goal.push_event(
            GoalEventKind::CompletionRejectionLimitReached,
            format!(
                "semantic completion rejection limit reached: {}/{}; goal blocked",
                goal.semantic_completion_rejected_count,
                limit.max(1)
            ),
        );
        goal.push_event(
            GoalEventKind::Blocked,
            "goal blocked after semantic completion rejection limit reached",
        );
    }
}

fn archive_goal(history: &mut Vec<Goal>, goal: Goal) {
    if !goal.status.is_history_worthy() {
        return;
    }
    if let Some(existing) = history
        .iter_mut()
        .find(|existing| existing.goal_id == goal.goal_id)
    {
        *existing = goal;
    } else {
        history.push(goal);
    }
}

fn refresh_goal_wall_elapsed(goal: &mut Goal, now_ms: u64) {
    let wall_seconds = now_ms.saturating_sub(goal.created_at_ms) / 1000;
    goal.time_used_seconds = goal.time_used_seconds.max(wall_seconds);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weak_goal_observer_does_not_keep_a_closed_state_alive() {
        let state = AppState::new("/owned-workspace");
        let observer = state.weak_goal_observation();
        let identity = state.inspection_identity();
        assert!(observer.try_snapshot().is_some());
        drop(state);
        assert!(!identity.is_alive());
        assert!(observer.try_snapshot().is_none());
    }

    #[test]
    fn goal_observation_captures_one_lifecycle_and_goal_identity() {
        let state = AppState::new("/owned-workspace");
        state.with_session_artifact_project_dir("/owned-artifacts", "artifact-session");
        let empty = state.try_goal_observation_snapshot().unwrap();
        assert_eq!(empty.session_id, state.session_id());
        assert_eq!(empty.artifact_session_id, "artifact-session");
        assert_eq!(empty.cwd, PathBuf::from("/owned-workspace"));
        assert!(empty.history_path.is_none());
        assert!(empty.goal.is_none());
        let goal = state.set_goal("observe", None);
        let observed = state.try_goal_observation_snapshot().unwrap();
        assert_eq!(
            observed.goal,
            Some((goal.goal_id, goal.revision, GoalStatus::Active))
        );
        assert!(observed.lifecycle.same_lifecycle(&empty.lifecycle));
        state.start_new_session().unwrap();
        let next = state.try_goal_observation_snapshot().unwrap();
        assert!(!observed.lifecycle.same_lifecycle(&next.lifecycle));
        assert!(next.goal.is_none());
    }

    #[test]
    fn goal_observation_does_not_wait_for_locks_and_rejects_faults() {
        let state = AppState::new("/owned-workspace");
        let held = state.inner.write().unwrap();
        assert!(state.try_goal_observation_snapshot().is_none());
        drop(held);
        let held = state.session_state_persist_lock.lock().unwrap();
        assert!(state.try_goal_observation_snapshot().is_none());
        drop(held);
        state.write_inner().history_write_fault = Some("uncertain".to_owned());
        assert!(state.try_goal_observation_snapshot().is_none());
    }

    #[test]
    fn goal_observation_rejects_oversized_metadata_before_cloning() {
        let state = AppState::new("/owned-workspace");
        state.set_goal("goal", None);
        let original_goal_id = state.goal().unwrap().goal_id;
        {
            let mut inner = state.write_inner();
            inner.goal.as_mut().unwrap().goal_id = "g".repeat(MAX_GOAL_OBSERVATION_ID_BYTES + 1);
        }
        assert!(state.try_goal_observation_snapshot().is_none());
        {
            let mut inner = state.write_inner();
            inner.goal.as_mut().unwrap().goal_id = original_goal_id;
            inner.cwd = PathBuf::from("p".repeat(MAX_GOAL_OBSERVATION_PATH_BYTES + 1));
        }
        assert!(state.try_goal_observation_snapshot().is_none());
        {
            let mut inner = state.write_inner();
            inner.cwd = PathBuf::from("/owned-workspace");
            inner.session_id = "s".repeat(MAX_GOAL_OBSERVATION_ID_BYTES + 1);
        }
        assert!(state.try_goal_observation_snapshot().is_none());
        {
            let mut inner = state.write_inner();
            inner.session_id = "session".into();
            inner.history_path = Some(PathBuf::from(format!(
                "/history/{}.jsonl",
                "a".repeat(MAX_GOAL_OBSERVATION_ID_BYTES + 1)
            )));
        }
        assert!(state.try_goal_observation_snapshot().is_none());
        {
            let mut inner = state.write_inner();
            inner.history_path = None;
            inner.session_artifact_override = Some(SessionArtifactLocation {
                prefer_over_history: false,
                project_dir: PathBuf::from("/artifacts"),
                session_id: "a".repeat(MAX_GOAL_OBSERVATION_ID_BYTES + 1),
            });
        }
        assert!(state.try_goal_observation_snapshot().is_none());
    }

    #[test]
    fn goal_observation_rejects_poisoned_state_and_persistence_gates() {
        let state = AppState::new("/owned-workspace");
        let owned = state.clone();
        assert!(
            std::thread::spawn(move || {
                let _guard = owned.inner.write().unwrap();
                panic!("poison State fixture");
            })
            .join()
            .is_err()
        );
        assert!(state.try_goal_observation_snapshot().is_none());

        let state = AppState::new("/owned-workspace");
        let owned = state.clone();
        assert!(
            std::thread::spawn(move || {
                let _guard = owned.session_state_persist_lock.lock().unwrap();
                panic!("poison persistence fixture");
            })
            .join()
            .is_err()
        );
        assert!(state.try_goal_observation_snapshot().is_none());
    }

    #[test]
    fn goal_observation_does_not_publish_complete_during_actual_source_lock_wait() {
        #[cfg(unix)]
        let temp = {
            use std::os::unix::fs::PermissionsExt;
            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap()
        };
        #[cfg(not(unix))]
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path());
        let history = temp.path().join("session.jsonl");
        state.with_history_path(&history);
        state.add_message(kcoder_types::Message::user_text("original"));
        state.save_history().unwrap();
        state.set_goal("observe", None);
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(temp.path().join(".kcoder-history.lock"))
            .unwrap();
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        let owned = state.clone();
        let writer = std::thread::spawn(move || owned.update_goal_status(GoalStatus::Complete));
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let reached_uncommitted = loop {
            if state
                .goal()
                .is_some_and(|goal| goal.status == GoalStatus::Complete)
            {
                break true;
            }
            if std::time::Instant::now() >= until {
                break false;
            }
            std::thread::yield_now();
        };
        let observed = state.try_goal_observation_snapshot();
        fs2::FileExt::unlock(&lock).unwrap();
        let committed = writer.join().unwrap();
        assert!(reached_uncommitted, "writer did not reach the source lock");
        assert!(
            observed.is_none(),
            "uncommitted Complete must not be observed"
        );
        assert!(committed.is_some());
        assert_eq!(
            state
                .try_goal_observation_snapshot()
                .unwrap()
                .goal
                .unwrap()
                .2,
            GoalStatus::Complete
        );
    }

    fn set_strict_goal_with_rejection_limit(state: &AppState, limit: usize) -> Goal {
        let selection = GoalVerifierSelection {
            completion_rejection_limit: Some(limit),
            ..GoalVerifierSelection::default()
        };
        state
            .set_goal_prepared_with_mode_and_verification_and_verifier(
                "ship",
                None,
                None,
                GoalMode::Strict,
                GoalVerificationKind::Artifact,
                selection,
            )
            .unwrap()
    }

    #[test]
    fn user_goal_stop_reports_real_storage_failure_and_retries_without_reactivation() {
        for clear in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let state = AppState::new(temp.path());
            let history = temp.path().join("history.jsonl");
            state.with_history_path(&history);
            state.add_message(kcoder_types::Message::user_text("ship"));
            state.save_history().unwrap();
            state.set_goal("ship", None);
            let sidecar = state.session_state_path().unwrap();
            std::fs::remove_file(&sidecar).unwrap();
            std::fs::create_dir(&sidecar).unwrap();
            let error = if clear {
                state.clear_goal_by_user()
            } else {
                state.cancel_goal_by_user()
            }
            .unwrap_err();
            assert!(error.to_string().contains("not saved"));
            assert!(
                state
                    .goal()
                    .is_none_or(|goal| goal.status == GoalStatus::Cancelled)
            );
            std::fs::remove_dir(&sidecar).unwrap();
            if clear {
                state.clear_goal_by_user().unwrap();
            } else {
                state.cancel_goal_by_user().unwrap();
            }
            let restored = AppState::new(temp.path());
            restored.resume_from_history(&history).unwrap();
            if clear {
                assert!(restored.goal().is_none());
            } else {
                assert_eq!(restored.goal().unwrap().status, GoalStatus::Cancelled);
            }
            assert_eq!(
                restored.goal_history().last().unwrap().status,
                GoalStatus::Cancelled
            );
        }
    }

    #[test]
    fn blocked_audit_requires_consecutive_execution_epochs() {
        let state = AppState::new(".");
        let goal = state.set_goal("ship", None);
        for expected in [1, 2] {
            state.record_goal_turn_start(&goal.goal_id).unwrap();
            assert_eq!(
                state
                    .record_goal_blocked_candidate("same")
                    .unwrap()
                    .blocked_candidate_count,
                expected
            );
        }
        // A real execution without a matching blocked report breaks the audit.
        state.record_goal_turn_start(&goal.goal_id).unwrap();
        state.record_goal_turn_start(&goal.goal_id).unwrap();
        assert_eq!(state.goal().unwrap().blocked_candidate_count, 0);
        assert_eq!(
            state
                .record_goal_blocked_candidate("same")
                .unwrap()
                .blocked_candidate_count,
            1
        );
        assert_eq!(
            state
                .record_goal_blocked_candidate("same")
                .unwrap()
                .blocked_candidate_count,
            1
        );
        state.record_goal_continuation_start(&goal.goal_id).unwrap();
        assert_eq!(state.goal().unwrap().turn_count, 4);
        assert_eq!(state.goal().unwrap().continuation_count, 1);
    }

    #[test]
    fn blocked_audit_keeps_readable_reason_history() {
        let state = AppState::new(".");
        let goal = state.set_goal("ship", None);
        state.record_goal_turn_start(&goal.goal_id).unwrap();
        state
            .record_goal_blocked_candidate_details(
                "a",
                Some("permission"),
                Some("Missing deployment permission"),
                None,
            )
            .unwrap();
        state.record_goal_turn_start(&goal.goal_id).unwrap();
        let updated = state
            .record_goal_blocked_candidate_details(
                "b",
                Some("network"),
                Some("Server unavailable"),
                None,
            )
            .unwrap();
        assert_eq!(updated.blocked_candidate_count, 1);
        let history = serde_json::to_string(&updated.events).unwrap();
        assert!(history.contains("Missing deployment permission"));
        assert!(history.contains("Server unavailable"));
    }

    #[test]
    fn legacy_nonconsecutive_blocked_counts_are_not_trusted() {
        let state = AppState::new(".");
        let goal = state.set_goal("ship", None);
        let mut encoded = serde_json::to_value(goal).unwrap();
        encoded
            .as_object_mut()
            .unwrap()
            .remove("blocked_audit_version");
        encoded["blocked_candidate_count"] = serde_json::json!(2);
        encoded["blocked_candidate_last_turn"] = serde_json::json!(42);
        encoded["blocked_candidate_fingerprint"] = serde_json::json!("legacy");
        let restored: Goal = serde_json::from_value(encoded).unwrap();
        assert_eq!(restored.blocked_candidate_count, 0);
        assert!(restored.blocked_candidate_fingerprint.is_none());
    }

    #[test]
    fn explicit_cancel_is_terminal_durable_and_cannot_be_overwritten_by_model() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path());
        let path = temp.path().join("goal.jsonl");
        state.with_history_path(&path);
        state.add_message(kcoder_types::Message::user_text("ship"));
        state.save_history().unwrap();
        let initial = state.set_goal("ship", None);
        let cancelled = state.update_goal_status(GoalStatus::Cancelled).unwrap();
        assert!(!cancelled.status.is_unfinished());
        assert!(!cancelled.status.is_user_resumable());
        assert!(
            state
                .commit_goal_model_status(&initial.goal_id, initial.revision, GoalStatus::Complete)
                .is_none()
        );
        assert_eq!(
            state.goal_history().last().unwrap().status,
            GoalStatus::Cancelled
        );
        let restored = AppState::new(temp.path());
        restored.resume_from_history(&path).unwrap();
        assert_eq!(restored.goal().unwrap().status, GoalStatus::Cancelled);
        assert!(
            restored
                .goal()
                .unwrap()
                .events
                .iter()
                .any(|event| event.kind == GoalEventKind::Cancelled)
        );
        restored.set_goal("next", None);
        let removed = restored.clear_goal_by_user().unwrap().unwrap();
        assert_eq!(removed.status, GoalStatus::Cancelled);
        assert!(
            restored
                .goal_history()
                .iter()
                .any(|goal| goal.goal_id == removed.goal_id)
        );
    }

    #[test]
    fn advance_goal_model_escalation_is_cas_and_active_only() {
        let state = AppState::new(".");
        state.set_goal("ship it", None);

        let advanced = state.advance_goal_model_escalation(0).expect("rung 0 -> 1");
        assert_eq!(advanced.model_escalation_rung, 1);
        // An already consumed rung cannot advance again.
        assert!(state.advance_goal_model_escalation(0).is_none());
        let second = state.advance_goal_model_escalation(1).expect("rung 1 -> 2");
        assert_eq!(second.model_escalation_rung, 2);
        // Preserve the rung after persisted recovery.
        let persisted = state.goal().unwrap();
        assert_eq!(persisted.model_escalation_rung, 2);

        // Reject advancement for a non-active goal.
        state.update_goal_status(GoalStatus::Paused).unwrap();
        assert!(state.advance_goal_model_escalation(2).is_none());
    }

    #[test]
    fn blocked_candidate_counts_at_most_once_per_goal_turn() {
        let state = AppState::new(".");
        let goal = state.set_goal("ship it", None);
        state.record_goal_turn_start(&goal.goal_id).unwrap();

        let first = state
            .record_goal_blocked_candidate("same-fingerprint")
            .unwrap();
        let duplicate = state
            .record_goal_blocked_candidate("same-fingerprint")
            .unwrap();
        assert_eq!(first.blocked_candidate_count, 1);
        assert_eq!(duplicate.blocked_candidate_count, 1);

        state.record_goal_turn_start(&goal.goal_id).unwrap();
        let second = state
            .record_goal_blocked_candidate("same-fingerprint")
            .unwrap();
        assert_eq!(second.blocked_candidate_count, 2);
    }

    #[test]
    fn verification_commit_rejects_a_stale_revision_without_mutating_current_goal() {
        let state = AppState::new(".");
        let goal = state.set_goal_prepared_with_mode("ship", None, None, GoalMode::Strict);
        state.edit_goal("changed", None, None).unwrap();

        let outcome = state.commit_goal_verification(
            &goal.goal_id,
            goal.revision,
            GoalVerificationVerdict::Pass,
            "old attempt",
        );

        assert!(matches!(
            outcome,
            GoalVerificationCommitOutcome::Stale(Some(_))
        ));
        let current = state.goal().unwrap();
        assert_eq!(current.status, GoalStatus::Paused);
        assert_eq!(current.objective, "changed");
        assert!(current.events.iter().all(|event| {
            !matches!(
                event.kind,
                GoalEventKind::VerificationPassed | GoalEventKind::VerificationRejected
            )
        }));
    }

    #[test]
    fn semantic_rejections_block_atomically_at_the_frozen_limit() {
        let state = AppState::new(".");
        let initial = set_strict_goal_with_rejection_limit(&state, 2);

        let first = state.commit_goal_verification(
            &initial.goal_id,
            initial.revision,
            GoalVerificationVerdict::Fail,
            "first semantic rejection",
        );
        let GoalVerificationCommitOutcome::Applied(first) = first else {
            panic!("first verifier result should apply");
        };
        assert_eq!(first.status, GoalStatus::Active);
        assert_eq!(first.complete_rejected_count, 1);
        assert_eq!(first.semantic_completion_rejected_count, 1);

        let second = state.commit_goal_verification(
            &first.goal_id,
            first.revision,
            GoalVerificationVerdict::Flaky,
            "second semantic rejection",
        );
        let GoalVerificationCommitOutcome::Applied(blocked) = second else {
            panic!("threshold verifier result should apply");
        };
        assert_eq!(blocked.status, GoalStatus::Blocked);
        assert_eq!(blocked.complete_rejected_count, 2);
        assert_eq!(blocked.semantic_completion_rejected_count, 2);
        assert!(blocked.events.iter().any(|event| {
            event.kind == GoalEventKind::CompletionRejectionLimitReached
                && event.summary.contains("2/2")
        }));
        assert!(
            blocked
                .events
                .iter()
                .any(|event| event.kind == GoalEventKind::Blocked)
        );
        assert_eq!(state.goal_history(), vec![blocked]);
    }

    #[test]
    fn infrastructure_and_stale_verdicts_do_not_count_toward_the_limit() {
        let state = AppState::new(".");
        let initial = set_strict_goal_with_rejection_limit(&state, 1);

        let infrastructure = state.commit_goal_verification(
            &initial.goal_id,
            initial.revision,
            GoalVerificationVerdict::InfrastructureError,
            "provider unavailable",
        );
        let GoalVerificationCommitOutcome::Applied(after_infrastructure) = infrastructure else {
            panic!("infrastructure result should be recorded");
        };
        assert_eq!(after_infrastructure.status, GoalStatus::Active);
        assert_eq!(after_infrastructure.complete_rejected_count, 1);
        assert_eq!(after_infrastructure.semantic_completion_rejected_count, 0);

        state.update_goal_token_budget(Some(100)).unwrap();
        let stale = state.commit_goal_verification(
            &after_infrastructure.goal_id,
            after_infrastructure.revision,
            GoalVerificationVerdict::Fail,
            "stale semantic rejection",
        );
        assert!(matches!(
            stale,
            GoalVerificationCommitOutcome::Stale(Some(_))
        ));
        let current = state.goal().unwrap();
        assert_eq!(current.status, GoalStatus::Active);
        assert_eq!(current.complete_rejected_count, 1);
        assert_eq!(current.semantic_completion_rejected_count, 0);
    }

    #[test]
    fn deterministic_completion_gate_rejections_share_the_atomic_limit() {
        let state = AppState::new(".");
        let initial = set_strict_goal_with_rejection_limit(&state, 1);

        let outcome = state.record_goal_completion_rejected_if_matches(
            &initial.goal_id,
            initial.revision,
            "recent test failure evidence",
            true,
        );
        let GoalVerificationCommitOutcome::Applied(blocked) = outcome else {
            panic!("deterministic rejection should apply");
        };
        assert_eq!(blocked.status, GoalStatus::Blocked);
        assert_eq!(blocked.complete_rejected_count, 1);
        assert_eq!(blocked.semantic_completion_rejected_count, 1);
        assert!(blocked.events.iter().any(|event| {
            event.kind == GoalEventKind::CompletionRejected
                && event.summary.contains("recent test failure")
        }));
        assert!(
            blocked
                .events
                .iter()
                .any(|event| { event.kind == GoalEventKind::CompletionRejectionLimitReached })
        );
        assert!(
            blocked
                .events
                .iter()
                .any(|event| event.kind == GoalEventKind::Blocked)
        );
        assert_eq!(state.goal_history(), vec![blocked]);
    }

    #[test]
    fn stale_deterministic_completion_gate_rejection_does_not_count() {
        let state = AppState::new(".");
        let initial = set_strict_goal_with_rejection_limit(&state, 1);
        state.update_goal_token_budget(Some(100)).unwrap();

        let outcome = state.record_goal_completion_rejected_if_matches(
            &initial.goal_id,
            initial.revision,
            "stale deterministic rejection",
            true,
        );

        assert!(matches!(
            outcome,
            GoalVerificationCommitOutcome::Stale(Some(_))
        ));
        let current = state.goal().unwrap();
        assert_eq!(current.status, GoalStatus::Active);
        assert_eq!(current.complete_rejected_count, 0);
        assert_eq!(current.semantic_completion_rejected_count, 0);
    }

    #[test]
    fn pass_takes_precedence_and_legacy_unlimited_goals_never_auto_block() {
        let state = AppState::new(".");
        let limited = set_strict_goal_with_rejection_limit(&state, 1);
        let passed = state.commit_goal_verification(
            &limited.goal_id,
            limited.revision,
            GoalVerificationVerdict::Pass,
            "verified",
        );
        let GoalVerificationCommitOutcome::Applied(passed) = passed else {
            panic!("PASS should apply");
        };
        assert_eq!(passed.status, GoalStatus::Complete);
        assert_eq!(passed.semantic_completion_rejected_count, 0);

        let legacy = state.set_goal_prepared_with_mode("legacy", None, None, GoalMode::Strict);
        let mut current = legacy;
        for index in 0..10 {
            let outcome = state.commit_goal_verification(
                &current.goal_id,
                current.revision,
                GoalVerificationVerdict::Fail,
                &format!("legacy rejection {index}"),
            );
            let GoalVerificationCommitOutcome::Applied(applied) = outcome else {
                panic!("legacy verifier result should apply");
            };
            current = applied;
        }
        assert_eq!(current.status, GoalStatus::Active);
        assert_eq!(current.semantic_completion_rejected_count, 10);
        assert_eq!(current.verifier_selection.completion_rejection_limit, None);
    }

    #[test]
    fn revision_wrap_still_invalidates_a_verifier_snapshot() {
        let state = AppState::new(".");
        let goal = state.set_goal_prepared_with_mode("ship", None, None, GoalMode::Strict);
        {
            let mut inner = state.write_inner();
            inner.goal.as_mut().unwrap().revision = u64::MAX;
        }
        state.update_goal_token_budget(Some(100)).unwrap();

        let outcome = state.commit_goal_verification(
            &goal.goal_id,
            u64::MAX,
            GoalVerificationVerdict::Pass,
            "stale max revision",
        );

        assert!(matches!(
            outcome,
            GoalVerificationCommitOutcome::Stale(Some(_))
        ));
        assert_eq!(state.goal().unwrap().revision, 0);
        assert_ne!(state.goal().unwrap().status, GoalStatus::Complete);
    }

    #[test]
    fn blocked_candidate_resets_for_new_reason_and_after_resume() {
        let state = AppState::new(".");
        let goal = state.set_goal("ship it", None);
        state.record_goal_turn_start(&goal.goal_id).unwrap();
        state.record_goal_blocked_candidate("first").unwrap();
        state.record_goal_turn_start(&goal.goal_id).unwrap();
        let reset = state.record_goal_blocked_candidate("second").unwrap();
        assert_eq!(reset.blocked_candidate_count, 1);

        state.update_goal_status(GoalStatus::Blocked).unwrap();
        let resumed = state.update_goal_status(GoalStatus::Active).unwrap();
        assert_eq!(resumed.blocked_candidate_count, 0);
        assert!(resumed.blocked_candidate_fingerprint.is_none());
        assert!(resumed.blocked_candidate_last_turn.is_none());
    }
}
