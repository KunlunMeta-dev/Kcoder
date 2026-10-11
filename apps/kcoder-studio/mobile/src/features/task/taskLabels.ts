import { t } from "@/i18n";
import { type ThreadGoal } from "@/runtime/task-runtime";

export function taskOpenError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  if (/lease|already.*(?:active|running)|another.*client/i.test(message)) {
    return t("task.this_task_is_running_in_another_client_stop");
  }
  if (/session.*(?:expired|invalid)|authentication/i.test(message))
    return t("task.the_gateway_session_has_expired_reconnect_in_settings");
  return message;
}

export function goalLabel(goal: ThreadGoal): string {
  return goal.mode === "strict"
    ? "Goal Pro"
    : goal.mode === "arrangement"
      ? "UltGoal"
      : "Goal";
}

export function goalStatusNotice(goal: ThreadGoal | null): string {
  if (!goal) return t("task.no_current_goal");
  const budget = goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget}`;
  return `${goalLabel(goal)} · ${goal.status} · ${goal.tokensUsed}${budget} tokens · ${goal.timeUsedSeconds}s\n${goal.objective}`;
}

export function goalHistoryNotice(
  goals: ThreadGoal[],
  mode: ThreadGoal["mode"],
): string {
  if (goals.length === 0)
    return t("task.no_completed_blocked_or_budgetlimited_goals_in_history");
  const requestedLabel =
    mode === "strict"
      ? "Goal Pro"
      : mode === "arrangement"
        ? "UltGoal"
        : "Goal";
  return `${t("task.goal_history", { label: requestedLabel })}\n${goals
    .slice(-20)
    .reverse()
    .map((goal) => `${goal.status} · ${goal.mode} · ${goal.objective}`)
    .join("\n")}`;
}

export function goalIsUnfinished(goal: ThreadGoal): boolean {
  return (
    goal.status === "active" ||
    goal.status === "paused" ||
    goal.status === "blocked"
  );
}
