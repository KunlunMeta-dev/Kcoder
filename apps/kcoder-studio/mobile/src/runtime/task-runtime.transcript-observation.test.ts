import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetTaskRuntimeAsyncStorage } from "@/test/task-runtime-async-storage-fixture";
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { SessionCacheCoordinator } from "@/features/task/session-cache-coordinator";
import * as cachePublication from "./task-runtime/cache-publication";

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));
vi.mock("@react-native-async-storage/async-storage", async () => {
  const { taskRuntimeAsyncStorage } = await import("@/test/task-runtime-async-storage-fixture");
  return { default: taskRuntimeAsyncStorage };
});
beforeEach(resetTaskRuntimeAsyncStorage);

const thread = { id: "thread-1", cwd: "/workspace", status: "idle", createdAt: 1, updatedAt: 2 };
const proof = (body = "a", view = "b") => ({ observationId: body.repeat(64), viewKey: view.repeat(64) });
const unavailable = { status: "unavailable", code: "legacyReader" };
function page(observation: unknown, id: string, cursor?: string) {
  return { thread, messages: [{ id, role: "user", content: id, timestampMs: 1 }],
    rangeStart: cursor ? 1 : 0, rangeEnd: cursor ? 2 : 1,
    hasMoreBefore: Boolean(cursor), ...(cursor ? { beforeCursor: cursor } : {}),
    transcriptSnapshotV1: unavailable,
    ...(observation === undefined ? {} : { transcriptObservationV1: observation }) };
}
function inline(observation: unknown) {
  const { thread: actual, ...history } = page(observation, "base", `tp1:ob1-${"a".repeat(64)}:1`);
  return { thread: actual, history: { status: "ready", page: history } };
}
const runtimes = new Set<TaskRuntime>();
const coordinators = new Set<SessionCacheCoordinator>();
afterEach(() => {
  for (const coordinator of coordinators) coordinator.close();
  coordinators.clear();
  for (const runtime of runtimes) runtime.close();
  runtimes.clear(); taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks();
});
function fixture(handler: (method: string, params: JsonRecord) => unknown, inlineCap = false, observationCap = true) {
  const client = new FakeClient([]);
  client.supportsExperimental = name => ["threadIndexedPagesV1", "threadTranscriptSnapshotV1",
    ...(observationCap ? ["threadTranscriptObservationV1"] : []), ...(inlineCap ? ["threadResumeHistoryPageV1"] : [])].includes(name);
  const calls: Array<{ method: string; params: JsonRecord }> = [];
  client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
    calls.push({ method, params }); return handler(method, params);
  }) as never;
  const connector = vi.fn(async () => client as never);
  taskRuntimeTestHelpers.setConnector(connector as never);
  return { client, calls, connector };
}
async function resume() {
  const runtime = await TaskRuntime.resume({ profile, server, threadId: thread.id, cwd: thread.cwd });
  runtimes.add(runtime); return runtime;
}
function observed(runtime: TaskRuntime) {
  return runtime.getSnapshot() as ReturnType<TaskRuntime["getSnapshot"]> & { transcriptObservationV1?: unknown };
}

it("observed inline resume preserves an independent identity while snapshot remains unavailable", async () => {
  const { calls } = fixture(() => inline(proof()), true);
  const runtime = await resume();
  expect(observed(runtime).transcriptObservationV1).toEqual(proof());
  expect(observed(runtime).transcriptSnapshotV1).toEqual(unavailable);
  expect(calls.map(call => call.method)).toEqual(["thread/resume"]);
});

it.each([{ ...proof(), observationId: "A".repeat(64) }, { ...proof(), extra: true }, { viewKey: "a".repeat(64) }])(
  "observed malformed identity rejects an ordinary read (%j)", async malformed => {
    fixture(method => method === "thread/resume" ? { thread } : page(malformed, "invalid"));
    await expect(resume()).rejects.toMatchObject({ reason: "protocol" });
  });

