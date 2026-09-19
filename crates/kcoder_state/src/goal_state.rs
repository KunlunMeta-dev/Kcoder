use super::*;

impl AppState {
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
        .expect("Artifact verification is valid for every goal mode")
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
        {
            let mut inner = self.write_inner();
            if let Some(previous) = inner.goal.take() {
                archive_goal(&mut inner.goal_history, previous);
            }
            inner.goal = Some(goal.clone());
        }
        self.persist_latest_session_state_locked();
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
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            let now = now_millis();
            refresh_goal_wall_elapsed(goal, now);
            if status == GoalStatus::Active && goal.status != GoalStatus::Active {
                goal.blocked_candidate_fingerprint = None;
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

    /// Record that a model turn has started for the active `/goal`.
    pub fn record_goal_turn_start(&self, goal_id: &str) -> Option<Goal> {
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = {
                let goal = inner.goal.as_mut()?;
                if goal.goal_id != goal_id || !goal.status.is_active() {
                    return None;
                }
                goal.turn_count = goal.turn_count.saturating_add(1);
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
        let _persist = self.lock_session_state_persistence();
        let goal = {
            let mut inner = self.write_inner();
            let goal = inner.goal.as_mut()?;
            if !matches!(goal.status, GoalStatus::Active | GoalStatus::BudgetLimited) {
                return None;
            }
            let same_reason = goal.blocked_candidate_fingerprint.as_deref() == Some(fingerprint);
            if !same_reason {
                goal.blocked_candidate_fingerprint = Some(fingerprint.to_string());
                goal.blocked_candidate_count = 0;
                goal.blocked_candidate_last_turn = None;
            }
            if goal.blocked_candidate_last_turn != Some(goal.turn_count) {
                goal.blocked_candidate_count = goal.blocked_candidate_count.saturating_add(1);
                goal.blocked_candidate_last_turn = Some(goal.turn_count);
                goal.push_event(
                    GoalEventKind::BlockedCandidate,
                    format!("blocked candidate attempt {}", goal.blocked_candidate_count),
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
