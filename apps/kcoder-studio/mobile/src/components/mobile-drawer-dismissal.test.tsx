import { initLocale, t } from "@/i18n";
import React from "react";
import { act, create } from "react-test-renderer";
import { createRequire } from "node:module";
import { beforeEach, expect, it, vi } from "vitest";
import { GatewayConnectionBudget, gatewayConnectionBudget } from "../../../shared/gatewayConnectionBudget";
import { GatewayRpcClient } from "@/gateway/rpc";
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { MobileDrawer } from "./mobile-drawer";
import { WorkspaceHistoryActionsSheet } from "./workspace-history-actions-sheet";
import { statusDotColor } from "./status-dot-presentation";
import { connectionStatusLabel } from "./connection-status-presentation";
import { getThemeSnapshot } from "@/theme";
import { DrawerDismissal, stopDrawerSession } from "./mobile-drawer-dismissal";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: React.ReactNode): string;
};

const harness = vi.hoisted(() => ({
  controls: [] as Array<Record<string, any>>,
  views: [] as Array<Record<string, any>>,
  animationFinishes: [] as Array<(result: { finished: boolean }) => void>,
  modal: null as Record<string, any> | null,
  taskSheet: null as Record<string, any> | null,
  gesture: null as Record<string, any> | null,
  escape: null as (() => void) | null,
  navigate: vi.fn(),
  move: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const view = (props: any) => { harness.views.push(props); return React.createElement("div", props.testID ? { "data-testid": props.testID } : null, props.children); };
  const pressable = (props: Record<string, any>) => {
    harness.controls.push(props);
    return React.createElement("button", null, props.children);
  };
  return {
    View: view, Text: view, ScrollView: view, Pressable: pressable,
    Modal: (props: Record<string, any>) => { harness.modal = props; return view(props); },
    Animated: {
      Value: class { setValue(value: number) { harness.move(value); } interpolate() { return 0; } },
      View: view, createAnimatedComponent: () => pressable,
      timing: () => ({ start: (finish: (result: { finished: boolean }) => void) => harness.animationFinishes.push(finish) }),
      spring: () => ({ start() { harness.restore(); } }),
    },
    PanResponder: { create: (handlers: Record<string, any>) => { harness.gesture = handlers; return { panHandlers: {} }; } },
    Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) },
    Platform: { OS: "web" }, Alert: { alert() {} }, StyleSheet: { create: (v: unknown) => v, absoluteFill: {}, hairlineWidth: 1 },
  };
});
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({}), useRouter: () => ({ push: harness.navigate, replace: harness.navigate }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("lucide-react-native", () => {
  const icon = () => null;
  return Object.fromEntries(["ChevronDown", "ChevronRight", "ChevronUp", "CircleHelp", "Clock3", "Folder", "FolderPlus", "GitBranch", "Home", "MoreHorizontal", "Plus", "RefreshCw", "Server", "Settings", "X"].map(name => [name, icon]));
});
vi.mock("./use-modal-focus-trap", () => ({ useModalFocusTrap: (_visible: boolean, escape: () => void) => { harness.escape = escape; return null; } }));
vi.mock("./thread-actions-sheet", () => ({ ThreadActionsSheet: (props: Record<string, any>) => { harness.taskSheet = props; return null; } }));
vi.mock("@/storage/use-collapsed-server-sections", () => ({ useCollapsedServerSections: () => ({ serverIds: new Set(), hydrated: true, toggle() {} }) }));

function renderDrawer(overrides: Record<string, unknown> = {}) {
  initLocale("zh-CN");
  return renderToStaticMarkup(React.createElement(MobileDrawer, {
    visible: true, onClose: vi.fn(), profileId: "fixture", profile: { id: "fixture" },
    servers: [{ id: "backend", label: "Backend", workspacePath: "/fixture" }],
    onThreadRenamed: vi.fn(), onThreadRemoved: vi.fn(), ...overrides,
  } as unknown as React.ComponentProps<typeof MobileDrawer>));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  harness.controls = []; harness.animationFinishes = [];
  harness.views = [];
  harness.modal = null; harness.taskSheet = null; harness.gesture = null; harness.escape = null; harness.navigate.mockReset();
  harness.move.mockReset(); harness.restore.mockReset();
});

