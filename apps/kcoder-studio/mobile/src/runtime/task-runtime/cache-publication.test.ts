import { afterEach, expect, it, vi } from "vitest";
import { sessionTranscriptCache } from "@/storage/session-transcript-cache";
import { createSessionTranscriptStore } from "@/storage/session-transcript-store";
import type { SessionTranscriptBackend } from "@/storage/session-transcript-backend-contract";
import { captureSessionTranscriptScope } from "@/storage/session-transcript-scope";
import { projectConfirmedTranscript } from "@/storage/session-transcript-projection";
import { SessionCacheCoordinator } from "@/features/task/session-cache-coordinator";
import { captureRuntimeTranscriptLease, startRuntimeTranscriptPublication } from "./cache-publication";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";

const page = { messages: [{ id: "u", role: "user", content: "confirmed", timestampMs: 1 }] };
const scope = (cwd = "/workspace", threadId = "thread-1") => captureSessionTranscriptScope(profile, server, cwd, threadId);
const record = (cwd = "/workspace", threadId = "thread-1") => projectConfirmedTranscript(scope(cwd, threadId), page, { updatedAt: 1, title: "Title" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
function fixture() {
  let manifest: string | null = null;
  const entries = new Map<number, { revision: number; raw: string }>();
  const backend: SessionTranscriptBackend = {
    async readManifest() { return manifest; },
    async readEntry(slot, revision) { const entry = entries.get(slot); return entry?.revision === revision ? entry.raw : null; },
    async reset(raw, current) { if (!current()) throw new Error("stale"); manifest = raw; entries.clear(); },
    async commit(change, current) {
      if (!current()) throw new Error("stale");
      if (change.put) entries.set(change.put.slot, { revision: change.put.revision, raw: change.put.raw });
      for (const slot of change.removeSlots) entries.delete(slot);
      manifest = change.manifest;
    },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const fence = <T>(_identity: unknown, operation: () => Promise<T>) => {
    const result = tail.catch(() => {}).then(() => operation()); tail = result; return result;
  };
  const cache = createSessionTranscriptStore(backend, fence);
  const peer = createSessionTranscriptStore(backend, fence);
  return { backend, cache, peer, replaceManifest: (raw: string) => { manifest = raw; } };
}
function runtimeFixture(cwd = "/workspace", threadId = "thread-1") {
  const listeners = new Set<() => void>();
  const snapshot = { threadId, cwd, title: "Title", activeTurnId: null, messages: [] };
  const runtime = { disposed: false, confirmedTranscriptPage: { page, confirmedAt: 1 },
    completedTranscriptRevision: 0, confirmedTranscriptRevision: 0,
    getSnapshot: () => snapshot,
    subscribe: (callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); },
  } as unknown as TaskRuntime;
  return { runtime, snapshot, changed: () => { for (const listener of listeners) listener(); } };
}
async function bind(runtime: TaskRuntime, cache: typeof sessionTranscriptCache, cwd = "/workspace", threadId?: string) {
  const preflight = startRuntimeTranscriptPublication({ profile, server, cwd, threadId }, cache);
  await tick(); preflight.freeze(); preflight.bind(runtime, scope(cwd, runtime.getSnapshot().threadId));
  return preflight;
}
const opened = new Set<TaskRuntime>();
afterEach(() => {
  for (const runtime of opened) runtime.close();
  opened.clear(); taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks(); vi.useRealTimers();
});

it("allows routine same-Runtime publication but fences stale remounts after a peer workspace invalidation", async () => {
  const f = fixture(), r = runtimeFixture();
  await bind(r.runtime, f.cache);
  const route = { profile, serverId: server.id, threadId: "thread-1", cwd: "/workspace" };
  const first = new SessionCacheCoordinator(route, () => true, f.cache);
  first.watch(r.runtime, server);
  await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.messages[0].content).toBe("confirmed"));
  r.runtime.confirmedTranscriptPage = { page: { messages: [{ ...page.messages[0], content: "new authority" }] }, confirmedAt: 2 } as never;
  r.changed();
  await vi.waitFor(async () => expect((await f.cache.last(profile, () => true))?.record.updatedAt).toBe(2));
  await f.peer.save(await f.peer.capture(scope("/peer"), () => true), record("/peer"), false);
  const witness = await f.peer.captureWorkspaceWitness(scope(), () => true);
  expect(await f.peer.invalidateWorkspaceIfVersion(witness.lease, witness.version)).toBe(true);
  first.close();
  r.runtime.confirmedTranscriptPage = { page, confirmedAt: 3 } as never;
  const remounted = new SessionCacheCoordinator(route, () => true, f.cache);
  remounted.watch(r.runtime, server); await tick();
  expect(await captureRuntimeTranscriptLease(r.runtime, scope(), () => true, f.cache)).toBeNull();
  expect(await f.peer.load(await f.peer.capture(scope(), () => true))).toBeNull();
  expect((await f.peer.load(await f.peer.capture(scope("/peer"), () => true)))?.record.messages[0].content).toBe("confirmed");
  // A different operation may obtain a new fixed fence after fresh online authority.
  const fresh = runtimeFixture(); await bind(fresh.runtime, f.cache, "/workspace", "thread-1");
  expect(await captureRuntimeTranscriptLease(fresh.runtime, scope(), () => true, f.cache)).not.toBeNull();
  expect(r.runtime.disposed).toBe(false);
  remounted.close();
});

