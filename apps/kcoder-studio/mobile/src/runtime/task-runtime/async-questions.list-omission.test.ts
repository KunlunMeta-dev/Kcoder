import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));
const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 1, createdAtMs: 1, status: "pending",
  questions: [{ id: "item", header: "Mode", question: "Which mode?", multiSelect: false, options: [] }],
};
const peer = { ...question, questionId: "peer-question", requestId: "peer-request", toolCallId: "peer-tool", createdAtMs: 2 };
const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});
class QuestionClient extends FakeClient {
  calls: string[] = [];
  questions: AsyncQuestionRecord[] = [];
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") {
      expect(params.includeTerminal).toBe(true);
      return { threadId: question.threadId, questions: this.questions } as T;
    }
    return super.request<T>(method, params);
  }
}
async function fixture(questions: AsyncQuestionRecord[]) {
  const client = new QuestionClient();
  client.questions = questions;
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.calls = [];
  return { runtime, client };
}
for (const status of ["pending", "queued", "context_applied"] as const) {
  test.each(["empty", "partial"])(`${status}: a %s full list cannot forget a confirmed original question`, async shape => {
    const original: AsyncQuestionRecord = { ...question, status,
      ...(status === "pending" ? {} : { revision: 2,
        answer: { submissionId: "saved", acceptedAtMs: 2, answers: { item: { text: "Exact saved answer" } } } }),
    };
    const { runtime, client } = await fixture([original, peer]);
    client.questions = shape === "empty" ? [] : [peer];
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false,
      questions: [original, peer], error: expect.any(String), mutatingQuestionIds: [] });
    expect(runtime.canMutateAsyncQuestions()).toBe(false);
    client.questions = [original, peer];
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, questions: [original, peer], error: undefined });
    expect(runtime.canMutateAsyncQuestions()).toBe(true);
    expect(client.calls).toEqual(["asyncQuestion/list", "asyncQuestion/list"]);
  });
}
test("an initially empty full list can discover the first question", async () => {
  const { runtime, client } = await fixture([]);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [], error: undefined });
  client.questions = [question];
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], error: undefined });
});
