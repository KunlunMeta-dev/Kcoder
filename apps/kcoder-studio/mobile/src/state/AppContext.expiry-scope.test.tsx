// Actual AppProvider callback and actual coordinator with a deterministic hook host.
// Only the foreground authorization effect is executed below; this is not mounted UI.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const host = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], setters: [] as ((value: unknown) => void)[],
  stateIndex: 0, refIndex: 0, deferred: false, updates: [] as (() => void)[],
  effects: [] as { callback: () => void | (() => void); deps: readonly unknown[] }[],
  authorize: vi.fn<(profile: unknown) => Promise<void>>(), retryAt: new Map<string, number>(), appState: "active",
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState(initial: unknown) {
      const i = host.stateIndex++;
      if (!(i in host.states)) host.states[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      host.setters[i] ??= (value: unknown) => {
        const apply = () => { host.states[i] = typeof value === "function" ? (value as (current: unknown) => unknown)(host.states[i]) : value; };
        if (host.deferred) host.updates.push(apply); else apply();
      };
      return [host.states[i], host.setters[i]];
    },
    useRef(initial: unknown) { return host.refs[host.refIndex++] ??= { current: initial }; },
    useEffect(callback: () => void | (() => void), deps: readonly unknown[] = []) { host.effects.push({ callback, deps }); },
    useCallback: (callback: unknown) => callback, useMemo: (factory: () => unknown) => factory(),
  };
});
vi.mock("react-native", () => ({ AppState: { get currentState() { return host.appState; } }, Platform: { OS: "web" } }));
vi.mock("@/storage/profile-store", () => ({ PROFILE_INDEX_KEY: "index", loadProfiles: vi.fn(), persistProfiles: vi.fn(), migrateLegacyWebProfiles: vi.fn() }));
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}), GatewaySessionExpiredError: class extends Error {},
  getServerStatusSnapshot: vi.fn(async () => ({ gatewayRuntimeVersion: null, statuses: [] })) }));
vi.mock("@/runtime/task-runtime", () => ({ taskRuntimeRegistry: {} }));
vi.mock("@/runtime/task-runtime/modelCatalog", () => ({ clearModelCache: vi.fn() }));
vi.mock("@/runtime/task-runtime/workspaces", () => ({ clearWorkspaceOptionsCache: vi.fn() }));
vi.mock("@/storage/workspace-preferences", () => ({ workspaceStateAuthorizationScope: vi.fn() }));
vi.mock("@/storage/thread-deletion-cleanup", () => ({}));
vi.mock("./device-authorization", () => ({
  deviceRefreshLead: () => 100,
  DeviceAuthorizationManager: class {
    authorize = host.authorize;
    nextAttemptAt(profile: { id: string }) { return host.retryAt.get(profile.id) ?? 0; }
  },
}));
vi.mock("./profile-connection-effects", () => ({}));
vi.mock("./connect-gateway-profile", () => ({}));
vi.mock("./remove-gateway-profile", () => ({}));
import { AppProvider } from "./AppContext";
import { ProfileCoordinator, profileAuthorizationScopeKey } from "./profile-coordinator";
import { profile } from "@/runtime/task-runtime/fixture.test-support";
import { loadProfiles, persistProfiles } from "@/storage/profile-store";

function render() {
  host.stateIndex = host.refIndex = 0; host.effects = [];
  return (AppProvider({ children: null }) as ReactElement<{ value: {
    markGatewayReauthorizationRequired(id: string, scope?: string): void;
    setActiveProfile(id: string): Promise<void>;
    runtime: { reauthorizationRequired: boolean; error: string | null };
  } }>).props.value;
}
function coordinator() { return host.refs.map(ref => ref.current).find(value => value instanceof ProfileCoordinator) as ProfileCoordinator; }
beforeEach(() => {
  host.states = []; host.refs = []; host.setters = []; host.updates = []; host.deferred = false;
  vi.mocked(loadProfiles).mockResolvedValue({ profiles: [], activeId: null });
  vi.mocked(persistProfiles).mockResolvedValue(undefined);
  host.authorize.mockReset().mockResolvedValue(undefined); host.retryAt.clear(); host.appState = "active";
});
afterEach(() => vi.useRealTimers());

