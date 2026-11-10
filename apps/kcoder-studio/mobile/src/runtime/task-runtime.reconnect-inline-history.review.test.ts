// Model-independent Gateway reconnect protocol/lifecycle contract. The fake clients
// control history and notification timing; these tests issue no model request.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetTaskRuntimeAsyncStorage } from "@/test/task-runtime-async-storage-fixture";
import { gatewaySessionExpired } from "@/gateway/http";
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, appServerId, profile, server } from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));
vi.mock("@react-native-async-storage/async-storage", async () => {
  const { taskRuntimeAsyncStorage } = await import("@/test/task-runtime-async-storage-fixture");
  return { default: taskRuntimeAsyncStorage };
});

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
      serverId: appServerId,
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
      serverId: appServerId,
      threadId: "thread-1",
      turnId,
      attemptId,
      sequence,
      turn: { id: turnId, attemptId, threadId: "thread-1", status: "completed" },
    },
  };
}

function seedCompletedLivePair(runtime: TaskRuntime, client: FakeClient, userId = "canonical-user-rolled-back") {
  client.emit(turnStarted("rolled-back-turn", 1));
  runtime.patch({ messages: [...runtime.getSnapshot().messages, {
    id: userId, role: "user", content: "second turn",
    timestampMs: 11, turnId: "rolled-back-turn", clientMessageId: "accepted-second-turn",
  }] });
  client.emit({ method: "item/delta", params: {
    serverId: appServerId, threadId: "thread-1", turnId: "rolled-back-turn",
    attemptId: "rolled-back-turn-attempt", sequence: 2, delta: { text: "answer" },
  } });
  client.emit(turnCompleted("rolled-back-turn", 3));
  expect(runtime.getSnapshot().messages.filter(row => row.turnId === "rolled-back-turn"))
    .toMatchObject([{ role: "user" }, { role: "assistant", status: "completed" }]);
}

function rollbackAuthority(status: "idle" | "unknown" | "failed" = "idle", hasMoreBefore = false) {
  return { thread: { ...thread, status }, history: { status: "ready", page: {
    messages: [existingRow], rangeStart: 0, rangeEnd: 1,
    hasMoreBefore, beforeCursor: hasMoreBefore ? "older-page" : null,
    transcriptSnapshotV1: { status: "available", snapshotId: "c".repeat(64), viewKey: "d".repeat(64) },
  } } };
}

beforeEach(() => {
  resetTaskRuntimeAsyncStorage();
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});

afterEach(() => {
  for (const runtime of runtimes) runtime.close();
  runtimes.clear();
  taskRuntimeTestHelpers.resetConnector();
  vi.restoreAllMocks();
});

it("connection feedback follows scheduled recovery, success, retry exhaustion and expired authorization", async () => {
  const { runtime } = await resumeWith(new FakeClient([existingRow]), new FakeClient([existingRow]));
  runtime.scheduleReconnect("socket disconnected");
  expect(runtime.getSnapshot()).toMatchObject({ connected: false, connectionPhase: "reconnecting" });
  await runtime.reconnectNow();
  expect(runtime.getSnapshot().connected).toBe(true);
  expect(runtime.getSnapshot().connectionPhase).toBeUndefined();
  runtime.reconnectAttempt = 8;
  runtime.scheduleReconnect("socket disconnected");
  expect(runtime.getSnapshot()).toMatchObject({ connected: false, connectionPhase: "failed" });
  expect(runtime.reconnectTimer).toBeNull();
  runtime.reconnectAttempt = 0;
  runtime.reconnectContext = { ...runtime.reconnectContext!, profile: {
    ...runtime.reconnectContext!.profile, expiresAt: 0, refreshToken: undefined,
  } };
  await expect(runtime.reconnectNow()).rejects.toThrow("Gateway");
  expect(runtime.getSnapshot().connectionPhase).toBe("reauthorization-required");
  runtime.scheduleReconnect("socket disconnected");
  expect(runtime.getSnapshot().connectionPhase).toBe("reauthorization-required");
  expect(runtime.reconnectTimer).toBeNull();
});

