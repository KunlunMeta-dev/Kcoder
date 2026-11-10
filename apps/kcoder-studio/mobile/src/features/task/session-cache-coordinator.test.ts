import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayAuthorizationDenialWitness, GatewayProfile, KCoderServer } from "@/gateway/types";
import type { TaskRuntime } from "@/runtime/task-runtime";
import { captureSessionTranscriptScope } from "@/storage/session-transcript-scope";
import { projectConfirmedTranscript, decodeConfirmedTranscript } from "@/storage/session-transcript-projection";
import { createSessionTranscriptStore } from "@/storage/session-transcript-store";
import type { SessionTranscriptBackend } from "@/storage/session-transcript-backend-contract";
import { ProfileCoordinator, profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { normalizeHistoryPage } from "@/runtime/task-runtime/history";
import { ensureAssistantMessage } from "@/runtime/task-runtime/snapshotReducer";
import type { ChatMessage } from "@/runtime/task-runtime";
import type { ThreadPresenceObservation } from "@/runtime/task-runtime/thread-presence";
import { cachedSessionMatches, cacheProfileReadable, SessionCacheCoordinator } from "./session-cache-coordinator";

// These tests isolate coordinator ownership; the real fixed-fence path has separate integration coverage.
vi.mock("@/runtime/task-runtime/cache-publication", () => ({
  captureRuntimeTranscriptLease: async (_runtime: unknown, scope: unknown, isCurrent: () => boolean,
    cache: { capture: (scope: unknown, isCurrent: () => boolean) => Promise<unknown> }) => cache.capture(scope, isCurrent),
}));

const profile: GatewayProfile = { id: "p", label: "P", baseUrl: "https://gateway.example/g/g1", authMode: "device",
  authorizationGeneration: "g1", deviceId: "d1", accessToken: "access", rpcToken: "rpc", refreshToken: "refresh", refreshExpiresAt: Number.MAX_SAFE_INTEGER, expiresAt: 1 };
const server: KCoderServer = { id: "s", label: "S", description: "", runtime: "kcoder", transport: "local", workspacePath: "/w" };
const scope = captureSessionTranscriptScope(profile, server, "/w", "t");
const page = { messages: [{ id: "u", role: "user", content: "CONFIRMED", timestampMs: 1 }], hasMoreBefore: false };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function fixture() {
  let current = true;
  const record = projectConfirmedTranscript(scope, page, { title: "Title", updatedAt: 100 });
  const value = decodeConfirmedTranscript(JSON.stringify(record), scope)!;
  const last = vi.fn(async () => value);
  const cache = { last, capture: vi.fn(async (_scope: unknown, isCurrent: () => boolean) => ({ scope, epoch: "e", revision: 1, isCurrent })),
    load: vi.fn(async () => value), loadVersioned: vi.fn(async () => {
      const loaded = await last();
      return loaded ? { value: loaded, version: { epoch: "e".repeat(64), dataRevision: 1 } } : null;
    }),
    save: vi.fn(async (_lease: unknown, _record: unknown, _lastRoute?: boolean) => {}),
    invalidateThreadIfVersion: vi.fn(async () => true) };
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => current, cache as never);
  return { coordinator, cache, value, dispose: () => { current = false; coordinator.close(); } };
}
function runtimeFixture() {
  const listeners = new Set<() => void>();
  const runtime = { disposed: false, completedTranscriptRevision: 0, confirmedTranscriptRevision: 0,
    confirmedTranscriptPage: null as { page: typeof page; confirmedAt: number } | null,
    getSnapshot: () => ({ threadId: "t", cwd: "/w", title: "Title", activeTurnId: null, messages: normalizeHistoryPage(page).messages }),
    subscribe: (callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); },
    readConfirmedTranscriptPage: vi.fn(async () => {
      runtime.confirmedTranscriptRevision = runtime.completedTranscriptRevision;
      return runtime.confirmedTranscriptPage = { page, confirmedAt: 200 };
    }),
    applyDeferredConfirmedTranscriptPage: vi.fn((_isCurrent: () => boolean) => false),
  };
  return { runtime, changed: () => { for (const listener of listeners) listener(); }, listeners };
}
afterEach(() => vi.useRealTimers());
describe("route-owned confirmed transcript recovery", () => {
  it("applies deferred UI only for a current user's return to latest", () => {
    const f = fixture(), r = runtimeFixture();
    f.coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    f.coordinator.readAnchor({ messageId: "u", offset: 0, followsLatest: true });
    f.coordinator.readAnchor({ messageId: "u", offset: 17, followsLatest: false }, true);
    expect(r.runtime.applyDeferredConfirmedTranscriptPage).not.toHaveBeenCalled();
    f.coordinator.readAnchor({ messageId: "u", offset: 0, followsLatest: true }, true);
    expect(r.runtime.applyDeferredConfirmedTranscriptPage).toHaveBeenCalledTimes(1);
    const [current] = r.runtime.applyDeferredConfirmedTranscriptPage.mock.calls[0];
    expect(current()).toBe(true);
    f.dispose();
    expect(current()).toBe(false);
  });
  it.each(["deviceId", "authMode", "authorizationGeneration", "baseUrl"] as const)("late local read cannot publish after %s changes", async field => {
    const original = { ...profile }; let live = original;
    const pending = deferred<ReturnType<typeof fixture>["value"]>();
    const f = fixture(); f.cache.last.mockImplementation(() => pending.promise);
    const captured = profileAuthorizationScopeKey(original);
    const coordinator = new SessionCacheCoordinator({ profile: original, serverId: "s", threadId: "t" },
      () => profileAuthorizationScopeKey(live) === captured, f.cache as never);
    const result = coordinator.load();
    live = { ...original, [field]: field === "authMode" ? "legacy" : "changed" };
    pending.resolve(f.value);
    expect(await result).toBeNull(); expect(f.cache.save).not.toHaveBeenCalled();
    coordinator.close(); f.dispose();
  });
  it("short-token rotation retains identity; expiry without refresh and reauthorization deny display", () => {
    expect(profileAuthorizationScopeKey({ ...profile, accessToken: "new", expiresAt: 999 })).toBe(profileAuthorizationScopeKey(profile));
    expect(cacheProfileReadable(profile, false)).toBe(true);
    expect(cacheProfileReadable({ ...profile, refreshToken: undefined }, false)).toBe(false);
    expect(cacheProfileReadable(profile, true)).toBe(false);
  });
  it("a persisted denial only blocks cache reads for the matching authorization scope", () => {
    const blocked = { ...profile, reauthorizationRequiredScope: profileAuthorizationScopeKey(profile) } as GatewayProfile;
    expect(cacheProfileReadable(blocked, false)).toBe(false);
    expect(cacheProfileReadable({ ...blocked, accessToken: "rotated" }, false)).toBe(false);
    expect(cacheProfileReadable({ ...blocked, authorizationGeneration: "g2" }, false)).toBe(true);
  });
  it("missing server list retains cache but a changed confirmed target hides it", () => {
    const f = fixture(); const route = { profile, serverId: "s", threadId: "t", cwd: "/w" };
    expect(cachedSessionMatches(f.value, route)).toBe(true);
    expect(cachedSessionMatches(f.value, route, { ...server, command: "different" })).toBe(false);
    expect(cachedSessionMatches(f.value, route, server)).toBe(true); f.dispose();
  });
  it("revokes only an absent observation for this full route scope and version", async () => {
    const f = fixture();
    const version = { epoch: "e".repeat(64), dataRevision: 1 };
    const observation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" }, scope, version } as never;
    expect(await f.coordinator.revokeConfirmedAbsent(observation, server)).toBe(true);
    expect(f.cache.invalidateThreadIfVersion).toHaveBeenCalledTimes(1);
    expect(f.cache.invalidateThreadIfVersion).toHaveBeenCalledWith(expect.objectContaining({ scope }), version);
    f.dispose();
  });
  it("does not revoke a scope when the server absence echo names a different thread", async () => {
    const f = fixture();
    const observation: ThreadPresenceObservation = { result: { status: "absent", threadId: "other-thread", reason: "boundDeletedPrimarySource" },
      scope, version: { epoch: "e".repeat(64), dataRevision: 1 } };
    expect(await f.coordinator.revokeConfirmedAbsent(observation, server)).toBe(false);
    expect(f.cache.invalidateThreadIfVersion).not.toHaveBeenCalled();
    f.dispose();
  });
  it("does not accept an absent result with an unsupported proof reason", async () => {
    const f = fixture();
    const observation = { result: { status: "absent", threadId: "t", reason: "other" },
      scope, version: { epoch: "e".repeat(64), dataRevision: 1 } } as unknown as ThreadPresenceObservation;
    expect(await f.coordinator.revokeConfirmedAbsent(observation, server)).toBe(false);
    expect(f.cache.invalidateThreadIfVersion).not.toHaveBeenCalled();
    f.dispose();
  });
  it("reports an invalidation write failure separately while the same route still owns the request", async () => {
    const f = fixture();
    const observation: ThreadPresenceObservation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
      scope, version: { epoch: "e".repeat(64), dataRevision: 1 } };
    f.cache.invalidateThreadIfVersion.mockRejectedValueOnce(new Error("QuotaExceededError"));
    expect(await f.coordinator.revokeConfirmedAbsent(observation, server)).toBe("persistence-failed");
    expect(f.cache.invalidateThreadIfVersion).toHaveBeenCalledWith(expect.objectContaining({ scope }), observation.version);
    f.dispose();
  });
  it("blocks pending cache-only anchor publication for a bound absence without a version, then permits fresh live authority", async () => {
    vi.useFakeTimers();
    const f = fixture(), r = runtimeFixture();
    const observation: ThreadPresenceObservation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
      scope, version: null };
    try {
      await f.coordinator.load(server);
      f.coordinator.readAnchor({ messageId: "u", offset: 31, followsLatest: false }, true);
      expect(f.coordinator.suppressCacheOnlyWritesForConfirmedAbsent(observation, server)).toBe(true);
      await vi.advanceTimersByTimeAsync(250);
      await tick();
      expect(f.cache.save).not.toHaveBeenCalled();
      expect(f.cache.invalidateThreadIfVersion).not.toHaveBeenCalled();

      r.runtime.confirmedTranscriptPage = { page, confirmedAt: 200 };
      f.coordinator.watch(r.runtime as unknown as TaskRuntime, server);
      await tick();
      expect(f.coordinator.suppressCacheOnlyWritesForConfirmedAbsent(observation, server)).toBe(false);
      expect(f.cache.save).toHaveBeenCalledTimes(1);
      expect(f.cache.save.mock.calls[0][1]).toMatchObject({ updatedAt: 200 });
    } finally {
      f.dispose();
      vi.useRealTimers();
    }
  });
  it.each(["null-scope", "different-fingerprint"] as const)(
    "does not block cache-only anchor publication for %s absence", async stage => {
      vi.useFakeTimers();
      const f = fixture();
      const observation: ThreadPresenceObservation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
        scope: stage === "null-scope" ? null : captureSessionTranscriptScope(profile,
          { ...server, acceptNewHostKey: true }, "/w", "t"), version: null };
      try {
        await f.coordinator.load(server);
        f.coordinator.readAnchor({ messageId: "u", offset: 31, followsLatest: false }, true);
        expect(f.coordinator.suppressCacheOnlyWritesForConfirmedAbsent(observation, server)).toBe(false);
        await vi.advanceTimersByTimeAsync(250);
        await tick();
        expect(f.cache.save).toHaveBeenCalledTimes(1);
      } finally {
        f.dispose();
        vi.useRealTimers();
      }
    },
  );
  it("a failed absence write cancels cache-only anchor writes but a later live page can save", async () => {
    vi.useFakeTimers();
    const f = fixture(), r = runtimeFixture();
    const observation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
      scope, version: { epoch: "e".repeat(64), dataRevision: 1 } } as never;
    try {
      await f.coordinator.load(server);
      f.coordinator.readAnchor({ messageId: "u", offset: 17, followsLatest: false }, true);
      f.cache.invalidateThreadIfVersion.mockRejectedValueOnce(new Error("storage failure"));
      expect(await f.coordinator.revokeConfirmedAbsent(observation, server)).toBe("persistence-failed");
      await vi.advanceTimersByTimeAsync(250);
      await tick();
      expect(f.cache.save).not.toHaveBeenCalled();

      r.runtime.confirmedTranscriptPage = { page, confirmedAt: 200 };
      f.coordinator.watch(r.runtime as unknown as TaskRuntime, server);
      await tick();
      expect(f.cache.save).toHaveBeenCalledTimes(1);
      expect(f.cache.save.mock.calls[0][1]).toMatchObject({ updatedAt: 200 });
    } finally {
      f.dispose();
      vi.useRealTimers();
    }
  });
  it("does not turn an invalidation error into absence after live authority starts", async () => {
    const f = fixture(), r = runtimeFixture(), held = deferred<null>();
    f.cache.invalidateThreadIfVersion.mockImplementationOnce(async () => { await held.promise; throw new Error("storage failure"); });
    const observation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
      scope, version: { epoch: "e".repeat(64), dataRevision: 1 } } as never;
    const revoking = f.coordinator.revokeConfirmedAbsent(observation, server);
    await tick();
    f.coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    held.resolve(null);
    expect(await revoking).toBe(false);
    f.dispose();
  });
  it("ignores a late absence after the same route has acquired live authority", async () => {
    const f = fixture(), r = runtimeFixture();
    f.coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    const observation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
      scope, version: { epoch: "e".repeat(64), dataRevision: 1 } } as never;
    expect(await f.coordinator.revokeConfirmedAbsent(observation, server)).toBe(false);
    expect(f.cache.invalidateThreadIfVersion).not.toHaveBeenCalled();
    f.dispose();
  });
  it("does not issue a versioned delete when its route owner expires during lease capture", async () => {
    const f = fixture(), held = deferred<{ scope: typeof scope; epoch: string; revision: number; isCurrent: () => boolean }>();
    f.cache.capture.mockReturnValueOnce(held.promise as never);
    const observation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
      scope, version: { epoch: "e".repeat(64), dataRevision: 1 } } as never;
    const pending = f.coordinator.revokeConfirmedAbsent(observation, server);
    await tick(); f.dispose(); held.resolve({ scope, epoch: "e", revision: 1, isCurrent: () => false });
    expect(await pending).toBe(false);
    expect(f.cache.invalidateThreadIfVersion).not.toHaveBeenCalled();
  });
  it("inline resume saves authority without another read; idle/disconnect are not completed turns", async () => {
    const f = fixture(), r = runtimeFixture(); r.runtime.confirmedTranscriptPage = { page, confirmedAt: 100 };
    f.coordinator.watch(r.runtime as unknown as TaskRuntime, server); await tick(); r.changed(); await tick();
    expect(f.cache.save).toHaveBeenCalledTimes(1); expect(r.runtime.readConfirmedTranscriptPage).not.toHaveBeenCalled(); f.dispose();
  });
  it("persists the latest anchor after an initial authority save settles", async () => {
    vi.useFakeTimers();
    const f = fixture(), r = runtimeFixture(), entered = deferred<null>(), release = deferred<null>();
    r.runtime.confirmedTranscriptPage = { page, confirmedAt: 100 };
    f.cache.save.mockImplementationOnce(async () => { entered.resolve(null); await release.promise; });
    try {
      f.coordinator.watch(r.runtime as unknown as TaskRuntime, server);
      await entered.promise;
      f.coordinator.readAnchor({ messageId: "u", offset: 42, followsLatest: false }, true);
      await vi.advanceTimersByTimeAsync(250);
      release.resolve(null);
      await tick();
      expect(f.cache.save).toHaveBeenCalledTimes(2);
      expect(f.cache.save.mock.calls[1][1]).toMatchObject({ updatedAt: 100, anchor: { messageId: "u", offset: 42, followsLatest: false } });
    } finally {
      release.resolve(null);
      f.dispose();
      vi.useRealTimers();
    }
  });
  it("completion before UI subscription reads exactly one bounded authority page", async () => {
    const f = fixture(), r = runtimeFixture(); r.runtime.completedTranscriptRevision = 1;
    f.coordinator.watch(r.runtime as unknown as TaskRuntime, server); await tick(); r.changed(); await tick();
    expect(r.runtime.readConfirmedTranscriptPage).toHaveBeenCalledTimes(1); expect(f.cache.save).toHaveBeenCalledTimes(1); f.dispose();
  });
  it("live terminal reads once and a late completion after owner disposal cannot save", async () => {
    const f = fixture(), r = runtimeFixture(); const pending = deferred<null>();
    r.runtime.readConfirmedTranscriptPage.mockImplementation(async () => { await pending.promise; return r.runtime.confirmedTranscriptPage = { page, confirmedAt: 200 }; });
    f.coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    r.runtime.completedTranscriptRevision = 1; r.changed(); r.changed();
    expect(r.runtime.readConfirmedTranscriptPage).toHaveBeenCalledTimes(1);
    f.dispose(); pending.resolve(null); await tick();
    expect(f.cache.save).not.toHaveBeenCalled(); expect(r.listeners.size).toBe(0);
  });
  it("cached-only reading obtains a lease and persists the marker without changing confirmation time", async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.coordinator.load(server);
    f.coordinator.readAnchor({ messageId: "u", offset: 20, followsLatest: false });
    await vi.advanceTimersByTimeAsync(250);
    expect(f.cache.save.mock.calls.at(-1)?.[1]).toMatchObject({ updatedAt: 100, anchor: { offset: 20 } }); f.dispose();
  });
  it("anchor-only persistence retains authoritative confirmation time", async () => {
    vi.useFakeTimers(); const f = fixture(), r = runtimeFixture(); r.runtime.confirmedTranscriptPage = { page, confirmedAt: 100 };
    f.coordinator.watch(r.runtime as unknown as TaskRuntime, server); await tick();
    f.coordinator.readAnchor({ messageId: "u", offset: 33, followsLatest: false }); await vi.advanceTimersByTimeAsync(250);
    expect(f.cache.save.mock.calls.at(-1)?.[1]).toMatchObject({ updatedAt: 100, anchor: { messageId: "u", offset: 33 } }); f.dispose();
  });
});


