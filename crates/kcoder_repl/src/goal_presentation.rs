//! Goal labels and token/time display.

use super::*;

pub(super) fn goal_status_label(goal: &Goal) -> String {
    let name = goal_display_name(goal);
    let resume = format!("{} resume", goal_command_for_goal(goal));
    match goal.status {
        GoalStatus::Active => format!(
            "{name} running turn {} · Esc pauses · {}",
            goal.turn_count.max(1),
            active_goal_usage(goal)
        ),
        GoalStatus::Paused => format!("{name} paused ({resume})"),
        GoalStatus::Blocked => format!("{name} blocked ({resume})"),
        GoalStatus::UsageLimited => format!("{name} hit usage limits ({resume})"),
        GoalStatus::BudgetLimited => match stopped_goal_budget_usage(goal) {
            Some(usage) => format!("{name} unmet ({usage})"),
            None => format!("{name} abandoned"),
        },
        GoalStatus::Cancelled => format!("{name} cancelled by user"),
        GoalStatus::Complete => format!("{name} complete ({})", completed_goal_usage(goal)),
    }
}

pub(super) fn goal_display_name(goal: &Goal) -> &'static str {
    if goal.mode.is_arrangement() {
        "UltGoal"
    } else if goal.mode.is_strict() {
        "Goal Pro"
    } else {
        "Goal"
    }
}

pub(super) fn goal_command_for_goal(goal: &Goal) -> &'static str {
    if goal.mode.is_arrangement() {
        "/ultgoal"
    } else if goal.mode.is_strict() {
        "/goal-pro"
    } else {
        "/goal"
    }
}

pub(super) fn active_goal_usage(goal: &Goal) -> String {
    if let Some(budget) = goal.token_budget {
        return format!(
            "{} / {}",
            compact_token_count(goal.tokens_used),
            compact_token_count(budget)
        );
    }
    format_goal_elapsed_seconds(goal.time_used_seconds)
}

pub(super) fn stopped_goal_budget_usage(goal: &Goal) -> Option<String> {
    goal.token_budget.map(|budget| {
        format!(
            "{} / {} tokens",
            compact_token_count(goal.tokens_used),
            compact_token_count(budget)
        )
    })
}

pub(super) fn completed_goal_usage(goal: &Goal) -> String {
    if goal.token_budget.is_some() {
        return format!("{} tokens", compact_token_count(goal.tokens_used));
    }
    format_goal_elapsed_seconds(goal.time_used_seconds)
}

pub(super) fn format_goal_elapsed_seconds(seconds: u64) -> String {
    if seconds < 60 {
        return format!("{seconds}s");
    }

    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }

    let hours = minutes / 60;
    let remaining_minutes = minutes % 60;
    if hours >= 24 {
        let days = hours / 24;
        let remaining_hours = hours % 24;
        return format!("{days}d {remaining_hours}h {remaining_minutes}m");
    }

    if remaining_minutes == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h {remaining_minutes}m")
    }
}

pub(super) fn compact_token_count(value: u64) -> String {
    if value < 1_000 {
        return value.to_string();
    }

    let value_f64 = value as f64;
    let (scaled, suffix) = if value >= 1_000_000_000_000 {
        (value_f64 / 1_000_000_000_000.0, "T")
    } else if value >= 1_000_000_000 {
        (value_f64 / 1_000_000_000.0, "B")
    } else if value >= 1_000_000 {
        (value_f64 / 1_000_000.0, "M")
    } else {
        (value_f64 / 1_000.0, "K")
    };

    let decimals = if scaled < 10.0 {
        2
    } else if scaled < 100.0 {
        1
    } else {
        0
    };

    let mut formatted = format!("{scaled:.decimals$}");
    if formatted.contains('.') {
        while formatted.ends_with('0') {
            formatted.pop();
        }
        if formatted.ends_with('.') {
            formatted.pop();
        }
    }

    format!("{formatted}{suffix}")
}
