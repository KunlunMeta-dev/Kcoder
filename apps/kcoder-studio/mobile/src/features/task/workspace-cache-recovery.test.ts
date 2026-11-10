import { afterEach, expect, it, vi } from "vitest";
import { SessionCacheCoordinator } from "./session-cache-coordinator";
import { probeWorkspacePresence, WORKSPACE_PRESENCE_PHASE_DEADLINE_MS, type WorkspacePresenceObservation } from "@/runtime/task-runtime/workspace-presence";
import { createSessionTranscriptStore } from "@/storage/session-transcript-store";
import { captureSessionTranscriptScope } from "@/storage/session-transcript-scope";
import { projectConfirmedTranscript } from "@/storage/session-transcript-projection";
import type { SessionTranscriptBackend } from "@/storage/session-transcript-backend-contract";
import { profile, server as originalServer } from "@/runtime/task-runtime/fixture.test-support";

const observer = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/gateway/workspace-cwd-observation", async original => ({
  ...await original<typeof import("@/gateway/workspace-cwd-observation")>(), observeWorkspaceCwd: observer.call,
}));
const server = { ...originalServer, observationTargetIdentity: "a".repeat(64) };
const scope = (cwd = "/workspace", threadId = "t") => captureSessionTranscriptScope(profile, server, cwd, threadId);
const page = { messages: [{ id: "u", role: "user", content: "confirmed", timestampMs: 1 }] };
const record = (cwd = "/workspace", threadId = "t", at = 1) => projectConfirmedTranscript(scope(cwd, threadId), page, { updatedAt: at, title: "Title" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let manifest: string | null = null, fail = false;
  const entries = new Map<number, { revision: number; raw: string }>();
  const backend: SessionTranscriptBackend = {
    async readManifest() { return manifest; },
    async readEntry(slot, revision) { const entry = entries.get(slot); return entry?.revision === revision ? entry.raw : null; },
    async reset(raw, current) { if (!current()) throw new Error("stale"); manifest = raw; entries.clear(); },
    async commit(change, current) {
      if (!current()) throw new Error("stale"); if (fail) throw new Error("media unavailable");
      if (change.put) entries.set(change.put.slot, { revision: change.put.revision, raw: change.put.raw });
      for (const slot of change.removeSlots) entries.delete(slot);
      manifest = change.manifest;
    },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const fence = <T>(_identity: unknown, operation: () => Promise<T>) => { const result = tail.catch(() => {}).then(() => operation()); tail = result; return result; };
  const cache = createSessionTranscriptStore(backend, fence), peer = createSessionTranscriptStore(backend, fence);
  const coordinator = new SessionCacheCoordinator({ profile, serverId: server.id, threadId: "t", cwd: "/workspace" }, () => true, cache);
  const save = async (cwd = "/workspace", threadId = "t", at = 1) => cache.save(await cache.capture(scope(cwd, threadId), () => true), record(cwd, threadId, at), true);
  return { cache, peer, coordinator, save, fail: () => { fail = true; }, manifest: () => manifest };
}
async function proof(cache: ReturnType<typeof fixture>["cache"], current = () => true): Promise<WorkspacePresenceObservation> {
  return { scope: scope(), witness: await cache.captureWorkspaceWitness(scope(), current), isCurrent: current,
    result: { version: 1, status: "absent", targetId: server.id, targetSignature: server.observationTargetIdentity,
      workspacePath: "/workspace", loginGeneration: 1, observedAt: 1 } };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); observer.call.mockReset(); });

it("a bound workspace CAS removes every exact-workspace thread while preserving peer workspaces", async () => {
  const f = fixture(); await f.save("/workspace", "t"); await f.save("/workspace", "second"); await f.save("/peer", "peer");
  const observation = await proof(f.cache);
  expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(observation, server)).toBe(true);
  for (const id of ["t", "second"]) expect(await f.peer.load(await f.peer.capture(scope("/workspace", id), () => true))).toBeNull();
  expect((await f.peer.load(await f.peer.capture(scope("/peer", "peer"), () => true)))?.record.messages).toHaveLength(1);
  expect(JSON.parse(f.manifest()!).invalidations.some((item: { key: string }) => item.key.startsWith("w:"))).toBe(true);
  expect((await f.peer.last(profile, () => true))?.record.scope.cwd).toBe("/peer");
  f.coordinator.close();
});

it.each(["peer", "same-workspace"])("a %s publication after observation obeys exact prefix CAS", async kind => {
  const f = fixture(); await f.save(); const observation = await proof(f.cache);
  await f.save(kind === "peer" ? "/peer" : "/workspace", kind === "peer" ? "peer" : "t", 2);
  expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(observation, server)).toBe(kind === "peer");
  expect((await f.peer.load(await f.peer.capture(scope(), () => true)))?.record.updatedAt ?? null).toBe(kind === "peer" ? null : 2);
  f.coordinator.close();
});