it("watch restart on the same runtime shares its held terminal read", async () => {
  const f = fixture(), r = runtimeFixture(), held = deferred<null>();
  r.runtime.completedTranscriptRevision = 1;
  r.runtime.readConfirmedTranscriptPage.mockImplementation(async () => {
    await held.promise;
    r.runtime.confirmedTranscriptRevision = 1;
    return r.runtime.confirmedTranscriptPage = { page, confirmedAt: 200 };
  });
  const stop = f.coordinator.watch(r.runtime as unknown as TaskRuntime, server);
  stop(); f.coordinator.watch(r.runtime as unknown as TaskRuntime, { ...server });
  expect(r.runtime.readConfirmedTranscriptPage).toHaveBeenCalledTimes(1);
  held.resolve(null); await tick();
  expect(f.cache.save).toHaveBeenCalledTimes(1);
  expect(f.cache.save.mock.calls[0][1]).toMatchObject({ updatedAt: 200 });
  f.dispose();
});

it("a resident authority page accepts a late cached anchor without replacing live rows", async () => {
  const f = fixture(), r = runtimeFixture(), held = deferred<typeof f.value>();
  f.value.record.anchor = { messageId: "u", offset: 19, followsLatest: false };
  f.cache.last.mockReturnValue(held.promise);
  r.runtime.confirmedTranscriptPage = { page, confirmedAt: 300 };
  const load = f.coordinator.load(server);
  f.coordinator.watch(r.runtime as unknown as TaskRuntime, server); await tick();
  held.resolve(f.value); await load;
  expect(f.coordinator.anchor).toEqual(f.value.record.anchor);
  expect(f.cache.save.mock.calls.at(-1)?.[1]).toMatchObject({ updatedAt: 300 });
  f.dispose();
});