it("starts with Projects without the removed header, gateway row or footer shortcuts", () => {
  const markup = renderDrawer();
  expect(markup).toContain(t("new.projects"));
  expect(markup).not.toContain(t("task.new_task"));
  expect(markup).not.toContain(t("task.history"));
  expect(markup).not.toContain(t("task.schedules_coming_soon"));
  expect(markup).not.toContain("drawer-gateway-status");
  expect(harness.controls.filter(control => control.accessibilityLabel === t("task.close_navigation"))).toHaveLength(1);
  for (const label of ["task.home", "task.help"] as const) {
    expect(harness.controls.some(control => control.accessibilityLabel === t(label))).toBe(false);
  }
  expect(harness.controls.filter(control => control.testID === "drawer-settings")).toHaveLength(1);
});

it("renders a recent failure separately from the current Drawer activity", () => {
  const markup = renderDrawer({
    threads: {
      backend: [{
        id: "drawer-recent",
        title: "Current task",
        cwd: "/fixture",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
        runSummary: {
          mainTurn: "running",
          pendingApprovals: 0,
          pendingQuestions: 0,
          activeJobs: 0,
          tasksPending: 0,
          tasksRunning: 0,
          pendingFollowups: 0,
          pendingGoals: 0,
          recentError: {
            turnId: "turn-1",
            kind: "failed",
            source: "execution",
            category: "execution",
            atMs: 1,
          },
        },
      }],
    },
  });

  expect(markup).toContain(t("task.recent_failed"));
  expect(markup).toContain(t("task.running"));
});

it("renders project roots with shared hierarchy and target identity, without old workspace kind labels", () => {
  const serverA = { ...server, id: "target-a", label: "Shared", workspacePath: "/repo" };
  const serverB = { ...server, id: "target-b", label: "Shared", workspacePath: "/repo" };
  const workspaceOptions = {
    "target-a": [
      { path: "/project/main", label: "main", kind: "workspace" as const, projectKey: "project", projectName: "Project" },
      { path: "/project/tools", label: "tools", kind: "worktree" as const, projectKey: "project", projectName: "Project" },
    ],
    "target-b": [
      { path: "/project/main", label: "main", kind: "workspace" as const, projectKey: "project", projectName: "Project" },
    ],
  };
  const markup = renderDrawer({ servers: [serverA, serverB], workspaceOptions });

  expect(markup).toContain("drawer-project-target-a-1");
  expect(markup).toContain("drawer-workspace-row-target-a-1");
  expect(markup).toContain("drawer-workspace-row-target-a-2");
  expect(harness.controls.some(control => control.accessibilityLabel?.includes("target-a"))).toBe(true);
  expect(harness.controls.some(control => control.accessibilityLabel?.includes("target-b"))).toBe(true);
  expect(markup).not.toContain("PROJECT");
  expect(markup).not.toContain("WORKTREE");
  expect(markup).not.toContain(t("task.new_task_in_this_project"));
});

it("routes the workspace Plus with the exact profile, target and cwd", () => {
  const onClose = vi.fn();
  renderDrawer({
    onClose,
    workspaceHistoryOwner: "owner-a",
    canRefreshWorkspaceHistory: () => true,
  });
  const plus = harness.controls.find((props) => props.testID === "drawer-new-workspace-backend-0")!;
  plus.onPress();

  expect(harness.navigate).toHaveBeenCalledWith({
    pathname: "/new",
    params: { profileId: "fixture", serverId: "backend", cwd: "/fixture" },
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps the complete workspace path selectable in the menu and refreshes only that path", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const path = `/workspace/${"long-directory/".repeat(100)}project`;
  const onSelect = vi.fn();
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<WorkspaceHistoryActionsSheet server={server}
    workspace={{ path } as any} workspaceLabel="Project" workspaceAccessibleName={`Project · ${path}`}
    targetLabel="Target" workspaceIndex={0} onClose={vi.fn()} onSelect={onSelect} />); });
  const copy = renderer.root.findByProps({ testID: `workspace-actions-path-${server.id}-0` });
  expect(copy.props.children).toBe(path);
  expect(copy.props.selectable).toBe(true);
  expect(copy.props.numberOfLines).toBeUndefined();
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => { renderer.root.findByProps({ testID: `refresh-history-${server.id}-0` }).props.onPress(); });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(path);
  await act(async () => { renderer.unmount(); });
  vi.unstubAllGlobals();
});