it("old target identity, foreign scope, stale caller, and fresh Runtime authority never revoke", async () => {
  const f = fixture(); await f.save(); let current = true;
  const observation = await proof(f.cache, () => current);
  expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(observation, server,
    () => ({ ...server, observationTargetIdentity: "b".repeat(64) }))).toBe(false);
  expect(await f.coordinator.revokeConfirmedWorkspaceAbsent({ ...observation, scope: scope("/peer") }, server)).toBe(false);
  current = false; expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(observation, server)).toBe(false); current = true;
  const runtime = { disposed: false, confirmedTranscriptPage: null, completedTranscriptRevision: 0, confirmedTranscriptRevision: 0,
    getSnapshot: () => ({ threadId: "t", cwd: "/workspace" }), subscribe: () => () => {} };
  f.coordinator.watch(runtime as never, server);
  expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(observation, server)).toBe(false);
  expect((await f.cache.load(await f.cache.capture(scope(), () => true)))?.record.updatedAt).toBe(1);
  f.coordinator.close();
});

it.each(["media", "no-witness"])("%s failure stops pending cache-only anchors without claiming physical deletion", async kind => {
  vi.useFakeTimers(); const f = fixture(); await f.save(); await f.coordinator.loadWithVersion(server);
  const observation = await proof(f.cache);
  if (kind === "media") f.fail(); else observation.witness = null;
  const saves = vi.spyOn(f.cache, "save");
  f.coordinator.readAnchor({ messageId: "u", offset: 20, followsLatest: false }, true);
  expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(observation, server)).toBe("persistence-failed");
  await vi.advanceTimersByTimeAsync(250); expect(saves).not.toHaveBeenCalled();
  expect((await f.peer.load(await f.peer.capture(scope(), () => true)))?.record.messages).toHaveLength(1);
  f.coordinator.close();
});

it("an old witness cannot treat another realm's workspace tombstone as a successful CAS", async () => {
  const f = fixture(); await f.save(); const observation = await proof(f.cache);
  await f.peer.invalidateWorkspaceIfVersion(observation.witness!.lease, observation.witness!.version);
  expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(observation, server)).toBe(false);
  f.coordinator.close();
});

it.each(["thread-first", "workspace-first"])("simultaneous thread and workspace proofs keep their original CAS witnesses (%s)", async order => {
  const f = fixture(); await f.save(); await f.save("/workspace", "second");
  const workspace = await proof(f.cache);
  const lease = await f.cache.capture(scope(), () => true);
  const version = (await f.cache.loadVersioned(lease))!.version;
  const thread = { scope: scope(), version,
    result: { status: "absent", threadId: "t", reason: "boundDeletedPrimarySource" } } as const;
  if (order === "thread-first") {
    expect(await f.coordinator.revokeConfirmedAbsent(thread, server)).toBe(true);
    expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(workspace, server)).toBe(false);
    expect((await f.peer.load(await f.peer.capture(scope("/workspace", "second"), () => true)))?.record.messages).toHaveLength(1);
  } else {
    expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(workspace, server)).toBe(true);
    expect(await f.coordinator.revokeConfirmedAbsent(thread, server)).toBe(false);
    expect(await f.peer.load(await f.peer.capture(scope("/workspace", "second"), () => true))).toBeNull();
  }
  f.coordinator.close();
});

it("probe captures the original prefix before the HTTP observation and retains that exact witness", async () => {
  const f = fixture(); await f.save(); const held = deferred<void>(), entered = deferred<void>();
  observer.call.mockResolvedValue((await proof(f.cache)).result);
  const capture = f.cache.captureWorkspaceWitness;
  vi.spyOn(f.cache, "captureWorkspaceWitness").mockImplementationOnce(async (...args) => { entered.resolve(); await held.promise; return capture(...args); });
  const pending = probeWorkspacePresence({ profile, server, cwd: "/workspace", threadId: "t", isCurrentOwner: () => true }, f.cache);
  await entered.promise; expect(observer.call).not.toHaveBeenCalled(); held.resolve();
  const observation = await pending;
  expect(observation?.witness?.lease.scope).toEqual(scope()); expect(observation?.witness?.lease.isCurrent()).toBe(true);
  expect(await f.coordinator.revokeConfirmedWorkspaceAbsent(observation!, server)).toBe(true);
  f.coordinator.close();
});

it.each(["deadline", "caller"])("a pending cache witness is bounded by %s and cannot start late observation", async kind => {
  vi.useFakeTimers(); const f = fixture(), held = deferred<never>(), caller = new AbortController();
  vi.spyOn(f.cache, "captureWorkspaceWitness").mockReturnValueOnce(held.promise);
  const pending = probeWorkspacePresence({ profile, server, cwd: "/workspace", threadId: "t", isCurrentOwner: () => true, signal: caller.signal }, f.cache);
  if (kind === "caller") caller.abort(); else await vi.advanceTimersByTimeAsync(WORKSPACE_PRESENCE_PHASE_DEADLINE_MS);
  expect(await pending).toBeNull(); held.resolve(null as never); await Promise.resolve();
  expect(observer.call).not.toHaveBeenCalled(); f.coordinator.close();
});
