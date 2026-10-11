// Model-independent Gateway reconnect protocol/lifecycle contract. The fake clients
// control history and notification timing; these tests issue no model request.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gatewaySessionExpired } from "@/gateway/http";
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));

const thread = {
  id: "thread-1",
  cwd: "/workspace",
  title: "恢复任务",
  status: "idle" as const,
  createdAt: 1,
  updatedAt: 2,
};
const existingRow = {
  id: "history-existing",
  role: "user" as const,
  content: "已有记录",
  timestampMs: 10,
};
const reconnectRow = {
  id: "history-reconnect",
  role: "assistant" as const,
  content: "重连后的历史",
  timestampMs: 20,
};
const olderRow = {
  id: "history-older",
  role: "user" as const,
  content: "更早的记录",
  timestampMs: 9,
};
const runtimes = new Set<TaskRuntime>();

type RecordedCall = { method: string; params: JsonRecord };
type RequestHandler = (method: string, params: JsonRecord) => unknown | Promise<unknown>;

function captureClient(
  client: FakeClient,
  capabilities: string[],
  handler: RequestHandler,
): RecordedCall[] {
  client.supportsExperimental = (capability) => capabilities.includes(capability);
  const calls: RecordedCall[] = [];
  client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
    calls.push({ method, params });
    return await handler(method, params);
  }) as never;
  return calls;
}

