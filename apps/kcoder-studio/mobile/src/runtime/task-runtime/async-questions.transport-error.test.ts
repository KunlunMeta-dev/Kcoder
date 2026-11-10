import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

const question: AsyncQuestionRecord = {
  questionId: "question-1", requestId: "request-1", threadId: "thread-1",
  sourceTurnId: "source-turn", toolCallId: "tool-1", revision: 1,
  createdAtMs: 1, status: "pending",
  questions: [{ id: "item-1", header: "Mode", question: "Which mode?",
    options: [{ id: "fast", label: "Fast", description: "" }], multiSelect: false }],
};
const answers = { "item-1": { selectedOptionIds: ["fast"] } };
const transportError = { method: "server/transportError", params: {
  serverId: server.id, message: "app-server transport failed",
} };

class QuestionClient extends FakeClient {
  readonly calls: string[] = [];
  deferMethod?: string;
  finish?: (value: unknown) => void;
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean {
    return capability === "asyncUserQuestionsV1";
  }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === this.deferMethod) return new Promise<T>(resolve => {
      this.finish = value => resolve(value as T);
    });
    if (method === "asyncQuestion/list") return { threadId: question.threadId, questions: [question] } as T;
    return super.request<T>(method, params);
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture() {
  const client = new QuestionClient([]);
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.calls.length = 0;
  const operation = (method: string) => {
    const input = { questionId: question.questionId, expectedRevision: question.revision };
    return method === "list" ? runtime.refreshAsyncQuestions()
      : method === "answer" ? runtime.answerAsyncQuestion({ ...input, submissionId: "submission-1", answers })
      : runtime.cancelAsyncQuestion(input);
  };
  return { runtime, client, operation };
}

test.each(["list", "answer", "cancel"])(
  "transport failure revokes %s before protocol observers while the Gateway socket stays open",
  async method => {
    const { runtime, client, operation } = await fixture();
    let outcome: Promise<unknown> | undefined;
    const unsubscribe = runtime.subscribeProtocol(message => {
      if (message.method === transportError.method) outcome = operation(method).catch(error => error);
    });
    client.emit(transportError);
    unsubscribe();
    const result = await outcome;
    expect(client.isTransportOpen()).toBe(true);
    expect(client.calls).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({ connected: false, connectionPhase: "reconnecting" });
    if (method !== "list") expect(result).toMatchObject({ message: expect.stringContaining("no longer current") });
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], mutatingQuestionIds: [] });
  },
);

test.each(["list", "answer", "cancel"])(
  "transport failure fences an in-flight %s receipt before the Gateway socket closes",
  async method => {
    const { runtime, client, operation } = await fixture();
    client.deferMethod = `asyncQuestion/${method}`;
    const outcome = operation(method).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    client.emit(transportError);
    client.finish!(method === "list" ? { threadId: question.threadId, questions: [] }
      : { threadId: question.threadId,
        ...(method === "answer" ? { accepted: true, duplicate: false } : {}),
        question: { ...question, revision: 2,
        status: method === "answer" ? "answer_saved" : "cancelled",
        ...(method === "answer" ? { answer: { submissionId: "submission-1", answers, acceptedAtMs: 2 } } : {}) } });
    const result = await outcome;
    expect(client.isTransportOpen()).toBe(true);
    expect(client.calls).toEqual([`asyncQuestion/${method}`]);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], loading: false, mutatingQuestionIds: [] });
    if (method !== "list") expect(result.error?.message).toContain("task owner changed");
  },
);

test("transport failure followed by socket close recovers the original questions without replaying input", async () => {
  const { runtime, client } = await fixture();
  const replacement = new QuestionClient([]);
  const connect = vi.fn(async () => replacement as never);
  taskRuntimeTestHelpers.setConnector(connect as never);
  client.emit(transportError);
  client.emit({ method: "asyncQuestion/changed", params: { threadId: question.threadId,
    question: { ...question, revision: 2, status: "cancelled" } } });
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
  expect(client.calls).toEqual([]);
  client.emit({ method: "connection/closed", params: { reason: "socket closed later" } });
  await runtime.reconnectNow();
  await runtime.refreshAsyncQuestions();
  expect(connect).toHaveBeenCalledTimes(1);
  expect(runtime.getSnapshot()).toMatchObject({ connected: true, threadId: question.threadId });
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], loading: false });
  expect(client.closed).toBe(true);
  for (const method of ["asyncQuestion/answer", "asyncQuestion/cancel", "turn/start"])
    expect(replacement.calls).not.toContain(method);
});
