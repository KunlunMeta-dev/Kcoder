// AppProvider runs in a deterministic hook host, not mounted React/DOM or Browser.
// Actual-flow cases use real profile/auth/HTTP code and owned Node loopback fetch;
// localStorage/Web Locks are fixtures, not browser Web Locks or public RTT evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import type { ReactElement } from "react";
import type { GatewayAuthorizationDenialWitness, GatewayProfile, KCoderServer, ServerStatus } from "@/gateway/types";
import { GatewaySessionExpiredError, type MobileSessionBootstrap } from "@/gateway/http";
import { PROFILE_INDEX_KEY, persistProfiles } from "@/storage/profile-store";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import type { ProfileSnapshot } from "./profile-coordinator";
import type { MetadataAuthority } from "@/storage/metadata-authority";

type Effect = { callback: () => void | (() => void); deps: readonly unknown[]; pending: boolean; cleanup?: () => void };
const host = vi.hoisted(() => ({
  states: [] as unknown[], setters: [] as ((value: unknown) => void)[], refs: [] as { current: unknown }[],
  memos: [] as { deps: readonly unknown[]; value: unknown }[], effects: [] as Effect[],
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
}));
const api = vi.hoisted(() => ({
  stored: { profiles: [], activeId: null } as ProfileSnapshot,
  exchange: vi.fn<(baseUrl: string, token: string, label?: string, signal?: AbortSignal, connectionRoutes?: GatewayProfile["connectionRoutes"]) => Promise<MobileSessionBootstrap>>(),
  load: vi.fn<() => Promise<ProfileSnapshot>>(),
  persist: vi.fn<(profiles: GatewayProfile[], activeId: string | null) => Promise<void>>(),
  ensure: vi.fn<(profile: GatewayProfile) => Promise<GatewayProfile>>(),
  servers: vi.fn<(profile: GatewayProfile) => Promise<KCoderServer[]>>(),
  statuses: vi.fn(), revoke: vi.fn(), cleanup: vi.fn(),
  denialRecorder: undefined as ((witness: GatewayAuthorizationDenialWitness) => Promise<boolean>) | undefined,
  denialChecker: undefined as ((witness: GatewayAuthorizationDenialWitness) => boolean) | undefined,
  actualFlow: false,
  actualProfileLoads: 0,
  actualProfilePersists: 0,
  actualPersistBarrier: undefined as { activeId: string; entered: () => void; wait: Promise<void> } | undefined,
  actualLockClasses: [] as string[],
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
vi.mock("@/storage/profile-store", async importOriginal => {
  const actual = await importOriginal<typeof import("@/storage/profile-store")>();
  return {
    ...actual,
    loadProfiles: async (authority?: MetadataAuthority) => {
      if (!api.actualFlow) return api.load();
      api.actualProfileLoads += 1;
      return actual.loadProfiles(authority);
    },
    persistProfiles: async (profiles: GatewayProfile[], activeId: string | null, authority?: MetadataAuthority) => {
      if (!api.actualFlow) return api.persist(profiles, activeId);
      api.actualProfilePersists += 1;
      const barrier = api.actualPersistBarrier;
      if (barrier?.activeId === activeId) {
        api.actualPersistBarrier = undefined;
        barrier.entered(); await barrier.wait;
      }
      return actual.persistProfiles(profiles, activeId, authority);
    },
    migrateLegacyWebProfiles: async () => api.actualFlow ? actual.migrateLegacyWebProfiles() : null,
  };
});
vi.mock("@/storage/context-lock", async importOriginal => {
  const actual = await importOriginal<typeof import("@/storage/context-lock")>();
  return {
    ...actual,
    canCoordinateDeviceAuthorization: () => api.actualFlow ? actual.canCoordinateDeviceAuthorization() : true,
    withLocalMetadata: <T,>(key: string, operation: (authority?: MetadataAuthority) => Promise<T>, parent?: MetadataAuthority) => {
      if (!api.actualFlow) return operation();
      api.actualLockClasses.push(key === "gateway-profile-index" ? "profile-index" :
        key.startsWith("device-authorization:") ? "device-authorization" : "other");
      return actual.withLocalMetadata(key, operation, parent);
    },
  };
});
vi.mock("@/gateway/http", async importOriginal => {
  const actual = await importOriginal<typeof import("@/gateway/http")>();
  return {
    ...actual,
    exchangeMobileSessionWithBootstrap: (...args: Parameters<typeof actual.exchangeMobileSessionWithBootstrap>) =>
      api.actualFlow ? actual.exchangeMobileSessionWithBootstrap(...args) : api.exchange(...args),
    ensureGatewayAuthorization: (...args: Parameters<typeof actual.ensureGatewayAuthorization>) =>
      api.actualFlow ? actual.ensureGatewayAuthorization(...args) : api.ensure(args[0]),
    installGatewayAuthorizationResolver: (...args: Parameters<typeof actual.installGatewayAuthorizationResolver>) =>
      api.actualFlow ? actual.installGatewayAuthorizationResolver(...args) : () => {},
    installGatewayAuthorizationDenialRecorder: (...args: Parameters<typeof actual.installGatewayAuthorizationDenialRecorder>) => {
      const disposeActual = actual.installGatewayAuthorizationDenialRecorder(...args);
      if (!api.actualFlow) { api.denialRecorder = args[0]; api.denialChecker = args[1]; }
      return () => {
        disposeActual();
        if (api.denialRecorder === args[0]) { api.denialRecorder = undefined; api.denialChecker = undefined; }
      };
    },
    listServers: (...args: Parameters<typeof actual.listServers>) => api.actualFlow ? actual.listServers(...args) : api.servers(args[0]),
    listServerStatuses: (...args: Parameters<typeof actual.listServerStatuses>) => api.actualFlow ? actual.listServerStatuses(...args) : api.statuses(args[0]),
    getServerStatusSnapshot: (...args: Parameters<typeof actual.getServerStatusSnapshot>) => api.actualFlow
      ? actual.getServerStatusSnapshot(...args)
      : api.statuses(args[0]).then((statuses: ServerStatus[]) => ({ gatewayRuntimeVersion: null, statuses })),
    revokeMobileSession: (...args: Parameters<typeof actual.revokeMobileSession>) =>
      api.actualFlow ? actual.revokeMobileSession(...args) : api.revoke(...args),
  };
});
vi.mock("@/runtime/task-runtime", () => ({ taskRuntimeRegistry: { removeProfile: vi.fn() } }));
vi.mock("@/runtime/task-runtime/modelCatalog", () => ({ clearModelCache: vi.fn() }));
vi.mock("@/runtime/task-runtime/workspaces", () => ({ clearWorkspaceOptionsCache: vi.fn() }));
vi.mock("@/storage/workspace-preferences", () => ({ workspaceStateAuthorizationScope: vi.fn(),
  markWorkspaceStateRemoval: () => 1, removeWorkspaceStatesForProfile: api.cleanup }));
vi.mock("@/storage/pending-workspace-operation-v2", () => ({ assertWorkspaceOperationsResolvedV2: vi.fn(async () => {}) }));
vi.mock("@/storage/thread-deletion-cleanup", () => ({ installThreadDeletionCleanupAuthorityResolver: () => () => {},
  retryThreadDeletionCleanup: vi.fn(async () => {}) }));
vi.mock("./device-authorization", async importOriginal => {
  const actual = await importOriginal<typeof import("./device-authorization")>();
  class DelegatingDeviceAuthorizationManager {
    private readonly delegate: InstanceType<typeof actual.DeviceAuthorizationManager> | null;
    constructor(...args: ConstructorParameters<typeof actual.DeviceAuthorizationManager>) {
      this.delegate = api.actualFlow ? new actual.DeviceAuthorizationManager(...args) : null;
    }
    authorize(profile: GatewayProfile, force = false) {
      return this.delegate ? this.delegate.authorize(profile, force) : api.ensure(profile).then(() => undefined);
    }
    nextAttemptAt(profile: GatewayProfile) {
      return this.delegate ? this.delegate.nextAttemptAt(profile) : Number.MAX_SAFE_INTEGER;
    }
  }
  return {
    ...actual,
    deviceRefreshLead: (profile: GatewayProfile) => api.actualFlow ? actual.deviceRefreshLead(profile) : 0,
    DeviceAuthorizationManager: DelegatingDeviceAuthorizationManager,
  };
});
import { AppProvider } from "./AppContext";
import { ProfileOperationGate, profileAuthorizationScopeKey } from "./profile-coordinator";
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
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function profile(id: string, baseUrl = "https://review.invalid/g/one"): GatewayProfile {
  return { id, label: id, baseUrl, accessToken: `synthetic-${id}`, rpcToken: "synthetic", expiresAt: Number.MAX_SAFE_INTEGER,
    authMode: "legacy", authorizationGeneration: `generation-${id}` };
}
function denialWitness(profile: GatewayProfile): GatewayAuthorizationDenialWitness {
  return { profileId: profile.id, baseUrl: profile.baseUrl, authMode: profile.authMode,
    authorizationGeneration: profile.authorizationGeneration, deviceId: profile.deviceId,
    accessToken: profile.accessToken, refreshToken: profile.refreshToken };
}
async function recordAuthorizationDenial(profile: GatewayProfile): Promise<void> {
  const witness = denialWitness(profile);
  const recorder = api.denialRecorder;
  if (!recorder) throw new Error("AppProvider did not install its authorization denial recorder");
  expect(await recorder(witness)).toBe(true);
  expect(api.denialChecker?.(witness)).toBe(true);
}
function server(id: string): KCoderServer { return { id, label: id, description: id, runtime: "kcoder", transport: "local" }; }

type LoopbackRequestKind = "servers" | "statuses" | "refresh" | "unexpected";
type LoopbackRequestRecord = { kind: LoopbackRequestKind; atMs: number; accessClass: "initial" | "rotated" | "replacement" | "other" | "none" };
function startLoopbackGateway(identity: { deviceId: string; authorizationGeneration: string; initialAccessToken: string }) {
  const rotatedAccessToken = "loopback-rotated-access";
  const requests: LoopbackRequestRecord[] = [];
  const held: Array<{ kind: "servers" | "statuses"; response: ServerResponse }> = [];
  let holdAccessClass: string | null = null;
  let serverInstance: ReturnType<typeof createServer>;
  const classifyAccess = (header: string | undefined): LoopbackRequestRecord["accessClass"] => {
    if (!header) return "none";
    if (header === `Bearer ${identity.initialAccessToken}`) return "initial";
    if (header === `Bearer ${rotatedAccessToken}`) return "rotated";
    if (header === "Bearer loopback-replacement-access") return "replacement";
    if (header === "Bearer loopback-second-profile-access") return "other";
    return "other";
  };
  const send = (response: ServerResponse, payload: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify(payload));
  };
  const sendGet = (kind: "servers" | "statuses", response: ServerResponse, accessClass: LoopbackRequestRecord["accessClass"], late = false) => {
    if (kind === "statuses") send(response, { statuses: [] });
    else {
      const id = late ? "late-old-scope" : accessClass === "replacement" ? "replacement-live" : accessClass === "rotated" ? "rotated-live" : accessClass === "other" ? "second-profile-live" : "initial-live";
      send(response, { servers: [server(id)] });
    }
  };
  serverInstance = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const accessClass = classifyAccess(request.headers.authorization);
    const kind: LoopbackRequestKind = request.method === "POST" && path.endsWith("/api/mobile/session/refresh") ? "refresh" :
      request.method === "GET" && path.endsWith("/api/servers/status") ? "statuses" :
      request.method === "GET" && path.endsWith("/api/servers") ? "servers" : "unexpected";
    requests.push({ kind, atMs: performance.now(), accessClass });
    if (kind === "refresh") {
      request.resume();
      send(response, {
        accessToken: rotatedAccessToken,
        rpcToken: "loopback-rotated-rpc",
        refreshToken: "b".repeat(64),
        refreshExpiresAt: Date.now() + 3_600_000,
        expiresAt: Date.now() + 300_000,
        accessTtlMs: 300_000,
        deviceId: identity.deviceId,
        authorizationGeneration: identity.authorizationGeneration,
      });
      return;
    }
    if (kind === "servers" || kind === "statuses") {
      if (holdAccessClass !== null && accessClass === holdAccessClass) {
        held.push({ kind, response });
        return;
      }
      sendGet(kind, response, accessClass);
      return;
    }
    response.writeHead(404, { connection: "close" }); response.end();
  });
  const listening = new Promise<void>((resolve, reject) => {
    serverInstance.once("error", reject);
    serverInstance.listen(0, "127.0.0.1", () => resolve());
  });
  return listening.then(() => {
    const address = serverInstance.address();
    if (!address || typeof address === "string") throw new Error("loopback server did not bind an owned TCP port");
    const releaseHeld = () => {
      const lateKinds = new Set<string>();
      for (const item of held.splice(0)) {
        const late = !lateKinds.has(item.kind);
        lateKinds.add(item.kind);
        sendGet(item.kind, item.response, "initial", late);
      }
      holdAccessClass = null;
    };
    return {
      baseUrl: `http://127.0.0.1:${address.port}/g/actual-flow`,
      requests,
      rotatedAccessToken,
      holdAccessClass(accessClass: string) { holdAccessClass = accessClass; },
      allowNewRequests() { holdAccessClass = null; },
      heldKinds() { return held.map(item => item.kind); },
      releaseHeld,
      async close() {
        releaseHeld();
        await new Promise<void>(resolve => serverInstance.close(() => resolve()));
      },
    };
  });
}

