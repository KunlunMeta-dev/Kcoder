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
    multiSelect: false, options: [] }],
};
const answers = { item: { text: "Keep my answer" } };

class QuestionClient extends FakeClient {
  mutations: string[] = [];
  read?: () => Promise<unknown>;
  constructor(public saved: AsyncQuestionRecord) { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: question.threadId, questions: [this.saved] }) as T;
    if (method === "asyncQuestion/answer" || method === "asyncQuestion/cancel") {
      this.mutations.push(method);
      this.saved = { ...this.saved, revision: this.saved.revision + 1,
        status: method === "asyncQuestion/answer" ? "queued" : "cancelled",
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

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

test.each((["answer", "cancel", "continue"] as const).flatMap(operation =>
  [false, true].map(cancelled => ({ operation, cancelled }))))(
  "$operation waits for the reconnected owner's first list (cancelled while offline=$cancelled)",
  async ({ operation, cancelled }) => {
    const original: AsyncQuestionRecord = operation === "continue" ? {
      ...question, status: "queued", answer: { submissionId: "original", answers, acceptedAtMs: 2 },
    } : question;
    const client = new QuestionClient(original);
    taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
      profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
    runtimes.push(runtime);
    await runtime.refreshAsyncQuestions();

    const replacement = new QuestionClient(original);
    let finish!: (value: unknown) => void;
    replacement.read = () => new Promise(resolve => { finish = resolve; });
    taskRuntimeTestHelpers.setConnector((async () => replacement as never) as never);
    await runtime.reconnectNow();
    expect(runtime.getSnapshot().connected).toBe(true);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: true, questions: [original], error: undefined });
    const invoke = () => operation === "cancel"
      ? runtime.cancelAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision })
      : runtime.answerAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision,
        submissionId: "original", answers });
    try {
      await expect(invoke()).rejects.toThrow("Refresh its status");
      expect(replacement.mutations).toEqual([]);
      expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
    } finally {
      replacement.read = undefined;
      const restored = cancelled ? { ...original, revision: original.revision + 1, status: "cancelled" } : original;
      finish({ threadId: question.threadId, questions: [restored] });
      await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
    }
    if (cancelled) {
      await expect(invoke()).rejects.toThrow("no longer current");
      expect(replacement.mutations).toEqual([]);
    } else {
      await invoke();
      expect(replacement.mutations).toEqual([operation === "cancel" ? "asyncQuestion/cancel" : "asyncQuestion/answer"]);
    }
    expect(client.mutations).toEqual([]);
  },
);

test("an ordinary read on the confirmed live owner does not block an answer", async () => {
  const client = new QuestionClient(question);
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  let finish!: (value: unknown) => void;
  client.read = () => new Promise(resolve => { finish = resolve; });
  const read = runtime.refreshAsyncQuestions();
  try {
    await runtime.answerAsyncQuestion({ questionId: question.questionId,
      expectedRevision: question.revision, submissionId: "original", answers });
    expect(client.mutations).toEqual(["asyncQuestion/answer"]);
  } finally {
    finish({ threadId: question.threadId, questions: [question] });
    await read;
  }
  expect(runtime.getAsyncQuestionSnapshot().questions[0].status).toBe("queued");
});