it("late local marker replaces an automatic latest sample but never an explicit reading decision", async () => {
  for (const userDecision of [false, true]) {
    const f = fixture(), held = deferred<typeof f.value>();
    f.value.record.anchor = { messageId: "u", offset: 27, followsLatest: false };
    f.cache.last.mockReturnValue(held.promise);
    const load = f.coordinator.load(server);
    f.coordinator.readAnchor({ messageId: "u", offset: 0, followsLatest: true }, userDecision);
    held.resolve(f.value); await load;
    expect(f.coordinator.anchor?.offset).toBe(userDecision ? 0 : 27);
    f.dispose();
  }
});


it("nonrenewable expiry fences a held local read before any UI rerender", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const f = fixture(), pending = deferred<typeof f.value>();
  const expiring = { ...profile, refreshToken: undefined, expiresAt: 1100 };
  f.cache.last.mockReturnValue(pending.promise);
  const coordinator = new SessionCacheCoordinator({ profile: expiring, serverId: "s", threadId: "t" },
    () => cacheProfileReadable(expiring, false), f.cache as never);
  const result = coordinator.load();
  await vi.advanceTimersByTimeAsync(100); pending.resolve(f.value);
  expect(await result).toBeNull(); expect(f.cache.save).not.toHaveBeenCalled();
  coordinator.close(); f.dispose();
});


