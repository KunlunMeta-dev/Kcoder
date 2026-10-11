import { initLocale } from "@/i18n";
import React from "react";
import { createRequire } from "node:module";
import { beforeEach, expect, it, vi } from "vitest";
import { GatewayConnectionBudget, gatewayConnectionBudget } from "../../../shared/gatewayConnectionBudget";
import { GatewayRpcClient } from "@/gateway/rpc";
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { MobileDrawer } from "./mobile-drawer";
import { DrawerDismissal, stopDrawerSession } from "./mobile-drawer-dismissal";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: React.ReactNode): string;
};

const harness = vi.hoisted(() => ({
  controls: [] as Array<Record<string, any>>,
  animationFinishes: [] as Array<(result: { finished: boolean }) => void>,
  modal: null as Record<string, any> | null,
  gesture: null as Record<string, any> | null,
  escape: null as (() => void) | null,
  navigate: vi.fn(),
  move: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const view = ({ children }: any) => React.createElement("div", null, children);
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
    Platform: { OS: "web" }, Alert: { alert() {} }, StyleSheet: { create: (v: unknown) => v, absoluteFillObject: {}, hairlineWidth: 1 },
  };
});
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({}), useRouter: () => ({ push: harness.navigate, replace: harness.navigate }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("lucide-react-native", () => {
  const icon = () => null;
  return Object.fromEntries(["ChevronDown", "ChevronRight", "ChevronUp", "CircleHelp", "Clock3", "FolderPlus", "Home", "MoreHorizontal", "Plus", "Server", "Settings", "X"].map(name => [name, icon]));
});
vi.mock("./use-modal-focus-trap", () => ({ useModalFocusTrap: (_visible: boolean, escape: () => void) => { harness.escape = escape; return null; } }));
vi.mock("./thread-actions-sheet", () => ({ ThreadActionsSheet: () => null }));
vi.mock("@/storage/use-collapsed-server-sections", () => ({ useCollapsedServerSections: () => ({ serverIds: new Set(), hydrated: true, toggle() {} }) }));

function renderDrawer(overrides: Record<string, unknown> = {}) {
  initLocale("zh-CN");
  renderToStaticMarkup(React.createElement(MobileDrawer, {
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
  harness.modal = null; harness.gesture = null; harness.escape = null; harness.navigate.mockReset();
  harness.move.mockReset(); harness.restore.mockReset();
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

it("closing refuses even a stale load-control handler", () => {
  const load = vi.fn(); const projects = vi.fn();
  renderDrawer({ onLoadServer: load, onLoadProjects: projects });
  const controls = harness.controls;
  harness.escape!();
  controls.find(p => p.testID === "drawer-load-server-backend")!.onPress();
  controls.find(p => p.testID === "drawer-load-projects-backend")!.onPress();
  expect(load).not.toHaveBeenCalled(); expect(projects).not.toHaveBeenCalled();
});

it("navigation cancels before route dispatch and optional Home callback remains optional", () => {
  const order: string[] = [];
  harness.navigate.mockImplementation(() => order.push("navigate"));
  renderDrawer({ onDismissStart: () => order.push("cancel"), onClose: () => order.push("close") });
  const settings = harness.controls.find(p => p.accessibilityLabel === "设置")!;
  settings.onPress(); settings.onPress();
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
