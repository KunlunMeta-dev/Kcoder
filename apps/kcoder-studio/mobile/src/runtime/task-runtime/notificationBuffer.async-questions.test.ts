import { afterEach, expect, test, vi } from "vitest";
import type { RpcMessage } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import { bufferNotifications } from "./notificationBuffer";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 1, createdAtMs: 1,
  status: "pending", questions: [{ id: "item", header: "Mode", question: "Which mode?",
    multiSelect: false, options: [{ id: "fast", label: "Fast", description: "" }] }],
};
const changed = (record = question): RpcMessage => ({
  method: "asyncQuestion/changed", params: { threadId: record.threadId, question: record },
});
const latest: AsyncQuestionRecord = { ...question, revision: 2, status: "cancelled" };

class QuestionClient extends FakeClient {
  reads = 0;
  constructor(events: RpcMessage[] = []) { super([], events); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params = {}): Promise<T> {
    if (method === "asyncQuestion/list") {
      this.reads++;
      return { threadId: question.threadId, questions: [latest] } as T;
    }
    return super.request<T>(method, params);
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

test.each(["resume", "reconnect"] as const)("%s survives exact question replays while history is loading", async mode => {
  const replay = Array.from({ length: 513 }, () => structuredClone(changed()));
  replay.push(changed(latest));
  const client = new QuestionClient(mode === "resume" ? replay : []);
  let current = client;
  taskRuntimeTestHelpers.setConnector((async () => current as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  if (mode === "reconnect") {
    current = new QuestionClient(replay);
    await runtime.reconnectNow();
  }
  await runtime.refreshAsyncQuestions();
  expect(runtime.getSnapshot()).toMatchObject({ connected: true, error: null });
  expect(runtime.client).toBe(current);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, questions: [latest] });
});

test("question replay compaction retains original event order and forwards later live events", () => {
  const client = new FakeClient([]);
  const buffered = bufferNotifications(client as never);
  const turn: RpcMessage = { method: "turn/completed", params: { threadId: question.threadId, turnId: "source" } };
  client.emit(changed());
  client.emit(turn);
  for (let index = 0; index < 513; index++) client.emit(structuredClone(changed()));
  client.emit(changed(latest));
  const receive = vi.fn();
  const stop = buffered.activate(receive);
  expect(receive.mock.calls.map(([message]) => message)).toEqual([changed(), turn, changed(latest)]);
  client.emit(changed(latest));
  expect(receive).toHaveBeenCalledTimes(4);
  stop();
  expect(client.listeners.size).toBe(0);
});

test("exact question replays do not consume the byte budget repeatedly", () => {
  const client = new FakeClient([]);
  const buffered = bufferNotifications(client as never);
  const large = changed({ ...question, questions: [{ ...question.questions[0], question: "x".repeat(12 * 1024) }] });
  for (let index = 0; index < 100; index++) client.emit(structuredClone(large));
  expect(buffered.hasOverflowed()).toBe(false);
  const receive = vi.fn();
  const stop = buffered.activate(receive);
  expect(receive.mock.calls.map(([message]) => message)).toEqual([large]);
  stop();
});

test.each(["revision", "content", "thread", "ordinary event"] as const)(
  "distinct %s frames still enforce the original frame limit", kind => {
    const client = new FakeClient([]);
    const buffered = bufferNotifications(client as never);
    for (let index = 0; index < 513; index++) {
      const record = structuredClone(question);
      if (kind === "revision") record.revision = index + 1;
      if (kind === "content") record.questions[0].question = `Prompt ${index}`;
      if (kind === "thread") record.threadId = `thread-${index}`;
      client.emit(kind === "ordinary event" ? { method: "item/delta", params: { text: "same" } } : changed(record));
    }
    expect(buffered.hasOverflowed()).toBe(true);
    expect(() => buffered.activate(vi.fn())).toThrow("会话更新超过缓存上限");
    expect(client.listeners.size).toBe(0);
  },
);

test("a unique oversized question still fails closed at the byte limit", () => {
  const client = new FakeClient([]);
  const buffered = bufferNotifications(client as never);
  client.emit(changed({ ...question, deliveryError: "x".repeat(1024 * 1024) }));
  expect(buffered.hasOverflowed()).toBe(true);
  expect(() => buffered.activate(vi.fn())).toThrow("会话更新超过缓存上限");
  expect(client.listeners.size).toBe(0);
});

// Object member order has no meaning in JSON, including saved answer maps.
const reorderedChanged = (): RpcMessage => ({
  params: { question: Object.fromEntries(Object.entries(question).reverse()), threadId: question.threadId },
  method: "asyncQuestion/changed",
});

test("a reordered question replay cannot overflow a full recovery queue", () => {
  const client = new FakeClient([]);
  const buffered = bufferNotifications(client as never);
  const progress: RpcMessage[] = Array.from({ length: 511 }, (_, index) => ({
    method: "item/delta", params: { threadId: question.threadId, delta: String(index) },
  }));
  progress.forEach(message => client.emit(message));
  client.emit(changed());
  client.emit(reorderedChanged());
  expect(buffered.hasOverflowed()).toBe(false);
  const receive = vi.fn();
  const stop = buffered.activate(receive);
  expect(receive.mock.calls.map(([message]) => message)).toEqual([...progress, changed()]);
  stop();
  expect(client.listeners.size).toBe(0);
});

test.each(["resume", "reconnect"] as const)("%s preserves the original task when a full queue receives a reordered question replay", async mode => {
  const progress: RpcMessage[] = Array.from({ length: 511 }, (_, index) => ({
    method: "item/delta", params: { threadId: question.threadId, delta: String(index) },
  }));
  const replay = [...progress, changed(), reorderedChanged()];
  const client = new QuestionClient(mode === "resume" ? replay : []);
  let current = client;
  taskRuntimeTestHelpers.setConnector((async () => current as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  if (mode === "reconnect") {
    current = new QuestionClient(replay);
    await runtime.reconnectNow();
  }
  await runtime.refreshAsyncQuestions();
  expect(runtime.getSnapshot()).toMatchObject({ connected: true, error: null, threadId: question.threadId });
  expect(runtime.client).toBe(current);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, questions: [latest] });
});
