import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetTaskRuntimeAsyncStorage } from "@/test/task-runtime-async-storage-fixture";
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { normalizeHistoryPage, publishConfirmedHistoryPage } from "./task-runtime/history";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, appServerId, profile, server } from "./task-runtime/fixture.test-support";
import { SessionCacheCoordinator } from "@/features/task/session-cache-coordinator";
vi.mock("@react-native-async-storage/async-storage", async () => {
  const { taskRuntimeAsyncStorage } = await import("@/test/task-runtime-async-storage-fixture");
  return { default: taskRuntimeAsyncStorage };
});
beforeEach(resetTaskRuntimeAsyncStorage);

const thread = { id: "thread-1", cwd: "/workspace", title: "已恢复", status: "idle", createdAt: 1, updatedAt: 2 };
const row = { id: "history-1", role: "user", content: "历史", timestampMs: 1 };
const ready = (messages = [row], start = 0, cursor?: string) => ({
  thread,
  history: { status: "ready", page: {
    messages, rangeStart: start, rangeEnd: start + messages.length,
    hasMoreBefore: Boolean(cursor), ...(cursor ? { beforeCursor: cursor } : {}),
  } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const runtimes = new Set<TaskRuntime>();
const coordinators = new Set<SessionCacheCoordinator>();
afterEach(() => {
  for (const coordinator of coordinators) coordinator.close();
  coordinators.clear();
  for (const runtime of runtimes) runtime.close();
  runtimes.clear(); taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks();
});
function fixture(caps: string[], handler: (method: string, params: JsonRecord) => unknown) {
  const client = new FakeClient([]);
  client.supportsExperimental = name => caps.includes(name);
  const calls: Array<{ method: string; params: JsonRecord }> = [];
  client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
    calls.push({ method, params }); return handler(method, params);
  }) as never;
  const connector = vi.fn(async () => client as never);
  taskRuntimeTestHelpers.setConnector(connector as never);
  return { client, calls, connector };
}
async function resume() {
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
  runtimes.add(runtime); return runtime;
}

it.each([false, true])("inline ready preserves its cursor but never unions an unproved older page (indexed=%s)", async indexed => {
  const cursor = indexed ? "tp1:generation:1" : "1";
  const { calls } = fixture([
    "threadResumeHistoryPageV1", ...(indexed ? ["threadIndexedPagesV1"] : []),
  ], method => method === "thread/resume" ? ready([row], 1, cursor) : {
    thread, messages: [{ ...row, id: "history-0", content: "更早" }],
    rangeStart: 0, rangeEnd: 1, hasMoreBefore: false,
  });
  const runtime = await resume();
  expect(calls).toEqual([{ method: "thread/resume", params: {
    threadId: "thread-1", history: { limit: 50, indexed },
  } }]);
  expect(runtime.getSnapshot().messages).toMatchObject([{ id: "history-1", historyOrdinal: 1 }]);
  expect(runtime.getSnapshot()).toMatchObject({ title: "已恢复", connected: true, beforeCursor: cursor });
  await runtime.loadOlderMessages();
  expect(calls[1]).toEqual({ method: indexed ? "thread/read/indexed" : "thread/read",
    params: { threadId: "thread-1", limit: 50 } });
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["history-1"]);
  expect(runtime.getSnapshot().beforeCursor).toBe(cursor);
  expect(runtime.getSnapshot().error).toBeTruthy();
});

it.each([false, true])("legacy resume retains tolerant read parsing without the new cap (indexed=%s)", async indexed => {
  const { calls } = fixture(indexed ? ["threadIndexedPagesV1"] : [], method =>
    method === "thread/resume" ? { thread, history: { status: "unexpected" } } : {
      // Existing legacy contract tolerates missing range/thread and null cursor.
      messages: [row], hasMoreBefore: false, beforeCursor: null,
    });
  const runtime = await resume();
  expect(calls).toEqual([
    { method: "thread/resume", params: { threadId: "thread-1" } },
    { method: indexed ? "thread/read/indexed" : "thread/read", params: { threadId: "thread-1", limit: 50 } },
  ]);
  expect(runtime.getSnapshot().messages[0]?.content).toBe("历史");
});

it.each(["readFailed", "responseBudgetExceeded"])("explicit unavailable %s falls back once on the same client", async code => {
  const { calls, connector } = fixture(["threadResumeHistoryPageV1"], method =>
    method === "thread/resume" ? { thread, history: { status: "unavailable", code } } : { messages: [row] });
  const runtime = await resume();
  expect(connector).toHaveBeenCalledTimes(1);
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read"]);
  expect(runtime.getSnapshot().messages[0]?.content).toBe("历史");
});

it("negotiated budget-omitted history falls back once on the same client", async () => {
  const { calls, connector } = fixture(["threadResumeHistoryPageV1"], method =>
    method === "thread/resume" ? { thread } : { messages: [row] });
  const runtime = await resume();
  expect(connector).toHaveBeenCalledTimes(1);
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read"]);
  expect(runtime.getSnapshot().messages[0]?.content).toBe("历史");
});

it("read fallback failure never repeats resume or read and releases its buffer", async () => {
  const { client, calls } = fixture(["threadResumeHistoryPageV1"], method => {
    if (method === "thread/resume") return { thread, history: { status: "unavailable", code: "readFailed" } };
    throw new Error("controlled read failure");
  });
  await expect(resume()).rejects.toThrow("controlled read failure");
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read"]);
  expect(client.closed).toBe(true); expect(client.listeners.size).toBe(0);
});

it("activation or capacity failure cannot fall back to read", async () => {
  const { client, calls } = fixture(["threadResumeHistoryPageV1"], () => {
    throw new MobileRpcError("resident capacity full", -32039, "remote");
  });
  await expect(resume()).rejects.toThrow("resident capacity full");
  expect(calls.map(call => call.method)).toEqual(["thread/resume"]);
  expect(client.closed).toBe(true); expect(client.listeners.size).toBe(0);
});

it.each([
  { thread, history: null },
  { ...ready(), thread: { ...thread, id: "foreign-thread" } },
  { thread, history: { status: "unavailable", code: "unknown" } },
  { thread, history: { status: "unavailable", code: "readFailed", page: {} } },
  { ...ready(), history: { status: "ready", page: { ...ready().history.page, thread } } },
  { ...ready(), history: { status: "ready", page: { ...ready().history.page, rangeEnd: 2 } } },
])("malformed negotiated inline outcome rejects before any fallback %#", async invalid => {
  const { calls, client } = fixture(["threadResumeHistoryPageV1"], () => invalid);
  await expect(resume()).rejects.toMatchObject({ reason: "protocol" });
  expect(calls.map(call => call.method)).toEqual(["thread/resume"]);
  expect(client.closed).toBe(true); expect(client.listeners.size).toBe(0);
});

it.each([false, true])("notifications remain buffered until the base page arrives (fallback=%s)", async fallback => {
  const base = deferred<unknown>();
  const { client, calls } = fixture(["threadResumeHistoryPageV1"], method => {
    if (method === "thread/resume" && fallback)
      return { thread, history: { status: "unavailable", code: "readFailed" } };
    return base.promise;
  });
  const pending = resume();
  await vi.waitFor(() => expect(calls.at(-1)?.method).toBe(fallback ? "thread/read" : "thread/resume"));
  client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-live" } });
  client.emit({ method: "item/delta", params: { threadId: "thread-1", turnId: "turn-live", delta: { text: "实时完成" } } });
  client.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-live", turn: { id: "turn-live", status: "completed" } } });
  base.resolve(fallback ? { thread, messages: [row] } : ready());
  const runtime = await pending;
  expect(runtime.getSnapshot().messages.map(message => message.content)).toEqual(["历史", "实时完成"]);
  expect(runtime.getSnapshot().running).toBe(false);
  expect(calls.map(call => call.method)).toEqual(fallback ? ["thread/resume", "thread/read"] : ["thread/resume"]);
});