it("observed equal identities merge adjacent pages without another first-page read", async () => {
  const cursor = `tp1:ob1-${"a".repeat(64)}:1`;
  const { calls } = fixture((method, params) => method === "thread/resume" ? { thread } :
    params.beforeCursor ? page(proof(), "older") : page(proof(), "base", cursor));
  const runtime = await resume(); await runtime.loadOlderMessages();
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["older", "base"]);
  expect(observed(runtime).transcriptObservationV1).toEqual(proof());
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(2);
});

it.each([proof("c"), proof("a", "d"), undefined])(
  "observed changed or lost identity rebases one bounded page and retains real live tail (%j)", async next => {
    let reads = 0; let release!: (value: unknown) => void;
    const held = new Promise<unknown>(resolve => { release = resolve; });
    const { client, calls, connector } = fixture(method => {
      if (method === "thread/resume") return { thread };
      if (method === "turn/start") return { turn: { id: "optimistic-turn", status: "running" } };
      if (++reads === 1) return page(proof(), "obsolete", `tp1:ob1-${"a".repeat(64)}:1`);
      if (reads === 2) return page(next, "obsolete-older");
      return held;
    });
    const runtime = await resume(); const pending = runtime.loadOlderMessages();
    const authority = runtime.confirmedTranscriptPage;
    await vi.waitFor(() => expect(reads).toBe(3));
    await runtime.send("optimistic input survives", [], undefined, { clientMessageId: "observed-cid" });
    const optimisticId = runtime.getSnapshot().messages.find(message => message.content === "optimistic input survives")!.id;
    client.emit({ method: "turn/started", params: { threadId: thread.id, turnId: "optimistic-turn" } });
    client.emit({ method: "item/delta", params: { threadId: thread.id, turnId: "optimistic-turn", delta: { text: "live survives rebase" } } });
    runtime.flushPendingDeltas();
    client.emit({ method: "turn/completed", params: { threadId: thread.id, turnId: "optimistic-turn", turn: { id: "optimistic-turn", status: "completed" } } });
    release(page(next, "fresh")); await pending;
    if (next === undefined) {
      expect(runtime.getSnapshot().messages.map(message => message.id)).toContain("obsolete");
      expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("fresh");
      expect(runtime.getSnapshot().error).toBeTruthy();
      expect(observed(runtime).transcriptObservationV1).toEqual(proof());
    } else {
      expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("obsolete");
      expect(observed(runtime).transcriptObservationV1).toEqual(next);
    }
    expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("obsolete-older");
    expect(runtime.getSnapshot().messages.map(message => message.content)).toContain("live survives rebase");
    expect(runtime.getSnapshot().messages.find(message => message.id === optimisticId)).toMatchObject({
      content: "optimistic input survives", turnId: "optimistic-turn",
    });
    expect(calls.filter(call => call.method === "turn/start")).toEqual([expect.objectContaining({
      params: expect.objectContaining({ clientMessageId: "observed-cid" }),
    })]);
    expect(calls.filter(call => call.method === "thread/read/indexed").map(call => call.params.beforeCursor))
      .toEqual([undefined, `tp1:ob1-${"a".repeat(64)}:1`, undefined]);
    expect(connector).toHaveBeenCalledTimes(1);
    if (next === undefined) expect(runtime.confirmedTranscriptPage).toBe(authority);
    else {
      expect(runtime.confirmedTranscriptPage?.page.messages?.map(message => message.id)).toEqual(["fresh"]);
      expect(runtime.confirmedTranscriptRevision).toBe(0);
      expect(runtime.completedTranscriptRevision).toBe(1);
    }
  });