it.each([undefined, 999])("expired access with unknown/expired refresh deadline %s cannot display cache", refreshExpiresAt => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  expect(cacheProfileReadable({ ...profile, expiresAt: 999, refreshExpiresAt }, false)).toBe(false);
  expect(cacheProfileReadable({ ...profile, authMode: "legacy", expiresAt: 999, refreshExpiresAt: 2000 }, false)).toBe(false);
});

it("renewable credentials expiring during a held load deny its late cached result", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const f = fixture(), held = deferred<typeof f.value>();
  const expiring = { ...profile, expiresAt: 1050, refreshExpiresAt: 1100 };
  f.cache.last.mockReturnValue(held.promise);
  const coordinator = new SessionCacheCoordinator({ profile: expiring, serverId: "s", threadId: "t" }, () => cacheProfileReadable(expiring, false), f.cache as never);
  const loading = coordinator.load();
  await vi.advanceTimersByTimeAsync(100); held.resolve(f.value);
  expect(await loading).toBeNull(); expect(f.cache.capture).not.toHaveBeenCalled();
  coordinator.close(); f.dispose();
});

it("a newer terminal during shared read1 is read once after watch restart and saves page2", async () => {
  const f = fixture(), r = runtimeFixture(), held = deferred<null>();
  r.runtime.completedTranscriptRevision = 1;
  let reads = 0;
  r.runtime.readConfirmedTranscriptPage.mockImplementation(async () => {
    const revision = r.runtime.completedTranscriptRevision;
    if (++reads === 1) await held.promise;
    r.runtime.confirmedTranscriptRevision = revision;
    return r.runtime.confirmedTranscriptPage = { page: { ...page, messages: [{ ...page.messages[0], content: `page${revision}` }] }, confirmedAt: revision * 100 };
  });
  const stop = f.coordinator.watch(r.runtime as unknown as TaskRuntime, server);
  r.runtime.completedTranscriptRevision = 2; r.changed();
  stop(); f.coordinator.watch(r.runtime as unknown as TaskRuntime, { ...server });
  expect(reads).toBe(1);
  held.resolve(null); await tick(); await tick();
  expect(reads).toBe(2);
  expect(f.cache.save.mock.calls.at(-1)?.[1]).toMatchObject({ updatedAt: 200, messages: [{ content: "page2" }] });
  r.changed(); await tick(); expect(reads).toBe(2);
  f.dispose();
});


function persistedCacheFixture() {
  let manifest: string | null = null;
  const entries = new Map<number, { revision: number; raw: string }>();
  const backend: SessionTranscriptBackend = {
    async readManifest() { return manifest; },
    async readEntry(slot, revision) { const row = entries.get(slot); return row?.revision === revision ? row.raw : null; },
    async reset(raw, guard) { if (!guard()) throw new Error("disposed"); entries.clear(); manifest = raw; },
    async commit(change, guard) {
      if (!guard()) throw new Error("disposed");
      if (change.put) entries.set(change.put.slot, { revision: change.put.revision, raw: change.put.raw });
      for (const slot of change.removeSlots) entries.delete(slot);
      manifest = change.manifest;
    },
  };
  // Actual store/parser and coordinator, with a serialized in-memory storage gate.
  // This contract does not claim IndexedDB/Native publication or profile authorization coverage.
  let tail: Promise<unknown> = Promise.resolve();
  const fence = <T>(_identity: unknown, operation: () => Promise<T>): Promise<T> => {
    const result = tail.catch(() => {}).then(() => operation()); tail = result; return result;
  };
  return { backend, cache: createSessionTranscriptStore(backend, fence) };
}

