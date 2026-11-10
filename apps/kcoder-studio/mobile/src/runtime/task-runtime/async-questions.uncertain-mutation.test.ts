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
const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

class QuestionClient extends FakeClient {
  calls: string[] = [];
  read?: () => Promise<unknown>;
  mutate?: () => Promise<unknown>;
  constructor(public saved: AsyncQuestionRecord) { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: question.threadId, questions: [this.saved] }) as T;
    if (method === "asyncQuestion/answer" || method === "asyncQuestion/cancel") {
      if (this.mutate) return await this.mutate() as T;
      // Successful mutations carry their committed outcome, never the pending
      // list snapshot used to restore authority after an unknown result.
      if (method === "asyncQuestion/cancel") this.saved = {
        ...this.saved, revision: this.saved.revision + 1, status: "cancelled",
      };
      else if (!this.saved.answer) this.saved = {
        ...this.saved, revision: this.saved.revision + 1, status: "queued",
        answer: { submissionId: String(params.submissionId), acceptedAtMs: 2,
          answers: params.answers as NonNullable<AsyncQuestionRecord["answer"]>["answers"] },
      };
      return { threadId: question.threadId, question: this.saved,
        ...(method === "asyncQuestion/answer" ? { accepted: false, duplicate: false } : {}) } as T;
    }
    return super.request<T>(method, params);
  }
}

async function fixture(original = question) {
  const client = new QuestionClient(original);
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.calls = [];
  return { runtime, client };
}

for (const operation of ["answer", "cancel", "continue"] as const) {
  test.each(["lost receipt", "invalid receipt"])(
    `${operation}: %s cannot reopen mutation actions while original-task reconciliation is pending`,
    async failure => {
      const original: AsyncQuestionRecord = operation === "continue" ? {
        ...question, status: "queued", answer: { submissionId: "stable", answers, acceptedAtMs: 2 },
      } : question;
      const { runtime, client } = await fixture(original);
      const invoke = () => operation === "cancel"
        ? runtime.cancelAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision })
        : runtime.answerAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision,
          submissionId: "stable", answers });
      client.mutate = async () => {
        if (failure === "lost receipt") throw new Error("Original outcome unknown");
        return { threadId: "foreign-task" };
      };
      let finish!: (value: unknown) => void;
      client.read = () => new Promise(resolve => { finish = resolve; });
      try {
        await expect(invoke()).rejects.toThrow();
        expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
          loading: true, questions: [original], mutatingQuestionIds: [],
        });
        await expect(invoke()).rejects.toThrow("Refresh its status");
        expect(client.calls).toEqual([
          operation === "cancel" ? "asyncQuestion/cancel" : "asyncQuestion/answer", "asyncQuestion/list",
        ]);
      } finally {
        // Finish all owned reads even when the pre-fix second mutation fails.
        finish?.({ threadId: question.threadId, questions: [original] });
        client.read = async () => ({ threadId: question.threadId, questions: [original] });
      }
      await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, error: undefined }));
      // An authoritative unchanged revision permits a separate explicit action.
      client.mutate = undefined;
      await invoke();
      expect(runtime.getAsyncQuestionSnapshot().questions[0].status)
        .toBe(operation === "cancel" ? "cancelled" : "queued");
      expect(client.calls.filter(method => method === (operation === "cancel"
        ? "asyncQuestion/cancel" : "asyncQuestion/answer"))).toHaveLength(2);
    },
  );
}

test("a newer authoritative card is not disabled by an older mutation failure", async () => {
  const { runtime, client } = await fixture();
  let fail!: (error: Error) => void;
  client.mutate = () => new Promise((_, reject) => { fail = reject; });
  const mutation = runtime.answerAsyncQuestion({ questionId: question.questionId,
    expectedRevision: 1, submissionId: "stable", answers });
  const outcome = expect(mutation).rejects.toThrow("Late transport failure");
  const newer: AsyncQuestionRecord = { ...question, revision: 2, status: "queued",
    answer: { submissionId: "stable", answers, acceptedAtMs: 2 } };
  client.saved = newer;
  await runtime.refreshAsyncQuestions();
  let finish!: (value: unknown) => void;
  client.read = () => new Promise(resolve => { finish = resolve; });
  try {
    fail(new Error("Late transport failure"));
    await outcome;
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      loading: true, error: undefined, questions: [newer], mutatingQuestionIds: [],
    });
    client.mutate = undefined;
    await runtime.answerAsyncQuestion({ questionId: newer.questionId,
      expectedRevision: newer.revision, submissionId: "stable", answers });
  } finally {
    finish?.({ threadId: question.threadId, questions: [newer] });
  }
});
