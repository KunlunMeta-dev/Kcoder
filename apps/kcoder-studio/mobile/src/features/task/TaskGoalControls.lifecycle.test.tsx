import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskSnapshot, ThreadGoal } from "@/runtime/task-runtime";
const host = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0 }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = host.stateIndex++;
    if (!(index in host.states)) host.states[index] = initial;
    return [host.states[index], (value: unknown) => { host.states[index] = value; }];
  },
  useRef: (initial: unknown) => host.refs[host.refIndex++] ??= { current: initial },
  useEffect() {},
}));
vi.mock("expo-router", () => ({ useIsFocused: () => false }));
vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => "modern" }));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Modal: "Modal", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View", StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ChevronDown", "ChevronUp", "Pause", "Pencil", "Play", "Target", "Trash2", "X"].map(name => [name, name])));
vi.mock("@/theme", () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: (factory: (colors: object) => unknown) => factory({}), radius: { md: 8, lg: 12 }, spacing: { xs: 4, sm: 8, md: 12, lg: 16 } }));
vi.mock("@/components/ui", () => ({ Button: "Button" }));
import { TaskGoalControls } from "./TaskGoalControls";
const goal: ThreadGoal = { threadId: "thread", goalId: "goal", revision: 1, objective: "Original", mode: "standard", verificationKind: "artifact", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, turnCount: 0, createdAt: 1, updatedAt: 1 };
function makeSnapshot(currentGoal: ThreadGoal = goal): TaskSnapshot {
  return { goal: currentGoal, threadId: "thread", title: "Task", cwd: "/workspace", messages: [],
    hasMoreBefore: false, beforeCursor: null, loadingOlder: false, running: false, connected: true,
    activeTurnId: null, interaction: null, error: null };
}
function nodes(node: unknown): Array<ReactElement<Record<string, any>>> {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement(node)) return [];
  const value = node as ReactElement<Record<string, any>>;
  return [value, ...nodes(value.props.children)];
}
function byId(tree: unknown, id: string) { return nodes(tree).find(node => node.props.testID === id); }
beforeEach(() => { host.states = []; host.refs = []; });
it.each(["terminal", "revision", "replacement", "cleared", "readback-failed"] as const)("preserves the edit draft and refuses Save after %s", change => {
  const snapshot = makeSnapshot();
  const task = { snapshot, client: {}, clientGeneration: 1, editGoal: vi.fn(), clearGoal: vi.fn(), setGoal: vi.fn(), patch: vi.fn() };
  const render = (value: TaskSnapshot) => { host.stateIndex = 0; host.refIndex = 0; task.snapshot = value; return TaskGoalControls({ task: task as never, snapshot: value }); };
  let tree = render(snapshot);
  byId(tree, "task-goal-edit")!.props.onPress(); tree = render(snapshot);
  byId(tree, "task-goal-edit-input")!.props.onChangeText("Keep this unsaved text");
  const changed = change === "cleared" ? null : { ...goal, ...(change === "terminal" ? { status: "complete" as const } : {}), ...(change === "replacement" ? { goalId: "new-goal" } : {}), revision: change === "readback-failed" ? 1 : 2 };
  tree = render({ ...snapshot, goal: changed, goalEditReadRequired: change === "readback-failed" });
  expect(byId(tree, "task-goal-edit-input")!.props.value).toBe("Keep this unsaved text");
  expect(byId(tree, "task-goal-save")!.props.disabled).toBe(true);
  byId(tree, "task-goal-save")!.props.onPress();
  expect(task.editGoal).not.toHaveBeenCalled(); expect(task.clearGoal).not.toHaveBeenCalled(); expect(task.setGoal).not.toHaveBeenCalled();
  expect(byId(tree, "task-goal-edit-state-changed")).toBeDefined();
  if (change === "readback-failed") expect(byId(tree, "task-goal-edit-refresh")).toBeDefined();
  byId(tree, "task-goal-edit-close")!.props.onPress();
});

it("keeps the terminal explanation in expanded details", () => {
  const snapshot = makeSnapshot({ ...goal, status: "complete" });
  const task = { snapshot } as never;
  const render = () => { host.stateIndex = 0; host.refIndex = 0; return TaskGoalControls({ task, snapshot }); };
  let tree = render(); expect(byId(tree, "task-goal-terminal-readonly")).toBeUndefined();
  byId(tree, "task-goal-expand")!.props.onPress(); tree = render();
  expect(byId(tree, "task-goal-terminal-readonly")).toBeDefined();
  expect(byId(tree, "task-goal-edit")).toBeUndefined();
  expect(byId(tree, "task-goal-clear")).toBeDefined();
});

it("fences an open editor by task and thread before effects run, even with identical Goal identity", () => {
  const snapshotA = makeSnapshot();
  const taskA = { snapshot: snapshotA, client: {}, clientGeneration: 1, editGoal: vi.fn(), patch: vi.fn() };
  const snapshotB = { ...makeSnapshot(), threadId: "thread-B", goal: { ...goal, threadId: "thread-B" } };
  const taskB = { snapshot: snapshotB, client: {}, clientGeneration: 1, editGoal: vi.fn(), patch: vi.fn() };
  const render = (task: typeof taskA, snapshot: TaskSnapshot) => { host.stateIndex = 0; host.refIndex = 0; return TaskGoalControls({ task: task as never, snapshot }); };
  let tree = render(taskA, snapshotA);
  byId(tree, "task-goal-edit")!.props.onPress(); tree = render(taskA, snapshotA);
  byId(tree, "task-goal-edit-input")!.props.onChangeText("A private unsaved text");
  tree = render(taskA, snapshotA);
  const capturedSave = byId(tree, "task-goal-save")!.props.onPress;
  tree = render(taskB, snapshotB);
  expect(byId(tree, "task-goal-edit-input")).toBeUndefined();
  expect(byId(tree, "task-goal-save")).toBeUndefined();
  capturedSave();
  expect(taskA.editGoal).not.toHaveBeenCalled(); expect(taskB.editGoal).not.toHaveBeenCalled();
  byId(tree, "task-goal-edit")!.props.onPress(); tree = render(taskB, snapshotB);
  expect(byId(tree, "task-goal-edit-input")!.props.value).toBe(goal.objective);
});
