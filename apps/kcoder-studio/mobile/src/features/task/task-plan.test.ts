import { expect, test } from "vitest";
import type { ChatMessage } from "@/runtime/task-runtime";
import { latestTaskPlanMessage, latestTaskPlan, taskPlanProgress } from "./task-plan";

const todos: NonNullable<ChatMessage["todos"]> = [
  { content: "done", status: "completed" },
  { content: "cancelled", status: "cancelled" },
  { content: "next", status: "pending" },
  { content: "working", status: "in_progress" },
];
const previous: ChatMessage = { id: "previous", role: "assistant", content: "", timestampMs: 1, turnId: "previous-turn", todos };
const current: ChatMessage = { id: "current", role: "assistant", content: "", timestampMs: 2, turnId: "current-turn", todos: todos.slice(2) };

test("both placements count only completed tasks and prefer the running task in their summary", () => {
  expect(taskPlanProgress(todos)).toEqual({ completed: 1, total: 4, next: todos[3] });
  expect(taskPlanProgress(todos.slice(0, 2))).toEqual({ completed: 1, total: 2, next: undefined });
  expect(taskPlanProgress([])).toEqual({ completed: 0, total: 0, next: undefined });
});

test("the current footer selects the exact latest plan message in the active turn", () => {
  const updated = { ...current, id: "updated", todos };
  const messages = [previous, current, updated];
  expect(latestTaskPlanMessage({ messages, activeTurnId: "current-turn" })).toBe(updated);
  expect(latestTaskPlan({ messages, activeTurnId: "current-turn" })).toBe(updated.todos);
  expect(latestTaskPlanMessage({ messages, activeTurnId: "previous-turn" })).toBe(previous);
});

test("new turns without a plan never inherit a previous turn's checklist", () => {
  expect(latestTaskPlanMessage({ messages: [previous], activeTurnId: "new-turn" })).toBeUndefined();
  expect(latestTaskPlan({ activeTurnId: null, messages: [previous, { id: "user", role: "user", content: "New request", timestampMs: 3 }] })).toEqual([]);
  expect(latestTaskPlan({ activeTurnId: null, messages: [previous, { ...current, todos: undefined }] })).toEqual([]);
});

test("restored sessions keep the most recent assistant turn's plan without an active turn", () => {
  expect(latestTaskPlanMessage({ activeTurnId: null, messages: [previous, current] })).toBe(current);
  const legacy = { ...previous, turnId: undefined };
  expect(latestTaskPlanMessage({ activeTurnId: null, messages: [legacy] })).toBe(legacy);
});
