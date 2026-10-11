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
vi.mock("react-native", () => ({ Platform: { OS: "web" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
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
async function ready() { await vi.waitFor(() => expect(render().runtime.serversReady).toBe(true)); }
beforeEach(() => {
  host.states = []; host.setters = []; host.refs = []; host.memos = []; host.effects = [];
  api.stored = { profiles: [], activeId: null }; vi.clearAllMocks();
  api.load.mockImplementation(async () => ({ profiles: [...api.stored.profiles], activeId: api.stored.activeId }));
  api.persist.mockImplementation(async (profiles, activeId) => { api.stored = { profiles: [...profiles], activeId }; });
  api.ensure.mockImplementation(async p => p); api.servers.mockResolvedValue([server("get")]); api.statuses.mockResolvedValue([]);
  api.cleanup.mockResolvedValue(undefined); api.revoke.mockResolvedValue(undefined);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("navigator", {}); vi.stubGlobal("location", { search: "" });
});
afterEach(() => { for (const effect of host.effects) effect.cleanup?.(); vi.unstubAllGlobals(); });

it.each([{ inventory: [server("seed")] }, { inventory: [] as KCoderServer[] }])("activates valid inventory (including empty), skips only the first GET and still fetches status", async ({ inventory }) => {
  await startup(); api.exchange.mockResolvedValue({ profile: profile("paired"), initialServers: inventory });
  await render().connectGateway({ baseUrl: profile("paired").baseUrl, token: "synthetic" });
  await ready();
  expect(render().runtime.servers).toEqual(inventory); expect(api.servers).not.toHaveBeenCalled();
  expect(api.statuses).toHaveBeenCalledTimes(1);
  expect(api.stored.profiles[0]).not.toHaveProperty("initialServers");
  await render().refresh(); expect(api.servers).toHaveBeenCalledTimes(1); expect(api.statuses).toHaveBeenCalledTimes(2);
  expect(render().runtime.servers).toEqual([server("get")]);
});

it("uses the coordinator's committed existing ID rather than the exchanged ID for seed scope", async () => {
  api.stored = { profiles: [profile("existing")], activeId: null }; await startup();
  api.exchange.mockResolvedValue({ profile: profile("new-id"), initialServers: [server("seed")] });
  const committed = await render().connectGateway({ baseUrl: profile("new-id").baseUrl, token: "synthetic" });
  expect(committed?.id).toBe("existing"); await ready();
  expect(api.servers).not.toHaveBeenCalled(); expect(api.statuses.mock.calls[0][0].id).toBe("existing");
  expect(render().runtime.servers).toEqual([server("seed")]);
});

it("missing/rejected parser seed falls back to GET on activation", async () => {
  await startup(); api.exchange.mockResolvedValue({ profile: profile("paired") });
  await render().connectGateway({ baseUrl: profile("paired").baseUrl, token: "synthetic" });
  await ready(); expect(api.servers).toHaveBeenCalledTimes(1); expect(api.statuses).toHaveBeenCalledTimes(1);
});

it("manual refresh overlapping held activation authorization joins its gate; a later manual call performs GET", async () => {
  await startup(); const held = deferred<GatewayProfile>(); api.ensure.mockReturnValueOnce(held.promise);
  api.exchange.mockResolvedValue({ profile: profile("paired"), initialServers: [server("seed")] });
  await render().connectGateway({ baseUrl: profile("paired").baseUrl, token: "synthetic" }); render();
  expect(api.ensure).toHaveBeenCalledTimes(1); const joined = render().refresh();
  expect(api.servers).not.toHaveBeenCalled(); held.resolve(profile("paired")); await joined; await ready();
  expect(render().runtime.servers).toEqual([server("seed")]); expect(api.servers).not.toHaveBeenCalled();
  expect(api.statuses).toHaveBeenCalledTimes(1);
  await render().refresh(); expect(api.servers).toHaveBeenCalledTimes(1); expect(api.statuses).toHaveBeenCalledTimes(2);
});

it.each(["abort", "remove", "replace"] as const)("does not publish old seed/status after %s during held activation authorization", async action => {
  await startup(); const held = deferred<GatewayProfile>(); api.ensure.mockReturnValueOnce(held.promise);
  const controller = new AbortController(); const old = profile("old");
  api.exchange.mockResolvedValueOnce({ profile: old, initialServers: [server("old-seed")] });
  await render().connectGateway({ baseUrl: old.baseUrl, token: "synthetic", signal: controller.signal }); render();
  expect(api.ensure).toHaveBeenCalledTimes(1);
  if (action === "abort") controller.abort();
  if (action === "remove") { await render().removeGateway(old.id); render(); }
  if (action === "replace") {
    api.exchange.mockResolvedValueOnce({ profile: profile("winner"), initialServers: [server("winner-seed")] });
    await render().connectGateway({ baseUrl: old.baseUrl, token: "synthetic" }); render();
  }
  held.resolve(old);
  // Drain the actual pending gate and its completion, rather than a fixed sleep.
  await render().refresh(); render();
  expect(render().runtime.servers).not.toContainEqual(server("old-seed"));
  expect(api.statuses.mock.calls.every(([p]) => p.accessToken !== old.accessToken)).toBe(true);
  if (action === "remove") expect(render().profiles).toEqual([]);
  if (action === "replace") expect(render().activeProfile?.accessToken).toBe(profile("winner").accessToken);
});

it("a superseded same-base exchange commits no activation seed; aborted exchange is revoked and publishes nothing", async () => {
  await startup(); const old = deferred<MobileSessionBootstrap>();
  api.exchange.mockReturnValueOnce(old.promise);
  const first = render().connectGateway({ baseUrl: profile("old").baseUrl, token: "synthetic" });
  api.exchange.mockResolvedValueOnce({ profile: profile("winner"), initialServers: [server("winner-seed")] });
  await render().connectGateway({ baseUrl: profile("winner").baseUrl, token: "synthetic" }); await ready();
  old.resolve({ profile: profile("old"), initialServers: [server("old-seed")] }); await expect(first).resolves.toBeNull(); render();
  expect(render().runtime.servers).toEqual([server("winner-seed")]); expect(api.statuses).toHaveBeenCalledTimes(1);
  const cancelled = deferred<MobileSessionBootstrap>(); const controller = new AbortController();
  api.exchange.mockReturnValueOnce(cancelled.promise);
  const connection = render().connectGateway({ baseUrl: "https://review.invalid/g/other", token: "synthetic", signal: controller.signal });
  controller.abort(); cancelled.resolve({ profile: profile("cancelled", "https://review.invalid/g/other"), initialServers: [server("cancelled-seed")] });
  await expect(connection).resolves.toBeNull(); render();
  expect(api.revoke).toHaveBeenCalledWith(expect.objectContaining({ id: "cancelled" }));
  expect(render().runtime.servers).toEqual([server("winner-seed")]); expect(api.stored.profiles).toHaveLength(1);
});

it("an older different-base commit remains unactivated and cannot publish its seed", async () => {
  await startup(); const held = deferred<MobileSessionBootstrap>(); api.exchange.mockReturnValueOnce(held.promise);
  const first = render().connectGateway({ baseUrl: "https://review.invalid/g/older", token: "synthetic" });
  api.exchange.mockResolvedValueOnce({ profile: profile("winner"), initialServers: [server("winner-seed")] });
  await render().connectGateway({ baseUrl: profile("winner").baseUrl, token: "synthetic" }); await ready();
  held.resolve({ profile: profile("older", "https://review.invalid/g/older"), initialServers: [server("older-seed")] });
  await expect(first).resolves.toBeNull(); render();
  expect(render().activeProfile?.id).toBe("winner"); expect(api.stored.profiles).toHaveLength(2);
  expect(render().runtime.servers).toEqual([server("winner-seed")]); expect(api.statuses).toHaveBeenCalledTimes(1);
});

it("a cold restored profile has no activation seed and performs the ordinary servers GET", async () => {
  api.stored = { profiles: [profile("restored")], activeId: "restored" };
  await startup(); await ready();
  expect(api.exchange).not.toHaveBeenCalled(); expect(api.servers).toHaveBeenCalledTimes(1);
  expect(api.servers.mock.calls[0][0].id).toBe("restored"); expect(api.statuses).toHaveBeenCalledTimes(1);
  expect(render().runtime.servers).toEqual([server("get")]);
});
