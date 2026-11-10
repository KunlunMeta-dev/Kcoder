// Execute the actual AppProvider denial-recorder effect with a controlled hook host.
// The transcript store and cache remain real; only platform storage is in memory.
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const host = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], setters: [] as ((value: unknown) => void)[],
  effects: [] as { effect: () => unknown; deps?: unknown[] }[], stateIndex: 0, refIndex: 0,
  denialRecorder: undefined as ((witness: unknown) => Promise<boolean>) | undefined,
  denialChecker: undefined as ((witness: unknown) => boolean) | undefined,
  persistedProfiles: [] as Record<string, unknown>[], persistedActiveId: null as string | null,
  transcriptManifest: null as string | null,
  transcriptEntries: new Map<number, { revision: number; raw: string }>(),
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState(initial: unknown) {
      const i = host.stateIndex++;
      if (!(i in host.states)) host.states[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      host.setters[i] ??= (value: unknown) => { host.states[i] = typeof value === "function" ? (value as (current: unknown) => unknown)(host.states[i]) : value; };
      return [host.states[i], host.setters[i]];
    },
    useRef(initial: unknown) { return host.refs[host.refIndex++] ??= { current: initial }; },
    useEffect(effect: () => unknown, deps?: unknown[]) { host.effects.push({ effect, deps }); },
    useCallback: (callback: unknown) => callback, useMemo: (factory: () => unknown) => factory(),
  };
});
vi.mock("react-native", () => ({ AppState: { currentState: "active" }, Platform: { OS: "ios" } }));
vi.mock("@/storage/profile-store", () => ({
  PROFILE_INDEX_KEY: "index",
  loadProfiles: vi.fn(async () => ({ profiles: host.persistedProfiles.map(profile => ({ ...profile })), activeId: host.persistedActiveId })),
  persistProfiles: vi.fn(async (profiles: Record<string, unknown>[], activeId: string | null) => {
    host.persistedProfiles = profiles.map(profile => ({ ...profile })); host.persistedActiveId = activeId;
  }),
  migrateLegacyWebProfiles: vi.fn(),
}));
vi.mock("@/storage/secure", () => ({
  getSecureValue: vi.fn(async (key: string) => key === "index" ? JSON.stringify({ profiles: host.persistedProfiles }) : null),
  setSecureValue: vi.fn(), deleteSecureValue: vi.fn(),
}));
vi.mock("@/storage/session-transcript-backend", () => ({
  createSessionTranscriptBackend: () => ({
    async readManifest() { return host.transcriptManifest; },
    async readEntry(slot: number, revision: number) {
      const entry = host.transcriptEntries.get(slot); return entry?.revision === revision ? entry.raw : null;
    },
    async reset(raw: string, isCurrent: () => boolean) {
      if (!isCurrent()) throw new Error("owner changed");
      host.transcriptEntries.clear(); host.transcriptManifest = raw;
    },
    async commit(change: { manifest: string; put?: { slot: number; revision: number; raw: string }; removeSlots: number[] }, isCurrent: () => boolean) {
      if (!isCurrent()) throw new Error("owner changed");
      if (change.put) host.transcriptEntries.set(change.put.slot, { revision: change.put.revision, raw: change.put.raw });
      for (const slot of change.removeSlots) host.transcriptEntries.delete(slot);
      host.transcriptManifest = change.manifest;
    },
  }),
}));
vi.mock("@/gateway/http", () => ({
  exchangeMobileSessionWithBootstrap: vi.fn(), ensureGatewayAuthorization: vi.fn(async () => {}),
  installGatewayAuthorizationDenialRecorder(recorder: (witness: unknown) => Promise<boolean>, checker: (witness: unknown) => boolean) {
    host.denialRecorder = recorder; host.denialChecker = checker;
    return () => { host.denialRecorder = undefined; host.denialChecker = undefined; };
  },
  installGatewayAuthorizationResolver: vi.fn(() => () => {}), GatewaySessionExpiredError: class extends Error {},
  listServers: vi.fn(), listServerStatuses: vi.fn(),
  getServerStatusSnapshot: vi.fn(async () => ({ gatewayRuntimeVersion: null, statuses: [] })), revokeMobileSession: vi.fn(),
}));
vi.mock("@/runtime/task-runtime", () => ({ taskRuntimeRegistry: { removeProfile: vi.fn() } }));
vi.mock("@/runtime/task-runtime/modelCatalog", () => ({ clearModelCache: vi.fn() }));
vi.mock("@/runtime/task-runtime/workspaces", async importOriginal => {
  const actual = await importOriginal<typeof import("@/runtime/task-runtime/workspaces")>();
  return { ...actual, clearWorkspaceOptionsCache: vi.fn() };
});
vi.mock("@/storage/workspace-preferences", () => ({ workspaceStateAuthorizationScope: vi.fn(), markWorkspaceStateRemoval: vi.fn(), removeWorkspaceStatesForProfile: vi.fn() }));
vi.mock("@/storage/thread-deletion-cleanup", () => ({ retryThreadDeletionCleanup: vi.fn(), installThreadDeletionCleanupAuthorityResolver: vi.fn(() => () => {}) }));
vi.mock("./device-authorization", () => ({ DeviceAuthorizationManager: class {} , deviceRefreshLead: vi.fn() }));
vi.mock("./profile-connection-effects", () => ({ applyProfileConnectionEffects: vi.fn() }));
vi.mock("./connect-gateway-profile", () => ({ connectGatewayProfile: vi.fn() }));
vi.mock("./remove-gateway-profile", () => ({ removeGatewayProfile: vi.fn() }));