it("a held versioned absence cannot erase the pre-probe cache after live authority starts", async () => {
  const f = persistedCacheFixture(), r = runtimeFixture();
  const initial = projectConfirmedTranscript(scope, page, { title: "Title", updatedAt: 100 });
  await f.cache.save(await f.cache.capture(scope, () => true), initial, true);
  const observed = await f.cache.loadVersioned(await f.cache.capture(scope, () => true));
  expect(observed).not.toBeNull();

  const casEntered = deferred<null>(), releaseCas = deferred<null>();
  const authoritySaveEntered = deferred<null>(), releaseAuthoritySave = deferred<null>();
  const authoritySaveSettled = deferred<null>();
  let casLease: { epoch: string; revision: number } | undefined;
  let authorityLease: { epoch: string; revision: number } | undefined;
  let stop: (() => void) | undefined;
  let heldSaveEntered = false;
  const cache = {
    ...f.cache,
    save: async (lease: Parameters<typeof f.cache.save>[0], value: Parameters<typeof f.cache.save>[1], lastRoute?: boolean) => {
      if (!heldSaveEntered && value.updatedAt === 200) {
        heldSaveEntered = true;
        authorityLease = lease;
        authoritySaveEntered.resolve(null);
        await releaseAuthoritySave.promise;
      }
      try { await f.cache.save(lease, value, lastRoute); }
      finally { if (value.updatedAt === 200) authoritySaveSettled.resolve(null); }
    },
    invalidateThreadIfVersion: async (lease: Parameters<typeof f.cache.invalidateThreadIfVersion>[0], version: Parameters<typeof f.cache.invalidateThreadIfVersion>[1]) => {
      casLease = lease;
      casEntered.resolve(null);
      await releaseCas.promise;
      return f.cache.invalidateThreadIfVersion(lease, version);
    },
  };
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, cache as never);
  const absence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" }, scope, version: observed!.version } as never;
  const revoking = coordinator.revokeConfirmedAbsent(absence, server);
  try {
    await casEntered.promise;
    // The live page captures a lease from the still-published manifest before the
    // absence CAS is released, reproducing the stale-save/tombstone ordering.
    await coordinator.load(server);
    r.runtime.confirmedTranscriptPage = { page, confirmedAt: 200 };
    stop = coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    await authoritySaveEntered.promise;
    expect(authorityLease).toMatchObject({ epoch: casLease?.epoch, revision: casLease?.revision });

    releaseCas.resolve(null);
    await revoking;
    releaseAuthoritySave.resolve(null);
    await authoritySaveSettled.promise;

    const raw = JSON.parse((await f.backend.readManifest())!) as { entries: unknown[]; lastKey: string | null };
    expect(raw.entries).toHaveLength(1);
    expect(raw.lastKey).not.toBeNull();
    const reopened = createSessionTranscriptStore(f.backend, async (_identity, operation) => operation());
    const currentLease = await reopened.capture(scope, () => true);
    expect((await reopened.load(currentLease))?.record).toMatchObject({ updatedAt: 200, messages: [{ content: "CONFIRMED" }] });
    expect((await reopened.last(profile, () => true))?.record.updatedAt).toBe(200);
  } finally {
    releaseCas.resolve(null);
    releaseAuthoritySave.resolve(null);
    stop?.();
    coordinator.close();
    await revoking.catch(() => {});
    if (heldSaveEntered) await authoritySaveSettled.promise.catch(() => {});
  }
});

it("a failed live authority cache save remains retryable for the same confirmed page", async () => {
  const f = persistedCacheFixture(), r = runtimeFixture();
  await f.cache.save(await f.cache.capture(scope, () => true), projectConfirmedTranscript(scope, page, { title: "Title", updatedAt: 100 }), true);
  let saves = 0;
  const cache = { ...f.cache, save: async (lease: Parameters<typeof f.cache.save>[0], value: Parameters<typeof f.cache.save>[1], lastRoute?: boolean) => {
    if (value.updatedAt === 200 && ++saves === 1) throw new Error("transient cache write failure");
    return f.cache.save(lease, value, lastRoute);
  } };
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, cache as never);
  r.runtime.confirmedTranscriptPage = { page, confirmedAt: 200 };
  try {
    coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    await tick();
    expect(saves).toBe(1);
    expect((await f.cache.last(profile, () => true))?.record.updatedAt).toBe(100);
    r.changed();
    await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.updatedAt).toBe(200));
    expect(saves).toBe(2);
  } finally { coordinator.close(); }
});

it("a provisional auth denial closes held cache reads and writes before profile-index persistence settles", async () => {
  const current = { ...profile };
  let persistedProfile = { ...current };
  const profiles = new ProfileCoordinator({
    reload: async () => ({ profiles: [{ ...persistedProfile }], activeId: current.id }),
    serialize: operation => operation(),
  });
  profiles.hydrate({ profiles: [current], activeId: current.id });
  const f = persistedCacheFixture();
  const readable = () => cacheProfileReadable(current, false);
  const lease = await f.cache.capture(scope, readable);
  const saveEntered = deferred<null>(), releaseSave = deferred<null>();
  const backendCommit = f.backend.commit;
  f.backend.commit = async (change, guard) => {
    saveEntered.resolve(null);
    await releaseSave.promise;
    await backendCommit(change, guard);
  };
  const record = projectConfirmedTranscript(scope, page, { title: "Title", updatedAt: 100 });
  const saving = f.cache.save(lease, record, true);
  await saveEntered.promise;

  const persistEntered = deferred<null>(), releasePersist = deferred<null>();
  const witness: GatewayAuthorizationDenialWitness = {
    profileId: current.id,
    baseUrl: current.baseUrl,
    authMode: current.authMode,
    authorizationGeneration: current.authorizationGeneration,
    deviceId: current.deviceId,
    accessToken: current.accessToken,
    refreshToken: current.refreshToken,
  };
  const denial = profiles.recordAuthorizationDenial(witness, async next => {
    persistEntered.resolve(null);
    await releasePersist.promise;
    persistedProfile = { ...next[0] };
  });
  const reader = new SessionCacheCoordinator({ profile: current, serverId: "s", threadId: "t", cwd: "/w" }, readable, f.cache);
  try {
    expect(current.reauthorizationRequiredScope).toBe(profileAuthorizationScopeKey(current));
    await persistEntered.promise;
    // reloadSharedSnapshot saw the old unmarked index; the exact local witness
    // must keep the same live profile object and every captured cache lease shut.
    expect(current.reauthorizationRequiredScope).toBe(profileAuthorizationScopeKey(current));
    expect(lease.isCurrent()).toBe(false);
    expect(await reader.load(server)).toBeNull();

    releaseSave.resolve(null);
    await expect(saving).rejects.toThrow();
    expect(await f.cache.last(profile, () => true)).toBeNull();
    releasePersist.resolve(null);
    await expect(denial).resolves.toBe(true);
    expect(persistedProfile.reauthorizationRequiredScope).toBe(profileAuthorizationScopeKey(current));
  } finally {
    releaseSave.resolve(null);
    releasePersist.resolve(null);
    reader.close();
  }
});

