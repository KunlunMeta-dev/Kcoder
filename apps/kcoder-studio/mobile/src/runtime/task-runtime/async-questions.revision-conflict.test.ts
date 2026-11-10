import { asyncQuestionRevisionFingerprint } from "../../../../shared/asyncQuestionRevision";
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
  mutate?: () => Promise<unknown>;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: question.threadId, questions: [this.record] }) as T;
    if (this.mutate && ["asyncQuestion/answer", "asyncQuestion/cancel"].includes(method))
      return await this.mutate() as T;
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

test.each(["prompt", "status", "saved answer"])("a conflicting same-revision %s list cannot replace confirmed state", async kind => {
  const { runtime, client } = await fixture();
  if (kind === "saved answer") {
    client.record = saved(validAnswers);
    await runtime.refreshAsyncQuestions();
  }
  const original = runtime.getAsyncQuestionSnapshot().questions[0];
  client.record = kind === "prompt" ? { ...original, questions: original.questions.map((item, index) =>
    index === 0 ? { ...item, question: "A different question" } : item) }
    : kind === "status" ? { ...original, status: "cancelled" }
    : { ...original, answer: { ...original.answer!, submissionId: "foreign-winner" } };
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original], loading: false,
    error: "The server returned an invalid async question list." });
  await expect(runtime.answerAsyncQuestion({ questionId: question.questionId, expectedRevision: original.revision,
    submissionId: "this-device", answers: validAnswers })).rejects.toThrow("no longer current");
  expect(client.calls.every(method => method === "asyncQuestion/list")).toBe(true);
  client.record = { ...original, revision: original.revision + 1 };
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, error: undefined,
    questions: [{ revision: original.revision + 1 }] });
});

test("same-revision notification reconciliation cannot clear a persistent content conflict", async () => {
  const { runtime, client } = await fixture();
  client.record = { ...question, questions: question.questions.map(item => ({ ...item, question: "Conflicting prompt" })) };
  client.emit({ method: "asyncQuestion/changed", params: { threadId: question.threadId, question: client.record } });
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, questions: [question],
    error: "The server returned an invalid async question list." });
  client.record = question;
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().error).toBeUndefined();
});

test("revision content ignores wire key order and optional defaults while preserving answer bytes and array order", () => {
  const original = saved(validAnswers);
  const equivalent = { ...original, answer: { ...original.answer!, answers: {
    note: { ...validAnswers.note, selectedOptionIds: [] }, mode: { ...validAnswers.mode, text: null },
  } }, deliveryError: null };
  expect(asyncQuestionRevisionFingerprint(equivalent)).toBe(asyncQuestionRevisionFingerprint(original));
  expect(asyncQuestionRevisionFingerprint({ ...original, questions: [...original.questions].reverse() }))
    .not.toBe(asyncQuestionRevisionFingerprint(original));
  expect(asyncQuestionRevisionFingerprint(saved({ ...validAnswers, note: { text: "exact note" } })))
    .not.toBe(asyncQuestionRevisionFingerprint(original));
});

test.each([
  { operation: "answer", revision: 2 }, { operation: "cancel", revision: 2 },
  { operation: "answer", revision: 3 },
] as const)("a conflicting $operation receipt at revision $revision retains the confirmed winner", async ({ operation, revision }) => {
  const { runtime, client } = await fixture();
  let complete!: (value: unknown) => void;
  client.mutate = () => new Promise(resolve => { complete = resolve; });
  const input = { questionId: question.questionId, expectedRevision: 1 };
  const mutation = operation === "answer"
    ? runtime.answerAsyncQuestion({ ...input, submissionId: "this-device", answers: validAnswers })
    : runtime.cancelAsyncQuestion(input);
  // Another device's confirmed mutation arrives while our request is pending.
  const winner: AsyncQuestionRecord = operation === "answer" ? saved(validAnswers)
    : { ...question, revision: 2, status: "cancelled" };
  client.record = winner;
  client.emit({ method: "asyncQuestion/changed", params: { threadId: question.threadId, question: winner } });
  await runtime.refreshAsyncQuestions();
  const confirmed = runtime.getAsyncQuestionSnapshot().questions;
  expect(confirmed).toMatchObject([winner]);
  // Hold reconciliation to prove rejection itself preserves the known winner.
  let finishRead!: (value: unknown) => void;
  client.read = () => new Promise(resolve => { finishRead = resolve; });
  const conflict = operation === "answer"
    ? { ...winner, revision, answer: { ...winner.answer!, submissionId: "foreign-winner" } }
    : { ...winner, createdAtMs: winner.createdAtMs + 1 };
  complete({ threadId: question.threadId, question: conflict,
    ...(operation === "answer" ? { accepted: false, duplicate: false } : {}) });
  await expect(mutation).rejects.toThrow(/conflict/i);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: confirmed,
    mutatingQuestionIds: [], error: expect.stringMatching(/conflict/i) });
  expect(client.calls.filter(method => method === `asyncQuestion/${operation}`)).toHaveLength(1);
  client.read = undefined;
  const recovery = runtime.refreshAsyncQuestions();
  finishRead({ threadId: question.threadId, questions: [winner] });
  await recovery;
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: confirmed,
    loading: false, error: undefined });
});

