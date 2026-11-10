// Effect/callback contract simulation using actual Home/Sessions components,
// workspace cache/loader, dependency scheduler, pager and projection. This host
// is not React DOM, a real Browser, a WebLocks proof, or a phone navigation test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import type { GatewayRpcClient, JsonRecord } from "@/gateway/rpc";
import type { ThreadListPage } from "@/runtime/task-runtime/threadDirectory";

const fixture = vi.hoisted(() => ({
  interfaceVersion: "modern" as "modern" | "v3",
  states: [] as unknown[], setters: [] as Array<((update: unknown) => void) | undefined>,
  refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ value: unknown; deps: unknown[] } | undefined>,
  effects: [] as Array<{ deps: unknown[]; cleanup?: () => void } | undefined>,
  pendingEffects: [] as Array<{ index: number; effect: () => void | (() => void); deps: unknown[]; changed: boolean }>,
  queuedUpdates: [] as Array<() => void>, queueUpdates: false,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  params: {} as Record<string, string>, app: {} as Record<string, unknown>, focused: true,
  pushes: [] as unknown[], replaces: [] as unknown[], collapsedToggles: [] as string[], values: new Map<string, string>(), shouldActivateRouteProfile: false,
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  const memo = (factory: () => unknown, deps: unknown[]) => {
    const index = fixture.memoIndex++; const previous = fixture.memos[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value;
    const value = factory(); fixture.memos[index] = { value, deps }; return value;
  };
  return { ...actual,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useState: (initial: unknown) => {
      const index = fixture.stateIndex++;
      if (!(index in fixture.states)) fixture.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      fixture.setters[index] ??= update => {
        const apply = () => { fixture.states[index] = typeof update === "function" ? (update as (previous: unknown) => unknown)(fixture.states[index]) : update; };
        if (fixture.queueUpdates) fixture.queuedUpdates.push(apply); else apply();
      };
      return [fixture.states[index], fixture.setters[index]];
    },
    useRef: (initial: unknown) => fixture.refs[fixture.refIndex++] ??= { current: initial },
    useMemo: memo,
    useCallback: (callback: unknown, deps: unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => {
      const index = fixture.effectIndex++; const previous = fixture.effects[index];
      fixture.pendingEffects.push({ index, effect, deps, changed: !previous || deps.length !== previous.deps.length || !deps.every((value, i) => Object.is(value, previous.deps[i])) });
    },
  };
});
vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => fixture.interfaceVersion }));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => fixture.params, useRouter: () => ({ push: (value: unknown) => fixture.pushes.push(value), replace: (value: unknown) => fixture.replaces.push(value), back: vi.fn() }), useIsFocused: () => fixture.focused }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native", () => ({ Platform: { OS: "web" }, ActivityIndicator: "ActivityIndicator", FlatList: "FlatList", Pressable: "Pressable", RefreshControl: "RefreshControl", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View", StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFill: {} } }));
vi.mock("lucide-react-native", () => Object.fromEntries(["Filter", "Archive", "ChevronDown", "ChevronLeft", "ChevronRight", "ChevronUp", "Clock3", "Folder", "GitBranch", "History", "Inbox", "Laptop", "Menu", "MoreHorizontal", "Plus", "RefreshCw", "Search", "Server", "Settings", "SquareTerminal", "X"].map(name => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button", EmptyState: "EmptyState", StatusDot: "StatusDot" }));
vi.mock("@/components/mobile-drawer", () => ({ MobileDrawer: "MobileDrawer" }));
vi.mock("@/components/history-refresh-modal", () => ({ HistoryRefreshModal: "HistoryRefreshModal" }));
vi.mock("@/components/thread-actions-sheet", () => ({ ThreadActionsSheet: "ThreadActionsSheet" }));
vi.mock("@/storage/use-collapsed-server-sections", () => ({ useCollapsedServerSections: () => ({ serverIds: new Set<string>(), hydrated: true, toggle: (key: string) => fixture.collapsedToggles.push(key) }) }));
vi.mock("@/state/AppContext", () => ({ useApp: () => fixture.app }));
vi.mock("@/state/route-profile-activation", () => ({ shouldActivateRouteProfile: () => fixture.shouldActivateRouteProfile }));
vi.mock("@/navigation/back-or-replace", () => ({ backOrReplace: vi.fn(), profileHomeHref: (id: string) => "/h/" + id }));
vi.mock("@/i18n", async importOriginal => {
  const actual = await importOriginal<typeof import("@/i18n")>();
  return { ...actual, t: (value: string, params?: Record<string, string | number>) => params ? actual.t(value, params) : value };
});
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: (_target, key) => String(key) });
  return {
    colors,
    useTheme: () => ({ colors, mode: "dark" }),
    useThemedStyles: (factory: (value: any) => unknown) => factory(colors),
    radius: { sm: 6, md: 10, lg: 14 },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => fixture.values.get(key) ?? null,
  setItem: async (key: string, value: string) => { fixture.values.set(key, value); },
  removeItem: async (key: string) => { fixture.values.delete(key); },
  getAllKeys: async () => [...fixture.values.keys()],
  multiRemove: async (keys: string[]) => { for (const key of keys) fixture.values.delete(key); },
} }));
// Import the actual page/scope implementations, without unrelated TaskRuntime
// composition. None of the scheduling, pager or publication methods is faked.
vi.mock("@/runtime/task-runtime", async () => ({
  ...await import("@/runtime/task-runtime/threadDirectory"),
  ...await import("@/runtime/task-runtime/workspaces"),
  ...await import("@/runtime/task-runtime/registry"),
}));

// RED validation can load the preserved pre-fix route without rolling back the shared checkout.
vi.mock("../h/[profileId]/index", async importOriginal => {
  const before = process.env.KCODER_ABSENCE_HOME_BEFORE;
  return before ? await import(/* @vite-ignore */ before) : await importOriginal();
});
import { V3ConversationSelection } from "@/features/interface/V3ConversationSelection";
import Home, { WorkspaceHistoryActionsSheet } from "../h/[profileId]/index";
import { statusDotColor } from "@/components/status-dot-presentation";
import type { ConnectionStatus } from "@/components/connection-status-presentation";
import { createWorkspaceAbsenceHandoff, claimWorkspaceAbsenceHandoff } from "@/navigation/workspace-absence-handoff";
import { captureSessionTranscriptScope } from "@/storage/session-transcript-scope";
import Sessions from "../sessions";
import { SessionFiltersPage } from "@/components/session-filters";
import { t } from "@/i18n";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { installGatewayAuthorizationResolver } from "@/gateway/http";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { clearWorkspaceOptionsCache } from "@/runtime/task-runtime/workspaces";
import { deleteStoredThread } from "@/runtime/task-runtime/threadDirectory";

type Element = ReactElement<Record<string, unknown>>;
type Call = { method: string; params: JsonRecord; server: KCoderServer; cwd?: string; generation?: string; client: RouteClient };
type Read = (call: Call) => Promise<unknown>;
const profile: GatewayProfile = { id: "route-progress", baseUrl: "https://synthetic.invalid", label: "Synthetic", accessToken: "synthetic", rpcToken: "synthetic", expiresAt: Number.MAX_SAFE_INTEGER, authorizationGeneration: "auth-A", deviceId: "device-A" };
const target = (id: string, cwd = "/" + id): KCoderServer => ({ id, label: id, description: id, runtime: "kcoder", transport: "local", workspacePath: cwd });
const a = target("A"); const b = target("B");
const thread = (id: string, cwd = a.workspacePath, updatedAt = 10): ThreadSummary => ({ id, title: id, cwd, status: "idle", createdAt: 1, updatedAt });
const page = (threads: ThreadSummary[], nextCursor?: string, issueCount = 0): ThreadListPage => ({ threads, nextCursor, completeness: issueCount ? "partial" : "complete", issueCount });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
let read: Read;
let calls: Call[] = [];
let clients: RouteClient[] = [];
let peakLiveClients = 0;
let uninstallAuthorization: (() => void) | undefined;
class RouteClient {
  closeCount = 0;
  constructor(readonly owner: GatewayProfile, readonly server: KCoderServer, readonly cwd?: string) {
    clients.push(this); peakLiveClients = Math.max(peakLiveClients, clients.filter(client => client.closeCount === 0).length);
  }
  supportsExperimental(): boolean { return true; }
  async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    const call = { method, params, server: this.server, cwd: this.cwd, generation: this.owner.authorizationGeneration, client: this };
    calls.push(call); return await read(call) as T;
  }
  close(): void { this.closeCount += 1; }
}
function app(nextProfile = profile, servers = [a, b]): void {
  fixture.params = { profileId: nextProfile.id };
  fixture.app = { hydrated: true, activeProfile: nextProfile, profiles: [nextProfile], demo: false, refresh: vi.fn(async () => {}), setActiveProfile: vi.fn(), profileHydrationError: null, profileHydrationRetrying: false, retryStoredProfiles: vi.fn(async () => null), runtime: { servers, statuses: [], loading: false, serversReady: true, reauthorizationRequired: false, error: null, serversRevision: 0 } };
  const owner = fixture.app;
  fixture.app.refresh = vi.fn(async () => {
    if (fixture.app !== owner) return;
    const runtime = fixture.app.runtime as { serversRevision: number };
    fixture.app.runtime = { ...runtime, serversRevision: runtime.serversRevision + 1 };
  });
  installBrowserProfileFixture([nextProfile]);
}
function render(route: () => unknown, effects = true): unknown {
  fixture.stateIndex = fixture.refIndex = fixture.memoIndex = fixture.effectIndex = 0;
  fixture.pendingEffects = [];
  const tree = route(); const pending = fixture.pendingEffects; fixture.pendingEffects = [];
  if (effects) for (const item of pending) {
    if (!item.changed) continue;
    fixture.effects[item.index]?.cleanup?.();
    const cleanup = item.effect(); fixture.effects[item.index] = { deps: item.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  }
  return tree;
}
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...[element.props.children, element.props.refreshControl, element.props.ListFooterComponent, element.props.ListEmptyComponent].flatMap(elements)];
}
function byId(tree: unknown, id: string): Element | undefined { return elements(tree).find(element => element.props.testID === id); }
function byType(tree: unknown, type: unknown): Element | undefined { return elements(tree).find(element => element.type === type); }
function leaf(tree: unknown, type: string): Element | undefined { return elements(tree).find(element => element.type === type); }
function drawer(tree: unknown) { return leaf(tree, "MobileDrawer")!.props as { threads: Record<string, ThreadSummary[]>; workspaceOptions: Record<string, unknown[]>; workspaceErrors: Record<string, string>; threadErrors: Record<string, string> }; }
function text(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  return isValidElement(tree) ? text((tree.props as Record<string, unknown>).children) : "";
}
function press(element: Element | undefined): void {
  expect(element).toBeDefined(); (element!.props.onPress as () => void)();
}
function refreshHome(tree: unknown): void { (leaf(tree, "RefreshControl")!.props.onRefresh as () => void)(); }
function list(tree: unknown): Element | undefined { return byId(tree, "sessions-list"); }
function sessionRows(tree: unknown): Array<{ thread: ThreadSummary; workspacePath?: string }> {
  return list(tree)?.props.data as Array<{ thread: ThreadSummary; workspacePath?: string }> ?? [];
}
function pressSession(tree: unknown, id: string): void {
  const flat = list(tree)!; const item = sessionRows(tree).find(row => row.thread.id === id)!;
  const element = (flat.props.renderItem as (arg: { item: typeof item; index: number }) => unknown)({ item, index: sessionRows(tree).findIndex(row => row.thread.id === id) });
  press(byId(element, "session-" + id));
}
async function until(route: () => unknown, check: (tree: unknown) => void): Promise<unknown> {
  let tree: unknown;
  await vi.waitFor(() => { tree = render(route); check(tree); });
  return tree;
}
function longPress(node: any) { node?.props.onLongPress?.(); }
function registered(paths: string[]) { return { items: paths.map(workspacePath => ({ workspacePath, label: workspacePath })) }; }
function projectPinWrites() { return calls.filter(call => call.method === "runtime.sidebar.projects.pin"); }
function refreshSessions(tree: unknown): void { (leaf(tree, "RefreshControl")!.props.onRefresh as () => void)(); }

beforeEach(() => {
  Object.assign(fixture, { interfaceVersion: "modern", states: [], setters: [], refs: [], memos: [], effects: [], pendingEffects: [], queuedUpdates: [], queueUpdates: false, stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0, pushes: [], replaces: [], collapsedToggles: [], focused: true, shouldActivateRouteProfile: false });
  fixture.values.clear(); calls = []; clients = []; peakLiveClients = 0;
  taskRuntimeTestHelpers.resetConnector(); clearWorkspaceOptionsCache(); app();
  uninstallAuthorization = installGatewayAuthorizationResolver(async () => {});
  read = async call => call.method === "runtime.workspaces.list" ? registered([call.cwd ?? "/"]) : call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
  taskRuntimeTestHelpers.setConnector(async (owner, server, cwd) => new RouteClient(owner, server, cwd) as unknown as GatewayRpcClient);
});
afterEach(() => {
  for (const effect of fixture.effects) effect?.cleanup?.();
  for (const client of clients) client.close();
  uninstallAuthorization?.(); taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks();
});