it.each(["empty", "filtered"] as const)("a new %s confirmed page replaces persisted old rows without treating it as deletion", async kind => {
  const f = persistedCacheFixture(), r = runtimeFixture();
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, f.cache);
  r.runtime.confirmedTranscriptPage = { page, confirmedAt: 100 };
  coordinator.watch(r.runtime as unknown as TaskRuntime, server);
  await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.messages[0]?.content).toBe("CONFIRMED"));
  r.runtime.confirmedTranscriptPage = { page: { messages: kind === "empty" ? [] : [{ ...page.messages[0], id: "local-not-confirmed" }], hasMoreBefore: false }, confirmedAt: 200 };
  r.changed();
  await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record).toMatchObject({ updatedAt: 200, messages: [] }));
  const reopened = createSessionTranscriptStore(f.backend, async (_identity, operation) => operation());
  expect((await reopened.last(profile, () => true))?.record).toMatchObject({ updatedAt: 200, messages: [], scope: { threadId: "t" } });
  expect(r.runtime.readConfirmedTranscriptPage).not.toHaveBeenCalled();
  coordinator.close();
});

it("a held old anchor save cannot restore nonempty rows after an empty authoritative replacement", async () => {
  const f = persistedCacheFixture(), r = runtimeFixture();
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, f.cache);
  r.runtime.confirmedTranscriptPage = { page, confirmedAt: 100 };
  coordinator.watch(r.runtime as unknown as TaskRuntime, server);
  await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.messages).toHaveLength(1));
  vi.useFakeTimers();
  const held = deferred<null>(), entered = deferred<null>();
  const commit = f.backend.commit;
  let hold = true;
  f.backend.commit = async (change, guard) => {
    if (hold && change.put && JSON.parse(change.put.raw).anchor) {
      hold = false; entered.resolve(null); await held.promise;
    }
    await commit(change, guard);
  };
  coordinator.readAnchor({ messageId: "u", offset: 31, followsLatest: false });
  await vi.advanceTimersByTimeAsync(250); await entered.promise;
  r.runtime.confirmedTranscriptPage = { page: { messages: [], hasMoreBefore: false }, confirmedAt: 200 };
  r.changed(); held.resolve(null);
  for (let step = 0; step < 10; step++) await tick();
  const last = await f.cache.last(profile, () => true);
  expect(last?.record).toMatchObject({ updatedAt: 200, messages: [] });
  expect(last?.record.anchor).toBeUndefined();
  coordinator.readAnchor({ messageId: "u", offset: 99, followsLatest: false });
  await vi.advanceTimersByTimeAsync(250);
  expect((await f.cache.last(profile, () => true))?.record.messages).toEqual([]);
  expect(r.runtime.readConfirmedTranscriptPage).not.toHaveBeenCalled();
  coordinator.close();
});

it("same-authority anchor replacement preserves the published transcript cache", async () => {
  const f = persistedCacheFixture(), r = runtimeFixture();
  const peerScope = captureSessionTranscriptScope(profile, server, "/w", "peer");
  const peerRecord = projectConfirmedTranscript(peerScope, { ...page, messages: [{ ...page.messages[0], content: "PEER CONFIRMED" }] },
    { title: "Peer", updatedAt: 90 });
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, f.cache);
  const published = deferred<null>(), release = deferred<null>();
  try {
    await f.cache.save(await f.cache.capture(peerScope, () => true), peerRecord, false);
    r.runtime.confirmedTranscriptPage = { page, confirmedAt: 100 };
    coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.updatedAt).toBe(100));
    vi.useFakeTimers();
    const backendCommit = f.backend.commit;
    let holdPublishedAnchor = true;
    f.backend.commit = async (change, guard) => {
      await backendCommit(change, guard);
      if (holdPublishedAnchor && change.put && JSON.parse(change.put.raw).anchor) {
        holdPublishedAnchor = false;
        published.resolve(null);
        await release.promise;
      }
    };
    coordinator.readAnchor({ messageId: "u", offset: 31, followsLatest: false }, true);
    await vi.advanceTimersByTimeAsync(250);
    await published.promise;
    // The backend manifest and entry have already been published; only commit's return is held.
    expect(JSON.parse((await f.backend.readManifest())!).entries).toHaveLength(2);
    coordinator.readAnchor({ messageId: "u", offset: 62, followsLatest: false }, true);
    await vi.advanceTimersByTimeAsync(250);
    await tick();
    release.resolve(null);
    await tick();
    await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.anchor?.offset).toBe(62));
    const latest = await f.cache.last(profile, () => true);
    const peerLease = await f.cache.capture(peerScope, () => true);
    const peer = await f.cache.load(peerLease);
    expect.soft(latest?.record).toMatchObject({ messages: [{ content: "CONFIRMED" }], anchor: { messageId: "u", offset: 62, followsLatest: false } });
    expect.soft(peer?.record.messages).toMatchObject([{ content: "PEER CONFIRMED" }]);
  } finally {
    release.resolve(null);
    coordinator.close();
    vi.useRealTimers();
  }
});