it("observed typed remote stale rebases without depending on English error text", async () => {
  let reads = 0;
  const { calls } = fixture((method, params) => {
    if (method === "thread/resume") return { thread };
    if (++reads === 1) return page(proof(), "obsolete", `tp1:ob1-${"a".repeat(64)}:1`);
    if (params.beforeCursor) throw new MobileRpcError("游标对应的观察已失效", -32041, "remote");
    return page(proof("c"), "fresh");
  });
  const runtime = await resume(); await runtime.loadOlderMessages();
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["fresh"]);
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(3);
});

it.each([[-32021, "remote"], [-32041, "transport"], [-32041, "protocol"]] as const)(
  "observed stale-looking message is not authority to rebase (code=%s reason=%s)", async (code, reason) => {
    const { calls } = fixture((method, params) => {
      if (method === "thread/resume") return { thread };
      if (params.beforeCursor) throw new MobileRpcError("TRANSCRIPT_CURSOR_STALE", code, reason);
      return page(proof(), "base", `tp1:ob1-${"a".repeat(64)}:1`);
    });
    const runtime = await resume(); await runtime.loadOlderMessages();
    expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["base"]);
    expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(2);
    expect(runtime.getSnapshot().error).toContain("TRANSCRIPT_CURSOR_STALE");
  });

it("observed missing proof never unions an unverified numeric page and keeps server pagination intent", async () => {
  let reads = 0;
  const { calls } = fixture(method => method === "thread/resume" ? { thread } :
    page(undefined, ++reads === 1 ? "obsolete" : "fresh", "1"));
  const runtime = await resume(); await runtime.loadOlderMessages();
  expect(calls.filter(call => call.method === "thread/read/indexed").map(call => call.params.beforeCursor)).toEqual([undefined, undefined]);
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["obsolete"]);
  expect(runtime.getSnapshot()).toMatchObject({ hasMoreBefore: true, beforeCursor: "1", loadingOlder: false });
  expect(runtime.getSnapshot().error).toBeTruthy();
});

it.each([false, true])("observed missing proof still accepts the ordinary first authoritative page (cap=%s)", async enabled => {
  const { calls } = fixture(method => method === "thread/resume" ? { thread } : page(undefined, "first", "1"), false, enabled);
  const runtime = await resume();
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["first"]);
  expect(runtime.getSnapshot()).toMatchObject({ hasMoreBefore: true, beforeCursor: "1" });
  expect(runtime.getSnapshot().error).toBeFalsy();
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(1);
});

it("observed committed snapshot continuity does not depend on optional observation equality", async () => {
  const snapshot = { status: "available", snapshotId: "c".repeat(64), viewKey: "d".repeat(64) };
  const { calls } = fixture((method, params) => method === "thread/resume" ? { thread } : {
    ...page(params.beforeCursor ? proof("e") : undefined, params.beforeCursor ? "older" : "base",
      params.beforeCursor ? undefined : "tp1:committed:1"), transcriptSnapshotV1: snapshot,
  });
  const runtime = await resume(); await runtime.loadOlderMessages();
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["older", "base"]);
  expect(runtime.getSnapshot().transcriptSnapshotV1).toEqual(snapshot);
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(2);
});

it.each([false, true])("observed equal observation remains valid across independent snapshot fields (bothAvailable=%s)", async bothAvailable => {
  const snapshot = (id: string) => ({ status: "available", snapshotId: id.repeat(64), viewKey: "d".repeat(64) });
  const { calls } = fixture((method, params) => method === "thread/resume" ? { thread } : {
    ...page(proof(), params.beforeCursor ? "older" : "base", params.beforeCursor ? undefined : "tp1:source:1"),
    transcriptSnapshotV1: params.beforeCursor ? snapshot("c") : bothAvailable ? snapshot("e") : unavailable,
  });
  const runtime = await resume(); await runtime.loadOlderMessages();
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["older", "base"]);
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(2);
});

