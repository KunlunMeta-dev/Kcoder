import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, expect, test, vi } from "vitest";

vi.hoisted(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ChevronDown", "ChevronRight", "FileText", "Hourglass", "MessageSquareText", "Pin", "Plus", "Search", "Settings"].map(name => [name, name])));
vi.mock("@/theme", () => {
  const colors = { background: "#FFFFFF", text: "#222222", textDim: "#999999", textMuted: "#666666", blue: "#275DA1", green: "green", red: "red" };
  return { useTheme: () => ({ colors }), useThemedStyles: (factory: (colors: unknown) => unknown) => factory(colors) };
});
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "zh-CN" }));
import { initLocale } from "@/i18n";
import { V3ConversationSelection, V3ConversationSelectionHeader, type V3ConversationTarget } from "./V3ConversationSelection";

const callbacks = () => ({ onToggle: vi.fn(), onNew: vi.fn(), onAddProject: vi.fn(), onThread: vi.fn(), onThreadActions: vi.fn(), onProjectActions: vi.fn(), onViewAll: vi.fn() });
const makeTarget = (id: string): V3ConversationTarget => ({
  server: { id, label: id, description: "", runtime: "kcoder", transport: "local", workspacePath: "/same/project" }, enabled: true, status: "online", hasMore: false,
  projects: [{ key: `${id}/same-key`, projectKey: "same-key", name: "同名项目", rootProject: false, pinned: true,
    workspaces: [{ key: `${id}/workspace`, identity: `${id}/workspace`, path: "/same/project", projectKey: "same-key", projectName: "同名项目", rootProject: false,
      label: "project", kind: "workspace", threads: [{ id: `${id}-thread`, title: `${id} conversation`, status: "idle", cwd: "/same/project", createdAt: 1, updatedAt: 1 }] }] }],
});
const targets = [makeTarget("one"), makeTarget("two")];
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => { initLocale("zh-CN"); });
const press = async (id: string) => { await act(async () => renderer.root.findAllByProps({ testID: id })[0].props.onPress()); };
const rows = (id: string) => renderer.root.findAllByProps({ testID: id });
const mount = async (props: Partial<React.ComponentProps<typeof V3ConversationSelection>> = {}) => {
  const handlers = callbacks();
  await act(async () => { renderer = TestRenderer.create(<V3ConversationSelection targets={targets} collapsed={new Set()} collapseReady {...handlers} {...props} />); });
  return handlers;
};

test("pinned projects have their own sections and are absent from ordinary folders", async () => {
  await mount();
  expect(rows("v3-pinned-conversation-one-0")).toHaveLength(1);
  expect(rows("v3-pinned-conversation-two-0")).toHaveLength(1);
  expect(rows("v3-project-folder-one-0")).toHaveLength(0);
  expect(rows("v3-project-folder-two-1")).toHaveLength(0);
  expect(rows("v3-pinned-projects-heading")).toHaveLength(1);
  await act(async () => renderer.unmount());
});

test("ordinary projects expand in place without hiding or promoting pinned projects", async () => {
  const ordinary = structuredClone(targets[1]); ordinary.projects[0].pinned = false;
  const handlers = await mount({ targets: [targets[0], ordinary] });
  expect(rows("thread-two-thread")).toHaveLength(0);
  await press("v3-project-folder-two-1");
  expect(rows("v3-regular-conversations-two-0")).toHaveLength(1);
  expect(rows("thread-two-thread")).toHaveLength(1);
  expect(rows("v3-pinned-conversation-two-0")).toHaveLength(0);
  expect(rows("thread-one-thread")).toHaveLength(1);
  await press("thread-two-thread");
  expect(handlers.onThread).toHaveBeenCalledWith(ordinary.server, ordinary.projects[0].workspaces[0], ordinary.projects[0].workspaces[0].threads[0]);
  await press("v3-project-toggle-two-0");
  expect(rows("thread-two-thread")).toHaveLength(0);
  expect(rows("v3-project-toggle-two-0")[0].props["aria-expanded"]).toBe(false);
  await press("v3-project-toggle-two-0");
  expect(rows("thread-two-thread")).toHaveLength(1);
  await press("v3-project-all"); expect(rows("thread-two-thread")).toHaveLength(0);
  expect(rows("thread-one-thread")).toHaveLength(1);
  await act(async () => renderer.unmount());
});

