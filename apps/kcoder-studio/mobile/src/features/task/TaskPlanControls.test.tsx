import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, test, vi } from "vitest";
import { initLocale } from "@/i18n";
import type { TaskSnapshot } from "@/runtime/task-runtime";
import { TaskPlanControls } from "./TaskPlanControls";
import { TaskMenu } from "./TaskMenu";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("react-native", async original => ({ ...await original<typeof import("react-native")>(),
  TextInput: "TextInput",
  Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? <>{children}</> : null,
}));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("lucide-react-native", () => Object.fromEntries(["Check", "ChevronDown", "ChevronRight", "ListChecks", "ListTodo", "Pin", "PinOff", "Settings2", "Shield", "X"].map(name => [name, () => null])));

const value = (changes: Partial<TaskSnapshot> = {}) => ({ threadId: "thread", running: true, activeTurnId: "turn",
  messages: [{ id: "plan", role: "assistant", turnId: "turn", todos: [
    { content: "Done", status: "completed" }, { content: "Working", status: "in_progress" },
    { content: "Cancelled task", status: "cancelled" }, { content: "Pending", status: "pending" },
  ] }], ...changes } as TaskSnapshot);
const button = (r: ReactTestRenderer, id: string) => r.root.findAll(node => node.props.testID === id && typeof node.props.onPress === "function")[0];
const has = (r: ReactTestRenderer, id: string) => r.root.findAll(node => typeof node.type === "string" && node.props["data-testid"] === id).length > 0;
const press = async (r: ReactTestRenderer, id: string) => { await act(async () => button(r, id).props.onPress()); };

test("default rendering reserves no height; menu opens details and pinning is explicit", async () => {
  initLocale("en");
  const owner = {};
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<TaskPlanControls owner={owner} snapshot={value()} />); });
  expect(r.toJSON()).toBeNull();
  const request = {};
  await act(async () => r.update(<TaskPlanControls owner={owner} snapshot={value()} openRequest={request} />));
  expect(has(r, "task-plan-sheet")).toBe(true);
  expect(has(r, "task-plan-pinned")).toBe(false);
  expect(JSON.stringify(r.toJSON())).toContain("1/4 completed");
  expect(JSON.stringify(r.toJSON())).toContain("Cancelled");
  await press(r, "task-plan-pin-toggle");
  expect(has(r, "task-plan-pinned")).toBe(true);
  expect(has(r, "task-plan-sheet")).toBe(false);
  await act(async () => r.update(<TaskPlanControls owner={owner} snapshot={value()} openRequest={request} />));
  expect(has(r, "task-plan-sheet")).toBe(false);
  await press(r, "task-plan-summary");
  expect(has(r, "task-plan-sheet")).toBe(true);
  await press(r, "task-plan-pin-toggle");
  expect(r.toJSON()).toBeNull();
  await act(async () => r.unmount());
});

test.each(["ended", "completed", "cancelled", "archived", "new-turn", "new-owner"])("pin is scoped and cleared for %s", async reason => {
  const owner = {}, request = {};
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<TaskPlanControls owner={owner} snapshot={value()} openRequest={request} />); });
  await press(r, "task-plan-pin-toggle");
  const changed = value(reason === "ended" ? { running: false } : reason === "archived" ? { archivedAt: "2026-10-27" }
    : reason === "new-turn" ? { activeTurnId: "next-turn" } : {});
  if (reason === "completed" || reason === "cancelled") changed.messages[0].todos = changed.messages[0].todos!.map(todo => ({ ...todo, status: reason }));
  await act(async () => r.update(<TaskPlanControls owner={reason === "new-owner" ? {} : owner} snapshot={changed} openRequest={request} />));
  expect(has(r, "task-plan-pinned")).toBe(false);
  if (reason === "ended") {
    await act(async () => r.update(<TaskPlanControls owner={owner} snapshot={value()} openRequest={request} />));
    expect(has(r, "task-plan-pinned")).toBe(false);
  }
  if (reason === "new-owner" || reason === "new-turn") {
    await act(async () => r.update(<TaskPlanControls owner={owner} snapshot={value()} openRequest={request} />));
    expect(has(r, "task-plan-pinned")).toBe(false);
  }
  await act(async () => r.unmount());
});

test("the conversation menu reports real progress, closes before opening details and omits absent plans", async () => {
  initLocale("en");
  const onClose = vi.fn(), onPlan = vi.fn();
  let snapshot = value();
  const task = { subscribe: () => () => {}, getSnapshot: () => snapshot };
  let r!: ReactTestRenderer;
  const render = () => <TaskMenu visible task={task as never} demo={false} onClose={onClose} onPlan={onPlan} onArchived={() => {}} onDeleted={() => {}} />;
  await act(async () => { r = create(render()); });
  expect(JSON.stringify(r.toJSON())).toContain("Turn checklist · 1/4");
  await press(r, "task-menu-plan");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onPlan).toHaveBeenCalledTimes(1);
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onPlan.mock.invocationCallOrder[0]);
  snapshot = value({ activeTurnId: "next-turn" });
  await act(async () => r.update(render()));
  expect(button(r, "task-menu-plan")).toBeUndefined();
  await act(async () => r.unmount());
});

test("finished turns retain readable details with no pin action", async () => {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<TaskPlanControls owner={{}} snapshot={value({ running: false })} openRequest={{}} />); });
  expect(has(r, "task-plan-items")).toBe(true);
  expect(button(r, "task-plan-pin-toggle")).toBeUndefined();
  await press(r, "task-plan-sheet-close");
  expect(r.toJSON()).toBeNull();
  await act(async () => r.unmount());
});
