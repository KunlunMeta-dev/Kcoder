import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, appServerId, profile, server } from "./fixture.test-support";
import { bufferNotifications } from "./notificationBuffer";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const original: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 1, createdAtMs: 1,
  status: "pending", questions: [{ id: "item", header: "Mode", question: "Which mode?",
    multiSelect: false, options: [] }],
};
const cancelled: AsyncQuestionRecord = { ...original, revision: 2, status: "cancelled" };

class QuestionClient extends FakeClient {
  record = original;
  calls: string[] = [];
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return { threadId: original.threadId, questions: [this.record] } as T;
    return super.request<T>(method, params);
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

for (const mode of ["live", "buffered"] as const) {
  for (const id of [2000001, "request-1", null]) {
    test(`${mode}: request envelope id=${JSON.stringify(id)} cannot retire the original async question or trigger readback`, async () => {
      const client = new QuestionClient();
      taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
      const runtime = await TaskRuntime.resume({ profile, server, threadId: original.threadId,
        profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
      runtimes.push(runtime);
      await runtime.refreshAsyncQuestions();
      client.calls.length = 0;
      const observer = vi.fn();
      runtime.subscribeProtocol(observer);
      const message = { id, method: "asyncQuestion/changed", params: {
        threadId: original.threadId, question: cancelled,
      } } as RpcMessage;
      if (mode === "buffered") {
        runtime.unsubscribeRpc?.();
        runtime.unsubscribeRpc = null;
        const buffered = bufferNotifications(client as never);
        client.emit(message);
        runtime.attachBufferedClient(client as never, buffered);
      } else client.emit(message);

      expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([original]);
      expect(client.calls).toEqual([]);
      expect(observer).not.toHaveBeenCalled();
      expect(runtime.getAsyncQuestionSnapshot().error).toBeUndefined();
      // Attaching a buffered connection retires the old snapshot's authority.
      // Confirm its original-task list before checking that input reopens.
      await runtime.refreshAsyncQuestions();
      expect(runtime.canMutateAsyncQuestions()).toBe(true);
      client.calls.length = 0;

      // A discarded frame cannot suppress a later valid original-task update.
      client.record = cancelled;
      client.emit({ method: "asyncQuestion/changed", params: {
        threadId: original.threadId, question: cancelled,
      } });
      expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([cancelled]);
      await runtime.refreshAsyncQuestions();
      expect(client.calls.every(method => method === "asyncQuestion/list")).toBe(true);
      expect(observer).toHaveBeenCalledTimes(1);
    });
  }
}

test.each([2000001, "request-1", null])(
  "request envelope id=%s cannot exhaust the recovery queue before a valid update",
  id => {
    const client = new QuestionClient();
    const buffered = bufferNotifications(client as never);
    const params = { threadId: original.threadId, question: cancelled };
    for (let index = 0; index <= 512; index++)
      client.emit({ id, method: "asyncQuestion/changed", params } as RpcMessage);
    const valid = { method: "asyncQuestion/changed", params };
    client.emit(valid);
    try {
      expect(buffered.hasOverflowed()).toBe(false);
      const delivered: RpcMessage[] = [];
      buffered.activate(message => delivered.push(message));
      expect(delivered).toEqual([valid]);
    } finally {
      buffered.cancel();
    }
    expect(client.listeners.size).toBe(0);
    expect(client.calls).toEqual([]);
  },
);

for (const mode of ["live", "buffered"] as const) {
  test(`${mode}: an old app-server cannot withdraw the current question or notify observers`, async () => {
    const client = new QuestionClient();
    taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: original.threadId,
      profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
    runtimes.push(runtime);
    await runtime.refreshAsyncQuestions();
    client.calls.length = 0;
    const observer = vi.fn();
    runtime.subscribeProtocol(observer);
    const stale = { method: "asyncQuestion/changed", params: {
      serverId: "server-previous", sequence: 42, threadId: original.threadId, question: cancelled,
    } };
    if (mode === "buffered") {
      runtime.unsubscribeRpc?.();
      runtime.unsubscribeRpc = null;
      const buffered = bufferNotifications(client as never);
      client.emit(stale);
      runtime.attachBufferedClient(client as never, buffered);
    } else client.emit(stale);
    expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([original]);
    expect(client.calls).toEqual([]);
    expect(observer).not.toHaveBeenCalled();
    await runtime.refreshAsyncQuestions();
    expect(runtime.canMutateAsyncQuestions()).toBe(true);
    client.calls.length = 0;
    client.record = cancelled;
    client.emit({ ...stale, params: { ...stale.params, serverId: appServerId } });
    expect(observer).toHaveBeenCalledTimes(1);
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([cancelled]);
    expect(client.calls.every(method => method === "asyncQuestion/list")).toBe(true);
  });
}

test("old app-server updates cannot exhaust recovery before a current question update", () => {
  const client = new QuestionClient();
  const buffered = bufferNotifications(client as never);
  try {
    for (let sequence = 0; sequence <= 512; sequence++) client.emit({
      method: "asyncQuestion/changed", params: {
        serverId: "server-previous", sequence, threadId: original.threadId,
        question: { ...cancelled, revision: sequence + 2 },
      },
    });
    const valid = { method: "asyncQuestion/changed", params: {
      serverId: appServerId, threadId: original.threadId, question: cancelled,
    } };
    client.emit(valid);
    expect(buffered.hasOverflowed()).toBe(false);
    const delivered: RpcMessage[] = [];
    buffered.activate(message => delivered.push(message));
    expect(delivered).toEqual([valid]);
  } finally { buffered.cancel(); }
  expect(client.listeners.size).toBe(0);
  expect(client.calls).toEqual([]);
});