test("same-target pinned projects keep independent names, order, folding and creation directories", async () => {
  const server = structuredClone(targets[0]);
  server.projects[0].pinnedOrder = 2;
  const earlier = structuredClone(server.projects[0]);
  earlier.key = "one/earlier"; earlier.projectKey = "earlier"; earlier.name = "Earlier project"; earlier.pinnedOrder = 1;
  earlier.workspaces[0].identity = "one/earlier"; earlier.workspaces[0].path = "/earlier";
  earlier.workspaces[0].threads = [{ ...earlier.workspaces[0].threads[0], id: "earlier-thread", cwd: "/earlier" }];
  server.projects.push(earlier);
  const handlers = await mount({ targets: [server], collapsed: new Set([server.projects[0].key]) });
  const sections = renderer.root.findAll(node => String(node.type) === "View" && String(node.props.testID).startsWith("v3-pinned-conversation-"));
  expect(sections.map(node => node.props.testID)).toEqual(["v3-pinned-conversation-one-1", "v3-pinned-conversation-one-0"]);
  expect(rows("thread-one-thread")).toHaveLength(0); expect(rows("thread-earlier-thread")).toHaveLength(1);
  await press("toggle-workspace-one-1"); expect(handlers.onToggle).toHaveBeenCalledWith(earlier.key);
  await press("new-workspace-one-1"); expect(handlers.onNew).toHaveBeenCalledWith(server.server, "/earlier");
  await act(async () => rows("toggle-workspace-one-1")[0].props.onLongPress());
  expect(handlers.onProjectActions).toHaveBeenCalledWith(server.server, earlier.workspaces[0], "Earlier project");
  await act(async () => renderer.unmount());
});

test("unpin moves the project into ordinary folders and repin uses the same target", async () => {
  const target = structuredClone(targets[0]);
  const onProjectPinToggle = vi.fn(async () => {});
  const handlers = await mount({ targets: [target], onProjectPinToggle });
  expect(rows("v3-project-pin-one-0")[0].props["aria-pressed"]).toBe(true);
  await press("v3-project-pin-one-0"); expect(onProjectPinToggle).toHaveBeenCalledExactlyOnceWith(target.server, target.projects[0]);
  target.projects[0].pinned = false;
  await act(async () => renderer.update(<V3ConversationSelection targets={[target]} collapsed={new Set()} collapseReady {...handlers} onProjectPinToggle={onProjectPinToggle} />));
  expect(rows("v3-pinned-conversations")).toHaveLength(0);
  expect(rows("v3-project-folder-one-0")).toHaveLength(1);
  expect(rows("v3-project-pin-one-0")[0].props["aria-pressed"]).toBe(false);
  await press("v3-project-pin-one-0"); expect(onProjectPinToggle).toHaveBeenLastCalledWith(target.server, target.projects[0]);
  expect(handlers.onProjectActions).not.toHaveBeenCalled();
  expect(rows("thread-one-thread")).toHaveLength(0);
  await act(async () => renderer.unmount());
});

test("unknown and offline unpinned projects remain only in ordinary folders with offline pin guidance", async () => {
  const ordinary = structuredClone(targets[0]); ordinary.projects[0].pinned = false; ordinary.status = "offline";
  const unknown = structuredClone(targets[1]); delete unknown.projects[0].pinned;
  const onProjectPinToggle = vi.fn(async () => {});
  await mount({ targets: [ordinary, unknown], onProjectPinToggle });
  expect(rows("v3-pinned-conversations")).toHaveLength(0);
  expect(rows("v3-project-folder-one-0")).toHaveLength(1); expect(rows("v3-project-folder-two-1")).toHaveLength(1);
  expect(rows("v3-project-pin-one-0")[0].props.disabled).toBe(true); expect(rows("v3-project-pin-two-1")[0].props.disabled).toBe(false);
  expect(rows("v3-project-pin-unavailable-one-0")).toHaveLength(1);
  await press("v3-project-pin-one-0"); await press("v3-project-pin-two-1");
  expect(onProjectPinToggle).toHaveBeenCalledTimes(1);
  expect(rows("v3-pinned-conversations")).toHaveLength(0);
  await act(async () => renderer.unmount());
});