it.each([
  { fallback: false, carrier: "scalar" }, { fallback: false, carrier: "block" },
  { fallback: true, carrier: "scalar" }, { fallback: true, carrier: "block" },
])("completed assistant page overlaps buffered item and repeated terminal without duplication ($carrier, fallback=$fallback)", async ({ fallback, carrier }) => {
  const base = deferred<unknown>();
  const { client, calls } = fixture(["threadResumeHistoryPageV1"], method => {
    if (method === "thread/resume" && fallback)
      return { thread, history: { status: "unavailable", code: "readFailed" } };
    return base.promise;
  });
  const assistant = { id: "assistant-persisted", role: "assistant",
    content: carrier === "scalar" ? "已完成回答" : "",
    timestampMs: 2, turnId: "turn-overlap", attemptId: "attempt-overlap", status: "completed",
    blocks: carrier === "block" ? [{ id: "item-overlap", type: "text", content: "已完成回答", status: "done" }] : [] };
  expect(normalizeHistoryPage({ messages: [row, assistant] }).messages
    .find(message => message.role === "assistant")?.content).toBe("已完成回答");
  const pending = resume();
  await vi.waitFor(() => expect(calls.at(-1)?.method).toBe(fallback ? "thread/read" : "thread/resume"));
  const context = { threadId: "thread-1", turnId: "turn-overlap", attemptId: "attempt-overlap" };
  client.emit({ method: "item/completed", params: { ...context, sequence: 1,
    item: { id: "item-overlap", type: "agentMessage", text: "已完成回答" } } });
  const terminal = { method: "turn/completed", params: { ...context, sequence: 2,
    turn: { id: "turn-overlap", attemptId: "attempt-overlap", status: "completed" } } };
  client.emit(terminal); client.emit(terminal);
  const messages = [row, assistant];
  base.resolve(fallback ? { thread, messages } : ready(messages));
  const runtime = await pending;
  const projected = runtime.getSnapshot().messages;
  expect(projected.filter(message => message.role === "assistant")).toHaveLength(1);
  expect(projected.find(message => message.role === "assistant")).toMatchObject({
    id: "assistant-persisted", turnId: "turn-overlap", status: "completed", content: "已完成回答",
  });
  expect(runtime.getSnapshot()).toMatchObject({ running: false, activeTurnId: null });
  expect(calls.map(call => call.method)).toEqual(fallback ? ["thread/resume", "thread/read"] : ["thread/resume"]);
});

it("retains the actual inline authority page and counts buffered terminal completion before UI subscription", async () => {
  const pending = deferred<unknown>();
  const { client, calls } = fixture(["threadResumeHistoryPageV1"], () => pending.promise);
  const resumed = resume();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "early" } });
  client.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "early", turn: { id: "early", status: "completed" } } });
  pending.resolve(ready());
  const runtime = await resumed;
  expect(runtime.confirmedTranscriptPage?.page.messages).toEqual([row]);
  expect(runtime.completedTranscriptRevision).toBe(1);
  expect(runtime.confirmedTranscriptRevision).toBe(0);
  client.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "early", turn: { id: "early", status: "completed" } } });
  expect(runtime.completedTranscriptRevision).toBe(1);
  expect(calls.map(call => call.method)).toEqual(["thread/resume"]);
});
it("bounded confirmed read uses the same indexed client and cannot publish after owner invalidation", async () => {
  const held = deferred<unknown>();
  const { calls, connector } = fixture(["threadResumeHistoryPageV1", "threadIndexedPagesV1"], method => method === "thread/resume" ? ready() : held.promise);
  const runtime = await resume(); const original = runtime.confirmedTranscriptPage;
  let current = true; const pending = runtime.readConfirmedTranscriptPage(() => current);
  expect(calls.at(-1)).toEqual({ method: "thread/read/indexed", params: { threadId: "thread-1", limit: 50 } });
  current = false; held.resolve({ thread, messages: [{ ...row, id: "later" }] });
  expect(await pending).toBeNull(); expect(runtime.confirmedTranscriptPage).toBe(original);
  expect(connector).toHaveBeenCalledTimes(1);
  expect(calls.filter(call => call.method === "turn/start")).toHaveLength(0);
});


it("legacy fallback rejects a different thread before publishing or caching authority", async () => {
  const { client, calls } = fixture([], method => method === "thread/resume" ? { thread } : { thread: { ...thread, id: "foreign" }, messages: [row] });
  await expect(resume()).rejects.toMatchObject({ reason: "protocol" });
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read"]);
  expect(client.closed).toBe(true);
});

it("probes presence once after a negotiated remote resume-missing error", async () => {
  const { client, calls } = fixture(["threadPresenceReadV1"], method => {
    if (method === "thread/resume") throw new MobileRpcError("thread missing", -32022, "remote");
    if (method === "thread/presence/read") return {
      status: "unknown", threadId: "thread-1", reason: "coldSourceNotAuthorized",
    };
    throw new Error(`unexpected RPC ${method}`);
  });
  (client as unknown as { matchesRetainedAttachmentOwner: () => boolean })
    .matchesRetainedAttachmentOwner = () => true;

  await expect(resume()).rejects.toMatchObject({ code: -32022, reason: "remote" });
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/presence/read"]);
  expect(client.closed).toBe(true);
});

it("probes presence after the initial read reports a negotiated remote missing thread", async () => {
  const { client, calls } = fixture(["threadResumeHistoryPageV1", "threadPresenceReadV1"], method => {
    if (method === "thread/resume") return { thread };
    if (method === "thread/read") throw new MobileRpcError("thread missing", -32021, "remote");
    if (method === "thread/presence/read") return {
      status: "unknown", threadId: "thread-1", reason: "coldSourceNotAuthorized",
    };
    throw new Error(`unexpected RPC ${method}`);
  });
  (client as unknown as { matchesRetainedAttachmentOwner: () => boolean })
    .matchesRetainedAttachmentOwner = () => true;

  await expect(resume()).rejects.toMatchObject({ code: -32021, reason: "remote" });
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read", "thread/presence/read"]);
  expect(client.closed).toBe(true);
});

it("keeps successful resume/read at zero presence RPCs even when capability is echoed", async () => {
  const { calls } = fixture(["threadPresenceReadV1"], method => method === "thread/resume" ? { thread } : { messages: [row] });
  const runtime = await resume();
  expect(runtime.getSnapshot().messages[0]?.content).toBe("历史");
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read"]);
});

it.each([
  { capability: false, reason: "remote" as const, code: -32022 },
  { capability: true, reason: "transport" as const, code: -32022 },
  { capability: true, reason: "remote" as const, code: -32021 },
])("does not probe outside its exact capability and error boundary (%#)", async ({ capability, reason, code }) => {
  const { calls } = fixture(capability ? ["threadPresenceReadV1"] : [], () => {
    throw new MobileRpcError("resume failure", code, reason);
  });
  await expect(resume()).rejects.toMatchObject({ code, reason });
  expect(calls.map(call => call.method)).toEqual(["thread/resume"]);
});


