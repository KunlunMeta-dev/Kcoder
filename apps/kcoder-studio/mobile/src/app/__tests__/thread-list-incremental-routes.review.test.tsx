// Effect/callback contract simulation using actual Home/Sessions components,
// workspace cache/loader, dependency scheduler, pager and projection. This host
// is not React DOM, a real Browser, a WebLocks proof, or a phone navigation test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import type { GatewayRpcClient, JsonRecord } from "@/gateway/rpc";
import type { ThreadListPage } from "@/runtime/task-runtime/threadDirectory";

const fixture = vi.hoisted(() => ({
  states: [] as unknown[], setters: [] as Array<((update: unknown) => void) | undefined>,
  refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ value: unknown; deps: unknown[] } | undefined>,
  effects: [] as Array<{ deps: unknown[]; cleanup?: () => void } | undefined>,
  pendingEffects: [] as Array<{ index: number; effect: () => void | (() => void); deps: unknown[]; changed: boolean }>,
  queuedUpdates: [] as Array<() => void>, queueUpdates: false,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  params: {} as Record<string, string>, app: {} as Record<string, unknown>,
  pushes: [] as unknown[], values: new Map<string, string>(),
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  const memo = (factory: () => unknown, deps: unknown[]) => {
    const index = fixture.memoIndex++; const previous = fixture.memos[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value;
    const value = factory(); fixture.memos[index] = { value, deps }; return value;
  };
  return { ...actual,
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
vi.mock("expo-router", () => ({ useLocalSearchParams: () => fixture.params, useRouter: () => ({ push: (value: unknown) => fixture.pushes.push(value), replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native", () => ({ Platform: { OS: "web" }, ActivityIndicator: "ActivityIndicator", FlatList: "FlatList", Pressable: "Pressable", RefreshControl: "RefreshControl", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View", StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFillObject: {} } }));
vi.mock("lucide-react-native", () => Object.fromEntries(["Archive", "ChevronDown", "ChevronLeft", "ChevronRight", "ChevronUp", "Clock3", "GitBranch", "History", "Laptop", "Menu", "MoreHorizontal", "Plus", "Search", "Server", "Settings", "SquareTerminal"].map(name => [name, name])));
vi.mock("@/components/ui", () => ({ EmptyState: "EmptyState", StatusDot: "StatusDot" }));
vi.mock("@/components/mobile-drawer", () => ({ MobileDrawer: "MobileDrawer" }));
vi.mock("@/components/history-refresh-modal", () => ({ HistoryRefreshModal: "HistoryRefreshModal" }));
vi.mock("@/components/thread-actions-sheet", () => ({ ThreadActionsSheet: "ThreadActionsSheet" }));
vi.mock("@/storage/use-collapsed-server-sections", () => ({ useCollapsedServerSections: () => ({ serverIds: new Set<string>(), hydrated: true, toggle: vi.fn() }) }));
vi.mock("@/state/AppContext", () => ({ useApp: () => fixture.app }));
vi.mock("@/state/route-profile-activation", () => ({ shouldActivateRouteProfile: () => false }));
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
}));

import Home from "../h/[profileId]/index";
import Sessions from "../sessions";
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
let uninstallAuthorization: (() => void) | undefined;
class RouteClient {
  closeCount = 0;
  constructor(readonly owner: GatewayProfile, readonly server: KCoderServer, readonly cwd?: string) { clients.push(this); }
  supportsExperimental(): boolean { return true; }
  async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    const call = { method, params, server: this.server, cwd: this.cwd, generation: this.owner.authorizationGeneration, client: this };
    calls.push(call); return await read(call) as T;
  }
  close(): void { this.closeCount += 1; }
}
function app(nextProfile = profile, servers = [a, b]): void {
  fixture.params = { profileId: nextProfile.id };
  fixture.app = { hydrated: true, activeProfile: nextProfile, profiles: [nextProfile], demo: false, refresh: vi.fn(async () => {}), setActiveProfile: vi.fn(), runtime: { servers, statuses: [], loading: false, serversReady: true, reauthorizationRequired: false } };
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
  return [element, ...[element.props.children, element.props.refreshControl, element.props.ListFooterComponent].flatMap(elements)];
}
function byId(tree: unknown, id: string): Element | undefined { return elements(tree).find(element => element.props.testID === id); }
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
  const element = (flat.props.renderItem as (arg: { item: typeof item }) => unknown)({ item });
  press(byId(element, "session-" + id));
}
async function until(route: () => unknown, check: (tree: unknown) => void): Promise<unknown> {
  let tree: unknown;
  await vi.waitFor(() => { tree = render(route); check(tree); });
  return tree;
}
function registered(paths: string[]) { return { items: paths.map(workspacePath => ({ workspacePath, label: workspacePath })) }; }
function refreshSessions(tree: unknown): void { (leaf(tree, "RefreshControl")!.props.onRefresh as () => void)(); }