it.each(["online", "offline", "checking", "unknown"] as const)("keeps %s status on the project chevron without creating a fallback cwd", status => {
  const markup = renderDrawer({
    servers: [{ ...server, id: "missing-cwd", label: "No cwd", workspacePath: undefined }],
    serverStatuses: { "missing-cwd": status },
    threads: { "missing-cwd": [{ id: "no-cwd-thread", status: "idle", createdAt: 1, updatedAt: 2 }] },
    threadErrors: { "missing-cwd": "thread load failed" },
    workspaceErrors: { "missing-cwd": "workspace load failed" },
    workspaceHistoryOwner: "owner-a",
    canRefreshWorkspaceHistory: () => true,
  });
  const plus = harness.controls.find((props) => props.testID === "drawer-new-workspace-missing-cwd-0")!;
  expect(plus.disabled).toBe(true);
  plus.onPress();

  expect(harness.navigate).not.toHaveBeenCalled();
  expect(markup).toContain("No cwd");
  expect(markup).not.toContain("thread load failed");
  const toggle = harness.controls.find(control => control.testID === "drawer-toggle-server-missing-cwd")!;
  expect(plus.accessibilityLabel).toContain(connectionStatusLabel(status));
  expect(toggle.accessibilityLabel).toContain(connectionStatusLabel(status));
  const colors = getThemeSnapshot().colors;
  const chevron = harness.views.find(view => view.testID === "drawer-workspace-chevron-missing-cwd-0")!;
  expect(chevron.style.backgroundColor).toBeUndefined();
  expect(chevron.children.props.color).toBe(statusDotColor(status, colors));
  expect(plus.children.props.color).toBe(colors.textMuted);
  expect(toggle.accessibilityLabel).toContain(t("home.choose_directory_for_new"));
  expect(markup).not.toContain("workspace load failed");
  expect(markup).not.toContain("cwd=\"/\"");
});

it("opens the existing task sheet on long press, preserves its workspace, and rejects an old gesture after reopening", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const thread = { id: "task", title: "Task", cwd: "/fixture", status: "idle", createdAt: 1, updatedAt: 1 };
  const props = { visible: true, onClose: vi.fn(), profileId: "fixture", profile: { ...profile, id: "fixture" },
    servers: [{ ...server, id: "backend", workspacePath: "/fixture" }], threads: { backend: [thread] },
    onThreadRenamed: vi.fn(), onThreadRemoved: vi.fn() } as React.ComponentProps<typeof MobileDrawer>;
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<MobileDrawer {...props} />); });
  const row = () => harness.controls.filter(control => control.testID === "drawer-thread-task").at(-1)!;
  const oldRow = row();
  expect(harness.controls.some(control => control.testID === "drawer-thread-actions-task")).toBe(false);
  await act(async () => { oldRow.onLongPress(); });
  expect(harness.navigate).not.toHaveBeenCalled();
  expect(harness.taskSheet).toMatchObject({ visible: true, target: { thread, server: { id: "backend", workspacePath: "/fixture" } } });
  const oldClose = harness.taskSheet!.onClose;
  const oldRenamed = harness.taskSheet!.onRenamed;
  const oldRemoved = harness.taskSheet!.onRemoved;
  await act(async () => { oldRenamed({ ...thread, title: "Optimistic name" }); });
  expect(harness.taskSheet!.target.thread.title).toBe("Optimistic name");
  await act(async () => { oldRenamed(thread); });
  expect(harness.taskSheet!.target.thread.title).toBe("Task");
  await act(async () => { harness.taskSheet!.onClose(); });
  await act(async () => { row().onLongPress(); });
  const nextTarget = harness.taskSheet!.target;
  await act(async () => { oldRenamed({ ...thread, title: "Old result" }); oldRemoved("archived", thread); oldClose(); });
  expect(harness.taskSheet!.target).toBe(nextTarget);
  await act(async () => { harness.taskSheet!.onClose(); });
  await act(async () => { renderer.update(<MobileDrawer {...props} visible={false} />); });
  await act(async () => { renderer.update(<MobileDrawer {...props} />); });
  await act(async () => { oldRow.onLongPress(); });
  expect(harness.taskSheet!.visible).toBe(false);
  await act(async () => { row().onAccessibilityAction({ nativeEvent: { actionName: "longpress" } }); });
  expect(harness.taskSheet!.visible).toBe(true);
  await act(async () => { oldClose(); });
  expect(harness.taskSheet!.visible).toBe(true);
  await act(async () => { harness.taskSheet!.onClose(); });
  await act(async () => { row().onPress(); });
  expect(harness.navigate).toHaveBeenCalledWith({ pathname: "/h/[profileId]/task/[serverId]/[threadId]",
    params: { profileId: "fixture", serverId: "backend", threadId: "task", cwd: "/fixture", title: "Task" } });
  await act(async () => { renderer.unmount(); });
});