it("thread tombstones bind the actual thread even when create preflight used a threadless candidate", async () => {
  const f = fixture(), r = runtimeFixture(); await bind(r.runtime, f.cache);
  await f.peer.invalidateThread(await f.peer.capture(scope(), () => true));
  expect(await captureRuntimeTranscriptLease(r.runtime, scope(), () => true, f.cache)).toBeNull();
  const renewed = startRuntimeTranscriptPublication({ profile, server, cwd: "/workspace" }, f.cache);
  await tick(); renewed.freeze(); renewed.bind(r.runtime, scope());
  expect(await captureRuntimeTranscriptLease(r.runtime, scope(), () => true, f.cache)).toBeNull();
});

it("manifest epoch replacement invalidates an existing Runtime publisher", async () => {
  const f = fixture(), r = runtimeFixture(); await bind(r.runtime, f.cache, "/workspace", "thread-1");
  f.replaceManifest("corrupt"); await f.peer.capture(scope(), () => true);
  expect(await captureRuntimeTranscriptLease(r.runtime, scope(), () => true, f.cache)).toBeNull();
});

it("pending preflight at the first RPC remains disabled after its late completion", async () => {
  const f = fixture(), r = runtimeFixture();
  const held = deferred<Awaited<ReturnType<typeof f.cache.captureWorkspacePublisherFence>>>();
  vi.spyOn(f.cache, "captureWorkspacePublisherFence").mockImplementationOnce(() => held.promise);
  const preflight = startRuntimeTranscriptPublication({ profile, server, cwd: "/workspace" }, f.cache);
  preflight.freeze(); preflight.bind(r.runtime, scope());
  held.resolve(await f.peer.captureWorkspacePublisherFence(scope(), () => true)); await tick();
  preflight.freeze(); preflight.bind(r.runtime, scope());
  expect(await captureRuntimeTranscriptLease(r.runtime, scope(), () => true, f.cache)).toBeNull();
});

it.each(["throw", "reject", "owner-throws"])("cache preflight %s never blocks an operation", async kind => {
  const f = fixture(), r = runtimeFixture();
  if (kind === "throw") vi.spyOn(f.cache, "captureWorkspacePublisherFence").mockImplementationOnce(() => { throw new Error("media"); });
  if (kind === "reject") vi.spyOn(f.cache, "captureWorkspacePublisherFence").mockRejectedValueOnce(new Error("media"));
  const preflight = startRuntimeTranscriptPublication({ profile, server, cwd: "/workspace",
    ...(kind === "owner-throws" ? { isCurrentOwner: () => { throw new Error("stale owner"); } } : {}) }, f.cache);
  await tick(); expect(() => preflight.freeze()).not.toThrow(); preflight.bind(r.runtime, scope());
  expect(await captureRuntimeTranscriptLease(r.runtime, scope(), () => true, f.cache)).toBeNull();
});

it("unbound or mismatched Runtime cannot publish; backend I/O failures still reach the coordinator", async () => {
  const f = fixture(), r = runtimeFixture();
  expect(await captureRuntimeTranscriptLease(r.runtime, scope(), () => true, f.cache)).toBeNull();
  await bind(r.runtime, f.cache);
  expect(await captureRuntimeTranscriptLease(r.runtime, scope("/other"), () => true, f.cache)).toBeNull();
  vi.spyOn(f.cache, "capturePublisherLease").mockRejectedValueOnce(new Error("media"));
  await expect(captureRuntimeTranscriptLease(r.runtime, scope(), () => true, f.cache)).rejects.toThrow("media");
  const lease = await captureRuntimeTranscriptLease(r.runtime, scope(), () => true, f.cache);
  r.snapshot.cwd = "/other";
  expect(lease?.isCurrent()).toBe(false);
});