describe("Home actual route publication contracts", () => {
  it.each(["modern", "v3"] as const)("keeps unregistered history out of %s project groups without discarding the history rows", async interfaceVersion => {
    fixture.interfaceVersion = interfaceVersion;
    app(profile, [a]);
    const history = [thread("current", "/A"), thread("old", "/retired/workspace")];
    read = async call => call.method === "runtime.workspaces.list" ? { rootProjectPinned: true, items: [] }
      : call.method === "runtime.worktrees.list" ? { items: [] } : page(history);
    const tree = await until(Home, current => {
      expect(drawer(current).threads.A.map(row => row.id).sort()).toEqual(["current", "old"]);
      expect(leaf(current, "RefreshControl")!.props.refreshing).toBe(false);
    });
    if (interfaceVersion === "v3") {
      const selection = byType(tree, V3ConversationSelection)!;
      const targets = selection.props.targets as Array<{ projects: Array<{ name: string; workspaces: Array<{ threads: ThreadSummary[] }> }> }>;
      expect(targets[0]!.projects).toHaveLength(1);
      expect(targets[0]!.projects[0]!.workspaces.flatMap(workspace => workspace.threads.map(row => row.id))).toEqual(["current"]);
    } else {
      expect(byId(tree, "thread-current")).toBeDefined();
      expect(byId(tree, "thread-old")).toBeUndefined();
      expect(byId(tree, "home-projects")).toBeUndefined();
    }
  });

  it("offers neutral pairing and manual recovery for a profile absent from this device", () => {
    const opaqueProfileId = "opaque-route-profile";
    app(profile, [a]);
    fixture.params = { profileId: opaqueProfileId };
    const tree = render(Home);
    const emptyState = byType(tree, "EmptyState")!;
    expect(emptyState.props.title).toBe(t("home.missing_gateway_title"));
    expect(emptyState.props.body).toBe(t("home.missing_gateway_body"));
    expect(emptyState.props.title).not.toBe(t("home.deleted_gateway_title"));

    press(byId(tree, "missing-profile-pair-gateway"));
    press(byId(tree, "missing-profile-manual-connection"));
    press(byId(tree, "missing-profile-settings"));
    expect(fixture.pushes).toEqual([
      { pathname: "/welcome", params: { connectMode: "pairing" } },
      { pathname: "/welcome", params: { connectMode: "direct" } },
      "/settings-connections",
    ]);
    const recoveryRoutes = JSON.stringify(fixture.pushes);
    expect(recoveryRoutes).not.toContain(opaqueProfileId);
    expect(recoveryRoutes).not.toContain(profile.baseUrl);
    expect(recoveryRoutes).not.toContain(profile.accessToken);
    expect(recoveryRoutes).not.toContain(profile.rpcToken);
  });

  it("shows the saved-profile hydration error and keeps the opaque route after reusing local recovery", async () => {
    const opaqueProfileId = "opaque-route-profile";
    app(profile, [a]);
    fixture.params = { profileId: opaqueProfileId };
    const restored = deferred<string | null>();
    const retryStoredProfiles = vi.fn(() => restored.promise);
    fixture.app = { ...fixture.app, profileHydrationError: "Saved connection storage could not be read.", retryStoredProfiles };
    const tree = render(Home);
    const emptyState = byType(tree, "EmptyState")!;
    expect(emptyState.props.title).toBe(t("home.gateway_recovery_failed_title"));
    expect(emptyState.props.title).not.toBe(t("home.missing_gateway_title"));
    expect(byId(tree, "missing-profile-hydration-error")?.props.children).toBe("Saved connection storage could not be read.");

    const retry = byId(tree, "retry-profile-hydration");
    press(retry); press(retry);
    expect(retryStoredProfiles).toHaveBeenCalledOnce();
    restored.resolve("another-active-profile");
    await restored.promise; await Promise.resolve();
    expect(fixture.replaces).toEqual([]);
    expect(fixture.params).toEqual({ profileId: opaqueProfileId });
  });

  it("does not navigate with a recovered profile after the missing-profile route owner changes", async () => {
    app(profile, [a]);
    fixture.params = { profileId: "opaque-route-profile" };
    const restored = deferred<string | null>();
    fixture.app = { ...fixture.app, profileHydrationError: "Saved connection storage could not be read.", retryStoredProfiles: vi.fn(() => restored.promise) };
    press(byId(render(Home), "retry-profile-hydration"));

    fixture.params = { profileId: "another-opaque-profile" };
    render(Home);
    restored.resolve("restored-profile-from-old-route");
    await restored.promise; await Promise.resolve();
    expect(fixture.replaces).toEqual([]);
  });

  it("V3 retains multiple same-target pins when confirmations complete out of order", async () => {
    fixture.interfaceVersion = "v3";
    app(profile, [a]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "online" }] };
    const pins = new Map([["first", false], ["second", false]]);
    const firstReceipt = deferred<{ success: boolean; accepted: boolean }>();
    read = async call => {
      if (call.method === "runtime.sidebar.projects.pin") {
        pins.set(String(call.params.projectKey), call.params.pinned === true);
        return call.params.projectKey === "first" && call.params.pinned ? firstReceipt.promise : { success: true, accepted: true };
      }
      if (call.method === "runtime.workspaces.list") return { items: [...pins].map(([key, pinned]) => ({ workspacePath: key === "first" ? "/A" : "/second", label: key, projectKey: key, projectPinned: pinned })) };
      return call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    };
    const selection = (tree: unknown) => byType(tree, V3ConversationSelection)!.props as unknown as import("react").ComponentProps<typeof V3ConversationSelection>;
    const tree = await until(Home, tree => expect(selection(tree).targets[0]?.projects.map(p => p.projectKey)).toEqual(["first", "second"]));
    const initial = selection(tree);
    const first = initial.onProjectPinToggle!(a, initial.targets[0].projects[0]);
    await vi.waitFor(() => expect(projectPinWrites().some(write => write.params.projectKey === "first")).toBe(true));
    await initial.onProjectPinToggle!(a, initial.targets[0].projects[1]);
    firstReceipt.resolve({ success: true, accepted: true }); await first;
    expect(selection(render(Home)).targets[0].projects.map(p => p.pinned)).toEqual([true, true]);
    const confirmed = selection(render(Home));
    await confirmed.onProjectPinToggle!(a, confirmed.targets[0].projects[0]);
    expect(selection(render(Home)).targets[0].projects.map(p => p.pinned)).toEqual([false, true]);
    expect(projectPinWrites().map(call => [call.params.projectKey, call.params.pinned])).toEqual([["first", true], ["second", true], ["first", false]]);
  });

  it("keeps target-reported pins visible while the offline route handler blocks mutations", async () => {
    fixture.interfaceVersion = "v3";
    const other = { ...target("B", "/A"), transport: "ssh" as const, host: "other.example" };
    app(profile, [a, other]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "offline" }, { id: "B", status: "online" }] };
    const pins = new Map([["A", true], ["B", true]]);
    read = async call => {
      if (call.method === "runtime.sidebar.projects.pin") { pins.set(call.server.id, call.params.pinned === true); return { success: true, accepted: true }; }
      if (call.method === "runtime.workspaces.list") return { items: [{ workspacePath: "/A", label: "Project", projectKey: "same-project", projectPinned: pins.get(call.server.id) }] };
      return call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    };
    const selection = (tree: unknown) => byType(tree, V3ConversationSelection)!.props as unknown as import("react").ComponentProps<typeof V3ConversationSelection>;
    let tree = await until(Home, tree => expect(selection(tree).targets.find(t => t.server.id === "B")?.projects[0]?.pinned).toBe(true));
    const initial = selection(tree);
    expect(initial.targets.find(t => t.server.id === "A")!.status).toBe("offline");
    const project = initial.targets.find(t => t.server.id === "A")!.projects[0];
    expect(project.pinned).toBe(true);
    await initial.onProjectPinToggle!(a, project);
    tree = render(Home);
    expect(selection(tree).targets.find(t => t.server.id === "A")!.projects[0].pinned).toBe(true);
    expect(selection(tree).targets.find(t => t.server.id === "B")!.projects[0].pinned).toBe(true);
    selection(tree).onProjectActions(a, project.workspaces[0], project.name);
    const menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    expect(menu.props.projectPin).toMatchObject({ pinned: true, enabled: false });
    await (menu.props.projectPin as { onToggle(): Promise<void> }).onToggle();
    expect(selection(render(Home)).targets.find(t => t.server.id === "A")!.projects[0].pinned).toBe(true);
    expect(projectPinWrites()).toEqual([]);
    app({ ...profile, authorizationGeneration: "replacement-family" }, [a, other]); render(Home);
    await initial.onProjectPinToggle!(a, project);
    expect(projectPinWrites()).toHaveLength(0);
  });

  it("renames one registered project's display name across every root while isolating a same-key same-path target", async () => {
    const other = { ...target("B", "/A"), transport: "ssh" as const, host: "other.example" };
    app(profile, [a, other]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "online" }, { id: "B", status: "online" }] };
    const names = new Map([["A", "Original A"], ["B", "Original B"]]);
    read = async call => {
      if (call.method === "runtime.workspaces.rename") { names.set(call.server.id, String(call.params.name)); return { success: true, accepted: true }; }
      if (call.method === "runtime.workspaces.list") return { rootProjectPinned: true, items: ["/A", "/tools"].map(workspacePath => ({ workspacePath, label: names.get(call.server.id), projectName: names.get(call.server.id), projectKey: "runtime-target:A", projectPinned: true, projectPinnedOrder: 2 })) };
      return call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    };
    let tree = await until(Home, tree => expect(drawer(tree).workspaceOptions.B).toHaveLength(2));
    const original = drawer(tree).workspaceOptions.A.map(option => ({ ...option as object }));
    longPress(byId(tree, "toggle-workspace-A-1"));
    const menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    expect(menu.props.projectRename).toMatchObject({ name: "Original A", enabled: true });
    await (menu.props.projectRename as { onSave(name: string): Promise<void> }).onSave("New project");
    tree = render(Home);
    expect(byType(tree, WorkspaceHistoryActionsSheet)).toBeUndefined();
    expect(text(byId(tree, "home-project-A-0"))).toContain("New project");
    expect(drawer(tree).workspaceOptions.A).toEqual(original.map(option => ({ ...option, projectName: "New project" })));
    expect(drawer(tree).workspaceOptions.B.every(option => (option as { projectName: string }).projectName === "Original B")).toBe(true);
    expect(calls.filter(call => call.method === "runtime.workspaces.rename").map(call => [call.server.id, call.params])).toEqual([["A", { deviceId: "A", projectKey: "runtime-target:A", workspacePath: "/tools", runtime: "kcoder", name: "New project" }]]);
  });

  it("does not revive a pending project rename after blur and focus or close the newer workspace menu", async () => {
    app(profile, [a]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "online" }] };
    let name = "Original";
    const receipt = deferred<unknown>();
    read = async call => {
      if (call.method === "runtime.workspaces.rename") return receipt.promise;
      if (call.method === "runtime.workspaces.list") return { items: [{ workspacePath: "/A", projectKey: "project-A", projectName: name, projectPinned: false }] };
      return call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    };
    let tree = await until(Home, tree => expect(drawer(tree).workspaceOptions.A).toHaveLength(1));
    longPress(byId(tree, "toggle-server-A"));
    const menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    const pending = (menu.props.projectRename as { onSave(name: string): Promise<void> }).onSave("New name");
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(calls.some(call => call.method === "runtime.workspaces.rename")).toBe(true));
    fixture.focused = false; render(Home);
    fixture.focused = true; render(Home);
    tree = await until(Home, tree => expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false));
    longPress(byId(tree, "toggle-server-A")); render(Home);
    const reads = calls.filter(call => call.method === "runtime.workspaces.list").length;
    name = "New name"; receipt.resolve({ success: true, accepted: true });
    await rejected;
    tree = render(Home);
    expect(byType(tree, WorkspaceHistoryActionsSheet)).toBeDefined();
    expect(drawer(tree).workspaceOptions.A[0]).toMatchObject({ projectName: "Original" });
    expect(calls.filter(call => call.method === "runtime.workspaces.list")).toHaveLength(reads);
    expect(calls.filter(call => call.method === "runtime.workspaces.rename")).toHaveLength(1);
  });

  it("does not revive an old pin operation after blur and focus return to the same profile and target", async () => {
    app(profile, [a]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "online" }] };
    const receipt = deferred<unknown>();
    let pinned = false;
    read = async call => {
      if (call.method === "runtime.sidebar.projects.pin") return receipt.promise;
      if (call.method === "runtime.workspaces.list") return { items: [{ workspacePath: "/A", label: "A", projectKey: "project-A", projectPinned: pinned }] };
      return call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    };
    let tree = await until(Home, tree => expect(drawer(tree).workspaceOptions.A).toHaveLength(1));
    longPress(byId(tree, "toggle-server-A"));
    const oldMenu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    const pending = (oldMenu.props.projectPin as { onToggle(): Promise<void> }).onToggle();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(projectPinWrites()).toHaveLength(1));
    fixture.focused = false;
    render(Home);
    fixture.focused = true;
    render(Home);
    tree = await until(Home, tree => {
      expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false);
      expect(byId(tree, "toggle-server-A")?.props.disabled).toBe(false);
    });
    longPress(byId(tree, "toggle-server-A"));
    const newMenu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    expect(newMenu).toBeDefined();
    const readsBeforeReceipt = calls.filter(call => call.method === "runtime.workspaces.list").length;
    pinned = true;
    receipt.resolve({ success: true, accepted: true });
    await rejected;
    tree = render(Home);
    expect(byType(tree, WorkspaceHistoryActionsSheet)).toBeDefined();
    expect(calls.filter(call => call.method === "runtime.workspaces.list")).toHaveLength(readsBeforeReceipt);
    expect(projectPinWrites()).toHaveLength(1);
  });

  it("pins a registry project whose key and cwd collide with the target root without changing root state", async () => {
    app(profile, [a]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "online" }] };
    let pinned = false;
    read = async call => {
      if (call.method === "runtime.sidebar.projects.pin") { pinned = call.params.pinned === true && call.params.rootProject !== true; return { success: true, accepted: true }; }
      if (call.method === "runtime.workspaces.list") return { rootProjectPinned: true, items: [{ workspacePath: "/A", label: "Registry", projectKey: "runtime-target:A", projectPinned: pinned }] };
      return call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    };
    let tree = await until(Home, tree => expect(drawer(tree).workspaceOptions.A).toHaveLength(1));
    expect(byId(tree, "home-pinned-projects")).toBeUndefined();
    longPress(byId(tree, "toggle-server-A"));
    const menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    await (menu.props.projectPin as { onToggle(): Promise<void> }).onToggle();
    tree = render(Home);
    expect(byId(byId(tree, "home-pinned-projects"), "toggle-server-A")).toBeDefined();
    expect(drawer(tree).workspaceOptions.A[0]).toMatchObject({ rootProject: false, projectPinned: true });
    expect(projectPinWrites().map(call => call.params)).toEqual([{ deviceId: "A", projectKey: "runtime-target:A", pinned: true }]);
  });

  it("updates the root group from target readback without dropping its neighboring project", async () => {
    fixture.interfaceVersion = "v3";
    app(profile, [a]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "online" }] };
    let rootPinned = false;
    let projectPinned = false;
    read = async call => {
      if (call.method === "runtime.sidebar.projects.pin") {
        if (call.params.rootProject === true) rootPinned = call.params.pinned === true;
        else projectPinned = call.params.pinned === true;
        return { success: true, accepted: true };
      }
      if (call.method === "runtime.workspaces.list") return {
        rootProjectPinned: rootPinned,
        items: [{ workspacePath: "/tools", label: "Tools", projectKey: "tools", projectPinned }],
      };
      return call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    };
    const selection = (tree: unknown) => byType(tree, V3ConversationSelection)!.props as unknown as import("react").ComponentProps<typeof V3ConversationSelection>;
    let tree = await until(Home, tree => expect(selection(tree).targets[0]?.projects.map(project => project.projectKey)).toEqual(["runtime-target:A", "tools"]));
    const initial = selection(tree).targets[0].projects;
    expect(initial[0]).toMatchObject({ rootProject: true, pinned: false, pinSupported: true });
    await selection(tree).onProjectPinToggle!(a, initial[0]);
    tree = render(Home);
    const confirmed = selection(tree).targets[0].projects;
    expect(confirmed).toMatchObject([{ projectKey: "runtime-target:A", rootProject: true, pinned: true }, { projectKey: "tools", rootProject: false, pinned: false }]);
    expect(projectPinWrites().map(call => call.params)).toEqual([{ deviceId: "A", projectKey: "/A", pinned: true, rootProject: true }]);
    expect(drawer(tree).workspaceOptions.A).toHaveLength(2);
  });

  it.each(["checking", "offline"] as const)("confirms an already-sent pin when health changes to %s", async status => {
    app(profile, [a]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "online" }] };
    let pinned = false;
    const receipt = deferred<unknown>();
    read = async call => {
      if (call.method === "runtime.sidebar.projects.pin") { pinned = call.params.pinned === true; return receipt.promise; }
      if (call.method === "runtime.workspaces.list") return { rootProjectPinned: false, items: [{ workspacePath: "/A", label: "A", projectKey: "project-A", projectPinned: pinned }] };
      return call.method === "runtime.worktrees.list" ? { items: [{ path: "/managed-tree", state: "active", worktreeId: "managed", repositoryName: "Managed" }] } : page([]);
    };
    let tree = await until(Home, tree => expect(drawer(tree).workspaceOptions.A).toHaveLength(2));
    longPress(byId(tree, "toggle-server-A"));
    const menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    const pending = (menu.props.projectPin as { onToggle(): Promise<void> }).onToggle();
    const completed = expect(pending).resolves.toBeUndefined();
    await vi.waitFor(() => expect(projectPinWrites()).toHaveLength(1));
    fixture.app.runtime = { ...fixture.app.runtime as object, statusRefreshing: status === "checking", statuses: [{ id: "A", status: status === "checking" ? "online" : "offline" }] };
    render(Home);
    receipt.resolve({ success: true, accepted: true });
    await completed;
    tree = render(Home);
    expect(byId(tree, "home-pinned-projects")).toBeDefined();
    expect(byType(tree, WorkspaceHistoryActionsSheet)).toBeUndefined();
    expect(drawer(tree).workspaceOptions.A).toMatchObject([{ path: "/A", projectPinned: true }, { path: "/managed-tree", projectPinned: false }]);
    expect(projectPinWrites()).toHaveLength(1);
  });

  it("moves every workspace of a pinned project into one global section and preserves same-path target actions", async () => {
    const local = target("local", "/workspace");
    const remote = { ...target("remote", "/workspace"), transport: "ssh" as const, host: "remote.example" };
    app(profile, [local, remote]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "local", status: "online" }, { id: "remote", status: "online" }] };
    const pins = new Map([["local", false], ["remote", false]]);
    read = async call => {
      if (call.method === "runtime.sidebar.projects.pin") {
        pins.set(call.server.id, call.params.pinned === true);
        return { success: true, accepted: true };
      }
      if (call.method === "runtime.workspaces.list") return { items: ["/workspace", "/tools"].map(workspacePath => ({ workspacePath, label: "Project", projectKey: "shared-project", projectName: "Project", projectPinned: pins.get(call.server.id) })) };
      return call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    };
    let tree = await until(Home, tree => expect(drawer(tree).workspaceOptions.remote).toHaveLength(2));
    expect(byId(tree, "home-pinned-projects")).toBeUndefined();
    longPress(byId(tree, "toggle-workspace-local-1"));
    let menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    expect(menu.props.projectPin).toMatchObject({ name: "Project", pinned: false, enabled: true });
    await (menu.props.projectPin as { onToggle(): Promise<void> }).onToggle();
    tree = render(Home);
    expect(byType(tree, WorkspaceHistoryActionsSheet)).toBeUndefined();
    expect(elements(tree).filter(element => element.props.testID === "home-pinned-projects")).toHaveLength(1);
    expect(byId(byId(tree, "home-pinned-projects"), "toggle-server-local")).toBeDefined();
    expect(byId(byId(tree, "home-pinned-projects"), "toggle-workspace-local-1")).toBeDefined();
    expect(byId(byId(tree, "home-projects"), "toggle-server-local")).toBeUndefined();
    expect(byId(byId(tree, "home-projects"), "toggle-server-remote")).toBeDefined();
    longPress(byId(tree, "toggle-server-local"));
    menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    expect(menu.props.projectPin).toMatchObject({ pinned: true });
    await (menu.props.projectPin as { onToggle(): Promise<void> }).onToggle();
    tree = render(Home);
    expect(byId(tree, "home-pinned-projects")).toBeUndefined();
    expect(byId(byId(tree, "home-projects"), "toggle-workspace-local-1")).toBeDefined();
    expect(projectPinWrites().map(call => [call.server.id, call.params])).toEqual([
      ["local", { deviceId: "local", projectKey: "shared-project", pinned: true }],
      ["local", { deviceId: "local", projectKey: "shared-project", pinned: false }],
    ]);
  });

  it("keeps app-server pins readable and blocks offline or stale pin callbacks", async () => {
    app(profile, [a]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "offline" }] };
    read = async call => call.method === "runtime.workspaces.list" ? { items: [{ workspacePath: "/A", label: "A", projectKey: "project-A", projectPinned: true }] }
      : call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    let tree = await until(Home, tree => expect(byId(tree, "home-pinned-projects")).toBeDefined());
    longPress(byId(tree, "toggle-server-A"));
    const menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    expect(menu.props.projectPin).toMatchObject({ pinned: true, enabled: false });
    await (menu.props.projectPin as { onToggle(): Promise<void> }).onToggle();
    expect(projectPinWrites()).toEqual([]);
    app({ ...profile, id: "new-owner", authorizationGeneration: "new-family" }, [a]);
    tree = render(Home);
    expect(byType(tree, WorkspaceHistoryActionsSheet)).toBeUndefined();
    await (menu.props.projectPin as { onToggle(): Promise<void> }).onToggle();
    expect(projectPinWrites()).toEqual([]);
  });

  it("does not let an older in-flight catalog overwrite a confirmed project pin", async () => {
    app(profile, [a]);
    fixture.app.runtime = { ...fixture.app.runtime as object, statuses: [{ id: "A", status: "online" }] };
    let pinned = false;
    let holdNextCatalog = false;
    let staleClient: RouteClient | undefined;
    const staleCatalog = deferred<unknown>();
    const catalog = (value: boolean) => ({ items: [{ workspacePath: "/A", label: "A", projectKey: "project-A", projectPinned: value }] });
    read = async call => {
      if (call.method === "runtime.sidebar.projects.pin") { pinned = call.params.pinned === true; return { success: true, accepted: true }; }
      if (call.method === "runtime.workspaces.list") {
        if (holdNextCatalog) { holdNextCatalog = false; staleClient = call.client; return staleCatalog.promise; }
        return catalog(pinned);
      }
      return call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
    };
    let tree = await until(Home, tree => expect(drawer(tree).workspaceOptions.A).toHaveLength(1));
    clearWorkspaceOptionsCache(profile.id);
    holdNextCatalog = true;
    refreshHome(tree);
    tree = await until(Home, () => expect(staleClient).toBeDefined());
    longPress(byId(tree, "toggle-server-A"));
    const menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    await (menu.props.projectPin as { onToggle(): Promise<void> }).onToggle();
    tree = render(Home);
    expect(byId(tree, "home-pinned-projects")).toBeDefined();
    staleCatalog.resolve(catalog(false));
    tree = await until(Home, tree => {
      expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false);
      expect(staleClient!.closeCount).toBeGreaterThan(0);
      expect(drawer(tree).workspaceOptions.A[0]).toMatchObject({ projectPinned: true });
    });
    expect(byId(byId(tree, "home-pinned-projects"), "home-project-group-A-0")).toBeDefined();
    expect(byId(byId(tree, "home-projects"), "home-project-group-A-0")).toBeUndefined();
  });

  it("keeps workspace long-press actions independent of collapse, isolates same-path targets, and refreshes only the selected workspace", async () => {
    const local = target("local", "/workspace");
    const remote: KCoderServer = { ...target("remote", "/workspace"), transport: "ssh", host: "remote.example" };
    app(profile, [local, remote]);
    read = async call => call.method === "runtime.workspaces.list"
      ? registered(call.server.id === "local" ? ["/workspace", "/other"] : ["/workspace"])
      : call.method === "runtime.worktrees.list" ? { items: [] }
      : page([]);

    let tree = await until(Home, tree => {
      expect((drawer(tree).workspaceOptions.local as Array<{ path: string }>).map(option => option.path)).toEqual(["/workspace", "/other"]);
      expect((drawer(tree).workspaceOptions.remote as Array<{ path: string }>).map(option => option.path)).toEqual(["/workspace"]);
    });
    expect(byType(tree, WorkspaceHistoryActionsSheet)).toBeUndefined();
    expect(byId(tree, "new-workspace-local")).toBeUndefined();
    expect(byId(tree, "new-workspace-local-0")).toBeDefined();
    expect(byId(tree, "new-workspace-local-1")).toBeDefined();
    expect(byId(tree, "workspace-actions-local")).toBeUndefined();
    expect(byId(tree, "toggle-server-local")?.props.disabled).toBe(false);
    expect(byId(tree, "toggle-server-local")?.props.accessibilityState).toEqual({ expanded: true, disabled: false });
    expect(byId(tree, "toggle-workspace-local-1")?.props.accessibilityLabel).toContain("other");
    expect(byId(tree, "toggle-server-local")?.props.accessibilityLabel).toContain("Local · local");
    expect(byId(tree, "toggle-server-remote")?.props.accessibilityLabel).toContain("SSH · remote · remote.example:22");
    expect(byId(tree, "toggle-server-local")?.props.accessibilityLabel).not.toBe(byId(tree, "toggle-server-remote")?.props.accessibilityLabel);

    const collapsedRow = byId(tree, "toggle-workspace-local-1")!;
    const workspaceMenuTrigger = byId(tree, "toggle-workspace-local-1")!;
    expect(workspaceMenuTrigger).toBe(collapsedRow);
    expect(typeof workspaceMenuTrigger.props.onLongPress).toBe("function");
    longPress(workspaceMenuTrigger);
    expect(fixture.collapsedToggles).toEqual([]);
    tree = render(Home);
    let menu = byType(tree, WorkspaceHistoryActionsSheet)!;
    expect((menu.props.workspace as { path: string }).path).toBe("/other");
    expect(menu.props.workspaceLabel).toBe("other");
    expect(menu.props.workspaceAccessibleName).toContain("/other");
    expect(menu.props.targetLabel).toContain("Local · local");
    expect(menu.props.onSelectAll).toBeUndefined();
    (menu.props.onSelect as (workspace: string) => void)("/other");
    tree = render(Home);
    let refresh = leaf(tree, "HistoryRefreshModal")!;
    expect(refresh.props.target).toMatchObject({ kind: "workspace", profile, server: local, workspace: "/other", owner: expect.any(String) });
    (refresh.props.onClose as () => void)();

    tree = render(Home);
    press(byId(tree, "toggle-workspace-local-1"));
    expect(fixture.collapsedToggles).toEqual(["local\0/other"]);
    press(byId(tree, "new-workspace-local-1"));
    expect(fixture.pushes).toEqual([{ pathname: "/new", params: { profileId: profile.id, serverId: "local", cwd: "/other" } }]);
    fixture.pushes.length = 0;

    tree = render(Home);
    longPress(byId(tree, "toggle-workspace-local-1"));
    tree = render(Home);
    menu = byType(tree, WorkspaceHistoryActionsSheet)!;
    expect(menu.props.server).toEqual(local);
    expect((menu.props.workspace as { path: string }).path).toBe("/other");
    longPress(byId(tree, "toggle-server-remote"));
    tree = render(Home);
    menu = byType(tree, WorkspaceHistoryActionsSheet)!;
    expect(menu.props.server).toEqual(remote);
    expect((menu.props.workspace as { path: string }).path).toBe("/workspace");
    expect(menu.props.workspaceLabel).toBe("workspace");
    expect(menu.props.workspaceAccessibleName).toContain("/workspace");
    expect(menu.props.targetLabel).toContain("SSH · remote · remote.example:22");
    (menu.props.onSelect as (workspace: string) => void)("/workspace");
    tree = render(Home);
    refresh = leaf(tree, "HistoryRefreshModal")!;
    expect(refresh.props.target).toMatchObject({ kind: "workspace", profile, server: remote, workspace: "/workspace" });
    expect(fixture.pushes).toEqual([]);

    tree = render(Home);
    (refresh.props.onClose as () => void)();
    press(byId(tree, "new-workspace-remote-0"));
    expect(fixture.pushes.at(-1)).toEqual({ pathname: "/new", params: { profileId: profile.id, serverId: "remote", cwd: "/workspace" } });
    expect(byId(tree, "refresh-all-history-remote-0")).toBeUndefined();

    fixture.app.runtime = { ...(fixture.app.runtime as object), reauthorizationRequired: true };
    tree = render(Home);
    expect(byId(tree, "toggle-server-local")?.props.disabled).toBe(false);
    expect(byId(tree, "toggle-server-local")?.props.accessibilityState).toEqual({ expanded: true, disabled: false });
    expect(byId(tree, "toggle-server-local")?.props["aria-expanded"]).toBe(true);
    expect(byId(tree, "toggle-workspace-local-1")?.props.disabled).toBe(false);
    longPress(byId(tree, "toggle-server-local"));
    expect(byType(render(Home), WorkspaceHistoryActionsSheet)).toBeUndefined();
  });

  it("disambiguates same-name, same-path local targets and keeps each action on its target", async () => {
    const first = { ...target("local-one", "/shared"), label: "Local" };
    const second = { ...target("local-two", "/shared"), label: "Local" };
    app(profile, [first, second]);
    read = async call => call.method === "runtime.workspaces.list"
      ? registered(["/shared"])
      : call.method === "runtime.worktrees.list" ? { items: [] }
      : page([]);

    let tree = await until(Home, tree => {
      expect((drawer(tree).workspaceOptions["local-one"] as Array<{ path: string }>).map(option => option.path)).toEqual(["/shared"]);
      expect((drawer(tree).workspaceOptions["local-two"] as Array<{ path: string }>).map(option => option.path)).toEqual(["/shared"]);
    });

    for (const server of [first, second]) {
      const rowId = server.id;
      expect(byId(tree, `toggle-server-${rowId}`)?.props.accessibilityLabel).toContain(rowId);
      expect(byId(tree, `toggle-server-${rowId}`)?.props.accessibilityLabel).toContain(rowId);
      expect(byId(tree, `new-workspace-${rowId}-0`)?.props.accessibilityLabel).toContain(rowId);
      expect(byId(tree, `toggle-server-${rowId}`)?.props.accessibilityLabel).toContain(`Local · Local (${rowId})`);

      press(byId(tree, `new-workspace-${rowId}-0`));
      expect(fixture.pushes.at(-1)).toEqual({ pathname: "/new", params: { profileId: profile.id, serverId: rowId, cwd: "/shared" } });

      longPress(byId(tree, `toggle-server-${rowId}`));
      const menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
      expect(menu.props.server).toEqual(server);
      expect((menu.props.workspace as { path: string }).path).toBe("/shared");
      (menu.props.onSelect as (workspace: string) => void)("/shared");
      const refresh = leaf(render(Home), "HistoryRefreshModal")!;
      expect(refresh.props.target).toMatchObject({ kind: "workspace", profile, server, workspace: "/shared" });
      (refresh.props.onClose as () => void)();
      tree = render(Home);
    }
  });

  it("discards a gated single-workspace refresh confirmation instead of reviving it", async () => {
    const server = target("A", "/A");
    app(profile, [server]);
    const loaded = await until(Home, tree => expect(drawer(tree).workspaceOptions.A).toHaveLength(1));
    longPress(byId(loaded, "toggle-server-A"));
    const menu = byType(render(Home), WorkspaceHistoryActionsSheet)!;
    (menu.props.onSelect as (workspace: string) => void)("/A");

    const opened = render(Home);
    expect(leaf(opened, "HistoryRefreshModal")?.props.target).toMatchObject({ kind: "workspace", workspace: "/A" });

    const runtime = fixture.app.runtime as Record<string, unknown>;
    fixture.app.runtime = { ...runtime, reauthorizationRequired: true };
    expect(leaf(render(Home), "HistoryRefreshModal")).toBeUndefined();

    fixture.app.runtime = { ...runtime, reauthorizationRequired: false };
    expect(leaf(render(Home), "HistoryRefreshModal")).toBeUndefined();
    expect(calls.some(call => call.method === "thread/history/refresh")).toBe(false);
  });

  it.each(["settled", "refreshing", "failed", "reauthorization"] as const)("keeps Home and Drawer target status observations consistent during %s", outcome => {
    fixture.app.runtime = {
      ...fixture.app.runtime as object,
      statuses: [{ id: "A", status: "online" }, { id: "B", status: "offline" }],
      statusRefreshing: outcome === "refreshing",
      statusError: outcome === "failed" ? "Status request failed" : null,
      reauthorizationRequired: outcome === "reauthorization",
    };
    const tree = render(Home, false);
    const drawerProps = leaf(tree, "MobileDrawer")!.props as { serverStatuses: Record<string, string> };
    expect(drawerProps.serverStatuses).toEqual(outcome === "settled"
      ? { A: "online", B: "offline" }
      : outcome === "refreshing" ? { A: "checking", B: "checking" } : { A: "unknown", B: "unknown" });
    for (const serverId of ["A", "B"]) {
      const plus = byId(tree, `new-workspace-${serverId}-0`)!;
      const status = drawerProps.serverStatuses[serverId] as ConnectionStatus;
      const chevron = byId(tree, `home-workspace-chevron-${serverId}-0`)!;
      const icon = elements(chevron).find(element => element.type === "ChevronUp" || element.type === "ChevronRight")!;
      expect(icon.props.color).toBe("textDim");
      expect(leaf(byId(tree, `home-target-status-${serverId}-0`), "StatusDot")!.props.status).toBe(status);
      expect(leaf(plus, "Plus")!.props.color).toBe("textMuted");
      expect(plus.props.accessibilityLabel).toContain(`/${serverId}`);
      expect(plus.props.accessibilityLabel).toContain(t(status === "unknown" ? "task.unknown" : `settings.status_${status}`));
      expect(byId(tree, `toggle-server-${serverId}`)!.props.accessibilityLabel).toContain(t(status === "unknown" ? "task.unknown" : `settings.status_${status}`));
    }
  });
  it.each([
    { phase: "settled", loading: false, statusRefreshing: false },
    { phase: "refreshing", loading: true, statusRefreshing: true },
  ])("keeps reauthorization available without an error message while $phase", ({ loading, statusRefreshing }) => {
    app(profile, [a]);
    fixture.app.runtime = { ...(fixture.app.runtime as object), error: null, reauthorizationRequired: true, loading, statusRefreshing };
    const tree = render(Home);
    const action = byId(tree, "reauthorize-active-profile");
    expect(elements(tree).filter(element => element.props.testID === "reauthorize-active-profile")).toHaveLength(1);
    expect(action?.props.disabled).not.toBe(true);
    expect(byId(tree, "retry-gateway")).toBeUndefined();
    press(action);
    expect(fixture.pushes).toEqual([{ pathname: "/welcome", params: { gateway: profile.baseUrl, reauth: profile.id } }]);
    expect(fixture.app.refresh).not.toHaveBeenCalled();
  });

  it("keeps reauthorization available while refresh clears the error until authorization recovers", () => {
    app(profile, [a]);
    fixture.app.runtime = { ...(fixture.app.runtime as object), error: "Gateway session expired", reauthorizationRequired: true };
    expect(byId(render(Home), "reauthorize-active-profile")).toBeDefined();
    fixture.app.runtime = { ...(fixture.app.runtime as object), error: null, loading: true, statusRefreshing: true };
    const refreshing = render(Home);
    expect(byId(refreshing, "reauthorize-active-profile")).toBeDefined();
    press(byId(refreshing, "reauthorize-active-profile"));
    expect(fixture.pushes).toEqual([{ pathname: "/welcome", params: { gateway: profile.baseUrl, reauth: profile.id } }]);
    fixture.app.runtime = { ...(fixture.app.runtime as object), loading: false, statusRefreshing: false, reauthorizationRequired: false };
    const authorized = render(Home);
    expect(byId(authorized, "reauthorize-active-profile")).toBeUndefined();
    expect(byId(authorized, "retry-gateway")).toBeUndefined();
  });

  it("keeps an ordinary Gateway error on the retry action without reauthorization", () => {
    app(profile, [a]);
    fixture.app.runtime = { ...(fixture.app.runtime as object), error: "Gateway temporarily offline", reauthorizationRequired: false };
    const tree = render(Home);
    expect(text(tree)).toContain("Gateway temporarily offline");
    expect(byId(tree, "reauthorize-active-profile")).toBeUndefined();
    press(byId(tree, "retry-gateway"));
    expect(fixture.app.refresh).toHaveBeenCalledOnce();
    expect(fixture.pushes).toEqual([]);
  });

  it("shows one localized route failure while keeping the loaded conversation list", () => {
    app(profile, [a]);
    fixture.app.runtime = { ...(fixture.app.runtime as object),
      error: "No advertised Gateway route passed the connection proof",
      statusError: "No advertised Gateway route passed the connection proof" };
    const tree = render(Home);
    expect(elements(tree).filter(element => element.props.testID === "gateway-connection-error")).toHaveLength(1);
    expect(byId(tree, "server-status-error")).toBeUndefined();
    expect(text(tree)).not.toContain("No advertised Gateway route");
    expect(text(tree)).toContain(t("home.gateway_recovering"));
    expect(byId(tree, "retry-gateway")).toBeDefined();
  });

  function absenceHome() {
    const target = { ...a, observationTargetIdentity: "a".repeat(64) };
    app(profile, [target]);
    const cwd = "/A/deleted", threadId = "absent-thread";
    const token = createWorkspaceAbsenceHandoff({ profile, server: target, cwd, threadId, isCurrent: () => true,
      observation: { scope: captureSessionTranscriptScope(profile, target, cwd, threadId), witness: null, isCurrent: () => true,
        result: { version: 1, status: "absent", targetId: target.id, targetSignature: target.observationTargetIdentity,
          workspacePath: cwd, loginGeneration: 1, observedAt: Date.now() } } });
    expect(token).toEqual(expect.any(String));
    fixture.params = { profileId: profile.id, notice: "confirmed-workspace-absent", workspaceAbsenceHandoff: token! };
    return { target, token: token! };
  }

  it("confirmed workspace absence forwards a one-shot scoped handoff from the global New entry", () => {
    const { target, token } = absenceHome();
    const tree = render(Home);
    expect(byId(tree, "new-workspace")?.props.accessibilityLabel).toBe("task.new_task");
    press(byId(tree, "new-workspace"));
    expect(fixture.pushes).toEqual([{ pathname: "/new", params: { profileId: profile.id, serverId: target.id, workspaceAbsenceHandoff: token } }]);
    expect(claimWorkspaceAbsenceHandoff(token, "form", { isCurrent: () => true }, profile, target)?.absentCwd).toBe("/A/deleted");
    press(byId(tree, "new-workspace"));
    expect(fixture.pushes[1]).toEqual({ pathname: "/new", params: { profileId: profile.id } });
  });

  it("confirmed workspace absence handoff survives unrelated peer server inventory changes", () => {
    const { target, token } = absenceHome();
    render(Home);
    fixture.app.runtime = { ...(fixture.app.runtime as object), servers: [target, b] };
    const tree = render(Home);
    press(byId(tree, "new-workspace"));
    expect(fixture.pushes[0]).toEqual({ pathname: "/new", params: { profileId: profile.id, serverId: target.id, workspaceAbsenceHandoff: token } });
  });

  it.each(["auth", "target"] as const)("confirmed workspace absence handoff cannot survive Home %s A to B to A", change => {
    const { target } = absenceHome(); render(Home);
    if (change === "auth") fixture.app.activeProfile = { ...profile, authorizationGeneration: "auth-B" };
    else fixture.app.runtime = { ...(fixture.app.runtime as object), servers: [{ ...target, observationTargetIdentity: "b".repeat(64) }] };
    render(Home);
    fixture.app.activeProfile = profile;
    fixture.app.runtime = { ...(fixture.app.runtime as object), servers: [{ ...target }] };
    press(byId(render(Home), "new-workspace"));
    expect(fixture.pushes[0]).toEqual({ pathname: "/new", params: { profileId: profile.id } });
  });

  it.each(["auth", "target"] as const)("a stale Home New callback cannot navigate after %s owner replacement", change => {
    const { target } = absenceHome();
    const oldAction = byId(render(Home), "new-workspace");
    if (change === "auth") fixture.app.activeProfile = { ...profile, authorizationGeneration: "auth-B" };
    else fixture.app.runtime = { ...(fixture.app.runtime as object), servers: [{ ...target, observationTargetIdentity: "b".repeat(64) }] };
    render(Home, false);
    press(oldAction);
    expect(fixture.pushes).toEqual([]);
  });

  it("a bare Home absence notice leaves normal New preference restoration unchanged", () => {
    fixture.params.notice = "confirmed-workspace-absent";
    press(byId(render(Home), "new-workspace"));
    expect(fixture.pushes[0]).toEqual({ pathname: "/new", params: { profileId: profile.id } });
  });

  it("refreshes unchanged servers' history after the servers phase while statuses remain held", async () => {
    app(profile, [a]);
    let generation = 0;
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"])
      : call.method === "runtime.worktrees.list" ? { items: [] }
      : page([thread(`generation-${generation}`, "/A")]);
    render(Home);
    const ready = await until(Home, tree => {
      expect(byId(tree, "thread-generation-0")).toBeDefined();
      expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false);
    });
    const statuses = deferred<void>();
    const fullRefresh = vi.fn(() => statuses.promise);
    fixture.app.refresh = fullRefresh;
    const current = render(Home);
    expect(drawer(ready).threads.A).toHaveLength(1);
    generation = 1;
    refreshHome(current);
    await Promise.resolve();
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(1);
    try {
      // Model one accepted AppProvider publication: identical inventory, newer revision.
      fixture.app.runtime = { ...(fixture.app.runtime as object), serversRevision: 1 };
      await until(Home, tree => expect(byId(tree, "thread-generation-1")).toBeDefined());
      expect(calls.filter(call => call.method === "thread/list")).toHaveLength(2);
      expect(fullRefresh).toHaveBeenCalledTimes(1);
      render(Home); await Promise.resolve();
      expect(calls.filter(call => call.method === "thread/list")).toHaveLength(2);
    } finally {
      statuses.resolve(undefined);
    }
  });

  it("publishes changed servers and their revision as one history reload without reading old targets", async () => {
    app(profile, [a]);
    read = async call => call.method === "runtime.workspaces.list" ? registered([call.cwd ?? "/"])
      : call.method === "runtime.worktrees.list" ? { items: [] }
      : page([thread(`target-${call.server.id}`, call.cwd ?? "/")]);
    render(Home);
    await until(Home, tree => expect(byId(tree, "thread-target-A")).toBeDefined());
    const oldCalls = calls.length;
    fixture.app.runtime = { ...(fixture.app.runtime as object), servers: [b], serversRevision: 1 };
    await until(Home, tree => expect(byId(tree, "thread-target-B")).toBeDefined());
    const newPages = calls.slice(oldCalls).filter(call => call.method === "thread/list");
    expect(newPages).toHaveLength(1);
    expect(newPages[0].server.id).toBe("B");
  });

  it("cancels a revision-triggered page when status requires reauthorization and rejects late publication", async () => {
    app(profile, [a]);
    render(Home);
    await until(Home, tree => expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false));
    const held = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"])
      : call.method === "runtime.worktrees.list" ? { items: [] } : held.promise;
    fixture.app.runtime = { ...(fixture.app.runtime as object), serversRevision: 1 };
    await until(Home, () => expect(calls.filter(call => call.method === "thread/list")).toHaveLength(2));
    const pending = calls.filter(call => call.method === "thread/list")[1].client;
    fixture.app.runtime = { ...(fixture.app.runtime as object), reauthorizationRequired: true };
    render(Home);
    expect(pending.closeCount).toBe(1);
    held.resolve(page([thread("late-after-401", "/A")]));
    await Promise.resolve(); await Promise.resolve();
    expect(byId(render(Home), "thread-late-after-401")).toBeUndefined();
    fixture.app.runtime = { ...(fixture.app.runtime as object), serversRevision: 2 };
    render(Home); await Promise.resolve();
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(2);
  });

  it("reads three preview pages, releases every cursor owner and opens the exact server history without another Home read", async () => {
    app(profile, [a]);
    read = async call => {
      if (call.method === "runtime.workspaces.list") return registered(["/A", "/extra", "/third"]);
      if (call.method === "runtime.worktrees.list") return { items: [] };
      return page(Array.from({ length: 100 }, (_, i) => thread(`${call.cwd}-${i}`, call.cwd, 1000 - i)), "unread-home-cursor");
    };
    render(Home);
    let tree = await until(Home, tree => expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false));
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(3);
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
    expect(clients).toHaveLength(3);
    const defaultClient = calls.find(call => call.method === "runtime.workspaces.list")!.client;
    expect(calls.find(call => call.method === "thread/list" && call.cwd === "/A")!.client).toBe(defaultClient);
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
    expect(drawer(tree).threads.A).toHaveLength(300);
    expect(drawer(tree).threads.A.map(row => row.updatedAt)).toEqual([...drawer(tree).threads.A.map(row => row.updatedAt)].sort((a, b) => Number(b) - Number(a)));
    press(byId(tree, "toggle-more-threads-A-0")); tree = render(Home);
    expect(elements(tree).filter(element => String(element.props.testID ?? "").startsWith("thread-") && !String(element.props.testID).startsWith("thread-actions-")).length).toBe(116);
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(3);
    press(byId(tree, "view-all-home-threads-A"));
    expect(fixture.pushes).toEqual([{ pathname: "/sessions", params: { profileId: profile.id, serverId: "A" } }]);
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
  });

  it("bounds twelve scope previews to four live clients and retains no idle cursor transports", async () => {
    app(profile, [a]); const paths = ["/A", ...Array.from({ length: 11 }, (_, i) => `/extra-${i}`)];
    read = async call => call.method === "runtime.workspaces.list" ? registered(paths) : call.method === "runtime.worktrees.list" ? { items: [] } : page([thread(call.cwd!, call.cwd)], "unused-cursor");
    render(Home);
    const ready = await until(Home, tree => expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false));
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(12);
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
    expect(drawer(ready).threads.A).toHaveLength(12);
    expect(peakLiveClients).toBeLessThanOrEqual(4);
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
  });

  it("releases the borrowed preview lease exactly once after its held catalog finishes", async () => {
    app(profile, [a]); const catalog = deferred<unknown>();
    read = async call => call.method === "runtime.workspaces.list" ? catalog.promise : call.method === "runtime.worktrees.list" ? { items: [] } : page([thread("early")], "unused-cursor");
    render(Home);
    await until(Home, tree => expect(byId(tree, "thread-early")).toBeDefined());
    expect(clients).toHaveLength(1); expect(clients[0]!.closeCount).toBe(0);
    catalog.resolve(registered(["/A"]));
    await until(Home, tree => expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false));
    expect(clients[0]!.closeCount).toBe(1);
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(1);
  });

  it.each(["explicit", "unknown-default"] as const)("routes only concrete workspace-row Plus actions to their exact cwd with a cursored %s scope", async mode => {
    app(profile, [{ ...a, workspacePath: mode === "explicit" ? "/A" : undefined }]);
    read = async call => call.method === "runtime.workspaces.list" ? registered(mode === "explicit" ? ["/A", "/empty"] : ["/empty"]) : call.method === "runtime.worktrees.list" ? { items: [] } : call.cwd === "/empty" ? page([]) : page([], "unread");
    render(Home);
    const first = await until(Home, tree => expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false));
    expect(byId(first, "home-threads-incomplete-A")).toBeDefined();
    const emptyWorkspaceIndex = mode === "explicit" ? 1 : 0;
    expect(byId(first, `new-workspace-A-${emptyWorkspaceIndex}`)).toBeDefined();
    if (mode === "explicit") expect(byId(first, "new-workspace-A-0")).toBeDefined();
    else expect(byId(first, "new-workspace-A-1")).toBeUndefined();
    expect(elements(first).filter(element => String(element.props.testID ?? "").startsWith("home-workspace-row-A-"))).toHaveLength(mode === "explicit" ? 2 : 1);
    press(byId(first, `new-workspace-A-${emptyWorkspaceIndex}`));
    expect(fixture.pushes).toEqual([{ pathname: "/new", params: { profileId: profile.id, serverId: "A", cwd: "/empty" } }]);
    press(byId(first, "view-all-home-threads-A"));
    expect(fixture.pushes.at(-1)).toEqual({ pathname: "/sessions", params: { profileId: profile.id, serverId: "A" } });
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
  });

  it("keeps an unknown default directory non-actionable while preserving its prior collapse key", async () => {
    const implicit = { ...a, workspacePath: undefined };
    app(profile, [implicit]);
    read = async call => call.method === "runtime.workspaces.list" ? { items: [] }
      : call.method === "runtime.worktrees.list" ? { items: [] }
        : page([{ ...thread("no-cwd"), cwd: undefined }]);
    const tree = await until(Home, current => expect(byId(current, "thread-no-cwd")).toBeDefined());
    const row = byId(tree, "home-workspace-row-A-0")!;
    expect(byId(row, "toggle-server-A")?.props.accessibilityLabel).toContain(t("home.choose_directory_for_new"));
    expect(byId(tree, "new-workspace-A-0")?.props.disabled).toBe(true);
    expect(byId(tree, "toggle-server-A")?.props.disabled).toBe(false);
    longPress(byId(tree, "toggle-server-A"));
    expect(byType(render(Home), WorkspaceHistoryActionsSheet)).toBeUndefined();
    press(byId(tree, "toggle-server-A"));
    expect(fixture.collapsedToggles).toEqual(["A\0/"]);
  });

  it("does not treat a partial empty scope without a cursor as confirmed empty", async () => {
    app(profile, [a]);
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : page([], undefined, 1);
    render(Home);
    const first = await until(Home, tree => expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false));
    expect(drawer(first).threadErrors.A).toContain("不完整");
    expect(text(first)).not.toContain("task.new_task_in_this_project");
    expect(byId(first, "home-threads-incomplete-A")).toBeUndefined();
    expect(byId(first, "view-all-home-threads-A")).toBeUndefined();
  });

  it("releases a failed preview and retries only a fresh first page on explicit refresh", async () => {
    app(profile, [a]); let fail = true;
    read = async call => {
      if (call.method === "runtime.workspaces.list") return registered(["/A"]);
      if (call.method === "runtime.worktrees.list") return { items: [] };
      if (fail) throw new Error("preview-read-failed");
      return page([thread("recovered")], "unread");
    };
    render(Home);
    const failure = await until(Home, tree => { expect(drawer(tree).threadErrors.A).toContain("preview-read-failed"); expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false); });
    expect(byId(failure, "home-threads-incomplete-A")).toBeUndefined();
    expect(byId(failure, "view-all-home-threads-A")).toBeUndefined();
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
    fail = false; refreshHome(failure);
    const recovered = await until(Home, tree => { expect(byId(tree, "thread-recovered")).toBeDefined(); expect(drawer(tree).threadErrors.A).toBeUndefined(); expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false); });
    expect(byId(recovered, "home-threads-incomplete-A")).toBeDefined();
    expect(byId(recovered, "view-all-home-threads-A")).toBeDefined();
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(2);
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
  });

  it.each(["blur", "auth", "target", "reauth", "deleted-profile"] as const)("rejects a captured all-history action after %s changes", async change => {
    app(profile, [a]);
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : page([thread("kept")], "unread");
    render(Home);
    const ready = await until(Home, tree => expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false));
    const oldAction = byId(ready, "view-all-home-threads-A"); expect(oldAction).toBeDefined();
    if (change === "blur") fixture.focused = false;
    else if (change === "auth") app({ ...profile, authorizationGeneration: "auth-B" }, [a]);
    else if (change === "reauth") fixture.app.runtime = { ...(fixture.app.runtime as object), reauthorizationRequired: true };
    else if (change === "deleted-profile") fixture.app.profiles = [];
    else app(profile, [{ ...a, command: "changed-target" }]);
    render(Home, false); press(oldAction);
    expect(fixture.pushes).toEqual([]);
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
  });

  it.each(["blur", "auth", "refresh"] as const)("cancels a held first preview on %s and never publishes its late rows", async change => {
    app(profile, [a]); const first = deferred<ThreadListPage>(); let firstClient: RouteClient | undefined;
    read = async call => {
      if (call.method === "runtime.workspaces.list") return registered(["/A"]);
      if (call.method === "runtime.worktrees.list") return { items: [] };
      firstClient ??= call.client;
      return call.client === firstClient ? first.promise : page([]);
    };
    render(Home);
    const pending = await until(Home, tree => { expect(calls.filter(call => call.method === "thread/list")).toHaveLength(1); expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(true); });
    const oldClient = calls.find(call => call.method === "thread/list")!.client;
    if (change === "blur") fixture.focused = false;
    else if (change === "auth") app({ ...profile, authorizationGeneration: "auth-B" }, [a]);
    else refreshHome(pending);
    await until(Home, () => expect(oldClient.closeCount).toBe(1));
    first.resolve(page([thread("late-old-page")], "unread"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(byId(render(Home), "thread-late-old-page")).toBeUndefined();
    expect(oldClient.closeCount).toBe(1);
  });

  it("opens Home task actions with a long press without navigation and invalidates the menu across focus changes", async () => {
    app(profile, [a]);
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"])
      : call.method === "runtime.worktrees.list" ? { items: [] } : page([thread("actions")]);
    render(Home);
    const tree = await until(Home, tree => expect(byId(tree, "thread-actions")).toBeDefined());
    const open = byId(tree, "thread-actions")!;
    expect(byId(tree, "thread-actions-actions")).toBeUndefined();
    longPress(open);
    expect(fixture.pushes).toEqual([]);
    let sheet = leaf(render(Home), "ThreadActionsSheet")!;
    expect(sheet.props.visible).toBe(true);
    expect(sheet.props.profile).toBe(profile);
    expect(sheet.props.target).toMatchObject({ server: { id: "A", workspacePath: "/A" }, thread: { id: "actions", cwd: "/A" } });
    const oldClose = sheet.props.onClose as () => void;
    const oldRenamed = sheet.props.onRenamed as (thread: ThreadSummary) => void;
    const oldRemoved = sheet.props.onRemoved as (kind: string, thread: ThreadSummary) => void;
    oldRenamed({ ...thread("actions"), title: "Optimistic name" });
    expect(leaf(render(Home), "ThreadActionsSheet")!.props.target).toMatchObject({ thread: { title: "Optimistic name" } });
    oldRenamed(thread("actions"));
    expect(leaf(render(Home), "ThreadActionsSheet")!.props.target).toMatchObject({ thread: { title: "actions" } });
    oldClose();
    longPress(byId(render(Home), "thread-actions"));
    const nextTarget = leaf(render(Home), "ThreadActionsSheet")!.props.target;
    oldRenamed({ ...thread("actions"), title: "Old result" });
    oldRemoved("archived", thread("actions"));
    oldClose();
    expect(leaf(render(Home), "ThreadActionsSheet")!.props.target).toBe(nextTarget);
    fixture.focused = false; render(Home);
    fixture.focused = true;
    sheet = leaf(render(Home), "ThreadActionsSheet")!;
    expect(sheet.props.visible).toBe(false);
    longPress(open);
    expect(leaf(render(Home), "ThreadActionsSheet")!.props.visible).toBe(false);
    expect(fixture.pushes).toEqual([]);
    const currentTree = await until(Home, tree => expect(byId(tree, "thread-actions")).toBeDefined());
    longPress(byId(currentTree, "thread-actions"));
    expect(leaf(render(Home), "ThreadActionsSheet")!.props.visible).toBe(true);
    oldClose();
    expect(leaf(render(Home), "ThreadActionsSheet")!.props.visible).toBe(true);
  });

  it("shows a clickable first page while another discovery and the next cursor are held", async () => {
    const discovery = deferred<unknown>(); const peerFirst = deferred<ThreadListPage>(); const later = deferred<ThreadListPage>();
    read = async call => {
      if (call.method === "runtime.worktrees.list") return { items: [] };
      if (call.method === "runtime.workspaces.list") return call.server.id === "B" ? discovery.promise : registered(["/A"]);
      return call.params.cursor ? later.promise : call.server.id === "B" ? peerFirst.promise : page([thread("first")], "second");
    };
    render(Home);
    const tree = await until(Home, tree => expect(byId(tree, "thread-first")).toBeDefined());
    expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(true);
    press(byId(tree, "thread-first"));
    expect(fixture.pushes).toEqual([{ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: profile.id, serverId: "A", threadId: "first", cwd: "/A", title: "first" } }]);
    expect(calls.some(call => call.method === "thread/list" && call.server.id === "B")).toBe(true);
    expect(byId(tree, "thread-peer")).toBeUndefined();
    discovery.resolve(registered(["/B"]));
    // B's page does not inherit A's held cursor.
    read = async call => call.method === "runtime.worktrees.list" ? { items: [] } : call.method === "runtime.workspaces.list" ? registered([call.cwd ?? "/"]) : call.server.id === "B" ? page([thread("peer", "/B")]) : later.promise;
    peerFirst.resolve(page([thread("peer", "/B")]));
    const firstPages = await until(Home, tree => { expect(byId(tree, "thread-peer")).toBeDefined(); expect(byId(tree, "thread-first")).toBeDefined(); expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false); });
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
    press(byId(firstPages, "view-all-home-threads-A"));
    expect(fixture.pushes.at(-1)).toEqual({ pathname: "/sessions", params: { profileId: profile.id, serverId: "A" } });
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
  });

  it.each([{ kind: "error" }, { kind: "partial" }])("keeps a pending scope's prior $kind when its peer succeeds, then clears only that scope on success", async ({ kind }) => {
    app(profile, [a]); let phase = 0; const held = deferred<ThreadListPage>();
    read = async call => {
      if (call.method === "runtime.workspaces.list") return registered(["/A", "/extra"]);
      if (call.method === "runtime.worktrees.list") return { items: [] };
      if (call.cwd !== "/extra") return page([thread("fast")]);
      if (phase === 1) return held.promise;
      if (kind === "error") throw new Error("extra-scope-failure");
      return page([thread("previous", "/extra")], undefined, 1);
    };
    const expected = kind === "error" ? "extra-scope-failure" : "不完整";
    render(Home);
    const previous = await until(Home, tree => { expect(drawer(tree).threadErrors.A).toContain(expected); expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false); });
    phase = 1; refreshHome(previous);
    await until(Home, tree => { expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(true); expect(byId(tree, "thread-fast")).toBeDefined(); expect(drawer(tree).threadErrors.A).toContain(expected); });
    await vi.waitFor(() => expect(calls.filter(call => call.method === "thread/list" && call.cwd === "/extra")).toHaveLength(2));
    held.resolve(page([thread("recovered", "/extra")]));
    await until(Home, tree => { expect(byId(tree, "thread-recovered")).toBeDefined(); expect(drawer(tree).threadErrors.A).toBeUndefined(); });
  });

  it.each([{ change: "auth" }, { change: "device" }, { change: "target" }])("hides old paths and errors on the first $change owner render, before effects", async ({ change }) => {
    app(profile, [a]);
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/secret-A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : page([thread("old", "/secret-A")], undefined, 1);
    render(Home);
    const ready = await until(Home, tree => { expect(elements(tree).some(element => String(element.props.accessibilityLabel).includes("/secret-A"))).toBe(true); expect(drawer(tree).threadErrors.A).toContain("不完整"); expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false); });
    expect(drawer(ready).workspaceOptions.A).toHaveLength(1);
    // Establish a real discovery error with a previously successful catalog;
    // otherwise the workspaceErrors first-frame assertion would be vacuous.
    clearWorkspaceOptionsCache();
    read = async call => {
      if (call.method === "runtime.workspaces.list") throw new Error("private-catalog-A");
      if (call.method === "runtime.worktrees.list") return { items: [] };
      return page([thread("old", "/secret-A")], undefined, 1);
    };
    refreshHome(ready);
    await until(Home, tree => { expect(drawer(tree).workspaceErrors.A).toContain("private-catalog-A"); expect(drawer(tree).workspaceOptions.A).toHaveLength(1); expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false); });
    const nextProfile = change === "auth" ? { ...profile, authorizationGeneration: "auth-B" } : change === "device" ? { ...profile, deviceId: "device-B" } : profile;
    const nextServer = change === "target" ? { ...a, command: "changed-config" } : a;
    app(nextProfile, [nextServer]); const held = deferred<unknown>();
    read = async call => call.method === "runtime.worktrees.list" ? { items: [] } : held.promise;
    const firstRender = render(Home, false);
    expect(text(firstRender)).not.toContain("/secret-A");
    expect(elements(firstRender).some(element => String(element.props.accessibilityLabel).includes("/secret-A"))).toBe(false);
    expect(drawer(firstRender).workspaceOptions).toEqual({});
    expect(drawer(firstRender).workspaceErrors).toEqual({});
    expect(drawer(firstRender).threadErrors).toEqual({});
    expect(byId(firstRender, "thread-old")).toBeUndefined();
    render(Home); held.resolve(registered(["/new-B"]));
  });

  it("rejects an A first page's queued state updaters after a new owner render and closes its lazy pager", async () => {
    app(profile, [a]); const first = deferred<ThreadListPage>(); const later = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : call.params.cursor ? later.promise : first.promise;
    render(Home);
    await vi.waitFor(() => expect(calls.some(call => call.method === "thread/list")).toBe(true));
    fixture.queueUpdates = true; first.resolve(page([thread("queued-A")], "second"));
    await vi.waitFor(() => expect(fixture.queuedUpdates.length).toBeGreaterThan(0));
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
    const oldClient = calls.find(call => call.method === "thread/list")!.client;
    app({ ...profile, authorizationGeneration: "auth-B" }, [a]);
    render(Home, false); fixture.queueUpdates = false;
    for (const update of fixture.queuedUpdates.splice(0)) update();
    expect(byId(render(Home, false), "thread-queued-A")).toBeUndefined();
    const tree = render(Home, false);
    expect(drawer(tree).workspaceOptions).toEqual({}); expect(byId(tree, "thread-late-A")).toBeUndefined();
    // Render fences hide old values immediately; idle transport cleanup runs in the effect.
    render(Home);
    await vi.waitFor(() => expect(oldClient.closeCount).toBe(1));
  });

  it("does not publish a held peer preview after an actual delete RPC ACK", async () => {
    app(profile, [a]); const peer = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A", "/extra"]) : call.method === "runtime.worktrees.list" ? { items: [] } : call.method === "thread/delete" ? {} : call.cwd === "/extra" ? peer.promise : page([thread("deleted")], "unread");
    render(Home);
    await until(Home, tree => { expect(byId(tree, "thread-deleted")).toBeDefined(); expect(calls.some(call => call.method === "thread/list" && call.cwd === "/extra")).toBe(true); });
    const oldClient = calls.find(call => call.method === "thread/list" && call.cwd === "/extra")!.client;
    await deleteStoredThread(profile, a, "deleted", "/A");
    expect(calls.filter(call => call.method === "thread/delete")).toHaveLength(1);
    expect(byId(render(Home, false), "thread-deleted")).toBeUndefined();
    peer.resolve(page([thread("deleted"), thread("late-old")], "unread"));
    await vi.waitFor(() => expect(oldClient.closeCount).toBe(1));
    expect(byId(render(Home, false), "thread-deleted")).toBeUndefined();
    expect(byId(render(Home, false), "thread-late-old")).toBeUndefined();
  });
});

