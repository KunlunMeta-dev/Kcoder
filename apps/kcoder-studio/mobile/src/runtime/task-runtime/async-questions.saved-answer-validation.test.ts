import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionAnswerPayload, AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 1, createdAtMs: 1,
  status: "pending", questions: [
    { id: "mode", header: "Mode", question: "Which mode?", multiSelect: false,
      options: [{ id: "fast", label: "Fast", description: "" },
        { id: "careful", label: "Careful", description: "" }] },
    { id: "note", header: "Note", question: "Any details?", multiSelect: false, options: [] },
  ],
};
const validAnswers = { mode: { selectedOptionIds: ["fast"] }, note: { text: " exact note " } };
const saved = (answers: AsyncQuestionAnswerPayload): AsyncQuestionRecord => ({
  ...question, revision: 2, status: "queued",
  answer: { submissionId: "other-device", acceptedAtMs: 2, answers },
});

class QuestionClient extends FakeClient {
  calls: string[] = [];
  record = question;
  read?: () => Promise<unknown>;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: question.threadId, questions: [this.record] }) as T;
    if (method === "asyncQuestion/answer") return {
      threadId: question.threadId, question: this.record, accepted: false, duplicate: false,
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
  return { runtime, client };
}

const invalidAnswers: Array<{ name: string; answers: AsyncQuestionAnswerPayload }> = [
  { name: "no items", answers: {} },
  { name: "missing item", answers: { mode: validAnswers.mode } },
  { name: "multiple selections on a single-choice item", answers: {
    ...validAnswers, mode: { selectedOptionIds: ["fast", "careful"] } } },
  { name: "blank item", answers: { ...validAnswers, note: { text: " \t\n " } } },
];

test.each(["answer_saved", "queued", "context_applied", "delivery_unknown", "delivery_failed"] as const)(
  "%s without a durable answer cannot replace the original question", async status => {
    const { runtime, client } = await fixture();
    client.record = { ...question, revision: 2, status };
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], loading: false,
      error: "The server returned an invalid async question list." });
    client.record = saved(validAnswers);
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, error: undefined,
      questions: [{ answer: { submissionId: "other-device" } }] });
    expect(client.calls).toEqual(["asyncQuestion/list", "asyncQuestion/list"]);
  },
);

test("a missing answer notification preserves the card when reconciliation fails", async () => {
  const { runtime, client } = await fixture();
  client.read = async () => { throw new Error("read unavailable"); };
  client.emit({ method: "asyncQuestion/changed", params: {
    threadId: question.threadId, question: { ...question, revision: 2, status: "queued", answer: null },
  } });
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], error: "read unavailable" });
  expect(client.calls).toEqual(["asyncQuestion/list"]);
});

test("a pending list record with a saved answer cannot reopen input", async () => {
  const { runtime, client } = await fixture();
  client.record = { ...saved(validAnswers), status: "pending" };
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], loading: false,
    error: "The server returned an invalid async question list." });
  await expect(runtime.answerAsyncQuestion({ questionId: question.questionId, expectedRevision: 1,
    submissionId: "this-device", answers: validAnswers })).rejects.toThrow("no longer current");
  expect(client.calls).toEqual(["asyncQuestion/list"]);
  client.record = saved(validAnswers);
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, error: undefined,
    questions: [{ status: "queued", answer: { submissionId: "other-device" } }] });
});

test("a competing pending receipt with a saved answer cannot confirm input", async () => {
  const { runtime, client } = await fixture();
  client.record = { ...saved(validAnswers), status: "pending" };
  client.read = async () => ({ threadId: question.threadId, questions: [question] });
  await expect(runtime.answerAsyncQuestion({ questionId: question.questionId, expectedRevision: 1,
    submissionId: "this-device", answers: validAnswers })).rejects.toThrow("invalid async question answer receipt");
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
  expect(client.calls).toEqual(["asyncQuestion/answer", "asyncQuestion/list"]);
});

test("a competing receipt without its saved answer cannot settle the original question", async () => {
  const { runtime, client } = await fixture();
  client.record = { ...question, revision: 2, status: "queued" };
  client.read = async () => ({ threadId: question.threadId, questions: [question] });
  await expect(runtime.answerAsyncQuestion({ questionId: question.questionId, expectedRevision: 1,
    submissionId: "this-device", answers: validAnswers })).rejects.toThrow("invalid async question answer receipt");
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
  expect(client.calls).toEqual(["asyncQuestion/answer", "asyncQuestion/list"]);
});

test.each(invalidAnswers)("saved $name cannot replace an answerable card during a list refresh", async ({ answers }) => {
  const { runtime, client } = await fixture();
  client.record = saved(answers);
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    questions: [question], loading: false, error: "The server returned an invalid async question list.",
  });
  expect(client.calls).toEqual(["asyncQuestion/list"]);

  // A corrected original record recovers through an explicit read, with no
  // answer replay and no changes to the durable text or Rust defaults.
  client.record = saved(validAnswers);
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    questions: [{ answer: { answers: { mode: { selectedOptionIds: ["fast"] },
      note: { selectedOptionIds: [], text: " exact note " } } } }],
    loading: false, error: undefined,
  });
  expect(client.calls).toEqual(["asyncQuestion/list", "asyncQuestion/list"]);
});

test("an incomplete changed notification retains the prompt while its authoritative read waits", async () => {
  const { runtime, client } = await fixture();
  let finish!: (value: unknown) => void;
  client.read = () => new Promise(resolve => { finish = resolve; });
  client.emit({ method: "asyncQuestion/changed", params: {
    threadId: question.threadId, question: saved({ mode: validAnswers.mode }),
  } });
  const duringRead = runtime.getAsyncQuestionSnapshot();
  finish({ threadId: question.threadId, questions: [question] });
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(duringRead).toMatchObject({ questions: [question], loading: true });
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
  expect(client.calls).toEqual(["asyncQuestion/list"]);
});

test("a competing answer's incomplete receipt fails before confirming the card and only rereads", async () => {
  const { runtime, client } = await fixture();
  client.record = saved({ mode: validAnswers.mode });
  let finish!: (value: unknown) => void;
  client.read = () => new Promise(resolve => { finish = resolve; });
  const result = await runtime.answerAsyncQuestion({ questionId: question.questionId,
    expectedRevision: 1, submissionId: "this-device", answers: validAnswers,
  }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  const duringRead = runtime.getAsyncQuestionSnapshot();
  // Always release the owned reconciliation, including against the old code.
  finish?.({ threadId: question.threadId, questions: [saved(validAnswers)] });
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(result.error).toEqual(expect.objectContaining({
    message: "The server returned an invalid async question answer receipt.",
  }));
  expect(duringRead).toMatchObject({ questions: [question], loading: true, mutatingQuestionIds: [] });
  expect(client.calls).toEqual(["asyncQuestion/answer", "asyncQuestion/list"]);
  expect(runtime.getAsyncQuestionSnapshot().questions[0].answer?.submissionId).toBe("other-device");
});
