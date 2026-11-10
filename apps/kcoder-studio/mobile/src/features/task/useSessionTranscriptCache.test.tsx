// Actual cache hook and root route in a deterministic hook host. This is not mounted React.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type { TaskRuntime } from "@/runtime/task-runtime";
// Fixed Runtime publisher fencing is covered with the real helper and store in cache-publication.test.ts.
vi.mock("@/runtime/task-runtime/cache-publication", () => ({
  captureRuntimeTranscriptLease: async (_runtime: unknown, scope: unknown, isCurrent: () => boolean,
    cache: { capture: (scope: unknown, isCurrent: () => boolean) => Promise<unknown> }) => cache.capture(scope, isCurrent),
}));
const fixture = vi.hoisted(() => ({ load: vi.fn(), app: {} as Record<string, unknown>, version: "modern" }));
vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => fixture.version }));
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0, effectIndex: 0,
  effects: [] as { deps: readonly unknown[]; cleanup?: () => void }[],
  pending: [] as { index: number; deps: readonly unknown[]; run: () => void | (() => void) }[],
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ??= { current: initial },
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.states[index], (update: unknown) => { hooks.states[index] = typeof update === "function" ? (update as (value: unknown) => unknown)(hooks.states[index]) : update; }];
  },
  useEffect: (run: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.effectIndex++, old = hooks.effects[index];
    if (!old || old.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, old.deps[i]))) hooks.pending.push({ index, deps, run });
  },
}));
vi.mock("@/storage/session-transcript-cache", () => ({
  loadLastSessionTranscript: fixture.load,
  sessionTranscriptCache: {
    last: fixture.load,
    capture: async (scope: unknown, isCurrent: () => boolean) => { if (!isCurrent()) throw new Error("stale owner"); return { scope, isCurrent }; },
    loadVersioned: async () => {
      const value = await fixture.load();
      return value ? { value, version: { epoch: "a".repeat(64), dataRevision: 1 } } : null;
    },
    load: async () => null,
    save: vi.fn(async () => {}),
    invalidateThreadIfVersion: vi.fn(async () => true),
    invalidateWorkspaceIfVersion: vi.fn(async () => true),
  },
}));
vi.mock("@/storage/thread-deletion-cleanup", () => ({ isSessionTranscriptDeletionPending: vi.fn(async () => false) }));
vi.mock("@/state/AppContext", () => ({ useApp: () => fixture.app }));
vi.mock("@/theme", () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({ center: {} }) }));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", View: "View", StyleSheet: { create: (value: unknown) => value } }));
vi.mock("expo-router", () => ({ Redirect: "Redirect" }));
import IndexRoute from "@/app/index";
import { useSessionTranscriptCache } from "./useSessionTranscriptCache";
import { captureSessionTranscriptScope } from "@/storage/session-transcript-scope";
import { projectConfirmedTranscript, decodeConfirmedTranscript } from "@/storage/session-transcript-projection";
import { sessionTranscriptWorkspaceScopeKey } from "@/storage/session-transcript-scope";
import type { WorkspacePresenceObservation } from "@/runtime/task-runtime/workspace-presence";
const profile: GatewayProfile = { id: "p", label: "P", baseUrl: "https://gateway.example", authMode: "device", deviceId: "d", authorizationGeneration: "g", accessToken: "old", rpcToken: "old", refreshToken: "refresh", expiresAt: 1100, refreshExpiresAt: 1100 };
const server: KCoderServer = { id: "s", label: "S", runtime: "kcoder", transport: "local", workspacePath: "/w", description: "" };
const scope = captureSessionTranscriptScope(profile, server, "/w", "t");
const record = projectConfirmedTranscript(scope, { messages: [{ id: "u", role: "user", content: "CACHED", timestampMs: 1 }] }, { title: "Title", updatedAt: 100 });
const cached = decodeConfirmedTranscript(JSON.stringify(record), scope)!;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function render<T>(read: () => T): T {
  hooks.stateIndex = hooks.refIndex = hooks.effectIndex = 0; hooks.pending = [];
  const value = read();
  for (const effect of hooks.pending) {
    hooks.effects[effect.index]?.cleanup?.();
    const cleanup = effect.run();
    hooks.effects[effect.index] = { deps: effect.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  }
  return value;
}
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const workspaceServer = { ...server, observationTargetIdentity: "b".repeat(64) };
function workspaceProof(witness = true): WorkspacePresenceObservation {
  return { scope, isCurrent: () => true, result: { version: 1, status: "absent", targetId: server.id,
    targetSignature: workspaceServer.observationTargetIdentity, workspacePath: "/w", observedAt: 1000, loginGeneration: 1 },
  witness: witness ? { lease: { scope, epoch: "a".repeat(64), revision: 1, isCurrent: () => true },
    version: { epoch: "a".repeat(64), revision: 1, workspaceKey: sessionTranscriptWorkspaceScopeKey(scope),
      generation: 0, prefixDigest: "c".repeat(64) } } : null };
}
function route(mode: "task" | "root") {
  let current = { ...profile }, reauth = false;
  const read = () => {
    fixture.app = { hydrated: true, activeProfile: current, runtime: { reauthorizationRequired: reauth }, demo: false };
    return mode === "task" ? useSessionTranscriptCache({ profile: current, serverId: "s", threadId: "t", enabled: true, reauthorizationRequired: reauth, task: null }) : IndexRoute();
  };
  return { read, replace: (next: GatewayProfile) => { current = next; }, reauth: (value: boolean) => { reauth = value; } };
}
function visible(value: unknown, mode: "task" | "root") {
  return mode === "task" ? (value as ReturnType<typeof useSessionTranscriptCache>).cached?.record.messages[0]?.content :
    (value as ReactElement<{ href?: { pathname?: string } }>).props.href?.pathname;
}
beforeEach(async () => {
  fixture.version = "modern";
  vi.useFakeTimers(); vi.setSystemTime(1000); vi.clearAllMocks();
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = [];
  fixture.load.mockResolvedValue(cached);
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  vi.mocked(sessionTranscriptCache.invalidateWorkspaceIfVersion).mockReset().mockResolvedValue(true);
});

it.each(["v3", "modern", "classic"])("%s: cold launch without a recoverable transcript uses the version's entry", async version => {
  fixture.version = version;
  fixture.load.mockResolvedValue(null);
  const current = route("root");
  render(current.read); await tick();
  expect(visible(render(current.read), "root")).toBe(version === "v3" ? "/new" : "/h/[profileId]");
});

it("V3 cold launch restores the last transcript before considering a fresh draft", async () => {
  fixture.version = "v3";
  const current = route("root");
  render(current.read); await tick();
  expect(visible(render(current.read), "root")).toBe("/h/[profileId]/task/[serverId]/[threadId]");
});
afterEach(() => { for (const effect of hooks.effects) effect?.cleanup?.(); vi.useRealTimers(); });

it("workspace retry merges the same prefix proof while its held successful CAS clears the cache", async () => {
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  const held = deferred<boolean>();
  vi.mocked(sessionTranscriptCache.invalidateWorkspaceIfVersion).mockReturnValueOnce(held.promise);
  let workspacePresence: WorkspacePresenceObservation | null = workspaceProof();
  const read = () => useSessionTranscriptCache({ profile, server: workspaceServer, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, workspacePresence });
  render(read); await tick(); expect(render(read).cached).not.toBeNull();
  workspacePresence = null; render(read);
  workspacePresence = workspaceProof(); render(read); await tick();
  expect(sessionTranscriptCache.invalidateWorkspaceIfVersion).toHaveBeenCalledTimes(1);
  held.resolve(true); await tick();
  expect(render(read).workspaceAbsenceConfirmed).toBe(true);
  expect(render(read).cached).toBeNull();
});

it("a changed workspace prefix rejects absence navigation and keeps the cache visible", async () => {
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  vi.mocked(sessionTranscriptCache.invalidateWorkspaceIfVersion).mockResolvedValueOnce(false);
  const workspacePresence = workspaceProof();
  const read = () => useSessionTranscriptCache({ profile, server: workspaceServer, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, workspacePresence });
  render(read); await tick();
  expect(render(read).workspaceAbsenceConfirmed).toBe(false);
  expect(render(read).cached?.record.messages[0].content).toBe("CACHED");
});

it.each(["failed-write", "missing-witness"])("bound workspace absence %s hides only this route and blocks its pending anchor", async mode => {
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  if (mode === "failed-write") vi.mocked(sessionTranscriptCache.invalidateWorkspaceIfVersion).mockRejectedValueOnce(new Error("media"));
  const readableProfile = { ...profile, expiresAt: 2000, refreshExpiresAt: 3000 };
  let workspacePresence: WorkspacePresenceObservation | null = null;
  const read = () => useSessionTranscriptCache({ profile: readableProfile, server: workspaceServer, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, workspacePresence });
  render(read); await tick(); render(read).readAnchor?.({ messageId: "u", offset: 13, followsLatest: false }, true);
  workspacePresence = workspaceProof(mode !== "missing-witness"); render(read); await tick();
  await vi.advanceTimersByTimeAsync(250);
  expect(render(read).workspaceAbsenceConfirmed).toBe(true); expect(render(read).cached).toBeNull();
  expect(sessionTranscriptCache.save).not.toHaveBeenCalled();
  if (mode === "missing-witness") expect(sessionTranscriptCache.invalidateWorkspaceIfVersion).not.toHaveBeenCalled();
});

it("a workspace proof held by owner A cannot affect changed identity B or revive on A-B-A", async () => {
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  const held = deferred<boolean>(); vi.mocked(sessionTranscriptCache.invalidateWorkspaceIfVersion).mockReturnValueOnce(held.promise);
  const workspacePresence = workspaceProof(); let target = workspaceServer;
  const read = () => useSessionTranscriptCache({ profile, server: target, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, workspacePresence });
  render(read); await tick(); target = { ...workspaceServer, observationTargetIdentity: "d".repeat(64) }; render(read);
  held.resolve(true); await tick(); expect(render(read).workspaceAbsenceConfirmed).toBe(false);
  target = workspaceServer; render(read); await tick();
  expect(render(read).workspaceAbsenceConfirmed).toBe(false);
  expect(sessionTranscriptCache.invalidateWorkspaceIfVersion).toHaveBeenCalledTimes(1);
});

it("fresh live authority wins over a pending workspace absence proof", async () => {
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  const held = deferred<boolean>(); vi.mocked(sessionTranscriptCache.invalidateWorkspaceIfVersion).mockReturnValueOnce(held.promise);
  const workspacePresence = workspaceProof(); let task: TaskRuntime | null = null;
  const read = () => useSessionTranscriptCache({ profile, server: workspaceServer, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task, workspacePresence });
  render(read); await tick();
  task = { disposed: false, confirmedTranscriptPage: { page: { messages: [] }, confirmedAt: 200 },
    completedTranscriptRevision: 0, confirmedTranscriptRevision: 0,
    getSnapshot: () => ({ threadId: "t", cwd: "/w", title: "Live", activeTurnId: null, messages: [] }), subscribe: () => () => {},
  } as unknown as TaskRuntime;
  render(read); held.resolve(true); await tick();
  expect(render(read).workspaceAbsenceConfirmed).toBe(false);
});

it("retry revokes a null-witness workspace proof before its queued hook completion can navigate", async () => {
  let currentAttempt = true;
  let workspacePresence: WorkspacePresenceObservation | null = Object.assign(workspaceProof(false), { isCurrent: () => currentAttempt });
  const read = () => useSessionTranscriptCache({ profile, server: workspaceServer, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, workspacePresence });
  render(read);
  currentAttempt = false; workspacePresence = null; render(read); await tick();
  expect(render(read).workspaceAbsenceConfirmed).toBe(false);
});

it("a new Gateway login generation is not the same workspace absence proof", async () => {
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  const held = deferred<boolean>(); vi.mocked(sessionTranscriptCache.invalidateWorkspaceIfVersion).mockReturnValueOnce(held.promise).mockResolvedValueOnce(false);
  let workspacePresence = workspaceProof();
  const read = () => useSessionTranscriptCache({ profile, server: workspaceServer, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, workspacePresence });
  render(read); await tick(); workspacePresence = { ...workspaceProof(), result: { ...workspaceProof().result, loginGeneration: 2 } };
  render(read); await tick(); held.resolve(true); await tick();
  expect(render(read).workspaceAbsenceConfirmed).toBe(false);
});
it.each(["task", "root"] as const)("%s: same-scope refreshed object permits a held read after the old grant expires", async mode => {
  const held = deferred<typeof cached>(); fixture.load.mockReturnValueOnce(held.promise);
  const current = route(mode); render(current.read);
  current.replace({ ...profile, accessToken: "new", rpcToken: "new", refreshToken: "new-refresh", expiresAt: 2000, refreshExpiresAt: 3000 });
  render(current.read); await vi.advanceTimersByTimeAsync(200);
  held.resolve(cached); await tick();
  expect(visible(render(current.read), mode)).toBe(mode === "task" ? "CACHED" : "/h/[profileId]/task/[serverId]/[threadId]");
  expect(fixture.load).toHaveBeenCalledTimes(1);
});
it.each(["task", "root"] as const)("%s: clearing same-scope reauthorization resumes cache publication", async mode => {
  const current = route(mode); current.reauth(true); render(current.read);
  expect(fixture.load).not.toHaveBeenCalled();
  current.reauth(false); render(current.read); await tick();
  expect(visible(render(current.read), mode)).toBe(mode === "task" ? "CACHED" : "/h/[profileId]/task/[serverId]/[threadId]");
});
it.each(["task", "root"] as const)("%s: changed identity still rejects the old held completion", async mode => {
  const held = deferred<typeof cached>(); fixture.load.mockReturnValueOnce(held.promise).mockResolvedValueOnce(null);
  const current = route(mode); render(current.read);
  current.replace({ ...profile, deviceId: "other-device" }); render(current.read); await tick();
  held.resolve(cached); await tick();
  expect(visible(render(current.read), mode)).toBe(mode === "task" ? undefined : "/h/[profileId]");
});


it.each(["none", "reading", "latest"] as const)("late canonical cache anchor maps to the resident display row after %s input", async action => {
  const raw = { id: "raw-assistant", role: "assistant", turnId: "turn", attemptId: "attempt", content: "CONFIRMED", timestampMs: 1 };
  const authority = { messages: [raw], hasMoreBefore: false };
  const record = projectConfirmedTranscript(scope, authority, { title: "Title", updatedAt: 100,
    anchor: { messageId: raw.id, offset: 27, followsLatest: false } });
  const value = decodeConfirmedTranscript(JSON.stringify(record), scope)!;
  const held = deferred<typeof value>(); fixture.load.mockReturnValueOnce(held.promise);
  const messages = [{ ...raw, id: "assistant-attempt" }];
  const runtime = { disposed: false, confirmedTranscriptPage: { page: authority, confirmedAt: 100 },
    completedTranscriptRevision: 0, confirmedTranscriptRevision: 0,
    getSnapshot: () => ({ threadId: "t", cwd: "/w", title: "Title", activeTurnId: null, messages }),
    subscribe: () => () => {},
    applyDeferredConfirmedTranscriptPage: (_isCurrent: () => boolean) => false,
  } as unknown as TaskRuntime;
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w", enabled: true, reauthorizationRequired: false, task: runtime });
  const initial = render(read); await tick();
  if (action !== "none") initial.readAnchor?.({ messageId: messages[0].id, offset: 9, followsLatest: action === "latest" }, true);
  held.resolve(value); await tick();
  const next = render(read);
  expect(next.initialAnchor).toEqual({ messageId: messages[0].id, offset: action === "none" ? 27 : 9, followsLatest: action === "latest" });
  expect(runtime.getSnapshot().messages).toBe(messages);
});


it("the first live hook render translates a marker published by the cache-only transcript before its watch effect", async () => {
  const raw = { id: "raw-cached-assistant", role: "assistant", turnId: "turn", attemptId: "attempt", content: "CONFIRMED", timestampMs: 1 };
  const authority = { messages: [raw], hasMoreBefore: false };
  const record = projectConfirmedTranscript(scope, authority, { title: "Title", updatedAt: 100,
    anchor: { messageId: raw.id, offset: 27, followsLatest: false } });
  fixture.load.mockResolvedValue(decodeConfirmedTranscript(JSON.stringify(record), scope)!);
  let task: TaskRuntime | null = null;
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w", enabled: true, reauthorizationRequired: false, task });
  render(read); await tick(); const cacheOnly = render(read);
  cacheOnly.readAnchor?.({ messageId: raw.id, offset: 29, followsLatest: false }, true);
  task = { disposed: false, confirmedTranscriptPage: { page: authority, confirmedAt: 200 }, completedTranscriptRevision: 0, confirmedTranscriptRevision: 0,
    getSnapshot: () => ({ threadId: "t", cwd: "/w", title: "Title", activeTurnId: null, messages: [{ ...raw, id: "live-assistant" }] }), subscribe: () => () => {},
  } as unknown as TaskRuntime;
  // render() returns the hook value computed before effects; do not rely on a later render.
  expect(render(read).initialAnchor).toEqual({ messageId: "live-assistant", offset: 29, followsLatest: false });
});

it("a scoped absent observation clears cache only after a version witness is revoked", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "a".repeat(64), dataRevision: 1 } } as const;
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });
  render(read); await tick();
  const value = render(read);
  expect(value.absenceConfirmed).toBe(true);
  expect(value.cached).toBeNull();
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  expect(sessionTranscriptCache.invalidateThreadIfVersion).toHaveBeenCalledWith(expect.objectContaining({ scope }), presence.version);
});