function savedDevice(id: string, expiresAt: number) {
  return { ...profile, id, authMode: "device" as const, refreshToken: `synthetic-refresh-${id}`,
    refreshExpiresAt: Date.now() + 1_000_000, expiresAt };
}
function foregroundRenewal(saved: typeof profile[], activeId: string) {
  if (host.refs.length === 0) render();
  coordinator().hydrate({ profiles: saved, activeId });
  host.setters[1](true); host.setters[4](saved); host.setters[6](activeId);
  render();
  const effect = host.effects.find(effect => effect.deps.includes(coordinator()) && effect.deps.includes(saved));
  expect(effect).toBeDefined();
  return effect!.callback();
}

it("does not renew a saved inactive offline Gateway, including its pending durable rotation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const inactive = { ...savedDevice("old-offline", 0), pendingRotationId: "keep-original-rotation" };
  const active = savedDevice("current", 1_000_000);
  const cleanup = foregroundRenewal([inactive, active], active.id);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(host.authorize).not.toHaveBeenCalled();
  expect(coordinator().getSnapshot().profiles).toHaveLength(2);
  expect(coordinator().getSnapshot().profiles[0].pendingRotationId).toBe("keep-original-rotation");
  if (typeof cleanup === "function") cleanup();
});

it("renews the newly selected Gateway immediately and leaves other saved connections idle", () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const a = savedDevice("A", 9_000), b = savedDevice("B", 9_000);
  const cleanup = foregroundRenewal([a, b], b.id);
  expect(host.authorize.mock.calls.map(([value]) => (value as typeof profile).id)).toEqual(["B"]);
  if (typeof cleanup === "function") cleanup();
  const nextCleanup = foregroundRenewal([a, b], a.id);
  expect(host.authorize.mock.calls.map(([value]) => (value as typeof profile).id)).toEqual(["B", "A"]);
  if (typeof nextCleanup === "function") nextCleanup();
});

it("honors the active Gateway retry deadline and foreground state without polling inactive expiry", async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const a = savedDevice("inactive", 0), b = savedDevice("active", 9_000);
  host.retryAt.set(b.id, 40_000); host.appState = "background";
  const cleanup = foregroundRenewal([a, b], b.id);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(host.authorize).not.toHaveBeenCalled();
  host.appState = "active";
  await vi.advanceTimersByTimeAsync(10_000);
  expect(host.authorize).toHaveBeenCalledExactlyOnceWith(b);
  if (typeof cleanup === "function") cleanup();
});

it("a renewal failure after switching Gateways cannot reschedule or overwrite the new active runtime", async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  let reject!: (error: Error) => void;
  host.authorize.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  const a = savedDevice("A", 9_000), b = savedDevice("B", 1_000_000);
  const cleanup = foregroundRenewal([a, b], a.id);
  if (typeof cleanup === "function") cleanup();
  const nextCleanup = foregroundRenewal([a, b], b.id);
  reject(new Error("old Gateway unavailable"));
  await vi.advanceTimersByTimeAsync(0);
  expect(host.states[5]).toBe(0);
  expect(render().runtime.error).toBeNull();
  if (typeof nextCleanup === "function") nextCleanup();
});