beforeEach(() => {
  Object.assign(fixture, { states: [], setters: [], refs: [], memos: [], effects: [], pendingEffects: [], queuedUpdates: [], queueUpdates: false, stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0, pushes: [] });
  fixture.values.clear(); calls = []; clients = [];
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
    await until(Home, tree => { expect(byId(tree, "thread-peer")).toBeDefined(); expect(byId(tree, "thread-first")).toBeDefined(); });
    later.resolve(page([thread("last", "/A", 9)]));
    await until(Home, tree => { expect(byId(tree, "thread-last")).toBeDefined(); expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false); });
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
    const ready = await until(Home, tree => { expect(text(tree)).toContain("/secret-A"); expect(drawer(tree).threadErrors.A).toContain("不完整"); expect(leaf(tree, "RefreshControl")!.props.refreshing).toBe(false); });
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
    expect(drawer(firstRender).workspaceOptions).toEqual({});
    expect(drawer(firstRender).workspaceErrors).toEqual({});
    expect(drawer(firstRender).threadErrors).toEqual({});
    expect(byId(firstRender, "thread-old")).toBeUndefined();
    render(Home); held.resolve(registered(["/new-B"]));
  });

  it("rejects an A page's queued state updaters after a new owner render and ignores its late next page", async () => {
    app(profile, [a]); const first = deferred<ThreadListPage>(); const later = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : call.params.cursor ? later.promise : first.promise;
    render(Home);
    await vi.waitFor(() => expect(calls.some(call => call.method === "thread/list")).toBe(true));
    fixture.queueUpdates = true; first.resolve(page([thread("queued-A")], "second"));
    await vi.waitFor(() => { expect(fixture.queuedUpdates.length).toBeGreaterThan(0); expect(calls.some(call => call.params.cursor === "second")).toBe(true); });
    const oldClient = calls.find(call => call.params.cursor === "second")!.client;
    app({ ...profile, authorizationGeneration: "auth-B" }, [a]);
    render(Home, false); fixture.queueUpdates = false;
    for (const update of fixture.queuedUpdates.splice(0)) update();
    expect(byId(render(Home, false), "thread-queued-A")).toBeUndefined();
    later.resolve(page([thread("late-A")]));
    await vi.waitFor(() => expect(oldClient.closeCount).toBeGreaterThan(0));
    const tree = render(Home, false);
    expect(drawer(tree).workspaceOptions).toEqual({}); expect(byId(tree, "thread-late-A")).toBeUndefined();
  });

  it("does not resurrect a deleted first-page row when the old cursor returns after actual delete RPC ACK", async () => {
    app(profile, [a]); const later = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : call.method === "thread/delete" ? {} : call.params.cursor ? later.promise : page([thread("deleted")], "second");
    render(Home); await until(Home, tree => expect(byId(tree, "thread-deleted")).toBeDefined());
    await vi.waitFor(() => expect(calls.some(call => call.params.cursor === "second")).toBe(true));
    await deleteStoredThread(profile, a, "deleted", "/A");
    expect(calls.filter(call => call.method === "thread/delete")).toHaveLength(1);
    expect(byId(render(Home, false), "thread-deleted")).toBeUndefined();
    const oldClient = calls.find(call => call.params.cursor === "second")!.client;
    later.resolve(page([thread("deleted"), thread("late-old")]));
    await vi.waitFor(() => expect(oldClient.closeCount).toBeGreaterThan(0));
    expect(byId(render(Home, false), "thread-deleted")).toBeUndefined();
    // No new refresh is run here: a truly new stale server list is outside this contract.
  });
});

describe("Sessions actual route publication contracts", () => {
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
    phase = 1; (list(ready)!.props.onEndReached as () => void)();
    const more = await until(Sessions, tree => { expect(sessionRows(tree).map(row => row.thread.id)).toContain("A-more"); expect(byId(tree, "sessions-page-loading")).toBeDefined(); });
    (list(more)!.props.onEndReached as () => void)();
    expect(calls.filter(call => call.params.cursor && call.server.id === "B")).toHaveLength(1);
    heldB.reject(new Error("B-later-failed"));
    const failure = await until(Sessions, tree => { expect(text(tree)).toContain("B-later-failed"); expect(sessionRows(tree).map(row => row.thread.id)).toContain("B-first"); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    phase = 2; refreshSessions(failure);
    const refreshing = render(Sessions);
    expect(sessionRows(refreshing).map(row => row.thread.id)).toContain("A-more");
    expect(leaf(refreshing, "RefreshControl")!.props.refreshing).toBe(true);
    refreshA.resolve(page([thread("new-A")]));
    await until(Sessions, tree => expect(sessionRows(tree).map(row => row.thread.id)).toContain("new-A"));
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
    await until(Sessions, tree => { expect(list(tree)).toBeDefined(); expect(text(tree)).toContain("new-catalog-unavailable"); expect(sessionRows(tree)).toEqual([]); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    expect(calls.slice(callStart).filter(call => call.method === "thread/list").map(call => call.cwd)).toEqual([""]);
  });

  it("filters old errors and rows before new owner effects and ignores late A responses", async () => {
    app(profile, [a]); const later = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? registered(["/A"]) : call.method === "runtime.worktrees.list" ? { items: [] } : call.params.cursor ? later.promise : page([thread("old-A")], "second", 1);
    render(Sessions);
    const incompleteNotice = t("sessions.partial_list_notice", { p0: 1 });
    const tree = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(1); expect(text(tree)).toContain(incompleteNotice); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    (list(tree)!.props.onEndReached as () => void)();
    await vi.waitFor(() => expect(calls.some(call => call.params.cursor)).toBe(true));
    const oldClient = calls.find(call => call.params.cursor)!.client;
    app({ ...profile, deviceId: "device-B" }, [a]);
    const firstRender = render(Sessions, false);
    expect(sessionRows(firstRender)).toEqual([]); expect(text(firstRender)).not.toContain(incompleteNotice);
    // The first-render security assertion above precedes passive cleanup. Now
    // flush real effect cleanup before requiring the old source to be closed.
    render(Sessions);
    later.resolve(page([thread("late-A")], undefined, 1));
    await vi.waitFor(() => expect(oldClient.closeCount).toBeGreaterThan(0));
    expect(sessionRows(render(Sessions, false))).toEqual([]);
  });
});