const identity = (snapshot = "a", view = "b") => ({ status: "available", snapshotId: snapshot.repeat(64), viewKey: view.repeat(64) });
const snapshotOf = (runtime: TaskRuntime) => runtime.getSnapshot() as ReturnType<TaskRuntime["getSnapshot"]> & { transcriptSnapshotV1?: unknown };
const versionedReady = (proof: unknown, cursor = "tp1:generation:1") => {
  const result = ready([row], 1, cursor);
  return { ...result, history: { ...result.history, page: { ...result.history.page, transcriptSnapshotV1: proof } } };
};
const versionedPage = (proof: unknown, id: string, cursor?: string) => ({
  thread, messages: [{ ...row, id }], rangeStart: 0, rangeEnd: 1,
  hasMoreBefore: Boolean(cursor), ...(cursor ? { beforeCursor: cursor } : {}),
  ...(proof === undefined ? {} : { transcriptSnapshotV1: proof }),
});

it.each([identity(), { status: "unavailable", code: "unprovenSource" }])("inline snapshot proof is preserved independently of readable history (%j)", async proof => {
  fixture(["threadResumeHistoryPageV1", "threadIndexedPagesV1", "threadTranscriptSnapshotV1"], () => versionedReady(proof));
  const runtime = await resume();
  expect(snapshotOf(runtime).transcriptSnapshotV1).toEqual(proof);
  expect(runtime.getSnapshot().messages[0].content).toBe("历史");
});

it.each([{ ...identity(), snapshotId: "A".repeat(64) }, { ...identity(), extra: true }])("malformed snapshot identity rejects a normal indexed read (%j)", async proof => {
  fixture(["threadIndexedPagesV1", "threadTranscriptSnapshotV1"], method => method === "thread/resume" ? { thread } : versionedPage(proof, "invalid"));
  await expect(resume()).rejects.toMatchObject({ reason: "protocol" });
});

it.each([identity("c"), identity("a", "d"), undefined, { status: "unavailable", code: "unprovenSource" }])("changed or lost proof replaces obsolete history with one bounded fresh read (%j)", async proof => {
  let reads = 0;
  const fresh = deferred<unknown>();
  const { calls, client, connector } = fixture(["threadIndexedPagesV1", "threadTranscriptSnapshotV1"], method => {
    if (method === "thread/resume") return { thread };
    reads++;
    if (reads === 1) return { ...versionedPage(identity(), "obsolete", "tp1:generation:1"), rangeStart: 1, rangeEnd: 2 };
    if (reads === 2) return versionedPage(proof, "obsolete-older");
    return fresh.promise;
  });
  const runtime = await resume();
  const pending = runtime.loadOlderMessages();
  await vi.waitFor(() => expect(reads).toBe(3));
  // This notification arrived before the replacement page. Snapshot identities
  // do not order events or authorize dropping an observed live correction.
  client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "early-live" } });
  client.emit({ method: "item/delta", params: { threadId: "thread-1", turnId: "early-live", delta: { text: "live correction survives" } } });
  runtime.flushPendingDeltas();
  client.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "early-live", turn: { id: "early-live", status: "completed" } } });
  expect(runtime.getSnapshot().activeTurnId).toBeNull();
  fresh.resolve(versionedPage(proof, "fresh"));
  await pending;
  expect(runtime.getSnapshot().messages.map(message => message.content)).toContain("live correction survives");
  if (proof?.status === "available") {
    expect(runtime.getSnapshot().messages.map(message => message.id)).toContain("fresh");
    expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("obsolete");
    expect(snapshotOf(runtime).transcriptSnapshotV1).toEqual(proof);
  } else {
    expect(runtime.getSnapshot().messages.map(message => message.id)).toContain("obsolete");
    expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("fresh");
    expect(snapshotOf(runtime).transcriptSnapshotV1).toEqual(identity());
    expect(runtime.getSnapshot().error).toBeTruthy();
  }
  expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("obsolete-older");
  expect(calls.filter(call => call.method === "thread/read/indexed").map(call => call.params.beforeCursor)).toEqual([undefined, "tp1:generation:1", undefined]);
  expect(connector).toHaveBeenCalledTimes(1);
});

it.each([identity(), { status: "unavailable", code: "unprovenSource" }, undefined])("equal verified pages merge while unproved rebase preserves existing history (%j)", async proof => {
  let reads = 0;
  const { calls } = fixture(["threadIndexedPagesV1"], method => method === "thread/resume" ? { thread } :
    ++reads === 1 ? { ...versionedPage(proof, "newer", "tp1:generation:1"), rangeStart: 1, rangeEnd: 2 } : versionedPage(proof, "older"));
  const runtime = await resume(); await runtime.loadOlderMessages();
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(proof?.status === "available" ? ["older", "newer"] : ["newer"]);
  if (proof?.status !== "available") {
    expect(runtime.getSnapshot().error).toBeTruthy();
    expect(calls.filter(call => call.method === "thread/read/indexed").map(call => call.params.beforeCursor)).toEqual([undefined, undefined]);
  }
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(2);
  expect(snapshotOf(runtime).transcriptSnapshotV1).toEqual(proof);
});

it("accepted bounded authority read updates displayed proof and paging intent together", async () => {
  let reads = 0;
  const fresh = versionedPage(identity("c"), "fresh-canonical");
  fixture(["threadIndexedPagesV1"], method => method === "thread/resume" ? { thread } :
    ++reads === 1 ? { ...versionedPage(identity(), "newer", "tp1:generation:1"), rangeStart: 1, rangeEnd: 2 } :
    fresh);
  const runtime = await resume(); await runtime.readConfirmedTranscriptPage(() => true);
  expect(runtime.confirmedTranscriptPage?.page).toBe(fresh);
  expect(snapshotOf(runtime).transcriptSnapshotV1).toEqual(identity("c"));
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["fresh-canonical"]);
  expect(runtime.getSnapshot()).toMatchObject({ hasMoreBefore: false, beforeCursor: null, loadingOlder: false });
  await runtime.loadOlderMessages();
  expect(reads).toBe(2);
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["fresh-canonical"]);
});

it("new authority can shorten a pure historical row with the same ID", async () => {
  let reads = 0;
  fixture(["threadIndexedPagesV1"], method => method === "thread/resume" ? { thread } :
    ++reads === 1 ? { ...versionedPage(identity(), "stable", "tp1:generation:1"),
      messages: [{ ...row, id: "stable", content: "历史long obsolete suffix" }], rangeStart: 1, rangeEnd: 2 } :
    versionedPage(identity("c"), "stable"));
  const runtime = await resume(); await runtime.loadOlderMessages();
  expect(reads).toBe(3);
  expect(runtime.getSnapshot().messages).toHaveLength(1);
  expect(runtime.getSnapshot().messages[0]).toMatchObject({ id: "stable", content: "历史" });
});

