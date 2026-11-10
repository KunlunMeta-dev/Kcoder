import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const original: AsyncQuestionRecord = {
  questionId: "question", requestId: "original-request", threadId: "thread-1",
  sourceTurnId: "original-turn", toolCallId: "original-tool", revision: 1,
  createdAtMs: 1, status: "pending",
  questions: [{ id: "item", header: "Mode", question: "Which mode?", options: [], multiSelect: false }],
};

class QuestionClient extends FakeClient {
  readonly calls: string[] = [];
  read?: () => Promise<unknown>;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: original.threadId, questions: [original] }) as T;
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
  const runtime = await TaskRuntime.resume({ profile, server, threadId: original.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.calls.length = 0;
  return { runtime, client };
}

for (const field of ["requestId", "sourceTurnId", "toolCallId"] as const) {
  const foreign: AsyncQuestionRecord = {
    ...original, [field]: "another-source", revision: 9, status: "queued",
    answer: { submissionId: "another-device", acceptedAtMs: 2,
      answers: { item: { selectedOptionIds: [], text: "Answer to the other prompt" } } },
  };

  test(`a higher-revision notification cannot replace ${field} or poison later original-task reads`, async () => {
    const { runtime, client } = await fixture();
    let finish!: (value: unknown) => void;
    client.read = () => new Promise(resolve => { finish = resolve; });
    client.emit({ method: "asyncQuestion/changed", params: {
      threadId: original.threadId, question: foreign,
    } });
    const duringRead = runtime.getAsyncQuestionSnapshot();
    finish({ threadId: original.threadId, questions: [original] });
    await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
    expect(duringRead.questions).toEqual([original]);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original], error: undefined });
    expect(client.calls).toEqual(["asyncQuestion/list"]);
  });

  test(`an explicit snapshot with a different ${field} retains the original card and reports a read failure`, async () => {
    const { runtime, client } = await fixture();
    client.read = async () => ({ threadId: original.threadId, questions: [foreign] });
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original], loading: false,
      error: "The server returned an invalid async question list." });
    await expect(runtime.answerAsyncQuestion({ questionId: original.questionId, submissionId: "explicit-answer",
      expectedRevision: 1, answers: { item: { text: "Original answer" } } })).rejects.toThrow("Refresh its status");
    expect(client.calls).toEqual(["asyncQuestion/list"]);
    client.read = undefined;
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original], loading: false, error: undefined });
    expect(client.calls).toEqual(["asyncQuestion/list", "asyncQuestion/list"]);
  });
}