it("a route-bound absence without a pre-probe version exits without deleting the cached record", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" }, scope, version: null } as const;
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });
  render(read); await tick();
  const value = render(read);
  expect(value.absenceConfirmed).toBe(true);
  expect(value.cached?.record.messages[0]?.content).toBe("CACHED");
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  expect(sessionTranscriptCache.invalidateThreadIfVersion).not.toHaveBeenCalled();
});

it("a confirmed absence hides its matching cached version in memory when invalidation persistence fails", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "a".repeat(64), dataRevision: 1 } } as const;
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  vi.mocked(sessionTranscriptCache.invalidateThreadIfVersion).mockRejectedValueOnce(new Error("QuotaExceededError"));
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });
  render(read); await tick();
  const value = render(read);
  expect(value.absenceConfirmed).toBe(true);
  expect(value.cached).toBeNull();
  expect(sessionTranscriptCache.invalidateThreadIfVersion).toHaveBeenCalledWith(expect.objectContaining({ scope }), presence.version);
});

it("server-confirmed absence exits while cache loading is still pending after invalidation fails", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "a".repeat(64), dataRevision: 1 } } as const;
  const pendingLoad = deferred<typeof cached | null>();
  fixture.load.mockReturnValueOnce(pendingLoad.promise);
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  vi.mocked(sessionTranscriptCache.invalidateThreadIfVersion).mockRejectedValueOnce(new Error("QuotaExceededError"));
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });
  render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(true);
  expect(render(read).cached).toBeNull();
  pendingLoad.resolve(null); await tick();
  expect(render(read).absenceConfirmed).toBe(true);
});

