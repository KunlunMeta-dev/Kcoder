import { type ThreadGoal } from "@/runtime/task-runtime";

export function taskOpenError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  if (/lease|already.*(?:active|running)|another.*client/i.test(message)) {
    return "该任务正在另一个客户端运行。请先停止另一端的回合，再点击返回后重试。";
  }
  if (/session.*(?:expired|invalid)|authentication/i.test(message))
    return "Gateway 会话已失效，请在设置中重新连接。";
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
  if (!goal) return "当前没有目标";
  const budget = goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget}`;
  return `${goalLabel(goal)} · ${goal.status} · ${goal.tokensUsed}${budget} tokens · ${goal.timeUsedSeconds}s\n${goal.objective}`;
}

export function goalHistoryNotice(
  goals: ThreadGoal[],
  mode: ThreadGoal["mode"],
): string {
  if (goals.length === 0) return "没有已完成、阻塞或达到限额的目标历史";
  const requestedLabel =
    mode === "strict"
      ? "Goal Pro"
      : mode === "arrangement"
        ? "UltGoal"
        : "Goal";
  return `${requestedLabel} 历史：\n${goals
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