test.each(["answer", "cancel"] as const)("a matching %s receipt may replay a confirmed revision", async operation => {
  const { runtime, client } = await fixture();
  let complete!: (value: unknown) => void;
  client.mutate = () => new Promise(resolve => { complete = resolve; });
  const input = { questionId: question.questionId, expectedRevision: 1 };
  const mutation = operation === "answer"
    ? runtime.answerAsyncQuestion({ ...input, submissionId: "this-device", answers: validAnswers })
    : runtime.cancelAsyncQuestion(input);
  const winner: AsyncQuestionRecord = operation === "answer" ? saved(validAnswers)
    : { ...question, revision: 2, status: "cancelled" };
  client.record = winner;
  client.emit({ method: "asyncQuestion/changed", params: { threadId: question.threadId, question: winner } });
  await runtime.refreshAsyncQuestions();
  complete({ threadId: question.threadId, question: winner,
    ...(operation === "answer" ? { accepted: false, duplicate: false } : {}) });
  await mutation;
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [winner], error: undefined,
    mutatingQuestionIds: [] });
});

for (const transport of ["list", "notification"] as const) {
  test.each(["submission", "payload", "missing answer", "timestamp"])(`a newer ${transport} cannot replace the saved %s`, async change => {
    const { runtime, client } = await fixture();
    const winner = saved(validAnswers);
    client.record = winner;
    await runtime.refreshAsyncQuestions();
    const altered = { ...winner, revision: 3, status: "context_applied" as const,
      answer: change === "missing answer" ? undefined : { ...winner.answer!,
        ...(change === "submission" ? { submissionId: "foreign-winner" } : {}),
        ...(change === "timestamp" ? { acceptedAtMs: 99 } : {}),
        ...(change === "payload" ? { answers: { ...validAnswers, note: { text: "foreign answer" } } } : {}),
      } };
    client.record = altered;
    if (transport === "notification") client.emit({ method: "asyncQuestion/changed",
      params: { threadId: question.threadId, question: altered } });
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [winner], error: expect.any(String) });
    client.record = { ...winner, revision: 3, status: "context_applied" };
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [client.record], error: undefined });
    expect(client.calls.every(method => method === "asyncQuestion/list")).toBe(true);
  });
}

for (const status of ["delivery_failed", "delivery_unknown"] as const) {
  test.each(["list", "notification"] as const)(
    `a newer %s cannot reopen ${status} delivery but task interruption may mark it stale`, async transport => {
      const { runtime, client } = await fixture();
      const original: AsyncQuestionRecord = { ...saved(validAnswers), status };
      client.record = original;
      await runtime.refreshAsyncQuestions();
      const reopened: AsyncQuestionRecord = { ...original, revision: 3, status: "queued" };
      client.record = reopened;
      if (transport === "notification") client.emit({ method: "asyncQuestion/changed",
        params: { threadId: question.threadId, question: reopened } });
      await runtime.refreshAsyncQuestions();
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
        questions: [original], error: expect.any(String),
      });
      await expect(runtime.answerAsyncQuestion({ questionId: question.questionId, expectedRevision: 3,
        submissionId: original.answer!.submissionId, answers: validAnswers })).rejects.toThrow("no longer current");
      expect(client.calls.every(method => method === "asyncQuestion/list")).toBe(true);
      // The State task-interrupt path legitimately marks unfinished deliveries stale.
      client.record = { ...original, revision: 3, status: "stale" };
      await runtime.refreshAsyncQuestions();
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
        questions: [client.record], loading: false, error: undefined,
      });
    },
  );
}

test("unknown delivery may reconcile as applied while keeping its exact saved answer", async () => {
  const { runtime, client } = await fixture();
  const original: AsyncQuestionRecord = { ...saved(validAnswers), status: "delivery_unknown" };
  client.record = original;
  await runtime.refreshAsyncQuestions();
  client.record = { ...original, revision: 3, status: "context_applied" };
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    questions: [client.record], loading: false, error: undefined,
  });
  expect(client.calls.every(method => method === "asyncQuestion/list")).toBe(true);
});
