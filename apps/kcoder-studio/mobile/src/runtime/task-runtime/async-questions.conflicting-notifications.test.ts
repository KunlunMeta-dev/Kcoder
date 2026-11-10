import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const pendingQuestion: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 2, createdAtMs: 1,
  status: "pending", questions: [{ id: "item", header: "Mode", question: "Which mode?",
    multiSelect: false, options: [{ id: "fast", label: "Fast", description: "" }] }],
};

class QuestionClient extends FakeClient {
  reads = 0;
  read?: () => Promise<unknown>;
  constructor(readonly original: AsyncQuestionRecord) { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    if (method !== "asyncQuestion/list") return super.request<T>(method, params);
    this.reads++;
    return (this.read ? await this.read() : { threadId: this.original.threadId, questions: [this.original] }) as T;
  }
  notify(question: AsyncQuestionRecord) {
    this.emit({ method: "asyncQuestion/changed", params: {
      threadId: question.threadId, question: structuredClone(question),
    } });
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(original: AsyncQuestionRecord) {
  const client = new QuestionClient(original);
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: original.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.reads = 0;
  return { runtime, client };
}

const savedQuestion: AsyncQuestionRecord = {
  ...pendingQuestion, status: "queued",
  answer: { submissionId: "original-submission", acceptedAtMs: 2,
    answers: { item: { selectedOptionIds: ["fast"], text: " original answer " } } },
};

const conflicts: [string, AsyncQuestionRecord, AsyncQuestionRecord][] = [
  ["ended question", { ...pendingQuestion, status: "cancelled" }, pendingQuestion],
  ["saved answer", savedQuestion, { ...savedQuestion,
    answer: { ...savedQuestion.answer!, submissionId: "conflicting-submission",
      answers: { item: { selectedOptionIds: ["fast"], text: "different answer" } } } }],
];

for (const [name, original, conflict] of conflicts) {
  test.each([false, true])(`${name} retains its original content during same-revision reconciliation (read fails = %s)`, async readFails => {
    const { runtime, client } = await fixture(original);
    let finish!: () => void;
    client.read = () => new Promise((resolve, reject) => {
      finish = () => readFails ? reject(new Error("authoritative list unavailable"))
        : resolve({ threadId: original.threadId, questions: [original] });
    });
    client.notify(conflict);
    try {
      expect(client.reads).toBe(1);
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: true, questions: [original] });
    } finally {
      finish();
      await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
    }
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original],
      error: readFails ? "authoritative list unavailable" : undefined });
    expect(client.reads).toBe(1);
  });
}

test("same-revision list conflicts retain confirmed content until a matching read restores actions", async () => {
  const { runtime, client } = await fixture(pendingQuestion);
  const confirmed = { ...pendingQuestion,
    questions: [{ ...pendingQuestion.questions[0], question: "Confirmed wording" }] };
  client.read = async () => ({ threadId: confirmed.threadId, questions: [confirmed] });
  client.notify({ ...pendingQuestion,
    questions: [{ ...pendingQuestion.questions[0], question: "Conflicting wording" }] });
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [pendingQuestion],
    error: "The server returned an invalid async question list." });
  expect(client.reads).toBe(1);
  client.read = async () => ({ threadId: pendingQuestion.threadId, questions: [pendingQuestion] });
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [pendingQuestion], error: undefined });
  expect(client.reads).toBe(2);
});

for (const status of ["cancelled", "stale", "context_applied"] as const) {
  test.each(["list", "notification"] as const)(
    `%s cannot reopen a ${status} question at a higher revision`, async operation => {
      const original: AsyncQuestionRecord = status === "context_applied"
        ? { ...savedQuestion, status } : { ...pendingQuestion, status };
      const { runtime, client } = await fixture(original);
      const reopened: AsyncQuestionRecord = status === "context_applied"
        ? { ...original, revision: original.revision + 1, status: "queued" }
        : { ...original, revision: original.revision + 1, status: "pending" };
      let finish!: () => void;
      client.read = () => new Promise(resolve => {
        finish = () => resolve({ threadId: original.threadId, questions: [reopened] });
      });
      const reading = operation === "list" ? runtime.refreshAsyncQuestions() : undefined;
      if (operation === "notification") client.notify(reopened);
      try {
        expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([original]);
      } finally {
        finish();
        await reading;
        await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
      }
      expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([original]);
      expect(runtime.getAsyncQuestionSnapshot().error).toMatch(/invalid|conflicting/);
      expect(runtime.canMutateAsyncQuestions()).toBe(false);
      client.read = async () => ({ threadId: original.threadId, questions: [original] });
      await runtime.refreshAsyncQuestions();
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original], error: undefined });
      expect(client.reads).toBe(2);
    },
  );
}