async function prepareActualFlow(options: { nearExpiry?: boolean; resetAfterReady?: boolean; additionalProfiles?: (initialProfile: GatewayProfile) => GatewayProfile[] } = {}) {
  api.actualFlow = true;
  const storage = installBrowserProfileFixture();
  const storageListeners = new Set<(event: StorageEvent) => void>();
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", {
    localStorage: storage.localStorage,
    addEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === "storage") storageListeners.add(listener); },
    removeEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === "storage") storageListeners.delete(listener); },
  });
  const deviceId = "loopback-device";
  const authorizationGeneration = "loopback-generation";
  const initialProfile: GatewayProfile = {
    ...profile("actual-flow", ""),
    authMode: "device",
    deviceId,
    authorizationGeneration,
    accessToken: "loopback-initial-access",
    rpcToken: "loopback-initial-rpc",
    refreshToken: "a".repeat(64),
    refreshExpiresAt: Date.now() + 3_600_000,
    accessTtlMs: 300_000,
    expiresAt: Date.now() + (options.nearExpiry ? 1 : 3_600_000),
  };
  const gateway = await startLoopbackGateway({ deviceId, authorizationGeneration, initialAccessToken: initialProfile.accessToken });
  try {
    initialProfile.baseUrl = gateway.baseUrl;
    await persistProfiles([initialProfile, ...(options.additionalProfiles?.(initialProfile) ?? [])], initialProfile.id);
    if (options.nearExpiry) {
      api.actualProfileLoads = 0; api.actualProfilePersists = 0; api.actualLockClasses = [];
    }
    await startup(); await ready();
    if (options.resetAfterReady !== false) {
      api.actualProfileLoads = 0; api.actualProfilePersists = 0; api.actualLockClasses = [];
      gateway.requests.splice(0);
    }
    return {
      gateway,
      initialProfile,
      dispatchProfileStorageChange() {
        const event = { key: PROFILE_INDEX_KEY, storageArea: storage.localStorage } as StorageEvent;
        for (const listener of [...storageListeners]) listener(event);
      },
    };
  } catch (primaryError) {
    try { await gateway.close(); }
    catch (cleanupError) {
      throw new AggregateError([primaryError, cleanupError], "actual flow setup failed and its loopback cleanup also failed");
    }
    throw primaryError;
  }
}

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
  api.denialRecorder = undefined; api.denialChecker = undefined;
  api.actualFlow = false; api.actualProfileLoads = 0; api.actualProfilePersists = 0; api.actualLockClasses = [];
  api.actualPersistBarrier = undefined;
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
  const held = deferred<KCoderServer[]>(); api.servers.mockReturnValueOnce(held.promise);
  for (const listener of api.activeListeners) listener("active");
  await vi.waitFor(() => expect(api.servers).toHaveBeenCalledTimes(2));
  const manual = render().refresh();
  expect(clearWorkspaceOptionsCache).toHaveBeenCalledTimes(1); expect(clearWorkspaceOptionsCache).toHaveBeenCalledWith("active");
  held.resolve([server("get")]); await manual;
  expect(api.servers).toHaveBeenCalledTimes(2);
});

