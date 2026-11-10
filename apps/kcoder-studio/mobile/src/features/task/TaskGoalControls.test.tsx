import React from "react";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { TaskGoalControls, latestTaskPlan } from "./TaskGoalControls";
import { initLocale } from "@/i18n";
import type { TaskSnapshot, ThreadGoal } from "@/runtime/task-runtime";
vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => "modern" }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("lucide-react-native", () => Object.fromEntries(["Check", "ChevronRight", "ListTodo", "ChevronDown", "ChevronUp", "Pause", "Pencil", "Play", "Target", "Trash2", "X"].map(name => [name, () => null])));
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup(element: React.ReactNode): string };
const goal: ThreadGoal = { threadId: "thread", goalId: "goal", revision: 1, objective: "Verify the delivery",
  mode: "strict", verificationKind: "artifact", status: "paused", tokenBudget: 1000, tokensUsed: 87,
  timeUsedSeconds: 23, turnCount: 1, createdAt: 1, updatedAt: 2 };
const snapshot = { goal, threadId: "thread", connected: true, messages: [], running: false } as unknown as TaskSnapshot;
it.each(["active", "paused", "blocked", "complete", "cancelled", "usageLimited", "budgetLimited"] as const)("only unfinished Goals expose editing (%s)", status => {
  const value = { ...snapshot, goal: { ...goal, status } };
  const markup = renderToStaticMarkup(<TaskGoalControls task={{ snapshot: value } as never} snapshot={value} />);
  expect(markup.includes('data-testid="task-goal-edit"')).toBe(["active", "paused", "blocked"].includes(status));
});
it("shows real mode, status and usage and only valid terminal actions", () => {
  initLocale("en");
  const task = { snapshot } as never;
  const paused = renderToStaticMarkup(<TaskGoalControls task={task} snapshot={snapshot} />);
  expect(paused).toContain("Goal Pro"); expect(paused).toContain("Paused"); expect(paused).toContain("87 / 1000 tokens · 23s");
  expect(paused).toContain('data-testid="task-goal-resume"');
  expect(paused).not.toContain('data-testid="task-goal-pause"');
  const complete = renderToStaticMarkup(<TaskGoalControls task={task} snapshot={{ ...snapshot, goal: { ...goal, status: "complete" } }} />);
  expect(complete).toContain("Complete"); expect(complete).not.toContain('data-testid="task-goal-resume"');
});
it.each([
  ["en", "usageLimited", "Usage limited"],
  ["en", "budgetLimited", "Budget limited"],
  ["zh-CN", "usageLimited", "用量受限"],
  ["zh-CN", "budgetLimited", "预算受限"],
] as const)("renders %s %s as translated status text", (locale, status, label) => {
  initLocale(locale);
  const value = { ...snapshot, goal: { ...goal, status } };
  const markup = renderToStaticMarkup(<TaskGoalControls task={{ snapshot: value } as never} snapshot={value} />);
  expect(markup).toContain(label);
  expect(markup).not.toContain("task.goal_status_");
});
it("does not carry an old turn checklist into a new turn without a plan", () => {
  const previous = { id: "old", role: "assistant", turnId: "old-turn", todos: [{ content: "Old task", status: "completed" }] };
  const current = { id: "new", role: "assistant", turnId: "new-turn", content: "Working" };
  expect(latestTaskPlan({ ...snapshot, messages: [previous, current] } as TaskSnapshot)).toEqual([]);
  expect(latestTaskPlan({ ...snapshot, activeTurnId: "new-turn", messages: [previous] } as TaskSnapshot)).toEqual([]);
  expect(latestTaskPlan({ ...snapshot, activeTurnId: "old-turn", messages: [previous] } as TaskSnapshot)).toEqual(previous.todos);
});