test("failure retains pin state and blocks duplicate requests while pending", async () => {
  let reject!: (error: Error) => void;
  const onProjectPinToggle = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  await mount({ targets: [targets[0]], onProjectPinToggle });
  let pending!: Promise<void>;
  await act(async () => { pending = rows("v3-project-pin-one-0")[0].props.onPress(); });
  expect(rows("v3-project-pin-one-0")[0].props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  await press("v3-project-pin-one-0"); expect(onProjectPinToggle).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error("synthetic unavailable receipt")); await pending; });
  expect(rows("v3-project-pin-one-0")[0].props["aria-pressed"]).toBe(true);
  expect(rows("v3-project-pin-one-0")[0].props.disabled).toBe(false);
  expect(renderer.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(1);
  await act(async () => renderer.unmount());
});

test.each(["offline", "unsupported"])("confirmed pins retain their state while %s and block unavailable mutations", async condition => {
  const target = structuredClone(targets[0]);
  if (condition === "offline") target.status = "offline"; else target.projects[0].pinSupported = false;
  const onProjectPinToggle = vi.fn(async () => {});
  await mount({ targets: [target], onProjectPinToggle });
  expect(rows("v3-pinned-conversation-one-0")).toHaveLength(1);
  expect(rows("v3-project-pin-one-0")[0].props.disabled).toBe(true);
  expect(rows("v3-project-pin-unavailable-one-0")).toHaveLength(1);
  await press("v3-project-pin-one-0"); expect(onProjectPinToggle).toHaveBeenCalledTimes(0);
  await act(async () => renderer.unmount());
});

test("an offline root project with unknown capability asks for connection before upgrade", async () => {
  const target = structuredClone(targets[0]);
  target.status = "offline";
  target.projects[0].rootProject = true;
  delete target.projects[0].pinSupported;
  const onProjectPinToggle = vi.fn(async () => {});
  await mount({ targets: [target], onProjectPinToggle });
  expect(rows("v3-project-pin-one-0")[0].props.disabled).toBe(true);
  expect(rows("v3-project-pin-unavailable-one-0")[0].props.children).toBe("连接目标后可更改项目置顶。");
  await press("v3-project-pin-one-0");
  expect(onProjectPinToggle).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

test("removing a selected ordinary project cannot hide remaining pinned projects", async () => {
  const ordinary = structuredClone(targets[1]); ordinary.projects[0].pinned = false;
  const handlers = await mount({ targets: [targets[0], ordinary] });
  await press("v3-project-folder-two-1");
  await act(async () => renderer.update(<V3ConversationSelection targets={[targets[0]]} collapsed={new Set()} collapseReady {...handlers} />));
  expect(rows("thread-one-thread")).toHaveLength(1);
  expect(rows("v3-project-all")[0].props.accessibilityState.selected).toBe(true);
  await act(async () => renderer.unmount());
});

test("V3 navigation keeps search, pending, settings and add-project reachable", async () => {
  const handlers = await mount(); await press("v3-add-project"); expect(handlers.onAddProject).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
  const onSearch = vi.fn(), onInbox = vi.fn(), onSettings = vi.fn();
  await act(async () => { renderer = TestRenderer.create(<V3ConversationSelectionHeader pendingCount={2} onSearch={onSearch} onInbox={onInbox} onSettings={onSettings} />); });
  await press("home-search"); await press("interaction-inbox"); await press("home-settings");
  expect(onSearch).toHaveBeenCalledTimes(1); expect(onInbox).toHaveBeenCalledTimes(1); expect(onSettings).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});