it("automatically recovers failed runtime reads while retaining the current server inventory", async () => {
  api.stored = { profiles: [profile("active")], activeId: "active" };
  await startup(); await ready();
  vi.useFakeTimers();
  try {
    api.servers.mockRejectedValueOnce(new Error("No advertised Gateway route passed the connection proof"));
    api.statuses.mockRejectedValueOnce(new Error("No advertised Gateway route passed the connection proof"));
    await render().refresh();
    const failed = render();
    expect(failed.runtime.error).toBe(failed.runtime.statusError);
    expect(failed.runtime.servers.map(server => server.id)).toEqual(["get"]);
    const count = api.servers.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000); render(); await Promise.all(api.operations);
    expect(api.servers).toHaveBeenCalledTimes(count + 1);
    const recovered = render().runtime;
    expect(recovered.error).toBeNull(); expect(recovered.statusError).toBeNull();
    expect(recovered.servers.map(server => server.id)).toEqual(["get"]);
  } finally { for (const effect of host.effects) effect.cleanup?.(); vi.useRealTimers(); }
});


it("publishes one servers revision for joined refreshes before held status completes, including unchanged inventory", async () => {
  vi.spyOn(Date, "now").mockReturnValue(10_000);
  api.stored = { profiles: [profile("active")], activeId: "active" };
  await startup(); await ready();
  const before = render().runtime;
  const revision = before.serversRevision;
  const heldStatuses = deferred<[]>(); api.statuses.mockReturnValueOnce(heldStatuses.promise);
  let settled = false;
  const first = render().refresh().then(() => { settled = true; });
  const joined = render().refresh();
  try {
    await vi.waitFor(() => {
      const runtime = render().runtime;
      expect(runtime.serversRevision).toBe(revision + 1);
    });
    expect(render().runtime.servers).toEqual(before.servers);
    expect(settled).toBe(false);
    expect(api.servers).toHaveBeenCalledTimes(2);
    expect(api.statuses).toHaveBeenCalledTimes(2);
  } finally {
    heldStatuses.resolve([]); await Promise.all([first, joined]);
  }
  expect((render().runtime).serversRevision).toBe(revision + 1);
  await render().refresh();
  expect(render().runtime.serversRevision).toBe(revision + 2);
});