it("a real same-ID notification correction survives replacement even after terminal", async () => {
  let reads = 0; const held = deferred<unknown>();
  const assistant = { ...row, id: "stable", role: "assistant", turnId: "observed" };
  const { client } = fixture(["threadIndexedPagesV1"], method => method === "thread/resume" ? { thread } :
    ++reads === 1 ? { ...versionedPage(identity(), "stable", "tp1:generation:1"), messages: [assistant], rangeStart: 1, rangeEnd: 2 } :
    reads === 2 ? versionedPage(identity("c"), "mismatch") : held.promise);
  const runtime = await resume(); const pending = runtime.loadOlderMessages();
  await vi.waitFor(() => expect(reads).toBe(3));
  client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "observed" } });
  client.emit({ method: "item/delta", params: { threadId: "thread-1", turnId: "observed", delta: { text: " correction" } } });
  runtime.flushPendingDeltas();
  client.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "observed", turn: { id: "observed", status: "completed" } } });
  expect(runtime.getSnapshot().activeTurnId).toBeNull();
  held.resolve({ ...versionedPage(identity("c"), "stable"), messages: [assistant] }); await pending;
  expect(runtime.getSnapshot().messages).toHaveLength(1);
  expect(runtime.getSnapshot().messages[0]).toMatchObject({ id: "stable", content: "历史 correction" });
});

it("legacy history without ordinals is still history when a proven page replaces it", async () => {
  let reads = 0;
  fixture(["threadIndexedPagesV1"], method => method === "thread/resume" ? { thread } :
    ++reads === 1 ? { messages: [{ ...row, id: "legacy-old" }], hasMoreBefore: true, beforeCursor: "tp1:generation:1" } :
    versionedPage(identity(), "fresh"));
  const runtime = await resume(); await runtime.loadOlderMessages();
  expect(reads).toBe(2);
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["fresh"]);
});

it("owner closing during mismatch recovery prevents late first-page publication", async () => {
  let reads = 0; const held = deferred<unknown>();
  fixture(["threadIndexedPagesV1"], method => method === "thread/resume" ? { thread } :
    ++reads === 1 ? versionedPage(identity(), "original", "tp1:generation:1") :
    reads === 2 ? versionedPage(identity("c"), "mismatch") : held.promise);
  const runtime = await resume(); const pending = runtime.loadOlderMessages();
  await vi.waitFor(() => expect(reads).toBe(3));
  runtime.close(); held.resolve(versionedPage(identity("c"), "late")); await pending;
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["original"]);
});


it.each([true, false])("receipt history reconciliation publishes identity with its actual coverage (changed=%s)", async changed => {
  let reads = 0; const next = changed ? identity("c") : identity();
  const { client, calls } = fixture(["threadIndexedPagesV1"], method => {
    if (method === "thread/resume") return { thread };
    if (++reads === 1) return { ...versionedPage(identity(), "obsolete", "tp1:generation:1"), rangeStart: 1, rangeEnd: 2 };
    return { ...versionedPage(next, "accepted"), messages: [{ ...row, id: "accepted", turnId: "turn-accepted", clientMessageId: "stable-client" }] };
  });
  const runtime = await resume();
  expect(await runtime.reconcileSubmissionHistory(client as never,
    { turn: { id: "turn-accepted", status: "completed" } },
    { threadId: "thread-1", clientMessageId: "stable-client", content: "历史", attachments: [] }, () => true)).toBe(true);
  expect(snapshotOf(runtime).transcriptSnapshotV1).toEqual(next);
  expect(runtime.getSnapshot().beforeCursor).toBe(changed ? null : "tp1:generation:1");
  expect(runtime.getSnapshot().messages.some(message => message.id === "obsolete")).toBe(!changed);
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read/indexed", "thread/read/indexed"]);
});

it("reconnect never unions expanded history under a changed view even if cursors overlap", async () => {
  fixture(["threadIndexedPagesV1"], method => method === "thread/resume" ? { thread } :
    { ...versionedPage(identity(), "shared", "tp1:generation:2"), messages: [{ ...row, id: "obsolete" }, { ...row, id: "shared" }], rangeStart: 1, rangeEnd: 3 });
  const runtime = await resume();
  const nextClient = new FakeClient([]);
  nextClient.supportsExperimental = name => ["threadIndexedPagesV1", "threadResumeHistoryPageV1"].includes(name);
  // Use the same row to establish overlap; a changed view still invalidates union.
  nextClient.request = vi.fn(async () => {
    const result = versionedReady(identity("a", "d"), "tp1:generation:2");
    result.history.page.messages = [{ ...row, id: "shared" }];
    return result;
  }) as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => nextClient as never) as never);
  await runtime.reconnectNow();
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["shared"]);
  expect(snapshotOf(runtime).transcriptSnapshotV1).toEqual(identity("a", "d"));
  expect(nextClient.request).toHaveBeenCalledTimes(1);
});


it("same-version receipt publication cannot strand an owned older-page read", async () => {
  const older = deferred<unknown>();
  const accepted = { ...row, id: "accepted", turnId: "accepted-turn", clientMessageId: "stable-client" };
  const { client, calls } = fixture(["threadIndexedPagesV1"], (method, params) => {
    if (method === "thread/resume") return { thread };
    if (params.beforeCursor) return older.promise;
    return { ...versionedPage(identity(), "accepted", "tp1:generation:1"), messages: [accepted], rangeStart: 1, rangeEnd: 2 };
  });
  const runtime = await resume(); const pending = runtime.loadOlderMessages();
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(await runtime.reconcileSubmissionHistory(client as never,
    { turn: { id: "accepted-turn", status: "completed" } },
    { threadId: "thread-1", clientMessageId: "stable-client", content: "历史", attachments: [] }, () => true)).toBe(true);
  older.resolve(versionedPage(identity(), "older")); await pending;
  expect(runtime.getSnapshot().loadingOlder).toBe(false);
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["older", "accepted"]);
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(3);
});


it.each(["empty", "unrelated", "unchanged", "changed"])("agent/list snapshot never promotes old transcript body to live origin (%s)", async kind => {
  const agents = deferred<unknown>(); let reads = 0;
  const activity = { id: "background-agent", agentId: "agent", type: "activity", label: "review", status: kind === "changed" ? "running" : "completed" };
  const { calls } = fixture(["threadIndexedPagesV1", "agentSteering"], method => {
    if (method === "thread/resume") return { thread };
    if (method === "agent/list") return agents.promise;
    if (++reads === 1) return { ...versionedPage(identity(), "same", "tp1:generation:1"),
      messages: [{ ...row, id: "obsolete" }, { ...row, id: "same", role: "assistant", content: "历史 long obsolete suffix", activities: [activity] }], rangeStart: 1, rangeEnd: 3 };
    return { ...versionedPage(identity("c"), "same"), messages: [{ ...row, id: "same", role: "assistant" }] };
  });
  const runtime = await resume(); const original = runtime.getSnapshot().messages[0];
  const applied = vi.spyOn(runtime, "applySubagentSnapshot");
  agents.resolve({ threadId: "thread-1", agents: kind === "empty" ? [] : [{
    agentId: kind === "unrelated" ? "other" : "agent", status: "completed", queueDepth: 0, acceptingMessages: false,
  }] });
  await vi.waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
  expect(calls.filter(call => call.method === "agent/list")).toHaveLength(1);
  expect(runtime.getSnapshot().messages[0]).toBe(original);
  if (kind === "changed") expect(runtime.getSnapshot().messages[1].activities?.[0].status).toBe("completed");
  await runtime.loadOlderMessages();
  expect(reads).toBe(3);
  expect(runtime.getSnapshot().messages.map(message => message.id)).not.toContain("obsolete");
  expect(runtime.getSnapshot().messages.filter(message => message.id === "same")).toHaveLength(1);
  const replaced = runtime.getSnapshot().messages.find(message => message.id === "same");
  expect(replaced?.content).toBe("历史");
  if (kind === "changed") expect(replaced?.activities?.[0].status).toBe("completed");
});