import { AppProvider } from "./AppContext";
import { ProfileCoordinator, profileAuthorizationScopeKey } from "./profile-coordinator";
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { sessionTranscriptCache } from "@/storage/session-transcript-cache";
import { captureSessionTranscriptScope } from "@/storage/session-transcript-scope";
import { projectConfirmedTranscript } from "@/storage/session-transcript-projection";
import { loadProfiles, persistProfiles } from "@/storage/profile-store";

function render() {
  host.stateIndex = host.refIndex = 0;
  return (AppProvider({ children: null }) as ReactElement<{ value: { runtime: { reauthorizationRequired: boolean } } }>).props.value;
}
function coordinator() {
  return host.refs.map(ref => ref.current).find(value => value instanceof ProfileCoordinator) as ProfileCoordinator;
}
function denialRecorder() {
  render();
  const effect = host.effects.find(item => item.deps?.length === 2 && item.deps[0] === false && item.deps[1] instanceof ProfileCoordinator);
  if (!effect) throw new Error("AppProvider denial recorder effect was not captured");
  effect.effect();
  if (!host.denialRecorder) throw new Error("AppProvider did not install its denial recorder");
  return host.denialRecorder;
}
function cacheRecord(profileValue: typeof profile, content: string) {
  const scope = captureSessionTranscriptScope(profileValue, server, "/workspace", "thread-1");
  const record = projectConfirmedTranscript(scope, { messages: [{ id: "confirmed-1", role: "assistant", content, timestampMs: 1 }] }, { title: "Cached", updatedAt: 1 });
  return { scope, record };
}
async function putCache(profileValue: typeof profile, content: string, last = false) {
  const { scope, record } = cacheRecord(profileValue, content);
  const lease = await sessionTranscriptCache.capture(scope, () => true);
  await sessionTranscriptCache.save(lease, record, last);
  return scope;
}
function witness(profileValue: typeof profile) {
  return { profileId: profileValue.id, baseUrl: profileValue.baseUrl, authMode: profileValue.authMode,
    authorizationGeneration: profileValue.authorizationGeneration, deviceId: profileValue.deviceId,
    accessToken: profileValue.accessToken, refreshToken: profileValue.refreshToken };
}
function setupProfiles() {
  const deniedA = { ...profile, id: "profile-A", authorizationGeneration: "generation-A", accessToken: "access-A" };
  const liveB = { ...profile, id: "profile-B", authorizationGeneration: "generation-B", accessToken: "access-B" };
  host.persistedProfiles = [deniedA, liveB]; host.persistedActiveId = liveB.id;
  host.effects = [];
  render();
  coordinator().hydrate({ profiles: [deniedA, liveB], activeId: liveB.id });
  return { deniedA, liveB };
}
function holdCacheInvalidation() {
  let release!: () => void;
  let entered!: () => void;
  let finish!: () => void;
  let invoked = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = sessionTranscriptCache.invalidateProfile.bind(sessionTranscriptCache);
  const spy = vi.spyOn(sessionTranscriptCache, "invalidateProfile").mockImplementation(async (cachedProfile, isCurrent) => {
    invoked = true;
    entered(); await held;
    try { return await original(cachedProfile, isCurrent); }
    finally { finish(); }
  });
  return { started, finished, release, async drain() { release(); if (invoked) await finished; }, restore: () => spy.mockRestore() };
}
beforeEach(() => {
  host.states = []; host.refs = []; host.setters = []; host.effects = []; host.stateIndex = host.refIndex = 0;
  host.denialRecorder = undefined; host.denialChecker = undefined;
  host.persistedProfiles = []; host.persistedActiveId = null;
  host.transcriptManifest = null; host.transcriptEntries.clear();
  vi.mocked(loadProfiles).mockClear(); vi.mocked(persistProfiles).mockClear();
});

it("a background A denial invalidates only A's actual cache while B stays active", async () => {
  const { deniedA, liveB } = setupProfiles();
  const aScope = await putCache(deniedA, "A cached secret");
  const bScope = await putCache(liveB, "B remains", true);
  expect((await sessionTranscriptCache.load(await sessionTranscriptCache.capture(aScope, () => true)))?.record.messages[0].content).toBe("A cached secret");

  await denialRecorder()(witness(deniedA));

  expect(coordinator().getSnapshot().activeId).toBe(liveB.id);
  expect(await sessionTranscriptCache.load(await sessionTranscriptCache.capture(aScope, () => true))).toBeNull();
  expect((await sessionTranscriptCache.load(await sessionTranscriptCache.capture(bScope, () => true)))?.record.messages[0].content).toBe("B remains");
  expect((await sessionTranscriptCache.last(liveB, () => true))?.record.messages[0].content).toBe("B remains");
});