it.each(["servers", "authorization"] as const)("does not advance servers revision after %s failure", async failure => {
  api.stored = { profiles: [profile("active")], activeId: "active" };
  await startup(); await ready();
  const revision = render().runtime.serversRevision;
  if (failure === "servers") api.servers.mockRejectedValueOnce(new Error("servers unavailable"));
  else {
    api.ensure.mockImplementationOnce(async current => {
      await recordAuthorizationDenial(current);
      throw new GatewaySessionExpiredError();
    });
    // The GET boundary performs authorization in the real gatewayRequest path.
    api.servers.mockImplementationOnce(async p => { await api.ensure(p); return [server("get")]; });
  }
  await render().refresh();
  expect(render().runtime.serversRevision).toBe(revision);
  expect(render().runtime.error).toContain(failure === "servers" ? "servers unavailable" : new GatewaySessionExpiredError().message);
  expect(render().runtime.reauthorizationRequired).toBe(failure === "authorization");
  expect(api.servers).toHaveBeenCalledTimes(2);
});

it.each([false, true])("settles held status failure after publishing inventory without another revision (expired=%s)", async expired => {
  api.stored = { profiles: [profile("active")], activeId: "active" };
  await startup(); await ready();
  const revision = render().runtime.serversRevision;
  const held = deferred<[]>(); api.statuses.mockReturnValueOnce(held.promise);
  const refresh = render().refresh();
  await vi.waitFor(() => expect(render().runtime.serversRevision).toBe(revision + 1));
  if (expired) {
    const current = render().activeProfile;
    if (!current) throw new Error("The active profile disappeared before the held status denial");
    await recordAuthorizationDenial(current);
  }
  held.reject(expired ? new GatewaySessionExpiredError() : new Error("status unavailable"));
  await refresh;
  expect(render().runtime.serversRevision).toBe(revision + 1);
  const runtime = render().runtime;
  expect(runtime.reauthorizationRequired).toBe(expired);
  if (expired) {
    expect(runtime.error).toContain(new GatewaySessionExpiredError().message);
    expect(runtime.statusError).toBeNull();
  } else {
    expect(runtime.statusError).toContain("status unavailable");
  }
});

