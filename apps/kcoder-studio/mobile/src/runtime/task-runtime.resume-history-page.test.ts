import { afterEach, expect, it, vi } from "vitest";
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { normalizeHistoryPage } from "./task-runtime/history";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";

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
afterEach(() => {
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

it.each([false, true])("inline ready uses one resume and preserves older-page cursor (indexed=%s)", async indexed => {
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
    params: { threadId: "thread-1", limit: 50, beforeCursor: cursor } });
  expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["history-0", "history-1"]);
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