test.each([
  { readFails: false, interleaved: false }, { readFails: true, interleaved: false },
  { readFails: false, interleaved: true }, { readFails: true, interleaved: true },
])("repeated conflicting notifications cannot starve reconciliation (read fails = $readFails, interleaved = $interleaved)", async ({ readFails, interleaved }) => {
  const { runtime, client } = await fixture(pendingQuestion);
  const conflict = { ...pendingQuestion,
    questions: [{ ...pendingQuestion.questions[0], question: "Conflicting wording" }] };
  const updates = interleaved ? [conflict, { ...conflict, sourceTurnId: "different-source" }] : [conflict];
  const reads: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  client.read = () => new Promise((resolve, reject) => reads.push({ resolve, reject }));
  const refreshing = runtime.refreshAsyncQuestions();
  for (let index = 0; index < 20; index++) updates.forEach(update => client.notify(update));
  expect(runtime.canMutateAsyncQuestions()).toBe(false);
  reads[0].resolve({ threadId: pendingQuestion.threadId, questions: [pendingQuestion] });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(client.reads).toBe(2);

  for (let index = 0; index < 20; index++) updates.forEach(update => client.notify(update));
  if (readFails) reads[1].reject(new Error("authoritative list unavailable"));
  else reads[1].resolve({ threadId: pendingQuestion.threadId, questions: [pendingQuestion] });
  await new Promise<void>(resolve => setImmediate(resolve));
  // Settle pre-fix trailing work before assertions so the test owns every read.
  for (const read of reads.slice(2))
    read.resolve({ threadId: pendingQuestion.threadId, questions: [pendingQuestion] });
  await refreshing;

  expect(client.reads).toBe(2);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false,
    questions: [pendingQuestion], error: readFails ? "authoritative list unavailable" : undefined });
  expect(runtime.canMutateAsyncQuestions()).toBe(!readFails);
  // Deduplication ends with the read. A later identical conflict still requires recovery.
  client.read = undefined;
  client.notify(conflict);
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(client.reads).toBe(3);
  expect(runtime.getAsyncQuestionSnapshot().error).toBeUndefined();
});


test("a distinct conflicting notification still supersedes a trailing read", async () => {
  const { runtime, client } = await fixture(pendingQuestion);
  const wordingConflict = { ...pendingQuestion,
    questions: [{ ...pendingQuestion.questions[0], question: "Conflicting wording" }] };
  const sourceConflict = { ...pendingQuestion, sourceTurnId: "different-source" };
  const reads: ((value: unknown) => void)[] = [];
  client.read = () => new Promise(resolve => reads.push(resolve));
  const refreshing = runtime.refreshAsyncQuestions();
  client.notify(wordingConflict);
  reads[0]({ threadId: pendingQuestion.threadId, questions: [pendingQuestion] });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(client.reads).toBe(2);
  client.notify(wordingConflict);
  for (let index = 0; index < 20; index++) client.notify(sourceConflict);
  reads[1]({ threadId: pendingQuestion.threadId, questions: [pendingQuestion] });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(client.reads).toBe(3);
  for (let index = 0; index < 20; index++) client.notify(sourceConflict);
  reads[2]({ threadId: pendingQuestion.threadId, questions: [pendingQuestion] });
  await new Promise<void>(resolve => setImmediate(resolve));
  // Settle unexpected work to preserve test ownership if deduplication regresses.
  for (const finish of reads.slice(3))
    finish({ threadId: pendingQuestion.threadId, questions: [pendingQuestion] });
  await refreshing;
  expect(client.reads).toBe(3);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false,
    questions: [pendingQuestion], error: undefined });
  expect(runtime.canMutateAsyncQuestions()).toBe(true);
});
