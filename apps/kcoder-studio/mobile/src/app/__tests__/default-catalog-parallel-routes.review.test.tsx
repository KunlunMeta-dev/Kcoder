// Effect/callback contract simulation using actual Home/Sessions components,
// workspace cache/loader, dependency scheduler, pager and projection. This host
// is not React DOM, a real Browser, a WebLocks proof, or a phone navigation test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import { type GatewayRpcClient, type JsonRecord } from "@/gateway/rpc";
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
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { installGatewayAuthorizationResolver } from "@/gateway/http";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { listWorkspaceOptions, clearWorkspaceOptionsCache } from "@/runtime/task-runtime/workspaces";
import { ScopedReadCache } from "@/runtime/scoped-read-cache";
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
let peakClients = 0;
let uninstallAuthorization: (() => void) | undefined;
const originalSocket = globalThis.WebSocket;
class RouteClient {
  static readonly OPEN = 1;
  closeCount = 0;
  throwOnClose = false;
  readyState = 0;
  sent: Array<{ id?: number; method?: string; params?: JsonRecord }> = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly owner: GatewayProfile;
  readonly server: KCoderServer;
  readonly cwd?: string;
  constructor(readonly url: string) {
    const parsed = new URL(url);
    this.owner = { ...(fixture.app.activeProfile as GatewayProfile) };
    const server = (fixture.app.runtime as { servers: KCoderServer[] }).servers.find(item => item.id === parsed.searchParams.get("server"));
    if (!server) throw new Error("unexpected target");
    this.server = { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) };
    this.cwd = parsed.searchParams.get("workspace") ?? undefined;
    clients.push(this); peakClients = Math.max(peakClients, clients.filter(client => client.readyState !== 3).length);
    queueMicrotask(() => { if (this.readyState === 3) return; this.readyState = 1; this.onopen?.(); });
  }
  send(raw: string): void {
    const frame = JSON.parse(raw) as { id?: number; method?: string; params?: JsonRecord };
    this.sent.push(frame);
    if (frame.method === "initialized") return;
    if (frame.method === "initialize") {
      queueMicrotask(() => this.reply(frame, { protocolVersion: "2026-07-27", capabilities: { experimental: { threadListCompleteness: true } } })); return;
    }
    const call: Call = { method: frame.method!, params: frame.params ?? {}, server: this.server, cwd: this.cwd,
      generation: this.owner.authorizationGeneration, client: this };
    calls.push(call);
    void read(call).then(result => this.reply(frame, result), error => {
      if (this.readyState !== 1) return;
      this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }) });
    });
  }
  reply(frame: { id?: number }, result: unknown): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) });
  }
  close(): void {
    this.closeCount += 1; this.readyState = 3; this.onclose?.();
    if (this.throwOnClose) throw new Error("controlled source close error");
  }
}
function initializeCount(socket: RouteClient) { return socket.sent.filter(frame => frame.method === "initialize").length; }
function cleanupHost() { for (const effect of fixture.effects) effect?.cleanup?.(); }

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
  fixture.values.clear(); calls = []; clients = []; peakClients = 0;
  taskRuntimeTestHelpers.resetConnector(); clearWorkspaceOptionsCache(); app();
  uninstallAuthorization = installGatewayAuthorizationResolver(async () => {});
  read = async call => call.method === "runtime.workspaces.list" ? registered([call.cwd ?? "/"]) : call.method === "runtime.worktrees.list" ? { items: [] } : page([]);
  globalThis.WebSocket = RouteClient as unknown as typeof WebSocket;
});
afterEach(() => {
  for (const effect of fixture.effects) effect?.cleanup?.();
  for (const client of clients) if (client.readyState !== 3) client.close();
  globalThis.WebSocket = originalSocket;
  uninstallAuthorization?.(); taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks();
});