it("does not publish an old profile's late servers revision after switching profiles", async () => {
  api.stored = { profiles: [profile("active"), profile("next", "https://review.invalid/g/next")], activeId: "active" };
  await startup(); await ready();
  const held = deferred<KCoderServer[]>(); api.servers.mockReturnValueOnce(held.promise);
  const oldRefresh = render().refresh();
  await vi.waitFor(() => expect(api.servers).toHaveBeenCalledTimes(2));
  await render().setActiveProfile("next"); render();
  await vi.waitFor(() => {
    expect(render().activeProfile?.id).toBe("next");
    expect(render().runtime.serversReady).toBe(true);
  });
  const current = render().runtime;
  held.resolve([server("late-old")]); await oldRefresh;
  expect(render().runtime.serversRevision).toBe(current.serversRevision);
  expect(render().runtime.servers).toEqual(current.servers);
  expect(render().runtime.servers).not.toContainEqual(server("late-old"));
});

it("actual AppProvider refresh reaches both authenticated loopback GETs before either response is released", async () => {
  const flow = await prepareActualFlow();
  flow.gateway.holdAccessClass("initial");
  let refresh: Promise<void> | undefined;
  try {
    refresh = render().refresh();
    try { await vi.waitFor(() => expect(new Set(flow.gateway.heldKinds()).size).toBe(2)); }
    catch (cause) {
      const value = render();
      throw new Error(`actual loopback GET preflight did not reach both held requests: ${JSON.stringify({
        requests: flow.gateway.requests,
        heldKinds: flow.gateway.heldKinds(),
        profileLoads: api.actualProfileLoads,
        profilePersists: api.actualProfilePersists,
        lockClasses: api.actualLockClasses,
        activeProfileId: value.activeProfile?.id ?? null,
        activeAuthMode: value.activeProfile?.authMode ?? null,
        activeAccessMatchesFixture: value.activeProfile?.accessToken === flow.initialProfile.accessToken,
        activeAccessLength: value.activeProfile?.accessToken.length ?? null,
        activeAccessIsCookieAuth: value.activeProfile?.accessToken === "cookie-auth",
        activeHasDeviceRefreshCredential: typeof value.activeProfile?.refreshToken === "string",
        hydrated: value.hydrated,
        runtime: { loading: value.runtime.loading, serversReady: value.runtime.serversReady,
          error: value.runtime.error, statusError: value.runtime.statusError,
          reauthorizationRequired: value.runtime.reauthorizationRequired },
      })}`, { cause });
    }
    expect(new Set(flow.gateway.heldKinds())).toEqual(new Set(["servers", "statuses"]));
    expect(flow.gateway.requests.filter(request => request.kind === "servers" || request.kind === "statuses")).toHaveLength(2);
    expect(flow.gateway.requests.filter(request => request.kind === "refresh")).toHaveLength(0);
    expect(flow.gateway.requests.filter(request => request.kind === "servers" || request.kind === "statuses").every(request => request.accessClass === "initial")).toBe(true);
  } finally {
    flow.gateway.releaseHeld();
    await refresh;
    await flow.gateway.close();
  }
});