async function resumeWith(firstClient: FakeClient, reconnectClient: FakeClient) {
  const connector = vi
    .fn()
    .mockResolvedValueOnce(firstClient as never)
    .mockResolvedValueOnce(reconnectClient as never);
  taskRuntimeTestHelpers.setConnector(connector as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
  runtimes.add(runtime);
  return { runtime, connector };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function turnStarted(turnId: string, sequence: number) {
  const attemptId = `${turnId}-attempt`;
  return {
    method: "turn/started",
    params: {
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId,
      attemptId,
      sequence,
      turn: { id: turnId, attemptId, threadId: "thread-1", status: "running" },
    },
  };
}

function turnCompleted(turnId: string, sequence: number) {
  const attemptId = `${turnId}-attempt`;
  return {
    method: "turn/completed",
    params: {
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId,
      attemptId,
      sequence,
      turn: { id: turnId, attemptId, threadId: "thread-1", status: "completed" },
    },
  };
}

beforeEach(() => {
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});

afterEach(() => {
  for (const runtime of runtimes) runtime.close();
  runtimes.clear();
  taskRuntimeTestHelpers.resetConnector();
  vi.restoreAllMocks();
});

it("reconnect uses indexed inline history, replays buffered notifications once, and rebinds ownership", async () => {
  const firstClient = new FakeClient([existingRow]);
  const reconnectClient = new FakeClient([]);
  const resumeSeen = deferred<JsonRecord>();
  const resumeReply = deferred<unknown>();
  const calls = captureClient(
    reconnectClient,
    ["threadResumeHistoryPageV1", "threadIndexedPagesV1"],
    async (method, params) => {
      if (method === "thread/resume") {
        resumeSeen.resolve(params);
        return resumeReply.promise;
      }
      if (method === "thread/read/indexed")
        return {
          thread,
          messages: [olderRow],
          rangeStart: 6,
          rangeEnd: 7,
          hasMoreBefore: false,
          beforeCursor: null,
        };
      throw new Error(`unexpected reconnect RPC ${method}`);
    },
  );
  const { runtime } = await resumeWith(firstClient, reconnectClient);
  const pendingReconnect = runtime.reconnectNow();
  const resumeParams = await resumeSeen.promise;

  expect(resumeParams).toEqual({
    threadId: "thread-1",
    history: { limit: 50, indexed: true },
  });
  expect(firstClient.listeners.size).toBe(1);
  expect(reconnectClient.listeners.size).toBe(1);
  const beforeInlineReply = runtime.getSnapshot();
  reconnectClient.emit(turnStarted("buffered-turn", 1));
  expect(runtime.getSnapshot()).toBe(beforeInlineReply);

  const cursor = "tp1:generation-7:before-7";
  resumeReply.resolve({
    thread,
    history: {
      status: "ready",
      page: {
        messages: [reconnectRow],
        rangeStart: 7,
        rangeEnd: 8,
        hasMoreBefore: true,
        beforeCursor: cursor,
      },
    },
  });
  await pendingReconnect;

  expect(calls).toEqual([{
    method: "thread/resume",
    params: { threadId: "thread-1", history: { limit: 50, indexed: true } },
  }]);
  expect(runtime.getSnapshot()).toMatchObject({
    connected: true,
    running: true,
    activeTurnId: "buffered-turn",
    hasMoreBefore: true,
    beforeCursor: cursor,
  });
  expect(runtime.getSnapshot().messages).toMatchObject([
    { id: "history-reconnect", historyOrdinal: 7 },
  ]);
  expect(firstClient.closed).toBe(true);
  expect(firstClient.listeners.size).toBe(0);
  expect(reconnectClient.listeners.size).toBe(1);

  const afterRebind = runtime.getSnapshot();
  firstClient.emit(turnStarted("stale-old-owner-turn", 2));
  expect(runtime.getSnapshot()).toBe(afterRebind);
  reconnectClient.emit(turnCompleted("buffered-turn", 2));
  expect(runtime.getSnapshot()).toMatchObject({ running: false, activeTurnId: null });

  await runtime.loadOlderMessages();
  expect(calls.at(-1)).toEqual({
    method: "thread/read/indexed",
    params: { threadId: "thread-1", limit: 50, beforeCursor: cursor },
  });
  expect(runtime.getSnapshot().messages.map((message) => message.id)).toEqual([
    "history-older",
    "history-reconnect",
    "assistant-buffered-turn-attempt",
  ]);
});

it.each([
  {
    label: "legacy peer",
    capabilities: ["threadIndexedPagesV1"],
    resumeResult: { thread },
    resumeParams: { threadId: "thread-1" },
  },
  {
    label: "negotiated unavailable history",
    capabilities: ["threadResumeHistoryPageV1", "threadIndexedPagesV1"],
    resumeResult: { thread, history: { status: "unavailable", code: "readFailed" } },
    resumeParams: {
      threadId: "thread-1",
      history: { limit: 50, indexed: true },
    },
  },
])("$label falls back to one read on the reconnect client", async ({
  capabilities,
  resumeResult,
  resumeParams,
}) => {
  const firstClient = new FakeClient([existingRow]);
  const reconnectClient = new FakeClient([]);
  const calls = captureClient(reconnectClient, capabilities, async (method) => {
    if (method === "thread/resume") return resumeResult;
    if (method === "thread/read/indexed")
      return {
        thread,
        messages: [reconnectRow],
        rangeStart: 0,
        rangeEnd: 1,
        hasMoreBefore: false,
        beforeCursor: null,
      };
    throw new Error(`unexpected reconnect RPC ${method}`);
  });
  const { runtime, connector } = await resumeWith(firstClient, reconnectClient);

  await runtime.reconnectNow();

  expect(connector).toHaveBeenCalledTimes(2);
  expect(calls).toEqual([
    { method: "thread/resume", params: resumeParams },
    { method: "thread/read/indexed", params: { threadId: "thread-1", limit: 50 } },
  ]);
  expect(runtime.getSnapshot()).toMatchObject({
    connected: true,
    messages: [expect.objectContaining({ id: "history-reconnect" })],
  });
});

it("malformed inline history closes only the candidate client, cancels buffered frames, and preserves unknown-send ownership", async () => {
  const firstClient = new FakeClient([]);
  const firstCalls: RecordedCall[] = [];
  const defaultRequest = firstClient.request.bind(firstClient);
  firstClient.supportsExperimental = (capability) => capability === "turnReceiptsV1";
  firstClient.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
    firstCalls.push({ method, params });
    if (method === "turn/start")
      throw new MobileRpcError("controlled lost ACK", -1, "transport", "unknown");
    if (method === "turn/receipt/read") return { receipt: null };
    return defaultRequest(method, params);
  }) as never;

  const reconnectClient = new FakeClient([]);
  const calls = captureClient(
    reconnectClient,
    ["threadResumeHistoryPageV1", "threadIndexedPagesV1"],
    async (method) => {
      if (method === "thread/resume") {
        reconnectClient.emit(turnStarted("candidate-only-turn", 1));
        return {
          thread: { ...thread, id: "foreign-thread" },
          history: {
            status: "ready",
            page: {
              messages: [reconnectRow],
              rangeStart: 0,
              rangeEnd: 1,
              hasMoreBefore: false,
              beforeCursor: null,
            },
          },
        };
      }
      throw new Error(`malformed reconnect must not issue ${method}`);
    },
  );
  const { runtime } = await resumeWith(firstClient, reconnectClient);

  await expect(runtime.send("不会重派的消息", [], undefined, {
    clientMessageId: "unknown-send-1",
  })).resolves.toBeUndefined();
  expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(true);
  expect(runtime.uncertainSend).toMatchObject({ clientMessageId: "unknown-send-1" });
  const beforeReconnect = runtime.getSnapshot();

  await runtime.reconnectNow();

  expect(calls).toEqual([{
    method: "thread/resume",
    params: { threadId: "thread-1", history: { limit: 50, indexed: true } },
  }]);
  expect(firstCalls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  expect(reconnectClient.closed).toBe(true);
  expect(reconnectClient.listeners.size).toBe(0);
  expect(firstClient.closed).toBe(false);
  expect(firstClient.listeners.size).toBe(1);
  expect(runtime.getSnapshot()).toMatchObject({
    connected: false,
    sendAcceptanceUnknown: true,
    activeTurnId: beforeReconnect.activeTurnId,
  });
  expect(runtime.uncertainSend).toMatchObject({ clientMessageId: "unknown-send-1" });
  expect(runtime.getSnapshot().messages).toEqual(beforeReconnect.messages);

  firstClient.emit(turnStarted("old-owner-turn", 2));
  expect(runtime.getSnapshot()).toMatchObject({
    activeTurnId: "old-owner-turn",
    sendAcceptanceUnknown: true,
  });
});
