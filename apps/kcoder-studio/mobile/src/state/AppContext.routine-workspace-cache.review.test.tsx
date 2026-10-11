// Actual AppProvider + ProfileCoordinator callbacks/effects in a deterministic
// hook host. NOT mounted React/DOM, Browser, real Web Locks or network evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type { MobileSessionBootstrap } from "@/gateway/http";
import type { ProfileSnapshot } from "./profile-coordinator";

type Effect = { callback: () => void | (() => void); deps: readonly unknown[]; pending: boolean; cleanup?: () => void };
const host = vi.hoisted(() => ({
  states: [] as unknown[], setters: [] as ((value: unknown) => void)[], refs: [] as { current: unknown }[],
  memos: [] as { deps: readonly unknown[]; value: unknown }[], effects: [] as Effect[],
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
}));
const api = vi.hoisted(() => ({
  stored: { profiles: [], activeId: null } as ProfileSnapshot,
  exchange: vi.fn<(baseUrl: string, token: string, label?: string, signal?: AbortSignal) => Promise<MobileSessionBootstrap>>(),
  load: vi.fn<() => Promise<ProfileSnapshot>>(),
  persist: vi.fn<(profiles: GatewayProfile[], activeId: string | null) => Promise<void>>(),
  ensure: vi.fn<(profile: GatewayProfile) => Promise<GatewayProfile>>(),
  servers: vi.fn<(profile: GatewayProfile) => Promise<KCoderServer[]>>(),
  statuses: vi.fn(), revoke: vi.fn(), cleanup: vi.fn(),
  activeListeners: new Set<(state: string) => void>(),
  operations: [] as Promise<void>[],
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (factory: () => unknown, deps: readonly unknown[]) => {
    const i = host.memoIndex++; const previous = host.memos[i];
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); host.memos[i] = { deps, value }; return value;
  };
  return { ...actual,
    useState(initial: unknown) {
      const i = host.stateIndex++;
      if (!(i in host.states)) host.states[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      host.setters[i] ??= value => { host.states[i] = typeof value === "function" ? (value as (old: unknown) => unknown)(host.states[i]) : value; };
      return [host.states[i], host.setters[i]];
    },
    useRef(initial: unknown) { return host.refs[host.refIndex++] ??= { current: initial }; },
    useMemo: memo, useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
    useEffect(callback: Effect["callback"], deps: readonly unknown[] = []) {
      const i = host.effectIndex++; const previous = host.effects[i];
      if (!previous || !same(previous.deps, deps)) {
        previous?.cleanup?.(); host.effects[i] = { callback, deps, pending: true };
      } else previous.callback = callback;
    },
  };
});
vi.mock("react-native", () => ({ Platform: { OS: "web" }, AppState: { currentState: "active", addEventListener: (_name: string, listener: (state: string) => void) => { api.activeListeners.add(listener); return { remove() { api.activeListeners.delete(listener); } }; } } }));
vi.mock("@/storage/profile-store", () => ({ PROFILE_INDEX_KEY: "review-profile-index", loadProfiles: api.load,
  persistProfiles: api.persist, migrateLegacyWebProfiles: vi.fn(async () => null) }));
vi.mock("@/storage/context-lock", () => ({ canCoordinateDeviceAuthorization: () => true,
  withLocalIdentityLock: async (_key: string, operation: () => Promise<unknown>) => operation() }));
vi.mock("@/gateway/http", () => ({ GatewaySessionExpiredError: class extends Error {},
  exchangeMobileSessionWithBootstrap: api.exchange, ensureGatewayAuthorization: api.ensure,
  installGatewayAuthorizationResolver: () => () => {}, listServers: api.servers,
  listServerStatuses: api.statuses, revokeMobileSession: api.revoke }));
vi.mock("@/runtime/task-runtime", () => ({ taskRuntimeRegistry: { removeProfile: vi.fn() } }));
vi.mock("@/runtime/task-runtime/modelCatalog", () => ({ clearModelCache: vi.fn() }));
vi.mock("@/runtime/task-runtime/workspaces", () => ({ clearWorkspaceOptionsCache: vi.fn() }));
vi.mock("@/storage/workspace-preferences", () => ({ workspaceStateAuthorizationScope: vi.fn(),
  markWorkspaceStateRemoval: () => 1, removeWorkspaceStatesForProfile: api.cleanup }));
vi.mock("@/storage/pending-workspace-operation-v2", () => ({ assertWorkspaceOperationsResolvedV2: vi.fn(async () => {}) }));
vi.mock("@/storage/thread-deletion-cleanup", () => ({ installThreadDeletionCleanupAuthorityResolver: () => () => {},
  retryThreadDeletionCleanup: vi.fn(async () => {}) }));
vi.mock("./device-authorization", () => ({ deviceRefreshLead: () => 0, DeviceAuthorizationManager: class {
  authorize(profile: GatewayProfile) { return api.ensure(profile); }
  nextAttemptAt() { return Number.MAX_SAFE_INTEGER; }
} }));
import { AppProvider } from "./AppContext";
import { ProfileOperationGate } from "./profile-coordinator";
const actualGateRun = ProfileOperationGate.prototype.run;
import { clearWorkspaceOptionsCache } from "@/runtime/task-runtime/workspaces";
type Value = ReturnType<typeof import("./AppContext").useApp>;
function render(): Value {
  host.stateIndex = host.refIndex = host.memoIndex = host.effectIndex = 0;
  const value = (AppProvider({ children: null }) as ReactElement<{ value: Value }>).props.value;
  // Commit each changed actual effect once, in declaration order; setters take
  // effect on the next explicit render (no reimplementation of AppProvider).
  for (const effect of host.effects) if (effect.pending) {
    effect.pending = false; const cleanup = effect.callback();
    effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
  }
  return value;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function profile(id: string, baseUrl = "https://review.invalid/g/one"): GatewayProfile {
  return { id, label: id, baseUrl, accessToken: `synthetic-${id}`, rpcToken: "synthetic", expiresAt: Number.MAX_SAFE_INTEGER,
    authMode: "legacy", authorizationGeneration: `generation-${id}` };
}
function server(id: string): KCoderServer { return { id, label: id, description: id, runtime: "kcoder", transport: "local" }; }
async function startup() { render(); await vi.waitFor(() => expect(render().hydrated).toBe(true)); }
async function ready() {
  await vi.waitFor(() => expect(render().runtime.serversReady).toBe(true));
  // serversReady precedes the other branch and gate cleanup. Await the actual
  // gate promises; do not assume a state publication means refresh has settled.
  await Promise.all(api.operations);
  render();
}
beforeEach(() => {
  host.states = []; host.setters = []; host.refs = []; host.memos = []; host.effects = [];
  api.stored = { profiles: [], activeId: null }; vi.clearAllMocks(); api.operations = [];
  vi.spyOn(ProfileOperationGate.prototype, "run").mockImplementation(function (this: ProfileOperationGate, id, operation) {
    const pending = actualGateRun.call(this, id, operation); api.operations.push(pending); return pending;
  });
  api.load.mockImplementation(async () => ({ profiles: [...api.stored.profiles], activeId: api.stored.activeId }));
  api.persist.mockImplementation(async (profiles, activeId) => { api.stored = { profiles: [...profiles], activeId }; });
  api.ensure.mockImplementation(async p => p); api.servers.mockResolvedValue([server("get")]); api.statuses.mockResolvedValue([]);
  api.cleanup.mockResolvedValue(undefined); api.revoke.mockResolvedValue(undefined);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("navigator", {}); vi.stubGlobal("location", { search: "" });
});
afterEach(() => { for (const effect of host.effects) effect.cleanup?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("activation and routine AppState refresh preserve workspace TTL; explicit refresh forces only the active profile", async () => {
  api.stored = { profiles: [profile("active")], activeId: "active" };
  await startup(); await ready();
  expect(clearWorkspaceOptionsCache).not.toHaveBeenCalled();
  expect(api.servers).toHaveBeenCalledTimes(1);
  for (const listener of api.activeListeners) listener("active");
  await vi.waitFor(() => expect(api.statuses).toHaveBeenCalledTimes(2));
  expect(clearWorkspaceOptionsCache).not.toHaveBeenCalled();
  await Promise.all(api.operations);
  await render().refresh();
  expect(clearWorkspaceOptionsCache).toHaveBeenCalledTimes(1); expect(clearWorkspaceOptionsCache).toHaveBeenCalledWith("active");
  expect(api.servers).toHaveBeenCalledTimes(3);
});
it("manual refresh still invalidates during a joined routine refresh", async () => {
  api.stored = { profiles: [profile("active")], activeId: "active" };
  await startup(); await ready();
  const held = deferred<GatewayProfile>(); api.ensure.mockReturnValueOnce(held.promise);
  for (const listener of api.activeListeners) listener("active");
  await vi.waitFor(() => expect(api.ensure).toHaveBeenCalledTimes(2));
  const manual = render().refresh();
  expect(clearWorkspaceOptionsCache).toHaveBeenCalledTimes(1); expect(clearWorkspaceOptionsCache).toHaveBeenCalledWith("active");
  held.resolve(profile("active")); await manual;
  expect(api.servers).toHaveBeenCalledTimes(2);
});