it("fresh actual refresh uses one profile-index reload/serialize for both GETs", async () => {
  const flow = await prepareActualFlow();
  flow.gateway.holdAccessClass("initial");
  let refresh: Promise<void> | undefined;
  let reloadCount = 0;
  let serializeCount = 0;
  try {
    refresh = render().refresh();
    await vi.waitFor(() => expect(new Set(flow.gateway.heldKinds()).size).toBe(2));
    reloadCount = api.actualProfileLoads;
    serializeCount = api.actualLockClasses.filter(kind => kind === "profile-index").length;
  } finally {
    flow.gateway.releaseHeld();
    await refresh;
    await flow.gateway.close();
  }
  expect(flow.gateway.requests.filter(request => request.kind === "refresh")).toHaveLength(0);
  // Both GETs share their authorization check; no redundant outer check runs.
  expect({ reloadCount, serializeCount }).toEqual({ reloadCount: 1, serializeCount: 1 });
});

it("actual near-expiry refresh rotates once without changing scope and uses the rotated token for both GETs", async () => {
  const flow = await prepareActualFlow({ nearExpiry: true, resetAfterReady: false });
  try {
    const refreshPosts = flow.gateway.requests.filter(request => request.kind === "refresh");
    const gets = flow.gateway.requests.filter(request => request.kind === "servers" || request.kind === "statuses");
    const current = render().activeProfile;
    expect(refreshPosts).toHaveLength(1);
    expect(gets.map(request => request.kind).sort()).toEqual(["servers", "statuses"]);
    expect(gets.every(request => request.accessClass === "rotated")).toBe(true);
    expect(current).not.toBeNull();
    expect(profileAuthorizationScopeKey(current!)).toBe(profileAuthorizationScopeKey(flow.initialProfile));
    expect(current?.accessToken).toBe(flow.gateway.rotatedAccessToken);
    expect(api.actualProfilePersists).toBeGreaterThanOrEqual(2);
  } finally {
    await flow.gateway.close();
  }
});

it("actual storage scope replacement fences held old HTTP responses from runtime publication", async () => {
  const flow = await prepareActualFlow();
  flow.gateway.holdAccessClass("initial");
  let oldRefresh: Promise<void> | undefined;
  try {
    oldRefresh = render().refresh();
    await vi.waitFor(() => expect(new Set(flow.gateway.heldKinds()).size).toBe(2));
    const replacement: GatewayProfile = {
      ...flow.initialProfile,
      authorizationGeneration: "loopback-replacement-generation",
      deviceId: "loopback-replacement-device",
      accessToken: "loopback-replacement-access",
      refreshToken: "c".repeat(64),
      expiresAt: Date.now() + 3_600_000,
    };
    await persistProfiles([replacement], replacement.id);
    flow.dispatchProfileStorageChange();
    await vi.waitFor(() => {
      expect(render().activeProfile?.authorizationGeneration).toBe(replacement.authorizationGeneration);
      expect(flow.gateway.requests.filter(request => request.accessClass === "replacement" && (request.kind === "servers" || request.kind === "statuses"))).toHaveLength(2);
      expect(render().runtime.servers).toEqual([server("replacement-live")]);
    });
    flow.gateway.releaseHeld();
    await oldRefresh;
    expect(render().runtime.servers).toEqual([server("replacement-live")]);
    expect(render().runtime.servers).not.toContainEqual(server("late-old-scope"));
  } finally {
    flow.gateway.releaseHeld();
    await oldRefresh;
    await flow.gateway.close();
  }
});

