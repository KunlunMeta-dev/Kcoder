import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 1, createdAtMs: 1,
  status: "pending", questions: [{ id: "item", header: "Mode", question: "Which mode?",
    multiSelect: false, options: [{ id: "fast", label: "Fast", description: "" }] }],
};
const answers = { item: { selectedOptionIds: ["fast"] } };
class QuestionClient extends FakeClient {
  calls: string[] = [];
  listed = question;
  resultRevision = 0;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return { threadId: question.threadId, questions: [this.listed] } as T;
    if (method === "asyncQuestion/answer" || method === "asyncQuestion/cancel") return {
      threadId: question.threadId, question: { ...question, revision: this.resultRevision,
        status: method === "asyncQuestion/cancel" ? "cancelled" : "queued",
        ...(method === "asyncQuestion/answer" ? { answer: {
          submissionId: params.submissionId, acceptedAtMs: 2, answers,
        } } : {}),
      }, ...(method === "asyncQuestion/answer" ? { accepted: true, duplicate: false } : {}),
    } as T;
    return super.request<T>(method, params);
  }
}
const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});
async function fixture(revision = 1) {
  const client = new QuestionClient();
  client.listed = { ...question, revision };
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.calls = [];
  return { runtime, client };
}

test("a zero-revision initial list cannot open a card or grant mutations; a valid read recovers", async () => {
  const { runtime, client } = await fixture(0);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [],
    error: expect.stringContaining("invalid async question list") });
  expect(runtime.canMutateAsyncQuestions()).toBe(false);
  await expect(runtime.cancelAsyncQuestion({ questionId: question.questionId, expectedRevision: 0 }))
    .rejects.toThrow("Refresh its status");
  expect(client.calls).toEqual([]);
  client.listed = question;
  await runtime.refreshAsyncQuestions();
  expect(runtime.canMutateAsyncQuestions()).toBe(true);
  client.resultRevision = 2;
  await runtime.cancelAsyncQuestion({ questionId: question.questionId, expectedRevision: 1 });
  expect(client.calls).toEqual(["asyncQuestion/list", "asyncQuestion/cancel"]);
});

test("a zero-revision notification requires readback instead of silently retaining input authority", async () => {
  const { runtime, client } = await fixture();
  let finish!: (value: unknown) => void;
  const request = client.request.bind(client);
  const spy = vi.spyOn(client, "request").mockImplementation((method, params) => method === "asyncQuestion/list"
    ? new Promise(resolve => { client.calls.push(method); finish = resolve; }) as never
    : request(method, params));
  client.emit({ method: "asyncQuestion/changed", params: {
    threadId: question.threadId, question: { ...question, revision: 0 },
  } });
  try {
    expect(runtime.canMutateAsyncQuestions()).toBe(false);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], loading: true });
    expect(client.calls).toEqual(["asyncQuestion/list"]);
  } finally {
    spy.mockRestore();
    finish?.({ threadId: question.threadId, questions: [question] });
    await runtime.refreshAsyncQuestions();
  }
  expect(runtime.canMutateAsyncQuestions()).toBe(true);
});

for (const operation of ["answer", "cancel"] as const) {
  test(`a zero-revision ${operation} receipt cannot confirm a mutation or replace the original card`, async () => {
    const { runtime, client } = await fixture();
    const input = { questionId: question.questionId, expectedRevision: 1 };
    const mutation = operation === "answer"
      ? runtime.answerAsyncQuestion({ ...input, submissionId: "original", answers })
      : runtime.cancelAsyncQuestion(input);
    await expect(mutation).rejects.toThrow("invalid async question");
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], mutatingQuestionIds: [] });
    expect(client.calls.filter(method => method === `asyncQuestion/${operation}`)).toHaveLength(1);
  });
}