it("a changed opaque target descriptor cannot renew an old Runtime with the same persisted scope", async () => {
  const f = fixture(), r = runtimeFixture();
  const original = { ...server, observationTargetIdentity: "1".repeat(64) };
  const replaced = { ...original, observationTargetIdentity: "2".repeat(64) };
  const capturedScope = captureSessionTranscriptScope(profile, original, "/workspace", "thread-1");
  const preflight = startRuntimeTranscriptPublication({ profile, server: original, cwd: "/workspace" }, f.cache);
  await tick(); preflight.freeze(); preflight.bind(r.runtime, capturedScope);
  expect(await captureRuntimeTranscriptLease(r.runtime, capturedScope, () => true, f.cache, { ...original })).not.toBeNull();
  expect(captureSessionTranscriptScope(profile, replaced, "/workspace", "thread-1")).toEqual(capturedScope);
  expect(await captureRuntimeTranscriptLease(r.runtime, capturedScope, () => true, f.cache, replaced)).toBeNull();
  const lease = await captureRuntimeTranscriptLease(r.runtime, capturedScope, () => true, f.cache, original);
  original.observationTargetIdentity = replaced.observationTargetIdentity;
  expect(lease?.isCurrent()).toBe(false);
  expect(await captureRuntimeTranscriptLease(r.runtime, capturedScope, () => true, f.cache)).toBeNull();
});

it.each(["C:\\Users\\me\\workspace", "C:\\"])("binds a Runtime to the actual Windows scope (%s)", async cwd => {
  const f = fixture(), r = runtimeFixture(cwd);
  const target = { ...server, workspacePath: cwd };
  const actual = captureSessionTranscriptScope(profile, target, cwd, "thread-1");
  const preflight = startRuntimeTranscriptPublication({ profile, server: target, cwd }, f.cache);
  await tick(); preflight.freeze(); preflight.bind(r.runtime, actual);
  expect(await captureRuntimeTranscriptLease(r.runtime, actual, () => true, f.cache, target)).not.toBeNull();
});

it("a cache-only anchor reuses its read lease and cannot recapture past a peer tombstone", async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.cache.save(await f.cache.capture(scope(), () => true), record(), true);
  const coordinator = new SessionCacheCoordinator({ profile, serverId: server.id, threadId: "thread-1", cwd: "/workspace" }, () => true, f.cache);
  await coordinator.loadWithVersion(server);
  await f.peer.invalidateThread(await f.peer.capture(scope(), () => true));
  const captures = vi.spyOn(f.cache, "capture");
  coordinator.readAnchor({ messageId: "u", offset: 20, followsLatest: false }, true);
  await vi.advanceTimersByTimeAsync(250); await tick();
  expect(captures).not.toHaveBeenCalled();
  expect(await f.peer.load(await f.peer.capture(scope(), () => true))).toBeNull();
  coordinator.close();
});

it("resume never waits for a held cache preflight or renews the late fence", async () => {
  const f = fixture(), held = deferred<Awaited<ReturnType<typeof f.cache.captureWorkspacePublisherFence>>>();
  vi.spyOn(sessionTranscriptCache, "captureWorkspacePublisherFence").mockReturnValueOnce(held.promise);
  const client = new FakeClient(page.messages);
  client.supportsExperimental = () => false;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never));
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1", cwd: "/workspace" });
  opened.add(runtime);
  expect(runtime.getSnapshot().messages[0].content).toBe("confirmed");
  held.resolve(await f.cache.captureWorkspacePublisherFence(scope(), () => true)); await tick();
  expect(await captureRuntimeTranscriptLease(runtime, scope(), () => true)).toBeNull();
});

it.each(["missing", "missing-id", "split-summary", "conflicting", "mismatched-thread", "matching"])("factory binds only online exact cwd/thread (%s)", async mode => {
  const f = fixture();
  vi.spyOn(sessionTranscriptCache, "captureWorkspacePublisherFence").mockImplementation(f.cache.captureWorkspacePublisherFence);
  vi.spyOn(sessionTranscriptCache, "capturePublisherLease").mockImplementation(f.cache.capturePublisherLease);
  const held = deferred<never>();
  taskRuntimeTestHelpers.setConnector(vi.fn(() => held.promise));
  const pending = TaskRuntime.resume({ profile, server, threadId: "thread-1", cwd: "/workspace" });
  await tick();
  const client = new FakeClient(page.messages); client.supportsExperimental = () => false;
  client.request = vi.fn(async method => method === "thread/resume"
    ? { thread: { ...(!["missing-id", "split-summary"].includes(mode) ? { id: mode === "mismatched-thread" ? "other" : "thread-1" } : {}),
      ...(mode !== "missing" ? { cwd: "/workspace" } : {}) } }
    : { ...(mode !== "missing-id" ? { thread: { id: "thread-1",
      ...(!["missing", "split-summary"].includes(mode) ? { cwd: mode === "conflicting" ? "/other" : "/workspace" } : {}) } } : {}), messages: page.messages }) as never;
  held.resolve(client as never);
  const runtime = await pending; opened.add(runtime);
  const lease = await captureRuntimeTranscriptLease(runtime, scope(runtime.getSnapshot().cwd), () => true);
  if (mode === "matching") expect(lease).not.toBeNull();
  else expect(lease).toBeNull();
});
