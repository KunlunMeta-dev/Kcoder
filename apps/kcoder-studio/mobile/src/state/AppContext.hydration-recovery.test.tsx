// Actual AppProvider entry points/coordinator and selected effects in a deterministic
// hook host. This is storage/API scheduling coverage, not mounted React or Browser.
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { GatewayProfile } from "@/gateway/types";
import type { ProfileSnapshot } from "./profile-coordinator";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";

const host = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[],
  memos: [] as { deps: readonly unknown[]; value: unknown }[],
  effects: [] as { callback: () => void | (() => void); deps: readonly unknown[] }[],
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
}));
const api = vi.hoisted(() => ({
  stored: { profiles: [], activeId: null } as ProfileSnapshot,
  load: vi.fn<() => Promise<ProfileSnapshot>>(),
  migrate: vi.fn<() => Promise<ProfileSnapshot | null>>(),
  exchange: vi.fn<() => Promise<GatewayProfile>>(),
  persist: vi.fn<(profiles: GatewayProfile[], activeId: string | null) => Promise<void>>(),
  listServers: vi.fn(), revoke: vi.fn(), cleanup: vi.fn(),
  platform: "web", storageListener: undefined as ((event: { key: string | null }) => void) | undefined,
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  const memo = (factory: () => unknown, deps: readonly unknown[]) => {
    const i = host.memoIndex++; const old = host.memos[i];
    if (old && old.deps.length === deps.length && deps.every((value, j) => Object.is(value, old.deps[j]))) return old.value;
    const value = factory(); host.memos[i] = { deps, value }; return value;
  };
  return { ...actual,
    useState(initial: unknown) {
      const i = host.stateIndex++;
      if (!(i in host.states)) host.states[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [host.states[i], (value: unknown) => { host.states[i] = typeof value === "function" ? (value as (old: unknown) => unknown)(host.states[i]) : value; }];
    },
    useRef(initial: unknown) { return host.refs[host.refIndex++] ??= { current: initial }; },
    useMemo: memo, useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
    useEffect(callback: () => void | (() => void), deps: readonly unknown[] = []) { host.effects[host.effectIndex++] = { callback, deps }; },
  };
});
vi.mock("react-native", () => ({ AppState: { currentState: "active" }, Platform: { get OS() { return api.platform; } } }));
vi.mock("@/storage/profile-store", () => ({
  PROFILE_INDEX_KEY: "review-profile-index", loadProfiles: api.load, migrateLegacyWebProfiles: api.migrate,
  persistProfiles: api.persist,
}));
vi.mock("@/gateway/http", () => ({
  GatewaySessionExpiredError: class extends Error {}, exchangeMobileSessionWithBootstrap: async (...args: Parameters<typeof api.exchange>) => ({ profile: await api.exchange(...args) }),
  revokeMobileSession: api.revoke, listServers: api.listServers, listServerStatuses: vi.fn(),
  ensureGatewayAuthorization: vi.fn(async (profile: GatewayProfile) => profile), installGatewayAuthorizationResolver: vi.fn(),
}));
vi.mock("@/runtime/task-runtime", () => ({ taskRuntimeRegistry: { removeProfile: vi.fn() } }));
vi.mock("@/runtime/task-runtime/modelCatalog", () => ({ clearModelCache: vi.fn() }));
vi.mock("@/runtime/task-runtime/workspaces", () => ({ clearWorkspaceOptionsCache: vi.fn() }));
vi.mock("@/storage/workspace-preferences", () => ({ workspaceStateAuthorizationScope: vi.fn(), markWorkspaceStateRemoval: vi.fn(() => 1), removeWorkspaceStatesForProfile: api.cleanup }));
vi.mock("@/storage/thread-deletion-cleanup", () => ({ installThreadDeletionCleanupAuthorityResolver: vi.fn(), retryThreadDeletionCleanup: vi.fn() }));
vi.mock("./device-authorization", () => ({ DeviceAuthorizationManager: class {} }));
import { AppProvider } from "./AppContext";
import { ProfileCoordinator } from "./profile-coordinator";

type Value = ReturnType<typeof import("./AppContext").useApp>;
function render(): Value {
  host.stateIndex = host.refIndex = host.memoIndex = host.effectIndex = 0;
  return (AppProvider({ children: null }) as ReactElement<{ value: Value }>).props.value;
}
function startHydration() {
  const value = render();
  const effect = (typeof value.retryStoredProfiles === "function" ? host.effects.find(effect => effect.deps.includes(value.retryStoredProfiles)) : undefined)
    ?? host.effects.find(effect => effect.callback.toString().includes("isWebDemo"));
  expect(effect).toBeDefined();
  const previousLoads = api.load.mock.calls.length;
  const cleanup = effect!.callback();
  expect(api.load).toHaveBeenCalledTimes(previousLoads + 1);
  return { value, cleanup };
}
function profile(id: string): GatewayProfile {
  return { id, label: id, baseUrl: `https://review.invalid/${id}`, accessToken: "synthetic", rpcToken: "synthetic", expiresAt: Number.MAX_SAFE_INTEGER };
}
function snapshot(...profiles: GatewayProfile[]): ProfileSnapshot { return { profiles, activeId: profiles[0]?.id ?? null }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function settle() { await vi.waitFor(() => expect(render().profileHydrationRetrying).toBe(false)); }
function coordinator() { return host.refs.map(ref => ref.current).find(value => value instanceof ProfileCoordinator) as ProfileCoordinator; }
beforeEach(() => {
  const browserProfileFixture = installBrowserProfileFixture();
  host.states = []; host.refs = []; host.memos = []; host.effects = [];
  api.stored = snapshot(); api.platform = "web"; api.storageListener = undefined;
  vi.clearAllMocks();
  api.load.mockImplementation(async () => ({ profiles: [...api.stored.profiles], activeId: api.stored.activeId }));
  api.migrate.mockResolvedValue(null); api.cleanup.mockResolvedValue(undefined); api.revoke.mockResolvedValue(undefined);
  api.persist.mockImplementation(async (profiles, activeId) => { api.stored = { profiles: [...profiles], activeId }; });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { localStorage: browserProfileFixture.localStorage, addEventListener: (_: string, callback: typeof api.storageListener) => { api.storageListener = callback; }, removeEventListener: vi.fn() });
});

it("publishes a recoverable startup error after a local migration failure without issuing a session or deleting configuration", async () => {
  api.migrate.mockRejectedValue(new Error("safe migration unavailable"));
  startHydration();
  await vi.waitFor(() => expect(render().hydrated).toBe(true));
  expect(typeof render().profileHydrationError).toBe("string");
  expect(render().profileHydrationError).toContain("原配置已保留");
  expect(api.exchange).not.toHaveBeenCalled(); expect(api.revoke).not.toHaveBeenCalled(); expect(api.cleanup).not.toHaveBeenCalled();
  await render().retryStoredProfiles();
  expect(render().profileHydrationError).toContain("原配置已保留");
  expect(api.migrate).toHaveBeenCalledTimes(2);
  expect(api.exchange).not.toHaveBeenCalled(); expect(api.cleanup).not.toHaveBeenCalled();
});

it.each(["reject", "abort"] as const)("finishes startup with a local retry action when a held hydration is superseded by a %s connection", async mode => {
  const held = deferred<ProfileSnapshot>(); api.load.mockImplementationOnce(() => held.promise);
  const exchange = deferred<GatewayProfile>(); api.exchange.mockImplementation(() => mode === "reject" ? Promise.reject(new Error("synthetic connect failure")) : exchange.promise);
  startHydration(); const controller = new AbortController();
  const connection = render().connectGateway({ baseUrl: "https://review.invalid/new", token: "synthetic", signal: controller.signal });
  if (mode === "reject") await expect(connection).rejects.toThrow("synthetic connect failure");
  else { controller.abort(); exchange.resolve(profile("new")); await expect(connection).resolves.toBeNull(); }
  expect(render().hydrated).toBe(true); expect(render().profileHydrationRetrying).toBe(false);
  expect(render().profileHydrationError).toContain("恢复已中止");
  held.resolve(snapshot(profile("stale"))); await vi.waitFor(() => expect(render().hydrated).toBe(true));
  expect(render().profiles).toEqual([]); expect(coordinator().getSnapshot().profiles).toEqual([]);
});

it("rejects a late startup snapshot after a new connection has committed", async () => {
  const held = deferred<ProfileSnapshot>(); api.load.mockImplementationOnce(() => held.promise);
  try {
    startHydration(); api.exchange.mockResolvedValue(profile("winner"));
    await render().connectGateway({ baseUrl: "https://review.invalid/winner", token: "synthetic" });
    held.resolve(snapshot(profile("stale"))); await vi.waitFor(() => expect(render().hydrated).toBe(true));
    expect(render().activeProfile?.id).toBe("winner"); expect(coordinator().getSnapshot().activeId).toBe("winner");
  } finally { held.resolve(snapshot(profile("stale"))); }
});

it("rejects a retry started during a held connection when that connection later commits", async () => {
  const exchange = deferred<GatewayProfile>(); api.exchange.mockReturnValue(exchange.promise);
  const value = render(); const connecting = value.connectGateway({ baseUrl: "https://review.invalid/winner", token: "synthetic" });
  const read = deferred<ProfileSnapshot>(); api.load.mockImplementationOnce(() => read.promise);
  const retry = value.retryStoredProfiles(); exchange.resolve(profile("winner")); await connecting;
  read.resolve(snapshot(profile("stale"))); await expect(retry).resolves.toBeNull();
  expect(render().activeProfile?.id).toBe("winner"); expect(render().profileHydrationError).toBeNull();
});

it.each(["activate", "remove"] as const)("keeps a committed %s operation instead of applying its held retry snapshot", async action => {
  api.stored = snapshot(profile("a"), profile("b"));
  await render().retryStoredProfiles();
  const old = snapshot(profile("a"), profile("b")); const held = deferred<ProfileSnapshot>(); api.load.mockImplementationOnce(() => held.promise);
  const retry = render().retryStoredProfiles();
  if (action === "activate") await render().setActiveProfile("b"); else await render().removeGateway("a");
  held.resolve(old); await expect(retry).resolves.toBeNull();
  expect(render().activeProfile?.id).toBe("b"); expect(coordinator().getSnapshot().activeId).toBe("b");
  if (action === "remove") expect(render().profiles.map(p => p.id)).toEqual(["b"]);
});

it.each(["activate", "remove"] as const)("fences a retry that starts during the %s persistence window", async action => {
  api.stored = snapshot(profile("a"), profile("b")); await render().retryStoredProfiles();
  const old = { profiles: [...api.stored.profiles], activeId: api.stored.activeId };
  const commit = deferred<void>(); let persistStarted = false;
  api.persist.mockImplementationOnce(async (profiles, activeId) => {
    persistStarted = true; await commit.promise; api.stored = { profiles: [...profiles], activeId };
  });
  const mutation = action === "activate" ? render().setActiveProfile("b") : render().removeGateway("a");
  await vi.waitFor(() => expect(persistStarted).toBe(true));
  const read = deferred<ProfileSnapshot>(); api.load.mockImplementationOnce(() => read.promise);
  const retry = render().retryStoredProfiles(); commit.resolve(); await mutation;
  read.resolve(old); await expect(retry).resolves.toBeNull();
  expect(render().activeProfile?.id).toBe("b"); expect(coordinator().getSnapshot().activeId).toBe("b");
  if (action === "remove") expect(render().profiles.map(p => p.id)).toEqual(["b"]);
});

it("lets authoritative storage synchronization supersede a retry begun during its read", async () => {
  api.stored = snapshot(profile("a")); await render().retryStoredProfiles(); render();
  const storageEffect = host.effects.find(effect => effect.callback.toString().includes("window.addEventListener"));
  expect(storageEffect).toBeDefined(); const cleanup = storageEffect!.callback();
  const synchronized = deferred<ProfileSnapshot>(); let readStarted = false;
  api.load.mockImplementationOnce(() => { readStarted = true; return synchronized.promise; });
  api.storageListener!({ key: "review-profile-index" }); await vi.waitFor(() => expect(readStarted).toBe(true));
  const retryRead = deferred<ProfileSnapshot>(); api.load.mockImplementationOnce(() => retryRead.promise);
  const retry = render().retryStoredProfiles();
  synchronized.resolve(snapshot(profile("b")));
  await vi.waitFor(() => expect(render().activeProfile?.id).toBe("b"));
  retryRead.resolve(snapshot(profile("a"))); await expect(retry).resolves.toBeNull();
  expect(render().activeProfile?.id).toBe("b"); if (typeof cleanup === "function") cleanup();
});

it("keeps a completed fresh retry when an older coordinator synchronization read resolves afterwards", async () => {
  api.stored = snapshot(profile("a")); await render().retryStoredProfiles(); render();
  const effect = host.effects.find(effect => effect.callback.toString().includes("window.addEventListener"))!;
  const cleanup = effect.callback(); const oldRead = deferred<ProfileSnapshot>(); let started = false;
  const synchronizations = vi.spyOn(coordinator(), "synchronize");
  api.load.mockImplementationOnce(() => { started = true; return oldRead.promise; });
  api.storageListener!({ key: "review-profile-index" }); await vi.waitFor(() => expect(started).toBe(true));
  api.stored = snapshot(profile("b"));
  await expect(render().retryStoredProfiles()).resolves.toBe("b");
  oldRead.resolve(snapshot(profile("a")));
  await synchronizations.mock.results[0].value;
  await vi.waitFor(() => expect(render().activeProfile?.id).toBe("b"));
  expect(coordinator().getSnapshot().activeId).toBe("b");
  if (typeof cleanup === "function") cleanup();
});

it("retries only local storage and returns the restored active ID for the normal activation flow", async () => {
  api.load.mockRejectedValueOnce(new Error("synthetic read failure")); startHydration(); await settle();
  api.stored = snapshot(profile("restored"));
  await expect(render().retryStoredProfiles()).resolves.toBe("restored");
  expect(render().activeProfile?.id).toBe("restored"); expect(render().profileHydrationError).toBeNull();
  expect(api.exchange).not.toHaveBeenCalled(); expect(api.listServers).not.toHaveBeenCalled();
});

it("drops a late restoration after the actual hydration effect unmounts", async () => {
  const held = deferred<ProfileSnapshot>(); api.load.mockReturnValueOnce(held.promise);
  const { cleanup } = startHydration(); if (typeof cleanup === "function") cleanup();
  held.resolve(snapshot(profile("stale"))); await Promise.resolve(); await Promise.resolve();
  expect(render().profiles).toEqual([]); await expect(render().retryStoredProfiles()).resolves.toBeNull();
});