it("a fully unbound absence stays fail-closed", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope: null, version: null } as const;
  fixture.load.mockResolvedValueOnce(null);
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });
  render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(false);
  expect(render(read).cached).toBeNull();
  expect(sessionTranscriptCache.invalidateThreadIfVersion).not.toHaveBeenCalled();
});

it("a bound absence without a cache version cancels a pending cache-only anchor write before exit", async () => {
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  const cacheReadableProfile = { ...profile, expiresAt: 5_000, refreshExpiresAt: 5_000 };
  let presence: { result: { status: "absent"; threadId: string; reason: "boundDeletedPrimarySource" };
    scope: typeof scope | null; version: null } | null = null;
  const read = () => useSessionTranscriptCache({ profile: cacheReadableProfile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });
  render(read); await tick();
  render(read).readAnchor?.({ messageId: "u", offset: 31, followsLatest: false }, true);
  presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" }, scope, version: null };
  render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  await tick();
  expect(sessionTranscriptCache.save).not.toHaveBeenCalled();
  expect(sessionTranscriptCache.invalidateThreadIfVersion).not.toHaveBeenCalled();
});

it("does not navigate on an unversioned absence after a live runtime takes authority", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: null } as const;
  const task = { disposed: false, confirmedTranscriptPage: null, completedTranscriptRevision: 0, confirmedTranscriptRevision: 0,
    getSnapshot: () => ({ threadId: "t", cwd: "/w", title: "Title", activeTurnId: null, messages: [] }),
    subscribe: () => () => {} } as unknown as TaskRuntime;
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task, presence });
  render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(false);
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  expect(sessionTranscriptCache.invalidateThreadIfVersion).not.toHaveBeenCalled();
});