it.each([false, true])("actual A to B to A activation reads current A before releasing old A (batched=%s)", async batched => {
  const flow = await prepareActualFlow({ additionalProfiles: initialProfile => [{
    ...initialProfile,
    id: "actual-flow-b",
    label: "actual-flow-b",
    deviceId: "loopback-device-b",
    authorizationGeneration: "loopback-generation-b",
    accessToken: "loopback-second-profile-access",
    rpcToken: "loopback-second-profile-rpc",
    refreshToken: "d".repeat(64),
  }] });
  let oldRefresh: Promise<void> | undefined;
  try {
    flow.gateway.holdAccessClass("initial");
    oldRefresh = render().refresh();
    await vi.waitFor(() => expect(flow.gateway.heldKinds()).toEqual(["servers", "statuses"]));

    const retainedActivation = render().setActiveProfile;
    await retainedActivation("actual-flow-b");
    if (!batched) {
      render();
      await vi.waitFor(() => {
        expect(render().activeProfile?.id).toBe("actual-flow-b");
        expect(render().runtime.servers).toEqual([server("second-profile-live")]);
        expect(render().runtime.statusRefreshing).toBe(false);
      });
    }
    expect(flow.gateway.requests.filter(request => request.accessClass === "other" && (request.kind === "servers" || request.kind === "statuses"))).toHaveLength(batched ? 0 : 2);

    // Preserve the obsolete responses while allowing the new activation to finish independently.
    flow.gateway.allowNewRequests();
    await (batched ? retainedActivation : render().setActiveProfile)(flow.initialProfile.id);
    render();
    await vi.waitFor(() => expect(render().activeProfile?.id).toBe(flow.initialProfile.id));
    await vi.waitFor(() => {
      const value = render();
      expect({
        activeProfileId: value.activeProfile?.id,
        serversReady: value.runtime.serversReady,
        servers: value.runtime.servers,
        initialServerGets: flow.gateway.requests.filter(request => request.accessClass === "initial" && request.kind === "servers").length,
      }).toEqual({
        activeProfileId: flow.initialProfile.id,
        serversReady: true,
        servers: [server("initial-live")],
        initialServerGets: 2,
      });
    });
    expect(flow.gateway.heldKinds()).toEqual(["servers", "statuses"]);
    const current = render().runtime;
    flow.gateway.releaseHeld();
    await oldRefresh;
    expect(render().runtime).toBe(current);
  } finally {
    flow.gateway.releaseHeld();
    if (oldRefresh) await oldRefresh;
    await Promise.all(api.operations);
    await flow.gateway.close();
  }
});

it.each([false, true])("actual pending B activation preserves the latest queued selection (returnToB=%s)", async returnToB => {
  const flow = await prepareActualFlow({ additionalProfiles: initialProfile => [{ ...initialProfile,
    id: "actual-flow-b", label: "actual-flow-b", deviceId: "loopback-device-b",
    authorizationGeneration: "loopback-generation-b", accessToken: "loopback-second-profile-access",
    rpcToken: "loopback-second-profile-rpc", refreshToken: "d".repeat(64) }] });
  const entered = deferred<void>(), release = deferred<void>();
  const operations: Promise<void>[] = [];
  try {
    api.actualPersistBarrier = { activeId: "actual-flow-b", entered: () => entered.resolve(), wait: release.promise };
    const activate = render().setActiveProfile;
    operations.push(activate("actual-flow-b"));
    await entered.promise;
    const backToA = activate(flow.initialProfile.id), joinedA = activate(flow.initialProfile.id);
    operations.push(backToA, joinedA);
    if (returnToB) operations.push(activate("actual-flow-b"));
    release.resolve();
    await Promise.all(operations);
    render();
    await vi.waitFor(() => {
      expect(render().activeProfile?.id).toBe(returnToB ? "actual-flow-b" : flow.initialProfile.id);
      expect(render().runtime.servers).toEqual([server(returnToB ? "second-profile-live" : "initial-live")]);
    });
    expect(joinedA).toBe(backToA);
    expect(flow.gateway.requests.filter(request => request.kind === "servers")).toHaveLength(1);
    expect(flow.gateway.requests.filter(request => request.kind === "statuses")).toHaveLength(1);
  } finally {
    release.resolve(); api.actualPersistBarrier = undefined;
    await Promise.allSettled(operations);
    await Promise.all(api.operations);
    await flow.gateway.close();
  }
});

