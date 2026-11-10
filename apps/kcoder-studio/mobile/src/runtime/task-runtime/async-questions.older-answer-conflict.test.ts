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
const answers = { item: { text: "My exact answer" } };
const saved: AsyncQuestionRecord = { ...question, revision: 2, status: "queued",
  answer: { submissionId: "submission", acceptedAtMs: 2, answers } };

class QuestionClient extends FakeClient {
  record = question;
  mutations = 0;
  mutate?: () => Promise<unknown>;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    if (method === "asyncQuestion/list") return { threadId: question.threadId, questions: [this.record] } as T;
    if (method === "asyncQuestion/answer" && this.mutate) {
      this.mutations++;
      return await this.mutate() as T;
    }
    return super.request<T>(method, params);
  }
}
const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});
async function fixture() {
  const client = new QuestionClient();
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  return { runtime, client };
}

for (const change of ["submission", "payload", "timestamp"] as const) {
  test(`an older accepted receipt cannot confirm a conflicting saved ${change}`, async () => {
    const { runtime, client } = await fixture();
    let complete!: (value: unknown) => void;
    client.mutate = () => new Promise(resolve => { complete = resolve; });
    // Attach rejection handling before publishing the newer authority.
    const outcome = runtime.answerAsyncQuestion({ questionId: question.questionId,
      expectedRevision: 1, submissionId: "submission", answers })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    const winner: AsyncQuestionRecord = { ...saved, revision: 3, answer: { ...saved.answer!,
      ...(change === "submission" ? { submissionId: "peer-winner" } : {}),
      ...(change === "payload" ? { answers: { item: { text: "Peer answer" } } } : {}),
      ...(change === "timestamp" ? { acceptedAtMs: 3 } : {}),
    } };
    client.record = winner;
    await runtime.refreshAsyncQuestions();
    complete({ threadId: question.threadId, question: saved, accepted: true, duplicate: false });
    const result = await outcome;
    expect(result.error).toEqual(expect.objectContaining({ message: expect.stringMatching(/conflicting/) }));
    expect(result.value).toBeUndefined();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [winner], mutatingQuestionIds: [] });
    expect(client.mutations).toBe(1);
  });
}

test.each(["list", "notification"] as const)("an older %s with a different saved answer requires readback", async transport => {
  const { runtime, client } = await fixture();
  const winner = { ...saved, revision: 3 };
  client.record = winner;
  await runtime.refreshAsyncQuestions();
  client.record = { ...saved, answer: { ...saved.answer!, answers: { item: { text: "Foreign answer" } } } };
  if (transport === "notification") client.emit({ method: "asyncQuestion/changed",
    params: { threadId: question.threadId, question: client.record } });
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [winner], error: expect.any(String) });
  expect(runtime.canMutateAsyncQuestions()).toBe(false);
  client.record = saved;
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [winner], error: undefined });
  expect(runtime.canMutateAsyncQuestions()).toBe(true);
  client.record = question;
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [winner], error: undefined });
  expect(client.mutations).toBe(0);
});
