import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 1, createdAtMs: 1,
  status: "pending", questions: [
    { id: "item", header: "Note", question: "Any details?", multiSelect: false, options: [] },
  ],
};

class QuestionClient extends FakeClient {
  calls: string[] = [];
  receipt = question;
  completeRead?: (value: unknown) => void;
  holdRead = false;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return (this.holdRead
      ? await new Promise<unknown>(resolve => { this.completeRead = resolve; })
      : { threadId: question.threadId, questions: [question] }) as T;
    if (["asyncQuestion/answer", "asyncQuestion/cancel"].includes(method)) return {
      threadId: question.threadId, question: this.receipt,
      ...(method === "asyncQuestion/answer" ? { accepted: false, duplicate: false } : {}),
    } as T;
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
  client.calls = [];
  client.holdRead = true;
  return { runtime, client };
}

test.each(["pending", "cancelled", "stale"] as const)(
  "an answer receipt with %s and no winning answer cannot confirm submission", async status => {
    const { runtime, client } = await fixture();
    client.receipt = { ...question, revision: status === "pending" ? 1 : 2, status };
    await expect(runtime.answerAsyncQuestion({ questionId: question.questionId, expectedRevision: 1,
      submissionId: "this-device", answers: { item: { text: "Keep my draft" } } }))
      .rejects.toThrow(/invalid.*receipt/i);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question],
      mutatingQuestionIds: [], error: expect.stringMatching(/invalid.*receipt/i) });
    expect(client.calls).toEqual(["asyncQuestion/answer", "asyncQuestion/list"]);
    client.holdRead = false;
    const recovery = runtime.refreshAsyncQuestions();
    client.completeRead?.({ threadId: question.threadId, questions: [question] });
    await recovery;
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ error: undefined, loading: false, questions: [question] });
    expect(client.calls.filter(method => method === "asyncQuestion/answer")).toHaveLength(1);
  },
);

test.each(["pending", "stale"] as const)(
  "a cancellation receipt with %s cannot confirm withdrawal", async status => {
    const { runtime, client } = await fixture();
    client.receipt = { ...question, revision: status === "pending" ? 1 : 2, status };
    await expect(runtime.cancelAsyncQuestion({ questionId: question.questionId, expectedRevision: 1 }))
      .rejects.toThrow(/invalid.*receipt/i);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], mutatingQuestionIds: [] });
    expect(client.calls).toEqual(["asyncQuestion/cancel", "asyncQuestion/list"]);
    client.holdRead = false;
    const recovery = runtime.refreshAsyncQuestions();
    client.completeRead?.({ threadId: question.threadId, questions: [question] });
    await recovery;
    expect(client.calls.filter(method => method === "asyncQuestion/cancel")).toHaveLength(1);
  },
);