it("persists a detached live assistant anchor against its confirmed source row", async () => {
  const f = persistedCacheFixture(), r = runtimeFixture();
  // Wire history IDs and the live reducer's display IDs are separate identities.
  const raw = { id: "history-entry-uuid", role: "assistant", turnId: "turn-1", attemptId: "attempt-1",
    content: "Confirmed assistant answer", timestampMs: 1 };
  const authority = { messages: [raw], hasMoreBefore: false };
  const normalized = normalizeHistoryPage(authority).messages;
  expect(normalized[0].id).toBe(raw.id);
  const live: ChatMessage[] = [];
  const rowIndex = ensureAssistantMessage.call({ attemptByTurn: new Map([["turn-1", "attempt-1"]]) } as TaskRuntime, live, "turn-1");
  expect(live[rowIndex].id).toBe("assistant-attempt-1");
  expect(live[rowIndex].id).not.toBe(normalized[0].id);
  // Exact turn/attempt binding is available; this does not simulate DOM geometry.
  const snapshot = r.runtime.getSnapshot();
  r.runtime.getSnapshot = () => ({ ...snapshot, messages: live });
  r.runtime.confirmedTranscriptPage = { page: authority, confirmedAt: 100 };
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, f.cache);
  try {
    coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.messages[0].id).toBe(raw.id));
    vi.useFakeTimers();
    coordinator.readAnchor({ messageId: live[rowIndex].id, offset: 33, followsLatest: false }, true);
    await vi.advanceTimersByTimeAsync(250);
    const cached = await f.cache.last(profile, () => true);
    // Reopened cache uses actual parser validation, not a mock save callback.
    expect(cached?.record.anchor).toEqual({ messageId: raw.id, offset: 33, followsLatest: false });
    expect(cached?.view.messages[0].id).toBe(cached?.record.anchor?.messageId);
    expect(cached?.record.updatedAt).toBe(100);
  } finally { coordinator.close(); }
});


it("an ambiguous live source drops only the persisted anchor while keeping confirmed body writable", async () => {
  const f = persistedCacheFixture(), r = runtimeFixture();
  const raw = { id: "raw1", role: "assistant", turnId: "turn", attemptId: "attempt", content: "first", timestampMs: 1 };
  const authority = { messages: [raw, { ...raw, id: "raw2", content: "second" }], hasMoreBefore: false };
  const snapshot = r.runtime.getSnapshot();
  r.runtime.getSnapshot = () => ({ ...snapshot, messages: [{ ...raw, id: "live" }] });
  r.runtime.confirmedTranscriptPage = { page: authority, confirmedAt: 100 };
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, f.cache);
  try {
    coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.messages).toHaveLength(2));
    vi.useFakeTimers(); coordinator.readAnchor({ messageId: "live", offset: 20, followsLatest: false }, true);
    await vi.advanceTimersByTimeAsync(250);
    expect((await f.cache.last(profile, () => true))?.record).toMatchObject({ messages: [{ content: "first" }, { content: "second" }] });
    expect((await f.cache.last(profile, () => true))?.record.anchor).toBeUndefined();
    r.runtime.confirmedTranscriptPage = { page: { ...authority, messages: [{ ...raw, content: "new authority" }] }, confirmedAt: 200 };
    r.changed(); await tick();
    expect((await f.cache.last(profile, () => true))?.record).toMatchObject({ updatedAt: 200, messages: [{ content: "new authority" }] });
    expect((await f.cache.last(profile, () => true))?.record.anchor).toBeUndefined();
  } finally { coordinator.close(); }
});

it("an authority or watch generation change before the anchor timer rejects the old binding", async () => {
  const f = fixture(), r = runtimeFixture(); r.runtime.confirmedTranscriptPage = { page, confirmedAt: 100 };
  const stop = f.coordinator.watch(r.runtime as unknown as TaskRuntime, server); await tick();
  vi.useFakeTimers(); f.coordinator.readAnchor({ messageId: "u", offset: 30, followsLatest: false }, true);
  stop(); f.coordinator.watch(r.runtime as unknown as TaskRuntime, server); await tick();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.cache.save.mock.calls.every(call => !(call[1] as { anchor?: unknown }).anchor)).toBe(true);
  f.dispose();
});

it("a current canonical marker translates into the live row without replacing transcript rows", async () => {
  const f = fixture(), r = runtimeFixture();
  const raw = { id: "history-row", role: "assistant", turnId: "turn", attemptId: "attempt", content: "authority", timestampMs: 1 };
  const authority = { messages: [raw], hasMoreBefore: false };
  const record = projectConfirmedTranscript(scope, authority, { title: "Title", updatedAt: 100, anchor: { messageId: raw.id, offset: 21, followsLatest: false } });
  f.cache.last.mockResolvedValue(decodeConfirmedTranscript(JSON.stringify(record), scope)!);
  const snapshot = r.runtime.getSnapshot(), messages = [{ ...raw, id: "live-row" }];
  r.runtime.getSnapshot = () => ({ ...snapshot, messages });
  r.runtime.confirmedTranscriptPage = { page: authority, confirmedAt: 100 };
  await f.coordinator.load(server);
  expect(f.coordinator.displayAnchor(r.runtime as unknown as TaskRuntime)).toEqual({ messageId: "live-row", offset: 21, followsLatest: false });
  expect(r.runtime.getSnapshot().messages).toBe(messages);
  r.runtime.confirmedTranscriptPage = { page: { ...authority, messages: [{ ...raw, id: "replacement" }] }, confirmedAt: 200 };
  // A missing canonical ID preserves only the in-memory detached-reading intent.
  expect(f.coordinator.displayAnchor(r.runtime as unknown as TaskRuntime)?.messageId).toBe(raw.id);
  f.dispose(); expect(f.coordinator.displayAnchor(r.runtime as unknown as TaskRuntime)).toBeUndefined();
});


