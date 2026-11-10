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
  read?: () => Promise<unknown>;
  constructor(public original: AsyncQuestionRecord) { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: question.threadId, questions: [this.original] }) as T;
    if (method === "asyncQuestion/answer" || method === "asyncQuestion/cancel") return {
      threadId: question.threadId,
      question: { ...this.original, revision: this.original.revision + 1,
        status: method === "asyncQuestion/cancel" ? "cancelled" : "queued",
        ...(method === "asyncQuestion/answer" ? { answer: {
          submissionId: params.submissionId, acceptedAtMs: 2, answers,
        } } : {}),
      },
      ...(method === "asyncQuestion/answer" ? { accepted: true, duplicate: false } : {}),
    } as T;
    return super.request<T>(method, params);
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

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

const invalidUpdates = [
  { name: "missing source identity", record: { ...question, sourceTurnId: undefined } },
  { name: "incomplete saved answer", record: { ...question, revision: 2, status: "queued",
    answer: { submissionId: "other-device", acceptedAtMs: 2, answers: {} } } },
  { name: "conflicting nested task", record: { ...question, threadId: "another-thread" } },
];

for (const invalid of invalidUpdates) {
  test.each(["answer", "cancel", "continue"] as const)(
    `%s waits for original-task readback after an update with ${invalid.name}`,
    async operation => {
      const original: AsyncQuestionRecord = operation === "continue" ? {
        ...question, status: "queued", answer: { submissionId: "original", acceptedAtMs: 2, answers },
      } : question;
      const { runtime, client } = await fixture(original);
      let fail: ((error: Error) => void) | undefined;
      client.read = () => new Promise((_, reject) => { fail = reject; });
      const invoke = () => operation === "cancel"
        ? runtime.cancelAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision })
        : runtime.answerAsyncQuestion({ questionId: original.questionId, expectedRevision: original.revision,
          submissionId: "original", answers });
      client.emit({ method: "asyncQuestion/changed", params: {
        threadId: question.threadId, question: invalid.record,
      } });
      try {
        const duringRead = runtime.getAsyncQuestionSnapshot();
        await expect(invoke()).rejects.toThrow("Refresh its status");
        expect(duringRead).toMatchObject({ loading: true, questions: [original],
          error: expect.stringContaining("Refresh its status"), mutatingQuestionIds: [] });
        expect(client.calls).toEqual(["asyncQuestion/list"]);
      } finally {
        fail?.(new Error("Original list unavailable"));
        await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
      }
      // A failed read keeps the retained card closed; explicit recovery permits
      // one user action and never replays the blocked mutation automatically.
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original], error: "Original list unavailable" });
      await expect(invoke()).rejects.toThrow("Refresh its status");
      client.read = undefined;
      await runtime.refreshAsyncQuestions();
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original], error: undefined });
      expect(client.calls).toEqual(["asyncQuestion/list", "asyncQuestion/list"]);
      await invoke();
      expect(client.calls).toEqual(["asyncQuestion/list", "asyncQuestion/list",
        operation === "cancel" ? "asyncQuestion/cancel" : "asyncQuestion/answer"]);
    },
  );
}

test("malformed updates routed to a different task do not block the original card or start reads", async () => {
  const { runtime, client } = await fixture();
  const listener = vi.fn();
  runtime.subscribe(listener);
  client.emit({ method: "asyncQuestion/changed", params: {
    threadId: "another-thread", question: { ...question, sourceTurnId: undefined },
  } });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(client.calls).toEqual([]);
  expect(listener).not.toHaveBeenCalled();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], loading: false, error: undefined });
});