it("does not navigate when an absence scope belongs to an older server fingerprint", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: null } as const;
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  const changedServer = { ...server, command: "different-runtime-command" };
  const read = () => useSessionTranscriptCache({ profile, server: changedServer, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });
  render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(false);
  expect(sessionTranscriptCache.invalidateThreadIfVersion).not.toHaveBeenCalled();
});

it("keeps the same absence result when a server identity object change cleans up and reruns its effect", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "a".repeat(64), dataRevision: 1 } } as const;
  const held = deferred<null>();
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  vi.mocked(sessionTranscriptCache.invalidateThreadIfVersion).mockImplementationOnce(async () => {
    await held.promise;
    throw new Error("QuotaExceededError");
  });
  let currentServer = server;
  const read = () => useSessionTranscriptCache({ profile, server: currentServer, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });
  render(read); await tick();
  expect(sessionTranscriptCache.invalidateThreadIfVersion).toHaveBeenCalledTimes(1);
  currentServer = { ...server };
  render(read); await tick();
  held.resolve(null); await tick();
  expect(render(read).absenceConfirmed).toBe(true);
  expect(render(read).cached).toBeNull();
  expect(sessionTranscriptCache.invalidateThreadIfVersion).toHaveBeenCalledTimes(1);
});

it.each(["committed", "storage-failed"] as const)(
  "does not apply an in-flight absence %s result after same-id target fingerprint changes", async outcome => {
    const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
      scope, version: { epoch: "a".repeat(64), dataRevision: 1 } } as const;
    const held = deferred<null>();
    const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
    vi.mocked(sessionTranscriptCache.invalidateThreadIfVersion).mockImplementationOnce(async () => {
      await held.promise;
      if (outcome === "storage-failed") throw new Error("QuotaExceededError");
      return true;
    });
    let currentServer = server;
    const read = () => useSessionTranscriptCache({ profile, server: currentServer, serverId: "s", threadId: "t", cwd: "/w",
      enabled: true, reauthorizationRequired: false, task: null, presence });
    render(read); await tick();
    expect(sessionTranscriptCache.invalidateThreadIfVersion).toHaveBeenCalledTimes(1);
    currentServer = { ...server, acceptNewHostKey: true };
    render(read); await tick();
    held.resolve(null); await tick();
    expect(render(read).absenceConfirmed).toBe(false);
    expect(sessionTranscriptCache.invalidateThreadIfVersion).toHaveBeenCalledTimes(1);
  },
);

