import type { ChatMessage, TaskSnapshot } from "@/runtime/task-runtime";

type PlanSnapshot = Pick<TaskSnapshot, "messages" | "activeTurnId">;
type Todos = NonNullable<ChatMessage["todos"]>;

/** Select the current or latest turn's plan without carrying it into a new draft turn. */
export function latestTaskPlanMessage(snapshot: PlanSnapshot): ChatMessage | undefined {
  const latestAssistant = [...snapshot.messages].reverse().find(message => message.role === "assistant");
  if (!snapshot.activeTurnId && snapshot.messages.at(-1)?.role === "user") return undefined;
  const turnId = snapshot.activeTurnId ?? latestAssistant?.turnId;
  if (!turnId) return latestAssistant?.todos?.length ? latestAssistant : undefined;
  return [...snapshot.messages].reverse().find(message =>
    message.role === "assistant" && message.turnId === turnId && message.todos?.length);
}

export function latestTaskPlan(snapshot: PlanSnapshot): Todos {
  return latestTaskPlanMessage(snapshot)?.todos ?? [];
}

/** Cancellation is an outcome, not successful completion. */
export function taskPlanProgress(todos: Todos) {
  return {
    completed: todos.filter(todo => todo.status === "completed").length,
    total: todos.length,
    next: todos.find(todo => todo.status === "in_progress") ?? todos.find(todo => todo.status === "pending"),
  };
}