it.each(["observation", "snapshot"] as const)(
  "observed receipt reconciliation releases an obsolete older-page owner when only %s changes", async changedDomain => {
    const snapshot = (id: string) => ({ status: "available", snapshotId: id.repeat(64), viewKey: "f".repeat(64) });
    const originalSnapshot = snapshot("c");
    const nextSnapshot = changedDomain === "snapshot" ? snapshot("e") : originalSnapshot;
    const nextObservation = changedDomain === "observation" ? proof("d") : proof();
    const cursor = changedDomain === "snapshot" ? `tp1:ob1-${"a".repeat(64)}:1` : "tp1:committed:1";
    let reads = 0; let olderReads = 0; let release!: (value: unknown) => void;
    const heldOlder = new Promise<unknown>(resolve => { release = resolve; });
    const { client, calls } = fixture((method, params) => {
      if (method === "thread/resume") return { thread };
      if (method === "turn/start") return { turn: { id: "accepted-turn", status: "running" } };
      if (params.beforeCursor) {
        if (++olderReads === 1) return heldOlder;
        return { ...page(nextObservation, "current-older"), transcriptSnapshotV1: nextSnapshot };
      }
      if (++reads === 1) return { ...page(proof(), "base", cursor), transcriptSnapshotV1: originalSnapshot };
      return {
        ...page(nextObservation, "persisted-accepted", cursor), transcriptSnapshotV1: nextSnapshot,
        messages: [{ id: "persisted-accepted", role: "user", turnId: "accepted-turn",
          content: "accepted input", timestampMs: 2 }],
      };
    });
    const runtime = await resume();
    await runtime.send("accepted input", [], undefined, { clientMessageId: "receipt-proof-cid" });
    const pendingOlder = runtime.loadOlderMessages();
    await vi.waitFor(() => expect(olderReads).toBe(1));
    expect(runtime.getSnapshot().loadingOlder).toBe(true);
    expect(await runtime.reconcileSubmissionHistory(client as never,
      { turn: { id: "accepted-turn", status: "running" } },
      { threadId: thread.id, clientMessageId: "receipt-proof-cid", content: "accepted input", attachments: [] },
      () => true)).toBe(true);
    release({ ...page(proof(), "obsolete-older"), transcriptSnapshotV1: originalSnapshot });
    await pendingOlder;
    expect(runtime.getSnapshot()).toMatchObject({ loadingOlder: false, beforeCursor: cursor,
      transcriptObservationV1: nextObservation, transcriptSnapshotV1: nextSnapshot });
    expect(runtime.getSnapshot().messages.map(message => message.id)).toContain("base");
    expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("obsolete-older");
    await runtime.loadOlderMessages();
    expect(runtime.getSnapshot().loadingOlder).toBe(false);
    expect(runtime.getSnapshot().messages.map(message => message.id)).toContain("current-older");
    expect(calls.filter(call => call.method === "thread/read/indexed").map(call => call.params.beforeCursor))
      .toEqual([undefined, cursor, undefined, cursor]);
    expect(calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  });

it.each([undefined, proof("c")])("observed reconnect protects expanded coverage and raw authority (%j)", async nextProof => {
  const originalCursor = `tp1:ob1-${"a".repeat(64)}:2`;
  const expandedCursor = `tp1:ob1-${"a".repeat(64)}:1`;
  const { client, calls } = fixture((method, params) => {
    if (method === "thread/resume") return { thread };
    if (method === "turn/start") return { turn: { id: "accepted-turn", status: "running" } };
    return params.beforeCursor ? page(proof(), "expanded", expandedCursor) : page(proof(), "base", originalCursor);
  });
  const runtime = await resume(); await runtime.loadOlderMessages();
  await runtime.send("accepted input", [], undefined, { clientMessageId: "reconnect-cid" });
  client.emit({ method: "turn/started", params: { threadId: thread.id, turnId: "accepted-turn" } });
  client.emit({ method: "item/delta", params: { threadId: thread.id, turnId: "accepted-turn", delta: { text: "accepted live answer" } } });
  runtime.flushPendingDeltas();
  client.emit({ method: "turn/completed", params: { threadId: thread.id, turnId: "accepted-turn", turn: { id: "accepted-turn", status: "completed" } } });
  const before = runtime.getSnapshot().messages;
  const authority = runtime.confirmedTranscriptPage;
  const next = new FakeClient([]); const nextCalls: string[] = [];
  next.supportsExperimental = name => ["threadIndexedPagesV1", "threadTranscriptObservationV1"].includes(name);
  next.request = vi.fn(async (method: string) => {
    nextCalls.push(method);
    return method === "thread/resume" ? { thread } : page(nextProof, "reconnect-page", "7");
  }) as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => next as never) as never);
  await runtime.reconnect();
  if (nextProof === undefined) {
    expect(runtime.getSnapshot().messages).toEqual(before);
    expect(runtime.getSnapshot()).toMatchObject({ connected: true, hasMoreBefore: true,
      beforeCursor: expandedCursor, transcriptObservationV1: proof(), loadingOlder: false });
    expect(runtime.getSnapshot().error).toBeTruthy();
    expect(runtime.confirmedTranscriptPage).toBe(authority);
  } else {
    expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("expanded");
    expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("base");
    expect(runtime.getSnapshot().messages.map(message => message.content)).toContain("accepted live answer");
    expect(runtime.getSnapshot().messages.map(message => message.content)).toContain("accepted input");
    expect(runtime.getSnapshot().transcriptObservationV1).toEqual(nextProof);
    expect(runtime.getSnapshot().error).toBeNull();
    expect(runtime.confirmedTranscriptPage?.page.messages?.map(message => message.id)).toEqual(["reconnect-page"]);
    expect(runtime.confirmedTranscriptRevision).toBe(1);
  }
  expect(nextCalls).toEqual(["thread/resume", "thread/read/indexed"]);
  expect(calls.filter(call => call.method === "turn/start")).toEqual([expect.objectContaining({
    params: expect.objectContaining({ clientMessageId: "reconnect-cid" }),
  })]);
});