it.each(["terminal", "todo", "tool", "read-ahead"])("non-body notification cannot revive old body after snapshot reset (%s)", async kind => {
  let reads = 0;
  const old = { ...row, id: "stable", role: "assistant", turnId: "old-turn", content: "历史 long obsolete suffix" };
  const { client } = fixture(["threadIndexedPagesV1"], method => method === "thread/resume" ? { thread } :
    ++reads === 1 ? { ...versionedPage(identity(), "stable", "tp1:generation:1"), messages: [old], rangeStart: 1, rangeEnd: 2 } :
    { ...versionedPage(identity("c"), "stable"), messages: [{ ...old, content: "历史" }] });
  const runtime = await resume();
  if (kind === "terminal") client.emit({ method: "turn/completed", params: {
    threadId: "thread-1", turnId: "old-turn", turn: { id: "old-turn", status: "completed" } } });
  else if (kind === "read-ahead") {
    client.emit({ method: "item/delta", params: { threadId: "thread-1", turnId: "old-turn", itemId: "producer", delta: { text: old.content } } });
    runtime.flushPendingDeltas();
  } else client.emit({ method: kind === "todo" ? "item/started" : "item/completed", params: { threadId: "thread-1", turnId: "old-turn", item: kind === "todo"
    ? { id: "todos", type: "toolCall", name: "TodoWrite", input: { TodoList: [{ content: "new todo", status: "completed" }] } }
    : { id: "tool", type: "toolCall", name: "Read", input: { path: "new.txt" }, output: "observed output", status: "completed" } } });
  await runtime.loadOlderMessages();
  expect(reads).toBe(3);
  expect(runtime.getSnapshot().messages).toHaveLength(1);
  const message = runtime.getSnapshot().messages[0];
  expect(message.content).toBe("历史");
  expect(message.orderedBlocks?.filter(block => block.kind === "text").map(block => block.content).join("")).toBe("历史");
  if (kind === "todo") expect(message.todos).toEqual([{ content: "new todo", status: "completed" }]);
  if (kind === "tool") expect(message.tools?.[0]).toMatchObject({ id: "tool", status: "completed" });
});


it.each(["terminal", "tool", "agent/list"])("decoration cannot restore an authority-removed row (%s)", async kind => {
  const agents = deferred<unknown>(); let reads = 0;
  const { client } = fixture(["threadIndexedPagesV1", ...(kind === "agent/list" ? ["agentSteering"] : [])], method => {
    if (method === "thread/resume") return { thread };
    if (method === "agent/list") return agents.promise;
    if (++reads === 1) return { ...versionedPage(identity(), "removed", "tp1:generation:1"), messages: [{ ...row, id: "removed", role: "assistant", turnId: "old-turn",
      activities: [{ id: "background-agent", agentId: "agent", type: "activity", label: "review", status: "running" }] }], rangeStart: 1, rangeEnd: 2 };
    return versionedPage(identity("c"), "new-id");
  });
  const runtime = await resume();
  if (kind === "agent/list") {
    const applied = vi.spyOn(runtime, "applySubagentSnapshot");
    agents.resolve({ threadId: "thread-1", agents: [{ agentId: "agent", status: "completed", queueDepth: 0 }] });
    await vi.waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
  } else if (kind === "terminal") client.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "old-turn", turn: { id: "old-turn", status: "completed" } } });
  else client.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "old-turn", item: { id: "tool", type: "toolCall", name: "Read", output: "new output" } } });
  await runtime.loadOlderMessages();
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["new-id"]);
});

it("activity-only projection cannot restore old thinking or text blocks", async () => {
  let reads = 0;
  const assistant = (content: string, thinking: string) => ({ ...row, id: "stable", role: "assistant", turnId: "old-turn", content: "",
    blocks: [{ id: "text", type: "text", content }, { id: "thinking", type: "thinking", content: thinking }] });
  const { client } = fixture(["threadIndexedPagesV1"], method => method === "thread/resume" ? { thread } :
    ++reads === 1 ? { ...versionedPage(identity(), "stable", "tp1:generation:1"), messages: [assistant("long body", "long private reasoning")], rangeStart: 1, rangeEnd: 2 } :
    { ...versionedPage(identity("c"), "stable"), messages: [assistant("short", "brief")] });
  const runtime = await resume();
  client.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "old-turn", turn: { id: "old-turn", status: "completed" } } });
  await runtime.loadOlderMessages();
  expect(runtime.getSnapshot().messages[0]).toMatchObject({ content: "short", thinking: "brief" });
  expect(runtime.getSnapshot().messages[0].orderedBlocks?.filter(block => block.kind === "text" || block.kind === "thinking").map(block => block.content)).toEqual(["short", "brief"]);
});

function emitExternalCompletedTurn(client: FakeClient, turnId: string, attemptId: string, chunks: string[], firstSequence = 1) {
  const context = { serverId: appServerId, threadId: thread.id, turnId, attemptId };
  let sequence = firstSequence;
  client.emit({ method: "turn/started", params: { ...context, sequence: sequence++,
    turn: { id: turnId, threadId: thread.id, status: "running" } } });
  client.emit({ method: "item/started", params: { ...context, sequence: sequence++,
    item: { id: `${turnId}-item`, type: "agentMessage" } } });
  for (const text of chunks) client.emit({ method: "item/delta", params: { ...context,
    sequence: sequence++, itemId: `${turnId}-item`, delta: { text } } });
  // The real completion notification carries no prompt or assistant body.
  client.emit({ method: "item/completed", params: { ...context, sequence: sequence++,
    item: { id: `${turnId}-item`, type: "agentMessage", status: "completed" } } });
  client.emit({ method: "turn/completed", params: { ...context, sequence: sequence++,
    turn: { id: turnId, attemptId, status: "completed" } } });
  return sequence;
}

