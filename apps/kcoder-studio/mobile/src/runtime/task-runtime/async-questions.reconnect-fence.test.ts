import { afterEach, expect, test, vi } from "vitest";
import { ensureGatewayAuthorization } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question-1", requestId: "request-1", threadId: "thread-1",
  sourceTurnId: "source-turn", toolCallId: "tool-1", revision: 1,
  createdAtMs: 1_800_000_000_000, status: "pending",
  questions: [{ id: "item-1", header: "Mode", question: "Which mode?",
    options: [{ id: "fast", label: "Fast", description: "" }], multiSelect: false }],
};

class QuestionClient extends FakeClient {
  readonly calls: string[] = [];
  pending?: { method: string; finish(value: unknown): void };
  deferMethod?: string;

  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean {
    return capability === "asyncUserQuestionsV1";
  }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === this.deferMethod) return new Promise<T>((resolve) => {
      this.pending = { method, finish: value => resolve(value as T) };
    });
    if (method === "asyncQuestion/list") return { threadId: question.threadId, questions: [question] } as T;
    return super.request<T>(method, params);
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
  vi.mocked(ensureGatewayAuthorization).mockReset().mockResolvedValue(undefined);
});

async function fixture() {
  const client = new QuestionClient();
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.calls.length = 0;
  return { runtime, client };
}

function holdReconnect(runtime: TaskRuntime) {
  let release!: () => void;
  vi.mocked(ensureGatewayAuthorization).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const completion = runtime.reconnectNow();
  expect(runtime.getSnapshot()).toMatchObject({ connected: false, connectionPhase: "reconnecting" });
  return async () => {
    runtime.close();
    release();
    await completion;
  };
}

test.each(["answer", "cancel"] as const)(
  "%s rejects the old receipt while reconnect has started but the old client is still open",
  async operation => {
    const { runtime, client } = await fixture();
    client.deferMethod = `asyncQuestion/${operation}`;
    const input = { questionId: question.questionId, expectedRevision: question.revision };
    const answers = { "item-1": { selectedOptionIds: ["fast"] } };
    const mutation = operation === "answer"
      ? runtime.answerAsyncQuestion({ ...input, submissionId: "submission-1", answers })
      : runtime.cancelAsyncQuestion(input);
    const outcome = mutation.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    const generation = runtime.clientGeneration;
    const stopReconnect = holdReconnect(runtime);
    try {
      expect(client.isTransportOpen()).toBe(true);
      expect(runtime.clientGeneration).toBe(generation);
      client.pending!.finish({ threadId: question.threadId,
        ...(operation === "answer" ? { accepted: true, duplicate: false } : {}),
        question: { ...question, revision: 2, status: operation === "answer" ? "answer_saved" : "cancelled",
          ...(operation === "answer" ? { answer: { submissionId: "submission-1", answers, acceptedAtMs: 2 } } : {}) } });
      const result = await outcome;
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("task owner changed");
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], mutatingQuestionIds: [] });
      expect(client.calls).toEqual([`asyncQuestion/${operation}`]);
    } finally { await stopReconnect(); }
  },
);

test.each([false, true])("an in-flight list cannot change cards during reconnect (queued=%s)", async queuedRead => {
  const { runtime, client } = await fixture();
  client.deferMethod = "asyncQuestion/list";
  const read = runtime.refreshAsyncQuestions();
  const queued = queuedRead ? runtime.refreshAsyncQuestions() : Promise.resolve();
  const stopReconnect = holdReconnect(runtime);
  try {
    client.pending!.finish({ threadId: question.threadId, questions: [] });
    // The original read settles before the loop can dispatch a queued read.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(client.calls).toEqual(["asyncQuestion/list"]);
    await Promise.all([read, queued]);
    expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
  } finally {
    await stopReconnect();
    client.pending?.finish({ threadId: question.threadId, questions: [] });
    await Promise.all([read, queued]);
  }
});

