import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const answers = { ["__proto__"]: { selectedOptionIds: ["fast"], text: " original " } };
const question: AsyncQuestionRecord = {
  questionId: "question-1", requestId: "request-1", threadId: "thread-1",
  sourceTurnId: "source-turn", toolCallId: "tool-1", revision: 1,
  createdAtMs: 1_800_000_000_000, status: "pending",
  questions: [{ id: "__proto__", header: "Mode", question: "Which mode?",
    options: [{ id: "fast", label: "Fast", description: "" }], multiSelect: false }],
};

function savedQuestion(status: "queued" | "answer_saved" = "queued"): AsyncQuestionRecord {
  return { ...question, revision: 2, status,
    answer: { submissionId: "submission-1", answers, acceptedAtMs: question.createdAtMs + 1 } };
}

class QuestionClient extends FakeClient {
  readonly calls: Array<{ method: string; params: JsonRecord }> = [];
  authoritative: AsyncQuestionRecord = question;
  receipt = savedQuestion();
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean {
    return capability === "asyncUserQuestionsV1";
  }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push({ method, params });
    const result = method === "asyncQuestion/list"
      ? { threadId: question.threadId, questions: [this.authoritative] }
      : method === "asyncQuestion/answer"
        ? { threadId: question.threadId, question: this.receipt, accepted: true, duplicate: true }
        : null;
    // Preserve the wire's own __proto__ key rather than constructing an object
    // literal that would give that key JavaScript prototype semantics.
    return result ? JSON.parse(JSON.stringify(result)) as T : super.request<T>(method, params);
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(client: QuestionClient) {
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.calls.length = 0;
  return runtime;
}

test.each(["queued", "answer_saved"] as const)(
  "restoring a %s answer preserves a protocol-valid __proto__ item for exact delivery retry",
  async status => {
    const client = new QuestionClient();
    client.authoritative = savedQuestion(status);
    client.receipt = client.authoritative;
    const runtime = await fixture(client);
    const restored = runtime.getAsyncQuestionSnapshot().questions[0];
    expect(Object.keys(restored.answer!.answers)).toEqual(["__proto__"]);
    expect(JSON.stringify(restored.answer!.answers)).toBe(JSON.stringify(answers));
    await expect(runtime.answerAsyncQuestion({ questionId: restored.questionId,
      expectedRevision: restored.revision, submissionId: restored.answer!.submissionId,
      answers: restored.answer!.answers })).resolves.toMatchObject({ accepted: true });
    expect(client.calls).toEqual([{ method: "asyncQuestion/answer", params: {
      threadId: question.threadId, questionId: question.questionId, expectedRevision: 2,
      submissionId: "submission-1", answers,
    } }]);
  },
);

test("a new answer's receipt preserves and matches a __proto__ item", async () => {
  const client = new QuestionClient();
  const runtime = await fixture(client);
  const result = await runtime.answerAsyncQuestion({ questionId: question.questionId,
    expectedRevision: 1, submissionId: "submission-1", answers });
  expect(result.accepted).toBe(true);
  expect(Object.hasOwn(result.question.answer!.answers, "__proto__")).toBe(true);
  expect(result.question.answer!.answers).toEqual(answers);
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
});

test("a cross-device saved-answer notification retains the own answer item immediately", async () => {
  const client = new QuestionClient();
  const runtime = await fixture(client);
  client.authoritative = savedQuestion();
  runtime.handleAsyncQuestionChanged(JSON.parse(JSON.stringify({
    threadId: question.threadId, question: client.authoritative,
  })));
  const saved = runtime.getAsyncQuestionSnapshot().questions[0].answer!.answers;
  expect(Object.keys(saved)).toEqual(["__proto__"]);
  expect(JSON.stringify(saved)).toBe(JSON.stringify(answers));
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().questions[0].answer!.answers).toEqual(answers);
  expect(client.calls.some(call => call.method === "asyncQuestion/answer")).toBe(false);
});

test("a changed __proto__ answer still fails receipt comparison and reconciles without replay", async () => {
  const client = new QuestionClient();
  client.receipt = { ...savedQuestion(), answer: { ...savedQuestion().answer!,
    answers: { ["__proto__"]: { selectedOptionIds: ["fast"], text: "changed" } } } };
  const runtime = await fixture(client);
  await expect(runtime.answerAsyncQuestion({ questionId: question.questionId,
    expectedRevision: 1, submissionId: "submission-1", answers }))
    .rejects.toThrow("invalid async question answer receipt");
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
  expect(client.calls.filter(call => call.method === "asyncQuestion/answer")).toHaveLength(1);
});