it("an authorization failure during reconnect is published as requiring sign-in", async () => {
  const connector = vi.fn().mockResolvedValueOnce(new FakeClient([existingRow])).mockRejectedValueOnce(new Error("HTTP 401"));
  taskRuntimeTestHelpers.setConnector(connector as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
  runtimes.add(runtime);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(true);
  await runtime.reconnectNow();
  expect(runtime.getSnapshot()).toMatchObject({ connected: false, connectionPhase: "reauthorization-required" });
  expect(runtime.reconnectTimer).toBeNull();
});

it("reconnect uses indexed inline history, replays buffered notifications once, and rebinds ownership", async () => {
  const firstClient = new FakeClient([existingRow]);
  const reconnectClient = new FakeClient([]);
  const resumeSeen = deferred<JsonRecord>();
  const resumeReply = deferred<unknown>();
  const snapshot = { status: "available", snapshotId: "a".repeat(64), viewKey: "b".repeat(64) };
  const calls = captureClient(
    reconnectClient,
    ["threadResumeHistoryPageV1", "threadIndexedPagesV1", "threadTranscriptSnapshotV1"],
    async (method, params) => {
      if (method === "thread/resume") {
        resumeSeen.resolve(params);
        return resumeReply.promise;
      }
      if (method === "thread/read/indexed")
        return {
          thread,
          transcriptSnapshotV1: snapshot,
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
        transcriptSnapshotV1: snapshot,
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

it("removes a completed live turn absent from a full idle reconnect authority", async () => {
  const firstClient = new FakeClient([existingRow]);
  const reconnectClient = new FakeClient([]);
  const reply = deferred<unknown>();
  const requestSeen = deferred<void>();
  captureClient(reconnectClient, ["threadResumeHistoryPageV1"], (method) => {
    if (method !== "thread/resume") throw new Error(`unexpected ${method}`);
    requestSeen.resolve();
    return reply.promise;
  });
  const { runtime } = await resumeWith(firstClient, reconnectClient);
  seedCompletedLivePair(runtime, firstClient);
  const reconnecting = runtime.reconnectNow();
  await requestSeen.promise;
  reconnectClient.emit(turnStarted("buffered-new-turn", 4));
  reply.resolve(rollbackAuthority());
  await reconnecting;
  expect(runtime.getSnapshot().messages.map(row => row.id)).toEqual([existingRow.id]);
  expect(runtime.getSnapshot()).toMatchObject({ running: true, activeTurnId: "buffered-new-turn" });
});

it.each([
  { label: "unknown activity", status: "unknown" as const },
  { label: "failed activity", status: "failed" as const },
  { label: "partial history", status: "idle" as const, partial: true },
  { label: "local user", status: "idle" as const, localUser: true },
  { label: "pending acceptance", status: "idle" as const, pending: true },
  { label: "old-client arrival during read", status: "idle" as const, oldArrival: true },
  { label: "changed candidate during read", status: "idle" as const, changedCandidate: true },
  { label: "changed authorization scope", status: "idle" as const, changedScope: true },
  { label: "missing completed attempt evidence", status: "idle" as const, missingCompletion: true },
  { label: "active interaction", status: "idle" as const, activeInteraction: true },
  { label: "invalid owner scope", status: "idle" as const, invalidScope: true },
  { label: "different authority workspace", status: "idle" as const, wrongAuthorityCwd: true },
])("retains the completed live pair when $label leaves deletion unproved", async (scenario) => {
  const firstClient = new FakeClient([existingRow]);
  const reconnectClient = new FakeClient([]);
  const reply = deferred<unknown>();
  const requestSeen = deferred<void>();
  captureClient(reconnectClient, ["threadResumeHistoryPageV1"], (method) => {
    if (method !== "thread/resume") throw new Error(`unexpected ${method}`);
    requestSeen.resolve();
    return reply.promise;
  });
  const { runtime } = await resumeWith(firstClient, reconnectClient);
  seedCompletedLivePair(runtime, firstClient, "localUser" in scenario ? "local-user-rolled-back" : undefined);
  if ("pending" in scenario) runtime.patch({ sendAcceptanceUnknown: true });
  if ("missingCompletion" in scenario) runtime.finishedAttempts.clear();
  if ("activeInteraction" in scenario) runtime.patch({ activeTurnId: "other-active-turn" });
  if ("invalidScope" in scenario) runtime.reconnectContext!.server =
    { ...runtime.reconnectContext!.server, workspacePath: "relative-workspace" };
  const reconnecting = runtime.reconnectNow();
  await requestSeen.promise;
  if ("oldArrival" in scenario) firstClient.emit(turnStarted("late-old-client-turn", 4));
  if ("changedCandidate" in scenario) runtime.patch({ messages: runtime.getSnapshot().messages.map(row =>
    row.id === "canonical-user-rolled-back" ? { ...row } : row) });
  if ("changedScope" in scenario) runtime.reconnectContext!.profile =
    { ...runtime.reconnectContext!.profile, authorizationGeneration: "changed" };
  const authority = rollbackAuthority(scenario.status, "partial" in scenario);
  if ("wrongAuthorityCwd" in scenario) authority.thread.cwd = "/other-workspace";
  reply.resolve(authority);
  await reconnecting;
  expect(runtime.getSnapshot().messages.some(row => row.role === "user" && row.turnId === "rolled-back-turn")).toBe(true);
  expect(runtime.getSnapshot().messages.some(row => row.role === "assistant" && row.turnId === "rolled-back-turn")).toBe(true);
});

it("keeps live rows when a legacy raw first page omits hasMoreBefore", async () => {
  const firstClient = new FakeClient([existingRow]);
  const reconnectClient = new FakeClient([]);
  const originalRequest = reconnectClient.request.bind(reconnectClient);
  captureClient(reconnectClient, [], (method, params) => {
    if (method === "thread/resume") return { thread };
    if (method === "thread/read") return {
      thread, messages: [existingRow], rangeStart: 0, rangeEnd: 1,
      beforeCursor: null,
      transcriptSnapshotV1: { status: "available", snapshotId: "c".repeat(64), viewKey: "d".repeat(64) },
    };
    return originalRequest(method, params);
  });
  const { runtime } = await resumeWith(firstClient, reconnectClient);
  seedCompletedLivePair(runtime, firstClient);
  await runtime.reconnectNow();
  expect(runtime.getSnapshot().messages.filter(row => row.turnId === "rolled-back-turn")).toHaveLength(2);
});

it("rejects a buffered notification overflow before publishing or pruning reconnect history", async () => {
  const firstClient = new FakeClient([existingRow]);
  const reconnectClient = new FakeClient([]);
  const reply = deferred<unknown>();
  const requestSeen = deferred<void>();
  captureClient(reconnectClient, ["threadResumeHistoryPageV1"], (method) => {
    if (method !== "thread/resume") throw new Error(`unexpected ${method}`);
    requestSeen.resolve();
    return reply.promise;
  });
  const { runtime } = await resumeWith(firstClient, reconnectClient);
  seedCompletedLivePair(runtime, firstClient);
  const before = runtime.getSnapshot();
  const beforeConfirmed = runtime.confirmedTranscriptPage;
  const observedErrors: string[] = [];
  const unsubscribe = runtime.subscribe(() => {
    if (runtime.getSnapshot().error) observedErrors.push(runtime.getSnapshot().error!);
  });
  const reconnecting = runtime.reconnectNow();
  await requestSeen.promise;
  for (let index = 0; index <= 512; index++)
    reconnectClient.emit(turnStarted(`buffered-${index}`, index + 1));
  reply.resolve(rollbackAuthority());
  await reconnecting;
  expect(runtime.getSnapshot().messages).toBe(before.messages);
  expect(runtime.getSnapshot().transcriptSnapshotV1).toBe(before.transcriptSnapshotV1);
  expect(runtime.confirmedTranscriptPage).toBe(beforeConfirmed);
  expect(observedErrors.some(error => error.includes("缓存上限"))).toBe(true);
  expect(runtime.getSnapshot().connected).toBe(false);
  expect(firstClient.closed).toBe(false);
  expect(reconnectClient.closed).toBe(true);
  unsubscribe();
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
])("$label reads once on reconnect and retains unproved existing history", async ({
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
    messages: [expect.objectContaining({ id: "history-existing" })],
  });
  expect(runtime.getSnapshot().error).toBeTruthy();
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

it("keeps a deferred resume read-only across reconnect until same-generation local preferences are checked", async () => {
  const first = new FakeClient([existingRow]);
  const second = new FakeClient([existingRow]);
  const configuration = deferred<unknown>();
  const record = (client: FakeClient, hold: boolean) => {
    const original = client.request.bind(client);
    return captureClient(client, [], async (method, params) => {
      if (method === "thread/resume") return { thread: { ...thread, model: "M2" } };
      if (method === "runtime.models.list") return hold ? configuration.promise : {};
      return original(method, params);
    });
  };
  const firstCalls = record(first, false), secondCalls = record(second, true);
  const connector = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  taskRuntimeTestHelpers.setConnector(connector as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: thread.id, deferConfiguration: true });
  runtimes.add(runtime);
  expect(runtime.getSnapshot().messages[0]?.id).toBe(existingRow.id);
  expect(runtime.getSnapshot().configurationReady).toBe(false);
  await expect(runtime.send("wait for preferences")).rejects.toThrow("正在校验");
  await runtime.reconnectNow();
  expect(runtime.getSnapshot().configurationReady).toBe(false);
  expect(secondCalls.filter(call => call.method === "runtime.models.list")).toHaveLength(0);
  const applying = runtime.restoreWorkspaceConfiguration("ultra");
  expect(runtime.getSnapshot().configurationReady).toBe(false);
  expect(secondCalls.filter(call => call.method === "runtime.models.list")).toHaveLength(1);
  configuration.resolve({}); await applying;
  expect(runtime.getSnapshot().configurationReady).toBe(true);
  expect(runtime.getSnapshot().reasoningEffort).toBe("ultra");
  expect(connector).toHaveBeenCalledTimes(2);
  expect([...firstCalls, ...secondCalls].some(call => call.method === "thread/metadata/update" || call.method === "turn/start")).toBe(false);
});

it("a late old-generation preference read cannot open configuration after reconnect or owner change", async () => {
  const old = new FakeClient([existingRow]), next = new FakeClient([existingRow]);
  const oldRead = deferred<unknown>(), nextRead = deferred<unknown>();
  const setup = (client: FakeClient, read: Promise<unknown>) => {
    const original = client.request.bind(client);
    captureClient(client, [], (method, params) => method === "thread/resume"
      ? { thread: { ...thread, model: "M2" } }
      : method === "runtime.models.list" ? read : original(method, params));
  };
  setup(old, oldRead.promise); setup(next, nextRead.promise);
  taskRuntimeTestHelpers.setConnector(vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: thread.id, deferConfiguration: true });
  runtimes.add(runtime);
  let ownerCurrent = true;
  const applying = runtime.restoreWorkspaceConfiguration("high", () => ownerCurrent);
  await runtime.reconnectNow();
  oldRead.resolve({}); await applying;
  expect(runtime.getSnapshot().configurationReady).toBe(false);
  ownerCurrent = false; nextRead.resolve({}); await Promise.resolve(); await Promise.resolve();
  expect(runtime.getSnapshot().configurationReady).toBe(false);
  await runtime.restoreWorkspaceConfiguration(undefined, () => true);
  expect(runtime.getSnapshot().configurationReady).toBe(true);
  expect(runtime.getSnapshot().reasoningEffort).toBeUndefined();
  const checking = runtime.restoreWorkspaceConfiguration("high");
  expect(runtime.getSnapshot().configurationReady).toBe(false);
  await checking;
  expect(runtime.getSnapshot().configurationReady).toBe(true);
});
