import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source-turn", toolCallId: "tool", revision: 1,
  createdAtMs: 1, status: "pending",
  questions: [{ id: "item", header: "Mode", question: "Which mode?", options: [], multiSelect: false }],
};
const answers = { item: { selectedOptionIds: [], text: "My original answer" } };
const saved: AsyncQuestionRecord = {
  ...question, revision: 2, status: "answer_saved",
  answer: { submissionId: "submission", answers, acceptedAtMs: 2 },
};

class QuestionClient extends FakeClient {
  readonly calls: string[] = [];
  result: unknown;
  read?: () => Promise<unknown>;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: question.threadId, questions: [question] }) as T;
    if (method === "asyncQuestion/answer" || method === "asyncQuestion/cancel") return this.result as T;
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
  client.calls.length = 0;
  return { runtime, client };
}

for (const operation of ["answer", "competing answer", "cancel"] as const) {
  test.each(["requestId", "sourceTurnId", "toolCallId", "prompt", "selection mode"] as const)(
    `${operation} rejects a receipt with a different %s and reads the original task without replay`, async field => {
      const { runtime, client } = await fixture();
      const responseQuestion: AsyncQuestionRecord = structuredClone(operation === "cancel"
        ? { ...question, revision: 2, status: "cancelled" } : saved);
      if (field === "prompt") responseQuestion.questions[0].question = "A different prompt?";
      else if (field === "selection mode") responseQuestion.questions[0].multiSelect = true;
      else responseQuestion[field] = "another-source";
      client.result = { threadId: question.threadId, question: responseQuestion,
        ...(operation === "cancel" ? {} : { accepted: operation === "answer", duplicate: false }) };
      let finish!: (value: unknown) => void;
      client.read = () => new Promise(resolve => { finish = resolve; });
      const action = () => operation === "cancel"
        ? runtime.cancelAsyncQuestion({ questionId: question.questionId, expectedRevision: 1 })
        : runtime.answerAsyncQuestion({ questionId: question.questionId, expectedRevision: 1,
          submissionId: "submission", answers });
      try {
        await expect(action()).rejects.toThrow("invalid async question");
        expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
          questions: [question], loading: true, mutatingQuestionIds: [],
        });
        expect(client.calls).toEqual([operation === "cancel" ? "asyncQuestion/cancel" : "asyncQuestion/answer",
          "asyncQuestion/list"]);
      } finally {
        finish?.({ threadId: question.threadId, questions: [question] });
      }
      await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
        questions: [question], loading: false, error: undefined,
      }));
      expect(client.calls).toHaveLength(2);
    }
  );
}

test("the same original question can display another device's winning answer", async () => {
  const { runtime, client } = await fixture();
  const winner = { ...saved, answer: { ...saved.answer!, submissionId: "winning-device",
    answers: { item: { selectedOptionIds: [], text: "The winning answer" } } } };
  client.result = { threadId: question.threadId, question: winner, accepted: false, duplicate: false };
  await expect(runtime.answerAsyncQuestion({ questionId: question.questionId, expectedRevision: 1,
    submissionId: "submission", answers })).resolves.toMatchObject({ accepted: false, question: winner });
  expect(runtime.getAsyncQuestionSnapshot().questions[0].answer).toEqual(winner.answer);
  expect(client.calls).toEqual(["asyncQuestion/answer"]);
});

test.each(["list", "notification"] as const)(
  "%s cannot replace the original prompt at a higher revision", async operation => {
    const { runtime, client } = await fixture();
    const changed = { ...question, revision: 3,
      questions: [{ ...question.questions[0], question: "A different prompt?" }] };
    let finish!: (value: unknown) => void;
    client.read = () => new Promise(resolve => { finish = resolve; });
    const reading = operation === "list" ? runtime.refreshAsyncQuestions() : undefined;
    if (operation === "list") {
      finish({ threadId: question.threadId, questions: [changed] });
      await reading;
    } else {
      runtime.handleAsyncQuestionChanged({ threadId: question.threadId, question: changed });
    }
    expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
    expect(runtime.getAsyncQuestionSnapshot().error).toMatch(/invalid|conflicting/);
    expect(client.calls).toEqual(["asyncQuestion/list"]);
    if (operation === "notification") {
      finish({ threadId: question.threadId, questions: [question] });
      await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
    }
  }
);