it.each([false, true])("cache-only published anchor survives live watch activation (user decision: %s)", async userDecision => {
  const f = persistedCacheFixture(), r = runtimeFixture();
  const raw = { id: "raw-cache-row", role: "assistant", turnId: "turn", attemptId: "attempt", content: "confirmed", timestampMs: 1 };
  const authority = { messages: [raw], hasMoreBefore: false };
  const record = projectConfirmedTranscript(scope, authority, { title: "Title", updatedAt: 100,
    anchor: { messageId: raw.id, offset: 27, followsLatest: false } });
  const lease = await f.cache.capture(scope, () => true); await f.cache.save(lease, record, true);
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, f.cache);
  try {
    await coordinator.load(server);
    // The actual cache-only Transcript publishes raw row IDs before a Runtime exists.
    coordinator.readAnchor({ messageId: raw.id, offset: 29, followsLatest: false }, userDecision);
    const snapshot = r.runtime.getSnapshot();
    r.runtime.getSnapshot = () => ({ ...snapshot, messages: [{ ...raw, id: "live-cache-row" }] });
    r.runtime.confirmedTranscriptPage = { page: authority, confirmedAt: 200 };
    coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    expect(coordinator.displayAnchor(r.runtime as unknown as TaskRuntime)).toEqual({ messageId: "live-cache-row", offset: 29, followsLatest: false });
    await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record).toMatchObject({ updatedAt: 200,
      anchor: { messageId: raw.id, offset: 29, followsLatest: false } }));
  } finally { coordinator.close(); }
});


it("a live Runtime without a confirmed page cannot persist an anchor against older cached rows", async () => {
  const f = persistedCacheFixture(), r = runtimeFixture();
  const raw = { id: "old-raw", role: "assistant", turnId: "turn", attemptId: "attempt", content: "older confirmed body", timestampMs: 1 };
  const record = projectConfirmedTranscript(scope, { messages: [raw] }, { title: "Title", updatedAt: 100 });
  await f.cache.save(await f.cache.capture(scope, () => true), record, true);
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, f.cache);
  try {
    await coordinator.load(server);
    const snapshot = r.runtime.getSnapshot();
    r.runtime.getSnapshot = () => ({ ...snapshot, messages: [{ ...raw, id: "live-unconfirmed" }] });
    coordinator.watch(r.runtime as unknown as TaskRuntime, server);
    vi.useFakeTimers(); coordinator.readAnchor({ messageId: "live-unconfirmed", offset: 30, followsLatest: false }, true);
    await vi.advanceTimersByTimeAsync(250);
    expect((await f.cache.last(profile, () => true))?.record.anchor).toBeUndefined();
  } finally { coordinator.close(); }
});


it("reused coordinator preserves a new cache-only marker between live watch generations", async () => {
  const f = persistedCacheFixture(), a = runtimeFixture(), b = runtimeFixture();
  const raw = { id: "reused-raw", role: "assistant", turnId: "turn", attemptId: "attempt", content: "confirmed", timestampMs: 1 };
  const authority = { messages: [raw], hasMoreBefore: false };
  for (const [fixture, id, confirmedAt] of [[a, "live-a", 100], [b, "live-b", 200]] as const) {
    const snapshot = fixture.runtime.getSnapshot();
    fixture.runtime.getSnapshot = () => ({ ...snapshot, messages: [{ ...raw, id }] });
    fixture.runtime.confirmedTranscriptPage = { page: authority, confirmedAt };
  }
  const coordinator = new SessionCacheCoordinator({ profile, serverId: "s", threadId: "t", cwd: "/w" }, () => true, f.cache);
  try {
    const stopA = coordinator.watch(a.runtime as unknown as TaskRuntime, server);
    await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.updatedAt).toBe(100));
    vi.useFakeTimers();
    coordinator.readAnchor({ messageId: "live-a", offset: 10, followsLatest: false }, true);
    stopA();
    // The previous Runtime's display tuple must not migrate to the new Runtime.
    expect(coordinator.displayAnchor(b.runtime as unknown as TaskRuntime)).toBeUndefined();
    coordinator.readAnchor({ messageId: raw.id, offset: 31, followsLatest: false }, true);
    // The in-memory marker survives; there is no read lease to renew between Runtime owners.
    await vi.advanceTimersByTimeAsync(250);
    expect((await f.cache.last(profile, () => true))?.record.anchor).toBeUndefined();
    expect(coordinator.displayAnchor(b.runtime as unknown as TaskRuntime)).toEqual({ messageId: "live-b", offset: 31, followsLatest: false });
    coordinator.watch(b.runtime as unknown as TaskRuntime, server);
    await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record).toMatchObject({ updatedAt: 200,
      anchor: { messageId: raw.id, offset: 31, followsLatest: false } }));
    expect(coordinator.displayAnchor(b.runtime as unknown as TaskRuntime)).toEqual({ messageId: "live-b", offset: 31, followsLatest: false });
  } finally { coordinator.close(); }
});


it("blocks a cache-only anchor timer after the current route's absence lease capture fails", async () => {
  vi.useFakeTimers();
  const current = fixture();
  const observation: ThreadPresenceObservation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "e".repeat(64), dataRevision: 1 } };
  try {
    await current.coordinator.load(server);
    current.coordinator.readAnchor({ messageId: "u", offset: 31, followsLatest: false }, true);
    current.cache.capture.mockRejectedValueOnce(new Error("QuotaExceededError"));
    const result = await current.coordinator.revokeConfirmedAbsent(observation, server);
    await vi.advanceTimersByTimeAsync(250); await tick();
    expect(current.cache.invalidateThreadIfVersion).not.toHaveBeenCalled();
    expect(current.cache.save).not.toHaveBeenCalled();
    expect(result).toBe("persistence-failed");
  } finally {
    current.dispose(); vi.useRealTimers();
  }
});

it("keeps a lease-capture failure inert after the route owner expires", async () => {
  const observation: ThreadPresenceObservation = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "e".repeat(64), dataRevision: 1 } };
  const stale = fixture(), held = deferred<null>();
  stale.cache.capture.mockImplementationOnce(async () => { await held.promise; throw new Error("QuotaExceededError"); });
  const pending = stale.coordinator.revokeConfirmedAbsent(observation, server);
  await tick(); stale.dispose(); held.resolve(null);
  expect(await pending).toBe(false);
  expect(stale.cache.invalidateThreadIfVersion).not.toHaveBeenCalled();
  expect(stale.cache.save).not.toHaveBeenCalled();
});
