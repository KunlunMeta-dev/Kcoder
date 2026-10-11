// Actual hook and pager with a deterministic hook host; not browser/native UI.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { GatewayConnectionBudget } from "../../../../shared/gatewayConnectionBudget";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { FakeClient, profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { useTaskScreen } from "./useTaskScreen";

const host = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0,
  effects: [] as Array<{ effect: () => void | (() => void); deps: unknown[] }>,
  app: {} as Record<string, unknown>,
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => host.effects.push({ effect, deps }),
  useRef: (value: unknown) => { const i = host.refIndex++; return host.refs[i] ??= { current: value }; },
  useState: (value: unknown) => {
    const i = host.stateIndex++;
    if (!(i in host.states)) host.states[i] = typeof value === "function" ? (value as () => unknown)() : value;
    return [host.states[i], (update: unknown) => { host.states[i] = typeof update === "function" ? (update as (old: unknown) => unknown)(host.states[i]) : update; }];
  },
}));
vi.mock("react-native", () => ({ Alert: {}, Keyboard: { dismiss() {} }, Platform: { OS: "web" } }));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({ profileId: "profile", serverId: "server", threadId: "thread", cwd: "/fixture" }), useRouter: () => ({}) }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("@/state/AppContext", () => ({ useApp: () => host.app }));
vi.mock("@/storage/workspace-preferences", () => ({ workspaceStateAuthorizationScope: () => "scope", loadWorkspaceState: async () => ({}), saveWorkspaceState: async () => {} }));
vi.mock("@/runtime/task-runtime", async () => ({
  ThreadListPager: (await import("@/runtime/task-runtime/threadDirectory")).ThreadListPager,
  TaskRuntime: {}, taskRuntimeRegistry: { get: () => null, remove() {} },
  listWorkspaceThreadScopes: vi.fn(), mapThreadListScopes: vi.fn(), subscribeThreadMutations: () => () => {},
}));
function renderHook() {
  host.stateIndex = 0; host.refIndex = 0; host.effects = [];
  return useTaskScreen();
}
function drawerEffect(hook: ReturnType<typeof useTaskScreen>) {
  return host.effects.find(entry => entry.deps.includes(hook.loadDrawerServer))!.effect;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  host.states = []; host.refs = [];
  host.app = { hydrated: true, activeProfile: { ...profile, id: "profile" }, profiles: [{ id: "profile" }], runtime: { servers: [{ ...server, id: "server" }] }, demo: false };
});
afterEach(() => taskRuntimeTestHelpers.resetConnector());

it("dismiss hook cancels a real pager queued in admission and blocks restart until new open", async () => {
  const budget = new GatewayConnectionBudget(1); const gate = deferred();
  const occupied = budget.run(() => gate.promise); const wire = vi.fn(async () => new FakeClient([]) as never);
  taskRuntimeTestHelpers.setConnector((p, s, cwd, channel, options) => budget.run(wire, options?.signal, options?.priority));
  let hook = renderHook(); hook.openDrawer(); hook = renderHook();
  const cleanup = drawerEffect(hook)();
  expect(hook.drawerOpen).toBe(true);
  hook.dismissDrawerWork();
  hook.openDrawer(); // An already-visible drawer is still closing, not a new open.
  await hook.loadDrawerServer("server"); await hook.loadDrawerProjects("server");
  // Dependency-driven effect rerender while animation keeps drawerOpen=true.
  hook = renderHook(); expect(drawerEffect(hook)()).toBeUndefined();
  gate.resolve(); await occupied; await Promise.resolve();
  expect(wire).not.toHaveBeenCalled();
  hook.setDrawerOpen(false); hook = renderHook(); hook.openDrawer(); hook = renderHook();
  drawerEffect(hook)();
  if (typeof cleanup === "function") cleanup(); // Old-generation cleanup after new open.
  await hook.loadDrawerServer("server");
  expect(wire).toHaveBeenCalledTimes(1);
  hook.dismissDrawerWork();
});

it("late old page and cleanup preserve a new session's loading and projection", async () => {
  let finishOld!: (value: unknown) => void; let finishNew!: (value: unknown) => void;
  const oldResult = new Promise(resolve => { finishOld = resolve; });
  const newResult = new Promise(resolve => { finishNew = resolve; });
  const oldClient = new FakeClient([]); const newClient = new FakeClient([]);
  oldClient.request = vi.fn(() => oldResult) as never;
  newClient.request = vi.fn(() => newResult) as never;
  let connects = 0;
  taskRuntimeTestHelpers.setConnector(async () => (++connects === 1 ? oldClient : newClient) as never);
  let hook = renderHook(); hook.openDrawer(); hook = renderHook();
  const oldCleanup = drawerEffect(hook)();
  const oldJob = hook.loadDrawerServer("server");
  await vi.waitFor(() => expect(oldClient.request).toHaveBeenCalledOnce());
  hook.dismissDrawerWork(); hook.setDrawerOpen(false); hook = renderHook();
  hook.openDrawer(); hook = renderHook(); drawerEffect(hook)();
  const newJob = hook.loadDrawerServer("server");
  await vi.waitFor(() => expect(newClient.request).toHaveBeenCalledOnce());
  if (typeof oldCleanup === "function") oldCleanup();
  expect(newClient.closed).toBe(false);
  finishOld({ threads: [{ id: "stale", updatedAt: 1 }] }); await oldJob;
  hook = renderHook();
  expect(hook.drawerLoading.server).toBe(true);
  expect(hook.drawerThreads.server).toBeUndefined();
  finishNew({ threads: [{ id: "current", updatedAt: 2 }] }); await newJob;
  hook = renderHook();
  expect(hook.drawerLoading.server).toBe(false);
  expect(hook.drawerThreads.server.map(thread => thread.id)).toEqual(["current"]);
  hook.dismissDrawerWork();
});