it.each(["unversioned", "cas-committed"] as const)(
  "does not revive the old %s absence proof after an A-to-B-to-A server fingerprint change", async proofType => {
    const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
    const cacheReadableProfile = { ...profile, expiresAt: 5_000, refreshExpiresAt: 5_000 };
    const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" }, scope,
      version: proofType === "unversioned" ? null : { epoch: "a".repeat(64), dataRevision: 1 } } as const;
    if (proofType === "cas-committed") vi.mocked(sessionTranscriptCache.invalidateThreadIfVersion).mockResolvedValueOnce(true);
    let currentServer = server;
    const read = () => useSessionTranscriptCache({ profile: cacheReadableProfile, server: currentServer, serverId: "s", threadId: "t", cwd: "/w",
      enabled: true, reauthorizationRequired: false, task: null, presence });
    render(read); await tick();
    expect(render(read).absenceConfirmed).toBe(true);
    currentServer = { ...server, acceptNewHostKey: true };
    render(read); await tick();
    currentServer = { ...server };
    render(read); await tick();
    expect(render(read).absenceConfirmed).toBe(false);
  },
);

it("a version conflict does not hide the cached transcript or claim absence", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "b".repeat(64), dataRevision: 2 } } as const;
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  vi.mocked(sessionTranscriptCache.invalidateThreadIfVersion).mockResolvedValueOnce(false);
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });
  render(read); await tick();
  const value = render(read);
  expect(value.absenceConfirmed).toBe(false);
  expect(value.cached?.record.messages[0]?.content).toBe("CACHED");
});

