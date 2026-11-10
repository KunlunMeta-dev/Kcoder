import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, expect, test, vi } from "vitest";

vi.hoisted(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
vi.mock("react-native", () => ({ ...Object.fromEntries(["ActivityIndicator", "KeyboardAvoidingView", "Modal", "Pressable", "ScrollView", "Text", "TextInput", "View"].map(name => [name, name])), Platform: { OS: "web" } }));
vi.mock("lucide-react-native", () => Object.fromEntries(["Archive", "ArchiveRestore", "Bot", "ChevronLeft", "ChevronRight", "ListChecks", "Minimize2", "PanelsTopLeft", "Pencil", "Search", "Settings2", "Shield", "Sparkles", "Trash2", "X"].map(name => [name, name])));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/components/ui", () => ({ Button: "Button" }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: {}, colors: { textMuted: "gray" } }) }));
import { initLocale } from "@/i18n";
import { TaskExpertMenuItem, TaskMenu } from "./TaskMenu";

let renderer: TestRenderer.ReactTestRenderer;
const hosts = (id: string) => renderer.root.findAll(node => node.props.testID === id && typeof node.type === "string");
const press = async (id: string) => { await act(async () => hosts(id)[0].props.onPress()); };
const mount = async (rename = vi.fn(async (_title: string) => {})) => {
  const snapshot = { title: "Original title", running: false, connected: true, configurationReady: true };
  const task = { getSnapshot: () => snapshot, subscribe: () => () => {}, rename };
  await act(async () => { renderer = TestRenderer.create(<TaskMenu visible task={task as never} demo={false}
    onClose={vi.fn()} onArchived={vi.fn()} onDeleted={vi.fn()} onSearch={vi.fn()} onWorkspace={vi.fn()} />); });
  return task;
};
beforeEach(() => initLocale("en"));

test("main actions have no inline editor; rename cancellation sends nothing", async () => {
  const task = await mount();
  await press("task-menu-management");
  expect(renderer.root.findAllByType("TextInput" as never)).toHaveLength(0);
  await press("rename-task");
  await act(async () => hosts("task-rename-input")[0].props.onChangeText("Unsent title"));
  await press("cancel-task-rename");
  expect(task.rename).not.toHaveBeenCalled();
  expect(hosts("rename-task")).toHaveLength(1);
  expect(renderer.root.findAllByType("TextInput" as never)).toHaveLength(0);
  await act(async () => renderer.unmount());
});

test("the expert menu action closes More before requesting the selector", async () => {
  const onClose = vi.fn(), onExpert = vi.fn();
  const snapshot = { title: "Conversation", running: false, connected: true, configurationReady: true };
  const task = { getSnapshot: () => snapshot, subscribe: () => () => {}, supportsExperts: () => true };
  await act(async () => { renderer = TestRenderer.create(<TaskMenu visible task={task as never} demo={false}
    onClose={onClose} onArchived={vi.fn()} onDeleted={vi.fn()} onExpert={onExpert} />); });
  await press("task-menu-expert");
  expect(onClose).toHaveBeenCalledOnce();
  expect(onExpert).toHaveBeenCalledOnce();
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onExpert.mock.invocationCallOrder[0]);
  await act(async () => renderer.unmount());
});

test("cached-session expert menu item is read-only and explains why", async () => {
  await act(async () => { renderer = TestRenderer.create(<TaskExpertMenuItem disabled detail="Unavailable in cached sessions." />); });
  expect(hosts("task-menu-expert")).toHaveLength(1);
  expect(hosts("task-menu-expert")[0].props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain("Unavailable in cached sessions.");
  await act(async () => renderer.unmount());
});

test.each([
  ["offline", { connected: false }, true, "Reconnect to view or change the expert selection."],
  ["archived", { archivedAt: "2026-11-09" }, true, "Restore this task to change its expert selection."],
  ["configuration loading", { configurationReady: false }, true, "Checking the current expert selection…"],
  ["unsupported", {}, false, "This target does not support expert selection."],
])("the task menu explains when expert selection is unavailable: %s", async (_name, changes, supports, detail) => {
  const snapshot = { title: "Conversation", running: false, connected: true, configurationReady: true, ...changes };
  const task = { getSnapshot: () => snapshot, subscribe: () => () => {}, supportsExperts: () => supports };
  await act(async () => { renderer = TestRenderer.create(<TaskMenu visible task={task as never} demo={false}
    onClose={vi.fn()} onArchived={vi.fn()} onDeleted={vi.fn()} onExpert={vi.fn()} />); });
  expect(hosts("task-menu-expert")[0].props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain(detail);
  await act(async () => renderer.unmount());
});

test("saving a rename calls the existing target action, then returns to the menu", async () => {
  const task = await mount(); await press("task-menu-management"); await press("rename-task");
  await act(async () => hosts("task-rename-input")[0].props.onChangeText("  Updated title  "));
  await press("save-task-title");
  expect(task.rename).toHaveBeenCalledExactlyOnceWith("Updated title");
  expect(hosts("task-rename-details")).toHaveLength(0);
  expect(hosts("rename-task")).toHaveLength(1);
  await act(async () => renderer.unmount());
});

test("a failed rename retains the editable title and an empty title cannot be saved", async () => {
  await mount(vi.fn(async () => { throw new Error("rename rejected"); })); await press("task-menu-management"); await press("rename-task");
  await act(async () => hosts("task-rename-input")[0].props.onChangeText("Retain this title"));
  await press("save-task-title");
  expect(hosts("task-rename-input")[0].props.value).toBe("Retain this title");
  expect(renderer.root.findAllByProps({ accessibilityLiveRegion: "polite" })[0].props.children).toBe("rename rejected");
  await act(async () => hosts("task-rename-input")[0].props.onChangeText("  "));
  expect(hosts("save-task-title")[0].props.disabled).toBe(true);
  await act(async () => renderer.unmount());
});