test.each(["list", "answer", "cancel"] as const)(
  "%s fences its pending receipt as soon as the app-server disconnects, before the Gateway socket closes",
  async operation => {
    const { runtime, client } = await fixture();
    client.deferMethod = `asyncQuestion/${operation}`;
    const answers = { "item-1": { selectedOptionIds: ["fast"] } };
    const input = { questionId: question.questionId, expectedRevision: question.revision };
    const pending = operation === "list" ? runtime.refreshAsyncQuestions()
      : operation === "answer" ? runtime.answerAsyncQuestion({ ...input, submissionId: "submission-1", answers })
      : runtime.cancelAsyncQuestion(input);
    const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));

    client.emit({ method: "server/disconnected", params: { serverId: server.id, code: 1 } });
    const disconnected = runtime.getSnapshot();
    expect(client.isTransportOpen()).toBe(true);
    const settled = { ...question, revision: 2, status: "cancelled" as const };
    client.pending!.finish(operation === "list"
      ? { threadId: question.threadId, questions: [] }
      : { threadId: question.threadId,
        ...(operation === "answer" ? { accepted: true, duplicate: false } : {}),
        question: operation === "answer" ? { ...settled, status: "answer_saved",
          answer: { submissionId: "submission-1", answers, acceptedAtMs: 2 } } : settled });
    const result = await outcome;

    expect(disconnected).toMatchObject({ connected: false, connectionPhase: "reconnecting" });
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [question], loading: false, mutatingQuestionIds: [],
    });
    if (operation !== "list") expect(result.error?.message).toContain("task owner changed");
    expect(client.calls).toEqual([`asyncQuestion/${operation}`]);
  },
);

test("app-server loss blocks new question operations and late changes while the Gateway socket remains open", async () => {
  const { runtime, client } = await fixture();
  client.emit({ method: "server/disconnected", params: { serverId: server.id, code: 1 } });
  await runtime.refreshAsyncQuestions();
  const input = { questionId: question.questionId, expectedRevision: question.revision };
  await expect(runtime.answerAsyncQuestion({ ...input, submissionId: "submission-1",
    answers: { "item-1": { selectedOptionIds: ["fast"] } } })).rejects.toThrow("no longer current");
  await expect(runtime.cancelAsyncQuestion(input)).rejects.toThrow("no longer current");
  client.emit({ method: "asyncQuestion/changed", params: { threadId: question.threadId,
    question: { ...question, revision: 2, status: "cancelled" } } });
  expect(client.isTransportOpen()).toBe(true);
  expect(client.calls).toEqual([]);
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
});

test.each(["snapshot", "protocol"] as const)("%s observers cannot send an answer during app-server disconnect publication", async observer => {
  const { runtime, client } = await fixture();
  let outcome: Promise<unknown> | undefined;
  const submit = () => {
    unsubscribe();
    outcome = runtime.answerAsyncQuestion({ questionId: question.questionId, expectedRevision: 1,
      submissionId: "submission-1", answers: { "item-1": { selectedOptionIds: ["fast"] } } })
      .catch(error => error);
  };
  const unsubscribe = observer === "snapshot" ? runtime.subscribe(submit) : runtime.subscribeProtocol(submit);
  client.emit({ method: "server/disconnected", params: { serverId: server.id, code: 1 } });
  expect(await outcome).toMatchObject({ message: expect.stringContaining("no longer current") });
  expect(client.calls).toEqual([]);
});

test("app-server loss followed by socket close recovers the original task once without replaying an answer", async () => {
  const { runtime, client } = await fixture();
  const replacement = new QuestionClient();
  const latest = { ...question, revision: 3 };
  const request = replacement.request.bind(replacement);
  const restoredRequest = vi.spyOn(replacement, "request").mockImplementation(async (method, params) => {
    if (method === "asyncQuestion/list") return { threadId: question.threadId, questions: [latest] };
    return request(method, params);
  });
  const connect = vi.fn(async () => replacement as never);
  taskRuntimeTestHelpers.setConnector(connect as never);

  client.emit({ method: "server/disconnected", params: { serverId: server.id, code: 1 } });
  client.emit({ method: "connection/closed", params: { reason: "socket closed later" } });
  await runtime.reconnectNow();
  await runtime.refreshAsyncQuestions();

  expect(connect).toHaveBeenCalledTimes(1);
  expect(runtime.getSnapshot()).toMatchObject({ connected: true, threadId: question.threadId });
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [latest], loading: false });
  expect(client.closed).toBe(true);
  expect(client.calls).toEqual([]);
  for (const method of ["asyncQuestion/answer", "asyncQuestion/cancel", "turn/start"])
    expect(restoredRequest.mock.calls.map(([method]) => method)).not.toContain(method);
  client.emit({ method: "asyncQuestion/changed", params: { threadId: question.threadId,
    question: { ...question, revision: 4, status: "cancelled" } } });
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([latest]);
});