it("marks valid same-scope runtime expiry without depending on form ownership", () => {
  const value = render(); const current = { ...profile, authorizationGeneration: "A" };
  current.reauthorizationRequiredScope = profileAuthorizationScopeKey(current);
  coordinator().hydrate({ profiles: [current], activeId: current.id });
  const runtimeCallback = () => value.markGatewayReauthorizationRequired(current.id, profileAuthorizationScopeKey(current));
  // Actual form navigation/unmount is covered in the route consumer test.
  runtimeCallback();
  expect(render().runtime.reauthorizationRequired).toBe(true);
});
it("rejects an old callback after same-id authorization replacement", () => {
  const value = render(); const old = { ...profile, authorizationGeneration: "A" };
  const deniedOld = { ...old, reauthorizationRequiredScope: profileAuthorizationScopeKey(old) };
  coordinator().hydrate({ profiles: [{ ...deniedOld, authorizationGeneration: "B" }], activeId: old.id });
  value.markGatewayReauthorizationRequired(old.id, profileAuthorizationScopeKey(old));
  expect(render().runtime.reauthorizationRequired).toBe(false);
});
it("accepts same-scope expiry across access-token rotation", () => {
  const value = render(); const old = { ...profile, authorizationGeneration: "A" };
  const deniedOld = { ...old, reauthorizationRequiredScope: profileAuthorizationScopeKey(old) };
  coordinator().hydrate({ profiles: [{ ...deniedOld, accessToken: "rotated", expiresAt: old.expiresAt + 1 }], activeId: old.id });
  value.markGatewayReauthorizationRequired(old.id, profileAuthorizationScopeKey(old));
  expect(render().runtime.reauthorizationRequired).toBe(true);
});
it("checks authority again when a previously queued runtime updater executes", () => {
  const value = render(); const old = { ...profile, authorizationGeneration: "A" };
  const deniedOld = { ...old, reauthorizationRequiredScope: profileAuthorizationScopeKey(old) };
  coordinator().hydrate({ profiles: [deniedOld], activeId: old.id });
  host.deferred = true;
  value.markGatewayReauthorizationRequired(old.id, profileAuthorizationScopeKey(old));
  expect(host.updates).toHaveLength(1);
  coordinator().hydrate({ profiles: [{ ...deniedOld, authorizationGeneration: "B" }], activeId: old.id });
  host.updates.shift()!(); host.deferred = false;
  expect(render().runtime.reauthorizationRequired).toBe(false);
});
it("does not publish a scope-only callback without a current grant-denial witness", () => {
  const value = render(); coordinator().hydrate({ profiles: [profile], activeId: profile.id });
  value.markGatewayReauthorizationRequired(profile.id);
  expect(render().runtime.reauthorizationRequired).toBe(false);
});

it("a delayed same-scope callback cannot re-deny a grant after validated refresh", async () => {
  const value = render();
  const denied = { ...profile, reauthorizationRequiredScope: profileAuthorizationScopeKey(profile) };
  const liveCoordinator = coordinator();
  liveCoordinator.hydrate({ profiles: [denied], activeId: denied.id });
  vi.mocked(loadProfiles).mockResolvedValue({ profiles: [denied], activeId: denied.id });
  vi.mocked(persistProfiles).mockResolvedValue(undefined);
  const updated = await liveCoordinator.updateCredentials(
    { ...denied },
    { ...denied, accessToken: "validated-t2", refreshToken: "validated-r2" },
    async () => {},
    "validated-refresh",
  );
  expect(updated).not.toHaveProperty("reauthorizationRequiredScope");

  value.markGatewayReauthorizationRequired(denied.id, profileAuthorizationScopeKey(denied));

  expect(render().runtime.reauthorizationRequired).toBe(false);
});

it("switching back to a denied nonactive profile resets retained runtime content behind reauthorization", async () => {
  const deniedA = { ...profile, id: "denied-A", authMode: "legacy" as const, authorizationGeneration: "A" };
  deniedA.reauthorizationRequiredScope = profileAuthorizationScopeKey(deniedA);
  const liveB = { ...profile, id: "live-B", authMode: "legacy" as const, authorizationGeneration: "B" };
  const snapshot = { profiles: [deniedA, liveB], activeId: liveB.id };
  vi.mocked(loadProfiles).mockResolvedValue(snapshot);
  vi.mocked(persistProfiles).mockResolvedValue(undefined);

  const value = render();
  coordinator().hydrate(snapshot);
  // Seed a prior live runtime so activation must not leave it visible while A is denied.
  host.setters[7]!({
    servers: [{ id: "retained-live-server" }], statuses: [], loading: false, serversReady: true,
    serversRevision: 1, statusRefreshing: false, statusError: null, serversUpdatedAt: 1,
    statusesUpdatedAt: 1, error: null, reauthorizationRequired: false,
  });

  await value.setActiveProfile(deniedA.id);

  expect(coordinator().getSnapshot().activeId).toBe(deniedA.id);
  expect(render().runtime).toMatchObject({
    servers: [],
    statuses: [],
    serversReady: false,
    error: "Gateway 会话已失效，请重新授权",
    reauthorizationRequired: true,
  });
});