it("live runtime authority prevents a late absence from claiming deletion", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "a".repeat(64), dataRevision: 1 } } as const;
  const task = { disposed: false, confirmedTranscriptPage: null, completedTranscriptRevision: 0, confirmedTranscriptRevision: 0,
    getSnapshot: () => ({ threadId: "t", cwd: "/w", title: "Title", activeTurnId: null, messages: [] }),
    subscribe: () => () => {} } as unknown as TaskRuntime;
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task, presence });
  render(read); await tick();
  const value = render(read);
  expect(value.absenceConfirmed).toBe(false);
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  expect(sessionTranscriptCache.invalidateThreadIfVersion).not.toHaveBeenCalled();
});

it("a live authority that arrives after transient absence suppression clears the in-memory marker", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "a".repeat(64), dataRevision: 1 } } as const;
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  const held = deferred<null>();
  vi.mocked(sessionTranscriptCache.invalidateThreadIfVersion).mockImplementationOnce(async () => {
    await held.promise;
    throw new Error("storage failure");
  });
  const task = { disposed: false, confirmedTranscriptPage: null, completedTranscriptRevision: 0, confirmedTranscriptRevision: 0,
    getSnapshot: () => ({ threadId: "t", cwd: "/w", title: "Title", activeTurnId: null, messages: [] }),
    subscribe: () => () => {} } as unknown as TaskRuntime;
  let liveTask: TaskRuntime | null = null;
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: liveTask, presence });
  render(read); await tick();
  expect(sessionTranscriptCache.invalidateThreadIfVersion).toHaveBeenCalledTimes(1);
  held.resolve(null); await tick();
  expect(render(read).absenceConfirmed).toBe(true);
  liveTask = task; render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(false);
  liveTask = null; render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(false);
});