it("actual close control aborts queued connection before the animation finishes", async () => {
  const budget = new GatewayConnectionBudget(1);
  const blocker = deferred();
  const occupied = budget.run(() => blocker.promise);
  const controller = new AbortController();
  const connector = vi.fn(async () => "connected");
  const waiting = budget.run(connector, controller.signal, "background");
  const outcome = waiting.then(() => "connected", () => "cancelled");
  const onClose = vi.fn(() => controller.abort());
  renderDrawer({ onClose, onDismissStart: () => controller.abort() });
  const close = harness.controls.filter(p => p.accessibilityLabel === "关闭导航").at(-1)!;
  close.onPress();
  // Release the real admission queue while Animated completion is still held.
  blocker.resolve(); await occupied; await outcome;
  expect(connector).not.toHaveBeenCalled();
  expect(controller.signal.aborted).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  harness.animationFinishes[0]({ finished: true });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it.each(["scrim", "escape", "android-back", "confirmed-swipe"])("%s signals dismissal synchronously once", trigger => {
  const start = vi.fn(); const close = vi.fn();
  renderDrawer({ onDismissStart: start, onClose: close });
  if (trigger === "scrim") harness.controls.find(p => p.accessibilityLabel === "关闭导航")!.onPress();
  if (trigger === "escape") harness.escape!();
  if (trigger === "android-back") harness.modal!.onRequestClose();
  if (trigger === "confirmed-swipe") harness.gesture!.onPanResponderRelease({}, { dx: -200, vx: 0 });
  harness.escape!(); // Duplicate request must not restart the animation.
  expect(start).toHaveBeenCalledTimes(1);
  expect(harness.animationFinishes).toHaveLength(1);
  expect(close).not.toHaveBeenCalled();
  harness.animationFinishes[0]({ finished: true });
  harness.animationFinishes[0]({ finished: true });
  expect(close).toHaveBeenCalledTimes(1);
});

it("restored and terminated swipes keep work active", () => {
  const start = vi.fn(); renderDrawer({ onDismissStart: start });
  harness.gesture!.onPanResponderRelease({}, { dx: -20, vx: 0 });
  harness.gesture!.onPanResponderTerminate();
  expect(start).not.toHaveBeenCalled();
  expect(harness.animationFinishes).toHaveLength(0);
});

it("closing ignores gesture movement and restoration that could interrupt its animation", () => {
  const close = vi.fn(); renderDrawer({ onClose: close });
  harness.escape!();
  expect(harness.gesture!.onMoveShouldSetPanResponderCapture({}, { dx: -200, dy: 0 })).toBe(false);
  harness.gesture!.onPanResponderMove({}, { dx: -100 });
  harness.gesture!.onPanResponderRelease({}, { dx: -20, vx: 0 });
  harness.gesture!.onPanResponderTerminate();
  expect(harness.move).not.toHaveBeenCalled();
  expect(harness.restore).not.toHaveBeenCalled();
  harness.animationFinishes[0]({ finished: true });
  expect(close).toHaveBeenCalledOnce();
});

it("interrupted current dismissal still closes once", () => {
  const close = vi.fn(); const start = vi.fn();
  renderDrawer({ onClose: close, onDismissStart: start });
  harness.escape!();
  harness.animationFinishes[0]({ finished: false });
  expect(close).toHaveBeenCalledOnce();
  harness.animationFinishes[0]({ finished: true });
  expect(start).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

it("workspace navigation cancels before route dispatch and dismissal callbacks remain optional", () => {
  const order: string[] = [];
  harness.navigate.mockImplementation(() => order.push("navigate"));
  renderDrawer({
    onDismissStart: () => order.push("cancel"), onClose: () => order.push("close"),
    workspaceHistoryOwner: "owner-a", canRefreshWorkspaceHistory: () => true,
  });
  const plus = harness.controls.find(p => p.testID === "drawer-new-workspace-backend-0")!;
  plus.onPress(); plus.onPress();
  expect(order).toEqual(["cancel", "close", "navigate"]);
  harness.controls = [];
  const close = vi.fn(); renderDrawer({ onClose: close });
  harness.escape!(); harness.animationFinishes.at(-1)!({ finished: true });
  expect(close).toHaveBeenCalledOnce();
});

it("old animation generation and old session cleanup cannot affect a reopened drawer", () => {
  const lifecycle = new DrawerDismissal(true);
  const old = lifecycle.begin()!;
  lifecycle.updateVisible(false); lifecycle.updateVisible(true);
  expect(lifecycle.finish(old)).toBe(false);
  const current = lifecycle.begin()!;
  expect(lifecycle.finish(current)).toBe(true);
  const oldPager = { close: vi.fn() }; const nextPager = { close: vi.fn() };
  const oldSession = { controller: new AbortController(), pagers: new Map([["old", { pager: oldPager }]]) };
  const nextSession = { controller: new AbortController(), pagers: new Map([["next", { pager: nextPager }]]) };
  const ref = { current: oldSession as typeof oldSession | null };
  stopDrawerSession(ref);
  ref.current = nextSession;
  stopDrawerSession(ref, oldSession);
  expect(ref.current).toBe(nextSession); expect(nextSession.controller.signal.aborted).toBe(false);
  expect(nextPager.close).not.toHaveBeenCalled();
});

it("dismissal cancels actual GatewayRpcClient admission before any WebSocket transport is constructed", async () => {
  class Socket {
    static OPEN = 1;
    static created = 0;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { Socket.created += 1; queueMicrotask(() => this.onopen?.()); }
    send(raw: string) {
      const request = JSON.parse(raw);
      if (request.method === "initialize") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2026-07-27" } }) }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const blocker = deferred();
  const occupied = Array.from({ length: 4 }, () => gatewayConnectionBudget.run(() => blocker.promise));
  try {
    const controller = new AbortController();
    const pending = GatewayRpcClient.connect(profile, server, "/fixture", "runtime", { signal: controller.signal, priority: "background" });
    const cancelled = expect(pending).rejects.toThrow("cancelled");
    renderDrawer({ onDismissStart: () => controller.abort() });
    harness.escape!();
    blocker.resolve(); await Promise.all(occupied); await cancelled;
    expect(Socket.created).toBe(0);
    // Positive control: released budget admits the same actual RPC transport.
    const client = await GatewayRpcClient.connect(profile, server, "/fixture");
    expect(Socket.created).toBe(1); client.close();
  } finally {
    blocker.resolve(); await Promise.all(occupied); globalThis.WebSocket = original;
  }
});
