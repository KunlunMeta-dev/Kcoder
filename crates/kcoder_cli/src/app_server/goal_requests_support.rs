//! Goal requests support: extracted from the app-server connection boundary.

use super::*;

pub(super) fn goal_pro_verifier_selection(engine: &QueryEngine) -> GoalVerifierSelection {
    let goal_pro = engine.settings.read().unwrap().goal_pro.clone();
    GoalVerifierSelection {
        profile: non_empty_setting(goal_pro.verifier_profile),
        provider: non_empty_setting(goal_pro.verifier_provider),
        model: non_empty_setting(goal_pro.verifier_model),
        verifier_panel: kcoder_config::normalize_goal_pro_verifier_panel(goal_pro.verifier_models),
        verifier_max_turns: goal_pro.verifier_max_turns.max(1),
        completion_rejection_limit: Some(goal_pro.completion_rejection_limit.max(1)),
        verification: goal_pro.verification,
    }
}

pub(super) fn non_empty_setting(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub(super) fn ensure_goal_precondition(
    current: Option<&Goal>,
    expected_goal_id: Option<&str>,
    expected_revision: Option<u64>,
    require_no_goal: bool,
) -> Result<()> {
    if require_no_goal {
        if expected_goal_id.is_some() || expected_revision.is_some() {
            anyhow::bail!("requireNoGoal cannot be combined with an expected goal")
        }
        if current.is_some() {
            anyhow::bail!("goal changed concurrently: expected no current goal")
        }
        return Ok(());
    }
    if expected_revision.is_some() && expected_goal_id.is_none() {
        anyhow::bail!("expectedRevision requires expectedGoalId")
    }
    let Some(expected_goal_id) = expected_goal_id else {
        return Ok(());
    };
    let current =
        current.context("goal changed concurrently: expected goal is no longer current")?;
    if current.goal_id != expected_goal_id {
        anyhow::bail!("goal changed concurrently: expected goal is no longer current")
    }
    if expected_revision.is_some_and(|revision| revision != current.revision) {
        anyhow::bail!("goal changed concurrently: expected revision is stale")
    }
    Ok(())
}

pub(super) fn parse_goal_status(value: &str) -> Result<GoalStatus> {
    match value.trim() {
        "active" => Ok(GoalStatus::Active),
        "paused" => Ok(GoalStatus::Paused),
        "blocked" => Ok(GoalStatus::Blocked),
        "usageLimited" | "usage_limited" => Ok(GoalStatus::UsageLimited),
        "budgetLimited" | "budget_limited" => Ok(GoalStatus::BudgetLimited),
        "complete" => Ok(GoalStatus::Complete),
        "cancelled" => Ok(GoalStatus::Cancelled),
        other => anyhow::bail!("unsupported goal status: {other}"),
    }
}

/// Validate explicit goal-state transitions in the app-server.
///
/// `usageLimited` is terminal for automatic execution, but after the user adds
/// allowance it must support the same narrow transition back to active as paused or
/// blocked. complete and budgetLimited remain irreversible, and other terminal-state
/// rewrites require clear first to preserve the goal lifecycle.
pub(super) fn ensure_goal_status_transition(
    existing: GoalStatus,
    requested: Option<GoalStatus>,
) -> Result<()> {
    let Some(requested) = requested else {
        return Ok(());
    };
    if requested == existing
        || existing.is_unfinished()
        || (requested == GoalStatus::Active && existing.is_user_resumable())
    {
        return Ok(());
    }
    anyhow::bail!(
        "terminal goal status `{}` cannot be changed; clear it before starting a new goal",
        existing.as_str()
    )
}

pub(super) fn parse_goal_mode(value: &str) -> Result<GoalMode> {
    match value.trim() {
        "standard" => Ok(GoalMode::Standard),
        "arrangement" => Ok(GoalMode::Arrangement),
        "strict" => Ok(GoalMode::Strict),
        other => anyhow::bail!("unsupported goal mode: {other}"),
    }
}

pub(super) fn parse_goal_verification_kind(value: &str) -> Result<GoalVerificationKind> {
    match value.trim() {
        "artifact" => Ok(GoalVerificationKind::Artifact),
        "answer" => Ok(GoalVerificationKind::Answer),
        other => anyhow::bail!("unsupported goal verification kind: {other}"),
    }
}

pub(super) fn thread_goal(thread_id: &str, goal: &Goal) -> ThreadGoal {
    let status = match goal.status {
        GoalStatus::Active => "active",
        GoalStatus::Paused => "paused",
        GoalStatus::Blocked => "blocked",
        GoalStatus::UsageLimited => "usageLimited",
        GoalStatus::BudgetLimited => "budgetLimited",
        GoalStatus::Complete => "complete",
        GoalStatus::Cancelled => "cancelled",
    };
    ThreadGoal {
        thread_id: thread_id.to_string(),
        goal_id: goal.goal_id.clone(),
        objective: kcoder_state::goal_objective_text(goal)
            .unwrap_or_else(|_| goal.objective.clone()),
        mode: goal.mode.as_str().to_string(),
        verification_kind: goal.verification_kind.as_str().to_string(),
        status: status.to_string(),
        token_budget: goal.token_budget,
        tokens_used: goal.tokens_used,
        time_used_seconds: goal.time_used_seconds,
        turn_count: goal.turn_count,
        blocked_candidate_count: goal.blocked_candidate_count,
        blocker_id: goal.blocked_candidate_id.clone(),
        blocker_reason: goal.blocked_candidate_reason.clone(),
        created_at: goal.created_at_ms,
        updated_at: goal.updated_at_ms,
        revision: goal.revision,
        events: goal
            .events
            .iter()
            .rev()
            .take(5)
            .rev()
            .map(|event| ThreadGoalEvent {
                kind: event.kind.as_str().to_string(),
                timestamp: event.timestamp_ms,
                summary: event.summary.clone(),
            })
            .collect(),
    }
}