describe("Sessions actual route publication contracts", () => {
  it("keeps unregistered-directory history accessible with its original cwd", async () => {
    app(profile, [a]);
    read = async call => call.method === "runtime.workspaces.list" ? { rootProjectPinned: true, items: [] }
      : call.method === "runtime.worktrees.list" ? { items: [] }
      : page([thread("old", "/retired/workspace")]);
    const tree = await until(Sessions, current => expect(sessionRows(current)).toHaveLength(1));
    expect(sessionRows(tree)[0]!.thread.cwd).toBe("/retired/workspace");
    expect((byType(tree, SessionFiltersPage)!.props.projects as Array<{ path: string; label: string }>).find(project => project.path === "/retired/workspace")?.label)
      .toBe(t("sessions.unassigned_project"));
    pressSession(tree, "old");
    expect(fixture.pushes.at(-1)).toMatchObject({
      pathname: "/h/[profileId]/task/[serverId]/[threadId]",
      params: { profileId: profile.id, serverId: "A", threadId: "old", cwd: "/retired/workspace" },
    });
  });

  it("offers pairing and manual recovery when no Gateway profile is saved", () => {
    app(profile, [a]);
    fixture.params = {};
    fixture.app = { ...fixture.app, activeProfile: null, profiles: [] };
    const tree = render(Sessions);
    expect(byId(tree, "sessions-no-active-profile")).toBeDefined();
    expect(byId(tree, "sessions-no-saved-profile")).toBeDefined();
    press(byId(tree, "sessions-pair-gateway"));
    press(byId(tree, "sessions-manual-gateway"));
    expect(fixture.pushes).toEqual([
      { pathname: "/welcome", params: { connectMode: "pairing" } },
      { pathname: "/welcome", params: { connectMode: "direct" } },
    ]);
  });

  it("keeps local profile hydration pending explicit and retries a hydration failure", () => {
    app(profile, [a]);
    fixture.params = {};
    fixture.app = { ...fixture.app, hydrated: false, activeProfile: null, profiles: [] };
    const loading = render(Sessions);
    expect(byId(loading, "sessions-profile-hydration-loading")).toBeDefined();
    expect(byId(loading, "sessions-state-spinner")).toBeDefined();

    const retryStoredProfiles = vi.fn(async () => null);
    fixture.app = { ...fixture.app, hydrated: true, profileHydrationError: "Local profile storage is unavailable.", retryStoredProfiles };
    const failed = render(Sessions);
    expect(byId(failed, "sessions-profile-recovery-error")).toBeDefined();
    expect(byId(failed, "sessions-profile-recovery-error-detail")?.props.children).toBe("Local profile storage is unavailable.");
    press(byId(failed, "sessions-retry-profile-recovery"));
    expect(retryStoredProfiles).toHaveBeenCalledOnce();
  });

  it("distinguishes saved profiles from having no active connection", () => {
    app(profile, [a]);
    fixture.params = {};
    fixture.app = { ...fixture.app, activeProfile: null };
    const tree = render(Sessions);
    expect(byId(tree, "sessions-no-active-profile")).toBeDefined();
    expect(byId(tree, "sessions-no-saved-profile")).toBeUndefined();
    press(byId(tree, "sessions-open-connections"));
    expect(fixture.pushes).toEqual(["/settings-connections"]);
  });

  it("shows a retryable server-inventory error when the Gateway list could not be read", () => {
    app(profile, [a]);
    const refresh = fixture.app.refresh as ReturnType<typeof vi.fn>;
    fixture.app = { ...fixture.app, runtime: { ...(fixture.app.runtime as object), servers: [], serversReady: false, loading: false, error: "servers GET returned 503", reauthorizationRequired: false } };
    const tree = render(Sessions);
    expect(byId(tree, "sessions-server-inventory-error")).toBeDefined();
    expect(byId(tree, "sessions-server-inventory-error-detail")?.props.children).toBe("servers GET returned 503");
    expect(byId(tree, "sessions-retry-server-inventory")).toBeDefined();
    expect(byId(tree, "sessions-state-spinner")).toBeUndefined();
    expect(calls).toHaveLength(0);
    press(byId(tree, "sessions-retry-server-inventory"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps reauthorization ahead of an unavailable server inventory", () => {
    app(profile, [a]);
    fixture.app = { ...fixture.app, runtime: { ...(fixture.app.runtime as object), servers: [], serversReady: false, loading: false, error: "session expired", reauthorizationRequired: true } };
    const tree = render(Sessions);
    expect(byId(tree, "sessions-reauthorize-active-profile")).toBeDefined();
    expect(byId(tree, "sessions-server-inventory-error")).toBeUndefined();
  });

  it("explains initial server inventory loading and leaves a connection settings exit", () => {
    app(profile, [a]);
    fixture.app = { ...fixture.app, runtime: { ...(fixture.app.runtime as object), servers: [], serversReady: false, loading: true, error: null, reauthorizationRequired: false } };
    const tree = render(Sessions);
    expect(byId(tree, "sessions-server-inventory-loading")).toBeDefined();
    expect(byId(tree, "sessions-state-spinner")).toBeDefined();
    press(byId(tree, "sessions-open-connections"));
    expect(fixture.pushes).toEqual(["/settings-connections"]);
  });

  it("settles a rejected profile switch into retry and connections actions", async () => {
    const routeProfile = { ...profile, id: "route-target", authorizationGeneration: "auth-route" };
    app(profile, [a]);
    fixture.params = { profileId: routeProfile.id };
    const setActiveProfile = vi.fn().mockRejectedValue(new Error("profile selection failed"));
    fixture.app = { ...fixture.app, profiles: [profile, routeProfile], setActiveProfile };
    fixture.shouldActivateRouteProfile = true;
    const failed = await until(Sessions, tree => expect(byId(tree, "sessions-profile-switch-error")).toBeDefined());
    expect(setActiveProfile).toHaveBeenCalledOnce();
    press(byId(failed, "sessions-retry-profile-switch"));
    await until(Sessions, tree => expect(byId(tree, "sessions-profile-switch-error")).toBeDefined());
    expect(setActiveProfile).toHaveBeenCalledTimes(2);
    press(byId(render(Sessions), "sessions-open-connections"));
    expect(fixture.pushes).toEqual(["/settings-connections"]);
  });

  it("renders the normal empty-history state after a successful empty inventory read", async () => {
    app(profile, [a]);
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"])
      : call.method === "runtime.worktrees.list" ? { items: [] }
      : page([]);
    render(Sessions);
    const tree = await until(Sessions, current => {
      expect(list(current)).toBeDefined();
      expect(byId(current, "sessions-page-loading")).toBeUndefined();
    });
    expect(sessionRows(tree)).toEqual([]);
    expect(byId(tree, "sessions-empty-state")).toBeDefined();
    expect(byId(tree, "sessions-server-inventory-error")).toBeUndefined();
  });

  it("bounds cursor keepers across twelve scopes and activates each queued scope with only one fresh replay", async () => {
    app(profile, [a]); const paths = ["/A", ...Array.from({ length: 11 }, (_, i) => `/workspace-${i}`)];
    read = async call => {
      if (call.method === "runtime.workspaces.list") return registered(paths);
      if (call.method === "runtime.worktrees.list") return { items: [] };
      const clientId = clients.indexOf(call.client);
      const cursor = call.params.cursor as string | undefined;
      if (cursor) expect(cursor.split(":")[0]).toBe(String(clientId));
      const index = cursor ? Number(cursor.split(":")[1]) : 0;
      return page(Array.from({ length: 50 }, (_, i) => thread(`${call.cwd}-${index * 50 + i}`, call.cwd, 1000 - index * 50 - i)), index < 2 ? `${clientId}:${index + 1}` : undefined);
    };
    render(Sessions);
    let tree = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(600); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(12);
    expect(clients.filter(client => client.closeCount === 0)).toHaveLength(4);
    expect(peakLiveClients).toBeLessThanOrEqual(8);
    let turns = 0;
    while (sessionRows(tree).length < 1800 && turns++ < 12) {
      const before = calls.filter(call => call.method === "thread/list").length;
      (list(tree)!.props.onEndReached as () => void)(); (list(tree)!.props.onEndReached as () => void)();
      tree = await until(Sessions, tree => { expect(calls.filter(call => call.method === "thread/list").length).toBeGreaterThan(before); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
      expect(clients.filter(client => client.closeCount === 0).length).toBeLessThanOrEqual(4);
    }
    expect(sessionRows(tree)).toHaveLength(1800);
    for (const path of paths) {
      const firstReads = calls.filter(call => call.method === "thread/list" && call.cwd === path && !call.params.cursor);
      expect(firstReads.length).toBeGreaterThanOrEqual(1); expect(firstReads.length).toBeLessThanOrEqual(2);
    }
    expect(calls.filter(call => call.method === "thread/list" && !call.params.cursor)).toHaveLength(20);
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
    expect(peakLiveClients).toBeLessThanOrEqual(8);
    expect(new Set(sessionRows(tree).map(row => row.thread.id)).size).toBe(1800);
  });

  it("keeps rows after an expired cursor and pulls a fresh snapshot without replaying that cursor", async () => {
    app(profile, [a]); let expire = true; const fresh = deferred<ThreadListPage>(); let freshClient: RouteClient | undefined;
    read = async call => {
      if (call.method === "runtime.workspaces.list") return registered(["/A"]);
      if (call.method === "runtime.worktrees.list") return { items: [] };
      if (call.params.cursor) throw new Error("expired thread/list cursor");
      if (expire) return page([thread("kept-before-expiry")], "expired-cursor");
      freshClient = call.client; return fresh.promise;
    };
    render(Sessions);
    const ready = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(1); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    (list(ready)!.props.onEndReached as () => void)();
    const failed = await until(Sessions, tree => { expect(text(tree)).not.toContain("expired thread/list cursor"); expect(byId(tree, "sessions-reload")).toBeUndefined(); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(sessionRows(failed).map(row => row.thread.id)).toEqual(["kept-before-expiry"]);
    expect(clients[0]!.closeCount).toBe(1);
    (list(failed)!.props.onEndReached as () => void)();
    expect(calls.filter(call => call.params.cursor)).toHaveLength(1);
    expire = false; refreshSessions(failed);
    await until(Sessions, tree => { expect(freshClient).toBeDefined(); expect(sessionRows(tree).map(row => row.thread.id)).toEqual(["kept-before-expiry"]); });
    expect(freshClient).not.toBe(clients[0]);
    fresh.resolve(page([thread("after-fresh-reload")]));
    const reloaded = await until(Sessions, tree => { expect(sessionRows(tree).map(row => row.thread.id)).toEqual(["after-fresh-reload"]); expect(byId(tree, "sessions-reload")).toBeUndefined(); });
    expect(calls.filter(call => call.params.cursor)).toHaveLength(1);
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
    expect(sessionRows(reloaded)).toHaveLength(1);
  });

  it("treats queued empty previews as unread and reaches their later matches on fresh activation", async () => {
    app(profile, [a]); const paths = ["/A", "/b", "/c", "/d", "/queued"];
    read = async call => call.method === "runtime.workspaces.list" ? registered(paths) : call.method === "runtime.worktrees.list" ? { items: [] } : call.params.cursor ? page([thread(`older-${call.cwd}`, call.cwd)]) : page([], `cursor-${clients.indexOf(call.client)}`);
    render(Sessions);
    let tree = await until(Sessions, tree => { expect(byId(tree, "sessions-page-loading")).toBeUndefined(); expect(byId(tree, "sessions-load-more-empty")).toBeDefined(); });
    expect(clients.filter(client => client.closeCount === 0)).toHaveLength(4);
    press(byId(tree, "sessions-load-more-empty"));
    tree = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(4); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(byId(tree, "sessions-load-more")).toBeDefined();
    press(byId(tree, "sessions-load-more"));
    await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(5); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(calls.filter(call => call.method === "thread/list" && !call.params.cursor)).toHaveLength(6);
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
  });

  it("shares one route-wide keeper budget across twelve targets and releases every default catalog lease on blur", async () => {
    const servers = Array.from({ length: 12 }, (_, i) => ({ ...a, id: `target-${i}`, workspacePath: `/target-${i}` }));
    app(profile, servers);
    read = async call => call.method === "runtime.workspaces.list" ? registered([call.cwd!, `${call.cwd}/extra`]) : call.method === "runtime.worktrees.list" ? { items: [] } : page([thread(`first-${call.cwd}`, call.cwd)], `cursor-${clients.indexOf(call.client)}`);
    render(Sessions);
    const ready = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(24); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(24);
    expect(clients).toHaveLength(24);
    expect(clients.filter(client => client.closeCount === 0)).toHaveLength(4);
    expect(peakLiveClients).toBeLessThanOrEqual(8);
    fixture.focused = false; render(Sessions);
    const count = calls.length;
    (list(ready)!.props.onEndReached as () => void)();
    expect(calls).toHaveLength(count);
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
  });

  it.each(["profile", "archive", "blur"] as const)("fences queued fresh activation and its old callback after %s changes", async change => {
    app(profile, [a]); const paths = ["/A", "/b", "/c", "/d", "/queued"];
    const held = deferred<ThreadListPage>(); let invalidated = false; let queuedFirst = 0; let oldQueuedClient: RouteClient | undefined;
    read = async call => {
      if (call.method === "runtime.workspaces.list") return registered(paths);
      if (call.method === "runtime.worktrees.list") return { items: [] };
      if (invalidated) return page([thread(`new-${call.cwd}`, call.cwd)]);
      if (call.cwd === "/queued" && !call.params.cursor && ++queuedFirst === 2) { oldQueuedClient = call.client; return held.promise; }
      return call.params.cursor ? page([thread(`old-more-${call.cwd}`, call.cwd)]) : page([thread(`old-first-${call.cwd}`, call.cwd)], `old-cursor-${clients.indexOf(call.client)}`);
    };
    render(Sessions);
    let tree = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(5); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    (list(tree)!.props.onEndReached as () => void)();
    tree = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(9); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    const staleContinue = list(tree)!.props.onEndReached as () => void;
    staleContinue();
    await until(Sessions, () => expect(oldQueuedClient).toBeDefined());
    invalidated = true;
    if (change === "profile") app({ ...profile, deviceId: "next-device" }, [a]);
    else if (change === "archive") {
      press(byId(render(Sessions), "sessions-open-filters"));
      const filters = byType(render(Sessions), SessionFiltersPage)!;
      (filters.props.onApply as (value: unknown) => void)({ serverId: "all", workspaceKey: null, archived: true });
    }
    else fixture.focused = false;
    const previousIds = sessionRows(tree).map(row => row.thread.id);
    // Blur cancels reads without erasing the same owner's already visible rows.
    // Authorization/profile or query-filter changes must hide mismatched rows.
    expect(sessionRows(render(Sessions, false)).map(row => row.thread.id)).toEqual(change === "blur" ? previousIds : []);
    render(Sessions);
    expect(oldQueuedClient!.closeCount).toBe(1);
    const oldCalls = calls.filter(call => call.client === oldQueuedClient).length;
    staleContinue();
    held.resolve(page([thread("late-queued-owner", "/queued")], "late-cursor"));
    if (change !== "blur") await until(Sessions, tree => expect(byId(tree, "sessions-page-loading")).toBeUndefined());
    else await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls.filter(call => call.client === oldQueuedClient)).toHaveLength(oldCalls);
    const finalIds = sessionRows(render(Sessions, false)).map(row => row.thread.id);
    expect(finalIds).not.toContain("late-queued-owner");
    if (change === "blur") expect(finalIds).toEqual(previousIds);
    else expect(finalIds.some(id => id.startsWith("old-"))).toBe(false);
    expect(oldQueuedClient!.closeCount).toBe(1);
  });

  it("preserves queued rows when its fresh scan fails and requires explicit reload", async () => {
    app(profile, [a]); const paths = ["/A", "/b", "/c", "/d", "/queued"]; let queuedFirst = 0;
    read = async call => {
      if (call.method === "runtime.workspaces.list") return registered(paths);
      if (call.method === "runtime.worktrees.list") return { items: [] };
      if (call.cwd === "/queued" && !call.params.cursor && ++queuedFirst === 2) throw new Error("queued-fresh-unavailable");
      return call.params.cursor ? page([thread(`older-${call.cwd}`, call.cwd)]) : page([thread(`first-${call.cwd}`, call.cwd)], `cursor-${clients.indexOf(call.client)}`);
    };
    render(Sessions);
    let tree = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(5); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    (list(tree)!.props.onEndReached as () => void)();
    tree = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(9); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    (list(tree)!.props.onEndReached as () => void)();
    const failed = await until(Sessions, tree => { expect(text(tree)).not.toContain("queued-fresh-unavailable"); expect(byId(tree, "sessions-reload")).toBeUndefined(); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(sessionRows(failed).map(row => row.thread.id)).toContain("first-/queued");
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
    const count = calls.length; (list(failed)!.props.onEndReached as () => void)();
    expect(calls).toHaveLength(count);
  });

  it("opens only the server selected by the Home link and reads later pages on its own initialized connection", async () => {
    fixture.params.serverId = "B";
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/B"]) : call.method === "runtime.worktrees.list" ? { items: [] } : call.params.cursor ? page([thread("older-B", "/B", 1)]) : page([thread("first-B", "/B")], "sessions-own-cursor");
    render(Sessions);
    const first = await until(Sessions, tree => { expect(sessionRows(tree).map(row => row.thread.id)).toEqual(["first-B"]); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(calls.every(call => call.server.id === "B")).toBe(true);
    expect(calls.filter(call => call.params.cursor)).toEqual([]);
    (list(first)!.props.onEndReached as () => void)();
    await until(Sessions, tree => expect(sessionRows(tree).map(row => row.thread.id)).toEqual(["first-B", "older-B"]));
    expect(calls.filter(call => call.method === "thread/list")).toHaveLength(2);
    expect(calls.filter(call => call.method === "thread/list").every(call => call.client === clients[0])).toBe(true);
    expect(clients[0]!.closeCount).toBe(1);
  });

  it("publishes a navigable first-page list and truthful loading footer before slow discovery completes", async () => {
    const discovery = deferred<unknown>(); const peerFirst = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? call.server.id === "B" ? discovery.promise : registered(["/A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : call.server.id === "B" ? peerFirst.promise : page([thread("early", call.cwd)], "second");
    render(Sessions);
    const tree = await until(Sessions, tree => expect(sessionRows(tree).map(row => row.thread.id)).toEqual(["early"]));
    expect(byId(tree, "sessions-page-loading")).toBeDefined(); pressSession(tree, "early");
    expect(fixture.pushes).toEqual([{ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: profile.id, serverId: "A", threadId: "early", cwd: "/A", title: "early" } }]);
    // Initial discovery is still draining, so onEndReached cannot create another batch.
    (list(tree)!.props.onEndReached as () => void)();
    expect(calls.filter(call => call.params.cursor)).toHaveLength(0);
    discovery.resolve(registered(["/B"]));
    peerFirst.resolve(page([thread("peer", "/B")]));
    await until(Sessions, tree => expect(sessionRows(tree).map(row => row.thread.id).sort()).toEqual(["early", "peer"]));
  });

  it("shows each loadMore result before its held peer and retains rows during refresh and later-page failure", async () => {
    let phase = 0; const heldB = deferred<ThreadListPage>(); const refreshA = deferred<ThreadListPage>();
    read = async call => {
      if (call.method === "runtime.workspaces.list") return registered([call.cwd ?? "/"]);
      if (call.method === "runtime.worktrees.list") return { items: [] };
      if (phase === 2 && call.server.id === "A") return refreshA.promise;
      if (call.params.cursor) return call.server.id === "B" ? heldB.promise : page([thread("A-more", "/A", 9)]);
      return page([thread(call.server.id + "-first", call.cwd)], "second");
    };
    render(Sessions);
    const ready = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(2); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(byId(ready, "sessions-incomplete-notice")).toBeUndefined();
    phase = 1; (list(ready)!.props.onEndReached as () => void)();
    const more = await until(Sessions, tree => { expect(sessionRows(tree).map(row => row.thread.id)).toContain("A-more"); expect(byId(tree, "sessions-page-loading")).toBeDefined(); });
    (list(more)!.props.onEndReached as () => void)();
    expect(calls.filter(call => call.params.cursor && call.server.id === "B")).toHaveLength(1);
    heldB.reject(new Error("B-later-failed"));
    const failure = await until(Sessions, tree => { expect(text(tree)).not.toContain("B-later-failed"); expect(byId(tree, "sessions-incomplete-notice")).toBeDefined(); expect(byId(tree, "sessions-retry-load")).toBeDefined(); expect(sessionRows(tree).map(row => row.thread.id)).toContain("B-first"); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    phase = 2; press(byId(failure, "sessions-retry-load"));
    const refreshing = render(Sessions);
    expect(sessionRows(refreshing).map(row => row.thread.id)).toContain("A-more");
    expect(leaf(refreshing, "RefreshControl")!.props.refreshing).toBe(true);
    refreshA.resolve(page([thread("new-A")]));
    await until(Sessions, tree => { expect(sessionRows(tree).map(row => row.thread.id)).toContain("new-A"); expect(byId(tree, "sessions-incomplete-notice")).toBeUndefined(); });
  });

  it("does not borrow undefined-path catalog options for an explicit empty-path owner after discovery fails", async () => {
    const implicit = { ...a, workspacePath: undefined };
    app(profile, [implicit]);
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/private-A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : page([thread("old-private", "/private-A")]);
    render(Sessions);
    await until(Sessions, tree => { expect(sessionRows(tree).map(row => row.thread.id)).toContain("old-private"); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    const callStart = calls.length;
    clearWorkspaceOptionsCache();
    read = async call => {
      if (call.method === "runtime.workspaces.list") throw new Error("new-catalog-unavailable");
      if (call.method === "runtime.worktrees.list") return { items: [] };
      return page([]);
    };
    app(profile, [{ ...a, workspacePath: "" }]);
    expect(sessionRows(render(Sessions, false))).toEqual([]);
    render(Sessions);
    await until(Sessions, tree => { expect(list(tree)).toBeDefined(); expect(byId(tree, "sessions-reload")).toBeUndefined(); expect(text(tree)).not.toContain("new-catalog-unavailable"); expect(sessionRows(tree)).toEqual([]); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(calls.slice(callStart).filter(call => call.method === "thread/list").map(call => call.cwd)).toEqual([""]);
  });

  it("filters old errors and rows before new owner effects and ignores late A responses", async () => {
    app(profile, [a]); const later = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : call.params.cursor ? later.promise : page([thread("old-A")], "second", 1);
    render(Sessions);
    const incompleteNotice = t("sessions.partial_list_notice", { p0: 1 });
    const tree = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(1); expect(text(tree)).toContain(incompleteNotice); expect(byId(tree, "sessions-incomplete-notice")).toBeDefined(); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    (list(tree)!.props.onEndReached as () => void)();
    await vi.waitFor(() => expect(calls.some(call => call.params.cursor)).toBe(true));
    const oldClient = calls.find(call => call.params.cursor)!.client;
    app({ ...profile, deviceId: "device-B" }, [a]);
    const firstRender = render(Sessions, false);
    expect(sessionRows(firstRender)).toEqual([]); expect(text(firstRender)).not.toContain(incompleteNotice);
    expect(byId(firstRender, "sessions-incomplete-notice")).toBeUndefined();
    const callCount = calls.length;
    press(byId(tree, "sessions-retry-load"));
    expect(calls).toHaveLength(callCount);
    // The first-render security assertion above precedes passive cleanup. Now
    // flush real effect cleanup before requiring the old source to be closed.
    render(Sessions);
    later.resolve(page([thread("late-A")], undefined, 1));
    await vi.waitFor(() => expect(oldClient.closeCount).toBeGreaterThan(0));
    expect(sessionRows(render(Sessions, false))).toEqual([]);
  });

  it("confirmed-absence route opens the exact active server/workspace list with a local notice", async () => {
    app(profile, [a, b]);
    fixture.params = { profileId: profile.id, serverId: "A", cwd: "/A", notice: "confirmed-thread-absent" };
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A", "/AB"])
      : call.method === "runtime.worktrees.list" ? { items: [] }
      : page([thread(`route-${call.cwd}`, call.cwd)]);
    const tree = await until(Sessions, current => {
      expect(byId(current, "sessions-confirmed-absence-notice")).toBeDefined();
      expect(sessionRows(current)).toHaveLength(1);
    });
    expect(text(tree)).toContain(t("task.confirmed_absent_body"));
    expect(sessionRows(tree).map(row => [row.thread.cwd, row.workspacePath])).toEqual([["/A", "/A"]]);
    expect(calls.filter(call => call.method === "thread/list").map(call => [call.server.id, call.cwd])).toEqual([ ["A", "/A"], ["A", "/AB"] ]);
  });
});