async function terminalAuthorityFixture() {
  const inline = deferred<unknown>();
  const read = deferred<unknown>();
  const transport = fixture([
    "threadResumeHistoryPageV1", "threadIndexedPagesV1", "threadTranscriptObservationV1",
  ], method => {
    if (method === "thread/resume") return inline.promise;
    if (method === "thread/read/indexed") return read.promise;
    if (method === "turn/start") return { threadId: thread.id,
      turn: { id: "local-turn", threadId: thread.id, attemptId: "local-attempt", status: "running" } };
    throw new Error(`unexpected RPC ${method}`);
  });
  const resumed = TaskRuntime.resume({ profile, server, threadId: thread.id, cwd: thread.cwd });
  await vi.waitFor(() => expect(transport.calls.map(call => call.method)).toEqual(["thread/resume"]));
  const nextSequence = emitExternalCompletedTurn(transport.client, "actor-turn", "actor-attempt", ["actor ", "reply"]);
  const seed = [row, { id: "seed-assistant", role: "assistant", content: "seed reply",
    turnId: "seed-turn", attemptId: "seed-attempt", status: "completed", timestampMs: 2 }];
  const initialPage = { messages: seed, rangeStart: 0, rangeEnd: seed.length, hasMoreBefore: false,
    transcriptSnapshotV1: { status: "unavailable", code: "legacyReader" },
    transcriptObservationV1: { observationId: "a".repeat(64), viewKey: "b".repeat(64) } };
  inline.resolve({ thread, history: { status: "ready", page: initialPage } });
  const runtime = await resumed;
  runtimes.add(runtime);
  expect(runtime.completedTranscriptRevision).toBe(1);
  expect(runtime.confirmedTranscriptRevision).toBe(0);
  expect(runtime.getSnapshot().messages.find(message => message.turnId === "actor-turn"))
    .toMatchObject({ role: "assistant", content: "actor reply", status: "completed", attemptId: "actor-attempt" });
  const user = { id: "actor-user-canonical", role: "user", content: "actor input",
    clientMessageId: "actor-cid", turnId: "actor-turn", timestampMs: 3 };
  const assistant = { id: "actor-assistant-canonical", role: "assistant", content: "actor reply",
    turnId: "actor-turn", attemptId: "actor-attempt", status: "completed", timestampMs: 4 };
  const freshPage = { thread, messages: [...seed, user, assistant],
    rangeStart: 0, rangeEnd: seed.length + 2, hasMoreBefore: false,
    transcriptSnapshotV1: { status: "unavailable", code: "legacyReader" },
    transcriptObservationV1: { observationId: "c".repeat(64), viewKey: "d".repeat(64) } };
  return { ...transport, runtime, read, freshPage, user, assistant, nextSequence };
}

it("terminal authority reconciliation adds the external user from its one bounded read after an old inline page", async () => {
  const { runtime, calls, connector, read, freshPage, user, assistant } = await terminalAuthorityFixture();
  const pending = runtime.readConfirmedTranscriptPage(() => true);
  expect(calls.at(-1)).toEqual({ method: "thread/read/indexed", params: { threadId: thread.id, limit: 50 } });
  read.resolve(freshPage);
  const accepted = await pending;
  expect(accepted?.page).toBe(freshPage);
  expect(runtime.confirmedTranscriptPage?.page.messages).toContainEqual(user);
  expect(runtime.confirmedTranscriptRevision).toBe(1);
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read/indexed"]);
  expect(connector).toHaveBeenCalledTimes(1);
  const messages = runtime.getSnapshot().messages;
  expect(messages.filter(message => message.role === "user" && message.clientMessageId === user.clientMessageId))
    .toHaveLength(1);
  expect(messages.find(message => message.clientMessageId === user.clientMessageId))
    .toMatchObject({ id: user.id, turnId: "actor-turn", content: user.content });
  expect(messages.filter(message => message.role === "assistant" && message.turnId === "actor-turn"))
    .toHaveLength(1);
  expect(messages.find(message => message.role === "assistant" && message.turnId === "actor-turn"))
    .toMatchObject({ content: assistant.content, status: "completed", attemptId: "actor-attempt" });
  expect(messages.findIndex(message => message.id === user.id))
    .toBeLessThan(messages.findIndex(message => message.role === "assistant" && message.turnId === "actor-turn"));
  expect(runtime.getSnapshot()).toMatchObject({ running: false, activeTurnId: null });
});

it.each(["owner", "client generation"])("terminal authority reconciliation rejects a read after %s changes", async kind => {
  const { runtime, calls, connector, read, freshPage } = await terminalAuthorityFixture();
  const previousAuthority = runtime.confirmedTranscriptPage;
  const previousSnapshot = runtime.getSnapshot();
  let currentOwner = true;
  const pending = runtime.readConfirmedTranscriptPage(() => currentOwner);
  if (kind === "owner") currentOwner = false;
  else runtime.clientGeneration++;
  read.resolve(freshPage);
  expect(await pending).toBeNull();
  expect(runtime.confirmedTranscriptPage).toBe(previousAuthority);
  expect(runtime.confirmedTranscriptRevision).toBe(0);
  expect(runtime.getSnapshot()).toBe(previousSnapshot);
  expect(runtime.getSnapshot().messages.some(message => message.clientMessageId === "actor-cid")).toBe(false);
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read/indexed"]);
  expect(connector).toHaveBeenCalledTimes(1);
});

it("terminal authority reconciliation keeps a newer terminal while the earlier bounded read is pending", async () => {
  const { runtime, client, calls, read, freshPage, nextSequence } = await terminalAuthorityFixture();
  const pending = runtime.readConfirmedTranscriptPage(() => true);
  emitExternalCompletedTurn(client, "newer-turn", "newer-attempt", ["newer ", "reply"], nextSequence);
  expect(runtime.completedTranscriptRevision).toBe(2);
  read.resolve(freshPage);
  expect((await pending)?.page).toBe(freshPage);
  expect(runtime.confirmedTranscriptRevision).toBe(1);
  expect(runtime.confirmedTranscriptRevision).toBeLessThan(runtime.completedTranscriptRevision);
  expect(runtime.getSnapshot().messages.filter(message => message.role === "assistant" && message.turnId === "newer-turn"))
    .toMatchObject([{ content: "newer reply", status: "completed", attemptId: "newer-attempt" }]);
  expect(runtime.getSnapshot().messages.find(message => message.role === "assistant" && message.turnId === "actor-turn"))
    .toMatchObject({ content: "actor reply", status: "completed" });
  expect(runtime.getSnapshot()).toMatchObject({ running: false, activeTurnId: null });
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read/indexed"]);
});

it("terminal authority reconciliation leaves the displayed page intact when the fresh page has no proof", async () => {
  const { runtime, calls, read, freshPage } = await terminalAuthorityFixture();
  const previous = runtime.getSnapshot();
  const { transcriptObservationV1: _proof, ...unproved } = freshPage;
  const pending = runtime.readConfirmedTranscriptPage(() => true);
  read.resolve(unproved);
  expect((await pending)?.page).toBe(unproved);
  expect(runtime.getSnapshot()).toBe(previous);
  expect(runtime.getSnapshot().messages.some(message => message.clientMessageId === "actor-cid")).toBe(false);
  expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/read/indexed"]);
});

it.each([false, true])("terminal authority reconciliation preserves expanded history only under the same proof (changed=%s)", async changed => {
  const read = deferred<unknown>();
  const proof = { transcriptSnapshotV1: { status: "unavailable", code: "legacyReader" },
    transcriptObservationV1: { observationId: "a".repeat(64), viewKey: "b".repeat(64) } };
  const cursor = `tp1:ob1-${"a".repeat(64)}:2`;
  const older = [{ ...row, id: "older-user", content: "older input", turnId: "older-turn" },
    { ...row, id: "older-assistant", role: "assistant", content: "older reply", turnId: "older-turn", status: "completed" }];
  const page = { messages: [row], rangeStart: 2, rangeEnd: 3, hasMoreBefore: true, beforeCursor: cursor, ...proof };
  const { calls } = fixture(["threadResumeHistoryPageV1", "threadIndexedPagesV1", "threadTranscriptObservationV1"], (method, params) => {
    if (method === "thread/resume") return { thread, history: { status: "ready", page } };
    if (params.beforeCursor) return { thread, messages: older, rangeStart: 0, rangeEnd: 2, hasMoreBefore: false, ...proof };
    return read.promise;
  });
  const runtime = await resume();
  await runtime.loadOlderMessages();
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["older-user", "older-assistant", row.id]);
  const fresh = changed
    ? { thread, messages: [{ ...row, id: "replacement", content: "corrected history" }],
      rangeStart: 0, rangeEnd: 1, hasMoreBefore: false, ...proof,
      transcriptObservationV1: { observationId: "c".repeat(64), viewKey: "d".repeat(64) } }
    : { thread, ...page };
  const pending = runtime.readConfirmedTranscriptPage(() => true);
  read.resolve(fresh);
  expect((await pending)?.page).toBe(fresh);
  expect(runtime.getSnapshot().messages.map(message => message.id))
    .toEqual(changed ? ["replacement"] : ["older-user", "older-assistant", row.id]);
  expect(runtime.getSnapshot()).toMatchObject({ hasMoreBefore: false, beforeCursor: null, loadingOlder: false });
  expect(calls).toHaveLength(3);
  expect(calls.at(-1)).toEqual({ method: "thread/read/indexed", params: { threadId: thread.id, limit: 50 } });
});