it("fresh live authority clears a previously confirmed absence after the runtime disappears", async () => {
  const presence = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "a".repeat(64), dataRevision: 1 } } as const;
  let liveTask: TaskRuntime | null = null;
  const page = { messages: [{ id: "live-user", role: "user", content: "LIVE", timestampMs: 2 }] };
  const task = { disposed: false, confirmedTranscriptPage: { page, confirmedAt: 200 }, completedTranscriptRevision: 0,
    confirmedTranscriptRevision: 0, getSnapshot: () => ({ threadId: "t", cwd: "/w", title: "Title", activeTurnId: null, messages: [] }),
    subscribe: () => () => {} } as unknown as TaskRuntime;
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: liveTask, presence });
  render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(true);
  liveTask = task; render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(false);
  liveTask = null; render(read); await tick();
  expect(render(read).absenceConfirmed).toBe(false);
});

it("applies a successful CAS when the same semantic absence arrives as a new observation object", async () => {
  const { sessionTranscriptCache } = await import("@/storage/session-transcript-cache");
  const first = { result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" },
    scope, version: { epoch: "a".repeat(64), dataRevision: 1 } } as const;
  const second = { ...first };
  const entered = deferred<null>(), held = deferred<null>();
  vi.mocked(sessionTranscriptCache.invalidateThreadIfVersion)
    .mockImplementationOnce(async () => { entered.resolve(null); await held.promise; return true; })
    .mockResolvedValueOnce(false);
  let presence: typeof first | null = first;
  const read = () => useSessionTranscriptCache({ profile, server, serverId: "s", threadId: "t", cwd: "/w",
    enabled: true, reauthorizationRequired: false, task: null, presence });

  render(read); await entered.promise; await tick();
  expect(render(read).cached?.record.messages[0]?.content).toBe("CACHED");
  presence = null; render(read);
  presence = second; render(read); await tick();
  held.resolve(null); await tick();

  const settled = render(read);
  expect(settled.absenceConfirmed).toBe(true);
  expect(settled.cached).toBeNull();
});