it("observed late background read cannot republish old raw authority after a proven rebase or coordinator remount", async () => {
  let reads = 0; let release!: (value: unknown) => void;
  const oldRead = new Promise<unknown>(resolve => { release = resolve; });
  const { calls } = fixture(method => {
    if (method === "thread/resume") return { thread };
    if (++reads === 1) return page(proof(), "obsolete", `tp1:ob1-${"a".repeat(64)}:1`);
    if (reads === 2) return oldRead;
    return page(proof("c"), reads === 3 ? "rejected-older" : "fresh");
  });
  const runtime = await resume();
  // Lease/backend boundaries are isolated here; fixed-fence persistence has
  // independent real-helper/store coverage in cache-publication.test.ts.
  vi.spyOn(cachePublication, "captureRuntimeTranscriptLease").mockImplementation(async (_runtime, scope, isCurrent) =>
    ({ scope, epoch: "e".repeat(64), revision: 1, isCurrent }));
  const save = vi.fn(async (_lease: unknown, _record: unknown) => {});
  const cache = { save };
  const watch = () => {
    const coordinator = new SessionCacheCoordinator({ profile, serverId: server.id, threadId: thread.id, cwd: thread.cwd },
      () => true, cache as never);
    coordinators.add(coordinator); coordinator.watch(runtime, server); return coordinator;
  };
  const initial = watch(); await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1)); initial.close();
  const pending = runtime.readConfirmedTranscriptPage(() => true);
  await vi.waitFor(() => expect(reads).toBe(2));
  await runtime.loadOlderMessages();
  release(page(proof(), "old-late"));
  expect(await pending).toBeNull();
  expect(runtime.confirmedTranscriptPage?.page.messages?.map(message => message.id)).toEqual(["fresh"]);
  watch(); await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls.at(-1)?.[1]).toMatchObject({ messages: [{ id: "fresh", content: "fresh" }] });
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(4);
});