it("terminal authority reconciliation preserves a newer unmatched optimistic CID and terminal without another submission", async () => {
  const { runtime, client, calls, read, freshPage, nextSequence } = await terminalAuthorityFixture();
  const pending = runtime.readConfirmedTranscriptPage(() => true);
  await runtime.send("local input", [], undefined, { clientMessageId: "local-cid" });
  const optimistic = runtime.getSnapshot().messages.find(message => message.clientMessageId === "local-cid");
  expect(optimistic).toMatchObject({ content: "local input", turnId: "local-turn" });
  emitExternalCompletedTurn(client, "local-turn", "local-attempt", ["local ", "reply"], nextSequence);
  read.resolve(freshPage);
  await pending;
  expect(runtime.getSnapshot().messages.filter(message => message.clientMessageId === "local-cid"))
    .toMatchObject([{ id: optimistic!.id, content: "local input", turnId: "local-turn" }]);
  expect(runtime.getSnapshot().messages.filter(message => message.role === "assistant" && message.turnId === "local-turn"))
    .toMatchObject([{ content: "local reply", status: "completed", attemptId: "local-attempt" }]);
  expect(runtime.getSnapshot()).toMatchObject({ running: false, activeTurnId: null });
  expect(runtime.confirmedTranscriptRevision).toBe(1);
  expect(runtime.completedTranscriptRevision).toBe(2);
  expect(calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(1);
});

it("terminal authority reconciliation retains matched local CID and completed body over a read captured while running", async () => {
  const { runtime, client, calls, read, freshPage, nextSequence } = await terminalAuthorityFixture();
  await runtime.send("local input", [], undefined, { clientMessageId: "local-cid" });
  const context = { serverId: appServerId, threadId: thread.id, turnId: "local-turn", attemptId: "local-attempt" };
  let sequence = nextSequence;
  client.emit({ method: "turn/started", params: { ...context, sequence: sequence++,
    turn: { id: "local-turn", threadId: thread.id, status: "running" } } });
  client.emit({ method: "item/started", params: { ...context, sequence: sequence++, item: { id: "local-item", type: "agentMessage" } } });
  client.emit({ method: "item/delta", params: { ...context, sequence: sequence++, itemId: "local-item", delta: { text: "local " } } });
  runtime.flushPendingDeltas();
  const pending = runtime.readConfirmedTranscriptPage(() => true);
  client.emit({ method: "item/delta", params: { ...context, sequence: sequence++, itemId: "local-item", delta: { text: "reply" } } });
  client.emit({ method: "item/completed", params: { ...context, sequence: sequence++,
    item: { id: "local-item", type: "agentMessage", status: "completed" } } });
  client.emit({ method: "turn/completed", params: { ...context, sequence: sequence++,
    turn: { id: "local-turn", attemptId: "local-attempt", status: "completed" } } });
  // Optional CID echo and capture-time status are independent of later live events.
  const canonicalUser = { id: "local-user-canonical", role: "user", content: "local input", turnId: "local-turn", timestampMs: 5 };
  const capturedAssistant = { id: "local-assistant-canonical", role: "assistant", content: "local ",
    turnId: "local-turn", attemptId: "local-attempt", status: "running", timestampMs: 6 };
  const captured = { ...freshPage, messages: [...freshPage.messages, canonicalUser, capturedAssistant],
    rangeEnd: freshPage.rangeEnd + 2,
    transcriptObservationV1: { observationId: "e".repeat(64), viewKey: "f".repeat(64) } };
  read.resolve(captured);
  expect((await pending)?.page).toBe(captured);
  expect(runtime.confirmedTranscriptPage?.page.messages?.at(-1)).toEqual(capturedAssistant);
  expect(runtime.getSnapshot().messages.filter(message => message.role === "user" && message.turnId === "local-turn"))
    .toMatchObject([{ id: canonicalUser.id, clientMessageId: "local-cid", content: "local input" }]);
  expect(runtime.getSnapshot().messages.filter(message => message.role === "assistant" && message.turnId === "local-turn"))
    .toMatchObject([{ id: capturedAssistant.id, content: "local reply", status: "completed", attemptId: "local-attempt" }]);
  expect(runtime.getSnapshot()).toMatchObject({ running: false, activeTurnId: null });
  expect(runtime.confirmedTranscriptRevision).toBe(1);
  expect(runtime.completedTranscriptRevision).toBe(2);
  expect(calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  expect(calls.filter(call => call.method === "thread/read/indexed")).toHaveLength(1);
});

it("terminal authority reconciliation never overlays a known different attempt's running status", async () => {
  const { runtime, read, freshPage, assistant } = await terminalAuthorityFixture();
  const pending = runtime.readConfirmedTranscriptPage(() => true);
  const foreignAttempt = { ...assistant, id: "other-attempt-assistant", attemptId: "other-attempt",
    content: "other attempt body", status: "running" };
  read.resolve({ ...freshPage, messages: [...freshPage.messages.slice(0, -1), foreignAttempt] });
  await pending;
  expect(runtime.getSnapshot().messages.find(message => message.attemptId === "actor-attempt"))
    .toMatchObject({ content: "actor reply", status: "completed" });
  expect(runtime.getSnapshot().messages.find(message => message.id === foreignAttempt.id))
    .toMatchObject({ attemptId: "other-attempt", content: "other attempt body", status: "running" });
});

async function expandedTerminalAnchorFixture(anchorAtLive = false) {
  const held = deferred<unknown>();
  const later = deferred<unknown>();
  const oldProof = { transcriptSnapshotV1: { status: "unavailable", code: "legacyReader" },
    transcriptObservationV1: { observationId: "a".repeat(64), viewKey: "b".repeat(64) } };
  const rows = Array.from({ length: 52 }, (_, index) => ({ id: `seed-${index}`,
    role: index % 2 ? "assistant" : "user", content: `seed content ${index}`, timestampMs: index + 1,
    turnId: `seed-turn-${Math.floor(index / 2)}`, ...(index % 2 ? { attemptId: `seed-attempt-${Math.floor(index / 2)}`, status: "completed" } : {}) }));
  const initial = { messages: rows.slice(2), rangeStart: 2, rangeEnd: 52, hasMoreBefore: true,
    beforeCursor: `tp1:ob1-${"a".repeat(64)}:2`, ...oldProof };
  let firstPageReads = 0;
  const transport = fixture(["threadResumeHistoryPageV1", "threadIndexedPagesV1", "threadTranscriptObservationV1"], (method, params) => {
    if (method === "thread/resume") return { thread, history: { status: "ready", page: initial } };
    if (params.beforeCursor) return { thread, messages: rows.slice(0, 2), rangeStart: 0, rangeEnd: 2,
      hasMoreBefore: false, ...oldProof };
    return ++firstPageReads === 1 ? held.promise : later.promise;
  });
  const runtime = await resume();
  await runtime.loadOlderMessages();
  expect(runtime.getSnapshot().messages).toHaveLength(52);
  let ownerCurrent = true;
  const coordinator = new SessionCacheCoordinator({ profile, serverId: server.id, threadId: thread.id, cwd: thread.cwd },
    () => ownerCurrent, { capturePublisherLease: vi.fn(async () => null), save: vi.fn(async () => {}) } as never);
  coordinators.add(coordinator);
  const stopWatching = coordinator.watch(runtime, server);
  let anchor = { messageId: rows[0].id, offset: 17, followsLatest: false };
  coordinator.readAnchor(anchor, true);
  const nextSequence = emitExternalCompletedTurn(transport.client, "actor-turn", "actor-attempt", ["actor ", "reply"]);
  await vi.waitFor(() => expect(transport.calls.filter(call => call.method === "thread/read/indexed" && !call.params.beforeCursor)).toHaveLength(1));
  const actorUser = { id: "actor-user-canonical", role: "user", content: "actor input",
    clientMessageId: "actor-cid", turnId: "actor-turn", timestampMs: 53 };
  const actorAssistant = { id: "actor-assistant-canonical", role: "assistant", content: "actor reply",
    turnId: "actor-turn", attemptId: "actor-attempt", status: "completed", timestampMs: 54 };
  const fresh = { thread, messages: [...rows.slice(4), actorUser, actorAssistant],
    rangeStart: 4, rangeEnd: 54, hasMoreBefore: true, beforeCursor: `tp1:ob1-${"c".repeat(64)}:4`,
    transcriptSnapshotV1: oldProof.transcriptSnapshotV1,
    transcriptObservationV1: { observationId: "c".repeat(64), viewKey: "d".repeat(64) } };
  expect(fresh.messages).toHaveLength(50);
  if (anchorAtLive) {
    anchor = { ...anchor, messageId: runtime.getSnapshot().messages.find(message => message.turnId === "actor-turn")!.id };
    coordinator.readAnchor(anchor, true);
  }
  const displayedBefore = runtime.getSnapshot();
  held.resolve(fresh);
  await vi.waitFor(() => expect(runtime.confirmedTranscriptPage?.page).toBe(fresh));
  return { ...transport, runtime, coordinator, stopWatching, anchor, fresh, displayedBefore, later, nextSequence,
    loseOwner: () => { ownerCurrent = false; }, oldProof };
}

it("terminal anchor reconciliation retains an expanded older row and its exact reading marker", async () => {
  const { runtime, coordinator, anchor, displayedBefore, oldProof, calls } = await expandedTerminalAnchorFixture();
  expect(runtime.getSnapshot()).toBe(displayedBefore);
  expect(runtime.getSnapshot().messages.find(message => message.id === anchor.messageId)).toBe(displayedBefore.messages[0]);
  expect(coordinator.anchor).toEqual(anchor);
  expect(runtime.getSnapshot()).toMatchObject({ ...oldProof, hasMoreBefore: false, beforeCursor: null });
  expect(runtime.confirmedTranscriptRevision).toBe(1);
  expect(calls).toHaveLength(3);
});

it("terminal anchor reconciliation applies the accepted raw page locally only after an explicit return to latest", async () => {
  const { runtime, coordinator, fresh, calls } = await expandedTerminalAnchorFixture();
  expect(runtime.getSnapshot().messages.some(message => message.clientMessageId === "actor-cid")).toBe(false);
  const authority = runtime.confirmedTranscriptPage;
  const live = runtime.getSnapshot().messages.find(message => message.turnId === "actor-turn")!;
  coordinator.readAnchor({ messageId: live.id, offset: 0, followsLatest: true }, true);
  expect(runtime.getSnapshot().messages.filter(message => message.clientMessageId === "actor-cid"))
    .toMatchObject([{ id: "actor-user-canonical", content: "actor input" }]);
  expect(runtime.getSnapshot()).toMatchObject({ transcriptObservationV1: fresh.transcriptObservationV1,
    hasMoreBefore: true, beforeCursor: fresh.beforeCursor, running: false, activeTurnId: null });
  expect(runtime.confirmedTranscriptPage).toBe(authority);
  expect(runtime.confirmedTranscriptRevision).toBe(1);
  expect(calls).toHaveLength(3);
});

it("terminal anchor reconciliation retains a live reading row until its canonical ID can be applied at latest", async () => {
  const f = await expandedTerminalAnchorFixture(true);
  expect(f.runtime.getSnapshot()).toBe(f.displayedBefore);
  expect(f.runtime.getSnapshot().messages.find(message => message.id === f.anchor.messageId))
    .toBe(f.displayedBefore.messages.find(message => message.id === f.anchor.messageId));
  expect(f.runtime.confirmedTranscriptPage?.page.messages?.some(message => message.id === "actor-assistant-canonical")).toBe(true);
  f.coordinator.readAnchor({ ...f.anchor, followsLatest: true }, true);
  expect(f.runtime.getSnapshot().messages.find(message => message.id === "actor-assistant-canonical"))
    .toMatchObject({ content: "actor reply", status: "completed" });
  expect(f.calls).toHaveLength(3);
});

it.each(["owner", "client generation", "new terminal", "watch generation", "raw authority", "page proof"])("terminal anchor reconciliation cannot publish a deferred page after %s changes", async kind => {
  const f = await expandedTerminalAnchorFixture();
  const before = f.runtime.getSnapshot();
  if (kind === "owner") f.loseOwner();
  else if (kind === "client generation") f.runtime.clientGeneration++;
  else if (kind === "watch generation") { f.stopWatching(); f.coordinator.watch(f.runtime, server); }
  else if (kind === "raw authority") publishConfirmedHistoryPage(f.runtime, { ...f.runtime.confirmedTranscriptPage!.page }, 1, () => true);
  else if (kind === "page proof") f.runtime.patch({ transcriptObservationV1: { observationId: "e".repeat(64), viewKey: "f".repeat(64) } });
  else emitExternalCompletedTurn(f.client, "newer-turn", "newer-attempt", ["newer ", "reply"], f.nextSequence);
  const expectedProof = f.runtime.getSnapshot().transcriptObservationV1;
  const live = f.runtime.getSnapshot().messages.find(message => message.turnId === "actor-turn")!;
  f.coordinator.readAnchor({ messageId: live.id, offset: 0, followsLatest: true }, true);
  expect(f.runtime.getSnapshot().messages.some(message => message.clientMessageId === "actor-cid")).toBe(false);
  expect(f.runtime.getSnapshot().messages.find(message => message.id === f.anchor.messageId)).toBe(before.messages[0]);
  expect(f.runtime.getSnapshot().transcriptObservationV1).toEqual(expectedProof);
  if (kind === "new terminal") {
    expect(f.runtime.completedTranscriptRevision).toBe(2);
    expect(f.runtime.getSnapshot().messages.find(message => message.turnId === "newer-turn"))
      .toMatchObject({ content: "newer reply", status: "completed" });
  }
  f.loseOwner();
  f.later.resolve(f.fresh);
});