it.each([false, true])("committed inactive connection replaces only the active authorization owner (scopeChanged=%s)", async scopeChanged => {
  const original = profile("active-a");
  api.stored = { profiles: [original], activeId: original.id };
  await startup(); await ready();
  const heldServers = deferred<KCoderServer[]>(), heldStatuses = deferred<[]>();
  api.servers.mockImplementation(() => heldServers.promise);
  api.statuses.mockImplementation(() => heldStatuses.promise);
  const oldRefresh = render().refresh();
  const retainedRuntime = render().runtime;
  const serverGets = api.servers.mock.calls.length;
  const oldExchange = deferred<MobileSessionBootstrap>(), latestExchange = deferred<MobileSessionBootstrap>();
  api.exchange.mockImplementationOnce(() => oldExchange.promise).mockImplementationOnce(() => latestExchange.promise);
  const oldConnection = render().connectGateway({ baseUrl: original.baseUrl, token: "synthetic-old" });
  const latestFailure = new Error("synthetic latest exchange failure");
  const latestConnection = render().connectGateway({ baseUrl: "https://review.invalid/g/other", token: "synthetic-latest" })
    .then(() => null, error => error as unknown);
  try {
    oldExchange.resolve({ profile: { ...original, id: "exchanged-a", accessToken: "synthetic-replacement-access",
      authorizationGeneration: scopeChanged ? "generation-replacement" : original.authorizationGeneration },
      initialServers: [server("unactivated-seed")] });
    expect(await oldConnection).toBeNull();
    // Read the actual commit effects before the changed-profile refresh can settle.
    const committed = render();
    expect(committed.activeProfile?.id).toBe(original.id);
    expect(committed.runtime.serversReady).toBe(!scopeChanged);
    expect(committed.runtime.servers).toEqual(scopeChanged ? [] : retainedRuntime.servers);
    expect(api.servers).toHaveBeenCalledTimes(serverGets + (scopeChanged ? 1 : 0));
    expect(committed.runtime.servers).not.toContainEqual(server("unactivated-seed"));
    latestExchange.reject(latestFailure);
    expect(await latestConnection).toBe(latestFailure);
    expect(render().activeProfile?.authorizationGeneration).toBe(scopeChanged ? "generation-replacement" : original.authorizationGeneration);
  } finally {
    latestExchange.reject(latestFailure);
    heldServers.resolve([server("fresh-current")]); heldStatuses.resolve([]);
    await Promise.allSettled([oldRefresh, oldConnection, latestConnection, ...api.operations]);
  }
});

it("an inactive connection compares the queued commit owner after another profile becomes active", async () => {
  const first = profile("active-a"), second = profile("active-b", "https://review.invalid/g/two");
  api.stored = { profiles: [first, second], activeId: first.id };
  await startup(); await ready();
  const exchange = deferred<MobileSessionBootstrap>();
  api.exchange.mockImplementationOnce(() => exchange.promise);
  const oldConnection = render().connectGateway({ baseUrl: first.baseUrl, token: "synthetic-old" });
  try {
    await render().setActiveProfile(second.id); await ready();
    const retainedRuntime = render().runtime, serverGets = api.servers.mock.calls.length;
    exchange.resolve({ profile: { ...first, id: "exchanged-a", authorizationGeneration: "generation-replacement" } });
    expect(await oldConnection).toBeNull();
    expect(render().activeProfile?.id).toBe(second.id);
    expect(render().runtime).toBe(retainedRuntime);
    expect(api.servers).toHaveBeenCalledTimes(serverGets);
  } finally {
    exchange.resolve({ profile: first });
    await oldConnection; await Promise.all(api.operations);
  }
});

it("a failed latest queued activation keeps the committed owner and permits a later retry", async () => {
  const first = profile("active-a"), second = profile("active-b", "https://review.invalid/g/two");
  api.stored = { profiles: [first, second], activeId: first.id };
  await startup(); await ready();
  const entered = deferred<void>(), release = deferred<void>();
  const failure = new Error("synthetic activation persistence failure");
  let failFirstReturn = true;
  api.persist.mockImplementation(async (profiles, activeId) => {
    if (activeId === second.id) { entered.resolve(); await release.promise; }
    if (activeId === first.id && failFirstReturn) { failFirstReturn = false; throw failure; }
    api.stored = { profiles: [...profiles], activeId };
  });
  const activate = render().setActiveProfile;
  const toB = activate(second.id);
  await entered.promise;
  const failedActivation = activate(first.id);
  const toA = failedActivation.then(() => null, error => error as unknown);
  try {
    release.resolve();
    await toB; expect(await toA).toBe(failure);
    // The readiness helper joins successful gates; this failure was asserted above.
    api.operations = api.operations.filter(operation => operation !== failedActivation);
    await ready();
    expect(render().activeProfile?.id).toBe(second.id);
    expect(api.stored.activeId).toBe(second.id);
    await render().setActiveProfile(first.id); await ready();
    expect(render().activeProfile?.id).toBe(first.id);
    expect(api.stored.activeId).toBe(first.id);
  } finally {
    release.resolve(); await Promise.allSettled([toB, toA, ...api.operations]);
  }
});