it("a held exact-denial cleanup cannot erase a same-scope cache saved after validated refresh", async () => {
  const { deniedA, liveB } = setupProfiles();
  const bScope = await putCache(liveB, "B remains", true);
  const oldWitness = witness(deniedA);
  const recordDenial = denialRecorder();
  const liveCoordinator = coordinator();
  const cleanup = holdCacheInvalidation();
  try {
    expect(await recordDenial(oldWitness)).toBe(true);
    await cleanup.started;
    const currentDeniedA = liveCoordinator.getSnapshot().profiles.find(value => value.id === "profile-A")!;
    const renewed = await liveCoordinator.updateCredentials(currentDeniedA, { ...currentDeniedA, accessToken: "access-A2", refreshToken: "refresh-A2" }, persistProfiles, "validated-refresh");
    expect(renewed).not.toHaveProperty("reauthorizationRequiredScope");
    if (!renewed) throw new Error("Validated refresh did not return the current profile");
    const newAScope = await putCache(renewed, "A renewed content", true);
    cleanup.release();
    await cleanup.finished;
    expect((await sessionTranscriptCache.load(await sessionTranscriptCache.capture(newAScope, () => true)))?.record.messages[0].content).toBe("A renewed content");
    expect((await sessionTranscriptCache.load(await sessionTranscriptCache.capture(bScope, () => true)))?.record.messages[0].content).toBe("B remains");
    expect(host.denialChecker?.(oldWitness)).toBe(false);
    expect(await recordDenial(oldWitness)).toBe(false);
    expect((await sessionTranscriptCache.load(await sessionTranscriptCache.capture(newAScope, () => true)))?.record.messages[0].content).toBe("A renewed content");
  } finally {
    await cleanup.drain(); cleanup.restore();
  }
});

it("the active-marker cleanup effect retains its exact grant witness across validated refresh", async () => {
  const deniedA = { ...profile, id: "profile-A", authorizationGeneration: "generation-A", accessToken: "access-A" };
  deniedA.reauthorizationRequiredScope = profileAuthorizationScopeKey(deniedA);
  const liveB = { ...profile, id: "profile-B", authorizationGeneration: "generation-B", accessToken: "access-B" };
  host.persistedProfiles = [deniedA, liveB]; host.persistedActiveId = deniedA.id;
  render();
  const liveCoordinator = coordinator();
  liveCoordinator.hydrate({ profiles: [deniedA, liveB], activeId: deniedA.id });
  host.setters[4]!([deniedA, liveB]); host.setters[6]!(deniedA.id);
  host.setters[7]!({ servers: [], statuses: [], loading: false, serversReady: false, serversRevision: 0,
    statusRefreshing: false, statusError: null, serversUpdatedAt: null, statusesUpdatedAt: null,
    error: "Gateway 会话已失效，请重新授权", reauthorizationRequired: true });
  const aScope = await putCache(deniedA, "A denied content");
  const bScope = await putCache(liveB, "B remains", true);
  const oldWitness = witness(deniedA);
  const recordDenial = denialRecorder();
  const cleanup = holdCacheInvalidation();
  try {
    const cleanupEffect = host.effects.find(item => item.deps?.length === 4 &&
      (item.deps[0] as { id?: string } | null)?.id === deniedA.id && item.deps[1] === true && item.deps[2] === false);
    if (!cleanupEffect) throw new Error("AppProvider active denial cleanup effect was not captured");
    cleanupEffect.effect();
    await cleanup.started;
    const currentDeniedA = liveCoordinator.getSnapshot().profiles.find(value => value.id === "profile-A")!;
    const renewed = await liveCoordinator.updateCredentials(currentDeniedA, { ...currentDeniedA, accessToken: "access-A2", refreshToken: "refresh-A2" }, persistProfiles, "validated-refresh");
    expect(renewed).not.toHaveProperty("reauthorizationRequiredScope");
    if (!renewed) throw new Error("Validated refresh did not return the current profile");
    const newAScope = await putCache(renewed, "A renewed content", true);
    cleanup.release();
    await cleanup.finished;
    expect((await sessionTranscriptCache.load(await sessionTranscriptCache.capture(newAScope, () => true)))?.record.messages[0].content).toBe("A renewed content");
    expect((await sessionTranscriptCache.load(await sessionTranscriptCache.capture(bScope, () => true)))?.record.messages[0].content).toBe("B remains");
    expect(host.denialChecker?.(oldWitness)).toBe(false);
    expect(await recordDenial(oldWitness)).toBe(false);
    expect((await sessionTranscriptCache.load(await sessionTranscriptCache.capture(aScope, () => true)))?.record.messages[0].content).toBe("A renewed content");
  } finally {
    await cleanup.drain(); cleanup.restore();
  }
});