// Actual GatewayRpcClient connect/initialize/request/close with a controlled
// WebSocket; actual Sessions/scheduler/cache/pager. Hook-host simulation only.
describe("cold default page is independent of directory discovery", () => {
  it.each([{ route: Home, cancel: false }, { route: Sessions, cancel: false }, { route: Home, cancel: true }, { route: Sessions, cancel: true }])("foreign cold loader never lends its source, and route cancel=$cancel preserves it", async ({ route, cancel }) => {
    app(profile, [a]); const catalog = deferred<unknown>();
    read = async call => call.method === "runtime.workspaces.list" ? catalog.promise : call.method === "runtime.worktrees.list" ? { items: [] } : page([thread("foreign-row")]);
    const foreign = listWorkspaceOptions(profile, a);
    await vi.waitFor(() => expect(calls.filter(call => call.method === "runtime.workspaces.list")).toHaveLength(1));
    const foreignSource = clients[0]!; const cacheGet = vi.spyOn(ScopedReadCache.prototype, "get");
    render(route); await vi.waitFor(() => expect(cacheGet).toHaveBeenCalledOnce());
    if (cancel) cleanupHost();
    expect(foreignSource.closeCount).toBe(0); expect(calls.filter(call => call.method === "thread/list")).toHaveLength(0);
    catalog.resolve(registered(["/A"])); await foreign;
    if (cancel) {
      await vi.waitFor(() => expect(foreignSource.closeCount).toBe(1));
      expect(calls.filter(call => call.method === "thread/list")).toHaveLength(0); expect(clients).toHaveLength(1);
    } else {
      await until(route, tree => route === Home ? expect(byId(tree, "thread-foreign-row")).toBeDefined() : expect(sessionRows(tree)).toHaveLength(1));
      expect(clients).toHaveLength(2); expect(calls.filter(call => call.method === "thread/list")).toHaveLength(1);
      expect(calls.find(call => call.method === "thread/list")!.client).not.toBe(foreignSource);
    }
  });
  it("an idle A cursor consumes no discovery slot: E starts before A loadMore, then A reuses its socket", async () => {
    app(profile, [a, b, target("C"), target("D"), target("E")]); const later = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? registered([call.cwd!]) : call.method === "runtime.worktrees.list" ? { items: [] } :
      call.params.cursor ? later.promise : page([thread(call.server.id, call.cwd)], call.server.id === "A" ? "A-next" : undefined);
    render(Sessions);
    const ready = await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(5); expect(byId(tree, "sessions-page-loading")).toBeUndefined(); });
    const source = clients.find(client => client.server.id === "A")!;
    expect(calls.filter(call => call.params.cursor)).toHaveLength(0); expect(source.closeCount).toBe(0);
    expect(clients.filter(client => client.server.id === "E")).toHaveLength(1);
    (list(ready)!.props.onEndReached as () => void)();
    await vi.waitFor(() => expect(calls.filter(call => call.params.cursor)).toHaveLength(1));
    expect(calls.find(call => call.params.cursor)!.client).toBe(source);
    later.resolve(page([thread("A-old", "/A", 1)]));
    await until(Sessions, tree => expect(sessionRows(tree)).toHaveLength(6)); expect(source.closeCount).toBe(1);
  });

  it("four cold targets retain the existing four-client limit during parallel page/catalog work", async () => {
    const targets = [a, b, target("C"), target("D"), target("E")]; app(profile, targets);
    const held = deferred<void>();
    read = async call => call.method === "runtime.workspaces.list" ? held.promise.then(() => registered([call.cwd!])) :
      call.method === "runtime.worktrees.list" ? held.promise.then(() => ({ items: [] })) : page([thread(call.server.id, call.cwd)]);
    render(Home);
    await until(Home, tree => { expect(clients).toHaveLength(4); expect(byId(tree, "thread-A")).toBeDefined(); expect(byId(tree, "thread-D")).toBeDefined(); });
    expect(peakClients).toBe(4); expect(calls.filter(call => call.method === "thread/list")).toHaveLength(4);
    held.resolve();
    await until(Home, tree => expect(byId(tree, "thread-E")).toBeDefined());
    await vi.waitFor(() => expect(clients.every(client => client.closeCount === 1)).toBe(true));
    expect(peakClients).toBeLessThanOrEqual(4);
  });
  it.each([{ name: "Home", route: Home }, { name: "Sessions", route: Sessions }])("$name publishes/clicks the first page before catalog or page two resolves", async ({ route }) => {
    app(profile, [a]); const catalog = deferred<unknown>(); const second = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? catalog.promise :
      call.method === "runtime.worktrees.list" ? catalog.promise : call.params.cursor ? second.promise : page([thread("early")], "next");
    render(route);
    const tree = await until(route, value => route === Home ? expect(byId(value, "thread-early")).toBeDefined() : expect(sessionRows(value).map(row => row.thread.id)).toEqual(["early"]));
    expect(clients).toHaveLength(1); expect(initializeCount(clients[0]!)).toBe(1);
    expect(calls.filter(call => call.method.startsWith("runtime."))).toHaveLength(2);
    if (route === Home) press(byId(tree, "thread-early")); else pressSession(tree, "early");
    expect(fixture.pushes).toEqual([expect.objectContaining({ params: expect.objectContaining({ threadId: "early", cwd: "/A" }) })]);
    if (route === Home) await vi.waitFor(() => expect(calls.filter(call => call.method === "thread/list")).toHaveLength(2));
    else {
      (list(tree)!.props.onEndReached as () => void)();
      expect(calls.filter(call => call.method === "thread/list")).toHaveLength(1);
    }
    expect(clients[0]!.closeCount).toBe(0);
    catalog.resolve(registered(["/A"]));
    if (route === Sessions) {
      const discovered = await until(route, value => expect(byId(value, "sessions-page-loading")).toBeUndefined());
      (list(discovered)!.props.onEndReached as () => void)();
      await vi.waitFor(() => expect(calls.filter(call => call.method === "thread/list")).toHaveLength(2));
    }
    expect(calls.filter(call => call.method === "thread/list" && !call.params.cursor)).toHaveLength(1);
    second.resolve(page([thread("second", "/A", 1)]));
    await until(route, value => route === Home ? expect(byId(value, "thread-second")).toBeDefined() : expect(sessionRows(value)).toHaveLength(2));
    await vi.waitFor(() => expect(clients[0]!.closeCount).toBe(1));
  });
  it.each([{ route: Home }, { route: Sessions }])("catalog failure preserves a successful default page", async ({ route }) => {
    app(profile, [a]); const catalog = deferred<unknown>();
    read = async call => call.method.startsWith("runtime.") ? catalog.promise : page([thread("kept")]);
    render(route);
    await until(route, tree => route === Home ? expect(byId(tree, "thread-kept")).toBeDefined() : expect(sessionRows(tree)).toHaveLength(1));
    expect(clients[0]!.closeCount).toBe(0);
    catalog.reject(new Error("controlled catalog failure"));
    await until(route, tree => { expect(text(tree)).toContain("controlled catalog failure"); if (route === Home) expect(byId(tree, "thread-kept")).toBeDefined(); else expect(sessionRows(tree)[0]?.thread.id).toBe("kept"); });
    expect(clients).toHaveLength(1); expect(clients[0]!.closeCount).toBe(1);
  });
  it("default failure does not suppress extra workspace discovery or its row", async () => {
    app(profile, [a]); const catalog = deferred<unknown>();
    read = async call => call.method === "runtime.workspaces.list" ? catalog.promise : call.method === "runtime.worktrees.list" ? { items: [] } :
      call.cwd === "/A" ? Promise.reject(new Error("default refused")) : page([thread("extra", "/extra")]);
    render(Sessions); await vi.waitFor(() => expect(calls.some(call => call.method === "thread/list")).toBe(true));
    catalog.resolve(registered(["/A", "/extra"]));
    await until(Sessions, tree => { expect(sessionRows(tree).map(row => row.thread.id)).toEqual(["extra"]); expect(text(tree)).toContain("default refused"); });
    expect(clients).toHaveLength(2); expect(calls.filter(call => call.method === "thread/list" && call.cwd === "/A")).toHaveLength(1);
  });
  it("page cancellation leaves the still-authorized foreign catalog waiter alive", async () => {
    app(profile, [a]); const catalog = deferred<unknown>(); const first = deferred<ThreadListPage>();
    read = async call => call.method === "runtime.workspaces.list" ? catalog.promise : call.method === "runtime.worktrees.list" ? { items: [] } : first.promise;
    render(Sessions); await vi.waitFor(() => expect(calls.some(call => call.method === "thread/list")).toBe(true));
    const cacheGet = vi.spyOn(ScopedReadCache.prototype, "get");
    const foreign = listWorkspaceOptions(profile, a);
    await vi.waitFor(() => expect(cacheGet).toHaveBeenCalledOnce());
    cleanupHost(); expect(clients[0]!.closeCount).toBe(0);
    catalog.resolve(registered(["/A"])); await expect(foreign).resolves.toEqual([expect.objectContaining({ path: "/A" })]);
    first.resolve(page([thread("late")]));
    await vi.waitFor(() => expect(clients[0]!.closeCount).toBe(1));
    expect(sessionRows(render(Sessions, false))).toHaveLength(0); expect(clients).toHaveLength(1);
  });
  it.each([{ changed: { id: "profile-B", baseUrl: "https://B.invalid" } }, { changed: { deviceId: "B-device" } }, { changed: { authorizationGeneration: "auth-B" } }])("changed authority cannot publish old held page: $changed", async ({ changed }) => {
    app(profile, [a]); const catalog = deferred<unknown>(); const first = deferred<ThreadListPage>();
    read = async call => call.generation === "auth-A" && call.client.owner.deviceId === "device-A" && call.client.owner.id === profile.id
      ? call.method.startsWith("runtime.") ? catalog.promise : first.promise
      : call.method.startsWith("runtime.") ? { items: [] } : page([]);
    render(Sessions); await vi.waitFor(() => expect(calls.some(call => call.method === "thread/list")).toBe(true));
    app({ ...profile, ...changed }, [a]); render(Sessions);
    catalog.resolve(registered(["/A"])); first.resolve(page([thread("old-owner")]));
    await until(Sessions, tree => { expect(sessionRows(tree)).toHaveLength(0); expect(clients.length).toBe(2); });
    expect(calls.filter(call => call.client === clients[0] && call.method === "thread/list")).toHaveLength(1);
  });
});
