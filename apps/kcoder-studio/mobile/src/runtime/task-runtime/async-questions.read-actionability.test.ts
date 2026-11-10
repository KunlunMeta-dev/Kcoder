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
  constructor(public saved: AsyncQuestionRecord) { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: question.threadId, questions: [this.saved] }) as T;
    if (method === "asyncQuestion/answer" || method === "asyncQuestion/cancel") {
      this.saved = { ...this.saved, revision: this.saved.revision + 1,
        status: method === "asyncQuestion/answer" ? "answer_saved" : "cancelled",
        ...(method === "asyncQuestion/answer" ? {
          answer: { submissionId: String(params.submissionId), answers, acceptedAtMs: 2 },
        } : {}),
      };
      return { threadId: question.threadId, question: this.saved,
        ...(method === "asyncQuestion/answer" ? { accepted: true, duplicate: false } : {}) } as T;
    }
    return super.request<T>(method, params);
  }
}

test.each(["answer", "cancel", "continue"] as const)(
  "%s waits for a successful original list read after failure, including during explicit retry",
  async operation => {
    const original: AsyncQuestionRecord = operation === "continue" ? {
      ...question, status: "queued", answer: { submissionId: "original", answers, acceptedAtMs: 2 },
    } : question;
    const client = new QuestionClient(original);
    taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
      profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
    runtimes.push(runtime);
    await runtime.refreshAsyncQuestions();
    client.calls = [];
    client.read = async () => { throw new Error("Original list unavailable"); };
    await runtime.refreshAsyncQuestions();
    const invoke = () => operation === "cancel"
      ? runtime.cancelAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision })
      : runtime.answerAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision,
        submissionId: "original", answers });
    await expect(invoke()).rejects.toThrow("Refresh its status");
    expect(client.calls).toEqual(["asyncQuestion/list"]);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [original], error: "Original list unavailable", mutatingQuestionIds: [],
    });
    let finish!: (value: unknown) => void;
    client.read = () => new Promise(resolve => { finish = resolve; });
    const retry = runtime.refreshAsyncQuestions();
    try {
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: true, error: "Original list unavailable" });
      await expect(invoke()).rejects.toThrow("Refresh its status");
      expect(client.calls).toEqual(["asyncQuestion/list", "asyncQuestion/list"]);
    } finally {
      finish({ threadId: question.threadId, questions: [original] });
      await retry;
    }
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, error: undefined, questions: [original] });
    await invoke();
    expect(client.calls).toEqual(["asyncQuestion/list", "asyncQuestion/list",
      operation === "cancel" ? "asyncQuestion/cancel" : "asyncQuestion/answer"]);
  },
);

for (const conflict of ["same revision", "source binding"] as const) {
  test.each(["answer", "cancel", "continue"] as const)(
    `%s cannot dispatch while a ${conflict} notification awaits authoritative readback`,
    async operation => {
      const original: AsyncQuestionRecord = operation === "continue" ? {
        ...question, status: "queued", answer: { submissionId: "original", answers, acceptedAtMs: 2 },
      } : question;
      const client = new QuestionClient(original);
      taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
      const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
        profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
      runtimes.push(runtime);
      await runtime.refreshAsyncQuestions();
      client.calls = [];
      let finish!: (value: unknown) => void;
      client.read = () => new Promise(resolve => { finish = resolve; });
      const conflicting = conflict === "source binding"
        ? { ...original, revision: 9, sourceTurnId: "another-turn" }
        : { ...original, questions: [{ ...original.questions[0], question: "A different prompt" }] };
      client.emit({ method: "asyncQuestion/changed", params: { threadId: question.threadId, question: conflicting } });
      try {
        expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: true, questions: [original] });
        const mutation = operation === "cancel"
          ? runtime.cancelAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision })
          : runtime.answerAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision,
            submissionId: "original", answers });
        await expect(mutation).rejects.toThrow("Refresh its status");
        expect(client.calls).toEqual(["asyncQuestion/list"]);
        expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
      } finally {
        finish({ threadId: question.threadId, questions: [original] });
        await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
      }
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original], error: undefined });
      client.read = undefined;
      if (operation === "cancel")
        await runtime.cancelAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision });
      else await runtime.answerAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision,
        submissionId: "original", answers });
      expect(client.calls).toEqual(["asyncQuestion/list", operation === "cancel" ? "asyncQuestion/cancel" : "asyncQuestion/answer"]);
    },
  );
}
