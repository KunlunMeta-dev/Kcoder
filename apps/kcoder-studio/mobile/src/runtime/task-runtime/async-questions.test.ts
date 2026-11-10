import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const threadId = "thread-1";
const baseQuestion: AsyncQuestionRecord = {
  questionId: "question-async-1",
  requestId: "request-async-1",
  threadId,
  sourceTurnId: "turn-source-1",
  toolCallId: "tool-call-1",
  revision: 1,
  createdAtMs: 1_800_000_000_000,
  status: "pending",
  questions: [{
    id: "mode",
    header: "Mode",
    question: "Which mode should be used?",
    options: [
      { id: "fast", label: "Fast", description: "" },
      { id: "careful", label: "Careful", description: "" },
    ],
    multiSelect: false,
  }],
};

class AsyncQuestionClient extends FakeClient {
  readonly calls: Array<{ method: string; params: JsonRecord }> = [];

  constructor(
    readonly supportsAsyncQuestions: boolean,
    readonly getQuestion: () => AsyncQuestionRecord,
    readonly answer?: (params: JsonRecord) => unknown,
    readonly cancel?: (params: JsonRecord) => unknown,
  ) {
    super([]);
  }

  override supportsExperimental(capability: string): boolean {
    return capability === "asyncUserQuestionsV1" && this.supportsAsyncQuestions;
  }

  matchesRuntimeOwner(): boolean { return true; }
  matchesRetainedAttachmentOwner(): boolean { return true; }

  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === "asyncQuestion/list") {
      return { threadId, questions: [this.getQuestion()] } as T;
    }
    if (method === "asyncQuestion/answer" && this.answer) return this.answer(params) as T;
    if (method === "asyncQuestion/cancel" && this.cancel) return this.cancel(params) as T;
    return super.request<T>(method, params);
  }

}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function resume(client: AsyncQuestionClient, isCurrentInteractionOwner = () => true) {
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({
    profile,
    server,
    threadId,
    profileActivationEpoch: 1,
    isCurrentInteractionOwner,
  });
  runtimes.push(runtime);
  return runtime;
}

test("refresh restores durable questions and changed notifications update the card without blocking-question counts", async () => {
  let authoritative = { ...baseQuestion };
  const client = new AsyncQuestionClient(true, () => authoritative);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    supported: true,
    questions: [{ questionId: baseQuestion.questionId, requestId: "request-async-1", status: "pending" }],
  });
  expect(runtime.getSnapshot().interactionCount ?? 0).toBe(0);
  expect(runtime.pendingInteractions).toHaveLength(0);

  authoritative = { ...authoritative, revision: 2, status: "context_applied", answer: {
    submissionId: "other-device", acceptedAtMs: 1_800_000_000_001,
    answers: { mode: { selectedOptionIds: ["fast"] } },
  } };
  client.emit({ method: "asyncQuestion/changed", params: { threadId, question: authoritative } });
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().questions[0]).toMatchObject({
    revision: 2,
    status: "context_applied",
  });
});

test("unsupported servers never receive async question RPCs", async () => {
  const client = new AsyncQuestionClient(false, () => baseQuestion);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  runtime.handleAsyncQuestionChanged({ threadId, question: baseQuestion });
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ supported: false, questions: [] });
  expect(client.calls.some(({ method }) => method.startsWith("asyncQuestion/"))).toBe(false);
});

test("stale task owner fences notifications and their follow-up list reads", async () => {
  let isOwner = true;
  const client = new AsyncQuestionClient(true, () => baseQuestion);
  const runtime = await resume(client, () => isOwner);
  await runtime.refreshAsyncQuestions();
  client.calls.length = 0;
  isOwner = false;

  client.emit({ method: "asyncQuestion/changed", params: { threadId, question: baseQuestion } });
  await Promise.resolve();
  expect(runtime.getAsyncQuestionSnapshot().questions).toHaveLength(1);
  expect(client.calls).toHaveLength(0);
});

test("two clients racing to answer show the authoritative first answer on both devices", async () => {
  let authoritative = { ...baseQuestion };
  const answer = (params: JsonRecord) => {
    if (authoritative.status === "pending" && params.expectedRevision === authoritative.revision) {
      authoritative = {
        ...authoritative,
        revision: authoritative.revision + 1,
        status: "answer_saved",
        answer: {
          submissionId: String(params.submissionId),
          answers: params.answers as NonNullable<AsyncQuestionRecord["answer"]>["answers"],
          acceptedAtMs: 1_800_000_000_001,
        },
      };
      return { threadId, question: authoritative, accepted: true, duplicate: false };
    }
    return { threadId, question: authoritative, accepted: false, duplicate: false };
  };
  const firstClient = new AsyncQuestionClient(true, () => authoritative, answer);
  const secondClient = new AsyncQuestionClient(true, () => authoritative, answer);
  const first = await resume(firstClient);
  const second = await resume(secondClient);
  await Promise.all([first.refreshAsyncQuestions(), second.refreshAsyncQuestions()]);
  const payload = { mode: { selectedOptionIds: ["fast"] } };

  const firstReceipt = await first.answerAsyncQuestion({
    questionId: baseQuestion.questionId,
    submissionId: "stable-first-submission",
    expectedRevision: baseQuestion.revision,
    answers: payload,
  });
  const secondReceipt = await second.answerAsyncQuestion({
    questionId: baseQuestion.questionId,
    submissionId: "stable-second-submission",
    expectedRevision: baseQuestion.revision,
    answers: { mode: { selectedOptionIds: ["careful"] } },
  });

  expect(firstReceipt).toMatchObject({ accepted: true, question: { answer: { answers: payload } } });
  expect(secondReceipt).toMatchObject({
    accepted: false,
    duplicate: false,
    question: { answer: { submissionId: "stable-first-submission", answers: payload } },
  });
  expect(first.getAsyncQuestionSnapshot().questions[0]?.answer?.answers).toEqual(payload);
  expect(second.getAsyncQuestionSnapshot().questions[0]?.answer?.answers).toEqual(payload);
  expect(first.getSnapshot().interactionCount ?? 0).toBe(0);
  expect(second.getSnapshot().interactionCount ?? 0).toBe(0);
  for (const client of [firstClient, secondClient]) client.emit({
    method: "turn/started",
    params: { threadId, turnId: "answer-triggered-turn", attemptId: "answer-triggered-attempt" },
  });
  expect(first.getSnapshot()).toMatchObject({ running: true, activeTurnId: "answer-triggered-turn" });
  expect(second.getSnapshot()).toMatchObject({ running: true, activeTurnId: "answer-triggered-turn" });
  expect(firstClient.calls.some(({ method }) => method === "turn/start")).toBe(false);
});

test("only an exact saved answer can resume queued delivery, and the original owner fence still applies", async () => {
  let authoritative = { ...baseQuestion };
  let isOwner = true;
  const answer = (params: JsonRecord) => {
    if (authoritative.status === "pending") {
      authoritative = {
        ...authoritative,
        revision: authoritative.revision + 1,
        status: "queued",
        answer: {
          submissionId: String(params.submissionId),
          answers: params.answers as NonNullable<AsyncQuestionRecord["answer"]>["answers"],
          acceptedAtMs: 1_800_000_000_001,
        },
      };
      return { threadId, question: authoritative, accepted: true, duplicate: false };
    }
    const exactRetry = params.submissionId === authoritative.answer?.submissionId &&
      JSON.stringify(params.answers) === JSON.stringify(authoritative.answer?.answers);
    return {
      threadId,
      question: authoritative,
      accepted: exactRetry,
      duplicate: exactRetry,
    };
  };
  const client = new AsyncQuestionClient(true, () => authoritative, (params) => {
    answerCalls += 1;
    return answer(params);
  });
  let answerCalls = 0;
  const runtime = await resume(client, () => isOwner);
  await runtime.refreshAsyncQuestions();
  const savedAnswers = { mode: { selectedOptionIds: ["fast"] } };
  const savedSubmissionId = "stable-saved-answer";
  const first = await runtime.answerAsyncQuestion({
    questionId: baseQuestion.questionId,
    submissionId: savedSubmissionId,
    expectedRevision: baseQuestion.revision,
    answers: savedAnswers,
  });
  expect(first).toMatchObject({ accepted: true, question: { status: "queued" } });

  const retry = await runtime.answerAsyncQuestion({
    questionId: baseQuestion.questionId,
    submissionId: savedSubmissionId,
    expectedRevision: authoritative.revision,
    answers: savedAnswers,
  });
  expect(retry).toMatchObject({ accepted: true, duplicate: true, question: { status: "queued" } });
  expect(client.calls.filter(({ method }) => method === "asyncQuestion/answer")).toHaveLength(2);

  await expect(runtime.answerAsyncQuestion({
    questionId: baseQuestion.questionId,
    submissionId: savedSubmissionId,
    expectedRevision: authoritative.revision,
    answers: { mode: { selectedOptionIds: ["careful"] } },
  })).rejects.toThrow("This question is no longer current");
  await expect(runtime.answerAsyncQuestion({
    questionId: baseQuestion.questionId,
    submissionId: "different-submission",
    expectedRevision: authoritative.revision,
    answers: savedAnswers,
  })).rejects.toThrow("This question is no longer current");
  expect(client.calls.filter(({ method }) => method === "asyncQuestion/answer")).toHaveLength(2);

  isOwner = false;
  await expect(runtime.answerAsyncQuestion({
    questionId: baseQuestion.questionId,
    submissionId: savedSubmissionId,
    expectedRevision: authoritative.revision,
    answers: savedAnswers,
  })).rejects.toThrow("This question is no longer current");
  expect(client.calls.filter(({ method }) => method === "asyncQuestion/answer")).toHaveLength(2);
});


test.each(["answer", "cancel"] as const)(
  "%s rejects another question's receipt in the same thread and reconciles without replay",
  async (operation) => {
    const authoritative = { ...baseQuestion, revision: 1 };
    const receiptQuestion: AsyncQuestionRecord = {
      ...authoritative,
      questionId: "another-question-in-the-same-thread",
      revision: 2,
      status: operation === "answer" ? "answer_saved" : "cancelled",
      ...(operation === "answer" ? {
        answer: {
          submissionId: "stable-submission",
          answers: { mode: { selectedOptionIds: ["fast"] } },
          acceptedAtMs: 1_800_000_000_001,
        },
      } : {}),
    };
    const client = new AsyncQuestionClient(
      true,
      () => authoritative,
      () => ({ threadId, question: receiptQuestion, accepted: true, duplicate: false }),
      () => ({ threadId, question: receiptQuestion }),
    );
    const runtime = await resume(client);
    await runtime.refreshAsyncQuestions();
    client.calls.length = 0;
    const input = { questionId: authoritative.questionId, expectedRevision: 1 };
    const result = operation === "answer"
      ? runtime.answerAsyncQuestion({
        ...input,
        submissionId: "stable-submission",
        answers: { mode: { selectedOptionIds: ["fast"] } },
      })
      : runtime.cancelAsyncQuestion(input);

    await expect(result).rejects.toThrow(`invalid async question ${operation === "answer" ? "answer" : "cancellation"} receipt`);
    expect(client.calls.map(({ method }) => method)).toEqual([
      `asyncQuestion/${operation}`, "asyncQuestion/list",
    ]);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [authoritative],
      mutatingQuestionIds: [],
    });
    expect(runtime.getAsyncQuestionSnapshot().questions).toHaveLength(1);
  },
);

test("an accepted answer receipt must confirm the submitted answer identity", async () => {
  const authoritative = { ...baseQuestion, revision: 1 };
  const client = new AsyncQuestionClient(true, () => authoritative, () => ({
    threadId,
    accepted: true,
    duplicate: false,
    question: {
      ...authoritative,
      revision: 2,
      status: "answer_saved",
      answer: {
        submissionId: "another-devices-submission",
        answers: { mode: { selectedOptionIds: ["careful"] } },
        acceptedAtMs: 1_800_000_000_001,
      },
    },
  }));
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  client.calls.length = 0;

  await expect(runtime.answerAsyncQuestion({
    questionId: authoritative.questionId,
    submissionId: "my-stable-submission",
    expectedRevision: 1,
    answers: { mode: { selectedOptionIds: ["fast"] } },
  })).rejects.toThrow("invalid async question answer receipt");
  expect(client.calls.map(({ method }) => method)).toEqual([
    "asyncQuestion/answer", "asyncQuestion/list",
  ]);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    questions: [authoritative],
    mutatingQuestionIds: [],
  });
});

test("a matching cancellation receipt settles only its original question", async () => {
  let authoritative = { ...baseQuestion, revision: 1 };
  const client = new AsyncQuestionClient(true, () => authoritative, undefined, () => {
    authoritative = { ...authoritative, revision: 2, status: "cancelled" };
    return { threadId, question: authoritative };
  });
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();

  await expect(runtime.cancelAsyncQuestion({
    questionId: authoritative.questionId,
    expectedRevision: 1,
  })).resolves.toMatchObject({ questionId: authoritative.questionId, status: "cancelled" });
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    questions: [authoritative],
    mutatingQuestionIds: [],
  });
});


test.each(["accepted", "competing", "cancelled"] as const)(
  "a list read started before the %s receipt cannot restore a pending card",
  async (outcome) => {
    const pending: AsyncQuestionRecord = { ...baseQuestion, revision: 1 };
    const settled: AsyncQuestionRecord = {
      ...pending,
      revision: 2,
      status: outcome === "cancelled" ? "cancelled" : "answer_saved",
      ...(outcome === "cancelled" ? {} : {
        answer: {
          submissionId: outcome === "competing" ? "other-device" : "my-submission",
          answers: { mode: { selectedOptionIds: ["fast"] } },
          acceptedAtMs: 1_800_000_000_001,
        },
      }),
    };
    const client = new AsyncQuestionClient(
      true,
      () => pending,
      () => ({ threadId, question: settled, accepted: outcome === "accepted", duplicate: false }),
      () => ({ threadId, question: settled }),
    );
    const runtime = await resume(client);
    await runtime.refreshAsyncQuestions();
    let finishRead!: (value: unknown) => void;
    const staleRead = new Promise<unknown>((resolve) => { finishRead = resolve; });
    vi.spyOn(client, "request").mockImplementationOnce(() => staleRead as never);
    const refresh = runtime.refreshAsyncQuestions();
    if (outcome === "cancelled") {
      await runtime.cancelAsyncQuestion({ questionId: pending.questionId, expectedRevision: 1 });
    } else {
      await runtime.answerAsyncQuestion({
        questionId: pending.questionId,
        expectedRevision: 1,
        submissionId: "my-submission",
        answers: { mode: { selectedOptionIds: ["fast"] } },
      });
    }
    expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([settled]);
    finishRead({ threadId, questions: [pending] });
    await refresh;
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [settled], loading: false, mutatingQuestionIds: [],
    });
  },
);


test("newer list revisions advance a settled question and read failures remain visible", async () => {
  const saved: AsyncQuestionRecord = {
    ...baseQuestion,
    revision: 2,
    status: "answer_saved",
    answer: {
      submissionId: "saved-submission",
      answers: { mode: { selectedOptionIds: ["fast"] } },
      acceptedAtMs: 1_800_000_000_001,
    },
  };
  let authoritative = saved;
  const client = new AsyncQuestionClient(true, () => authoritative);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  authoritative = { ...saved, revision: 3, status: "context_applied" };
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([authoritative]);
  vi.spyOn(client, "request").mockRejectedValueOnce(new Error("refresh unavailable"));
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    questions: [authoritative], loading: false, error: "refresh unavailable",
  });
});


test.each([
  { name: "padded Unicode text", text: "  跨端原答案\n  ", selectedOptionIds: [] },
  { name: "empty optional text", text: "", selectedOptionIds: ["fast"] },
  { name: "whitespace optional text", text: " \n\t ", selectedOptionIds: ["fast"] },
])("restored $name retains the exact saved payload when continuing delivery", async ({ text, selectedOptionIds }) => {
  // Another client saved this answer before Mobile attached. The server compares
  // the original typed payload digest, not a display-normalized version.
  const savedAnswers = { mode: { selectedOptionIds, text } };
  const authoritative: AsyncQuestionRecord = {
    ...baseQuestion,
    revision: 2,
    status: "queued",
    answer: {
      submissionId: "other-client-saved-answer",
      answers: savedAnswers,
      acceptedAtMs: 1_800_000_000_001,
    },
  };
  const client = new AsyncQuestionClient(true, () => authoritative, (params) => {
    const exactRetry = params.submissionId === authoritative.answer!.submissionId &&
      JSON.stringify(params.answers) === JSON.stringify(savedAnswers);
    return { threadId, question: authoritative, accepted: exactRetry, duplicate: exactRetry };
  });
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  const restored = runtime.getAsyncQuestionSnapshot().questions[0]!;
  const receipt = await runtime.answerAsyncQuestion({
    questionId: restored.questionId,
    submissionId: restored.answer!.submissionId,
    expectedRevision: restored.revision,
    answers: restored.answer!.answers,
  });
  expect(receipt).toMatchObject({ accepted: true, duplicate: true });
  expect(client.calls.filter(({ method }) => method === "asyncQuestion/answer")).toEqual([{
    method: "asyncQuestion/answer",
    params: {
      threadId,
      questionId: authoritative.questionId,
      submissionId: authoritative.answer!.submissionId,
      expectedRevision: authoritative.revision,
      answers: savedAnswers,
    },
  }]);
  expect(receipt.question.answer!.answers).toEqual(savedAnswers);
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().questions[0]!.answer!.answers).toEqual(savedAnswers);
  await expect(runtime.answerAsyncQuestion({
    questionId: restored.questionId,
    submissionId: restored.answer!.submissionId,
    expectedRevision: restored.revision,
    answers: { mode: { selectedOptionIds, text: text + "changed" } },
  })).rejects.toThrow("This question is no longer current");
  expect(client.calls.filter(({ method }) => method === "asyncQuestion/answer")).toHaveLength(1);
});


test.each(["answer", "cancel"] as const)(
  "%s releases its local busy state after the transport owner changes, without applying the old receipt",
  async (operation) => {
    let finish!: (value: unknown) => void;
    const oldReply = new Promise<unknown>((resolve) => { finish = resolve; });
    const oldClient = new AsyncQuestionClient(true, () => baseQuestion, () => oldReply, () => oldReply);
    const runtime = await resume(oldClient);
    await runtime.refreshAsyncQuestions();
    const input = { questionId: baseQuestion.questionId, expectedRevision: baseQuestion.revision };
    const mutation = operation === "answer"
      ? runtime.answerAsyncQuestion({ ...input, submissionId: "old-submission", answers: { mode: { selectedOptionIds: ["fast"] } } })
      : runtime.cancelAsyncQuestion(input);
    const rejected = expect(mutation).rejects.toThrow("task owner changed");
    expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([baseQuestion.questionId]);

    const currentQuestion = { ...baseQuestion, revision: 2 };
    const replacement = new AsyncQuestionClient(true, () => currentQuestion);
    runtime.attachClient(replacement as never);
    await runtime.refreshAsyncQuestions();
    finish({
      threadId,
      ...(operation === "answer" ? { accepted: true, duplicate: false } : {}),
      question: {
        ...baseQuestion,
        revision: 2,
        status: operation === "answer" ? "answer_saved" : "cancelled",
        ...(operation === "answer" ? {
          answer: { submissionId: "old-submission", answers: { mode: { selectedOptionIds: ["fast"] } }, acceptedAtMs: 2 },
        } : {}),
      },
    });
    await rejected;
    expect(runtime.asyncQuestionMutationIds.size).toBe(0);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [currentQuestion], mutatingQuestionIds: [], loading: false,
    });
    expect(replacement.calls.map(({ method }) => method)).toEqual(["asyncQuestion/list"]);
  },
);

test.each(["answer", "cancel"] as const)(
  "%s transport failure after reconnect cannot leave the recovered card permanently busy",
  async (operation) => {
    let fail!: (reason: Error) => void;
    const lostReply = new Promise<never>((_resolve, reject) => { fail = reject; });
    const oldClient = new AsyncQuestionClient(true, () => baseQuestion, () => lostReply, () => lostReply);
    const runtime = await resume(oldClient);
    await runtime.refreshAsyncQuestions();
    const input = { questionId: baseQuestion.questionId, expectedRevision: baseQuestion.revision };
    const mutation = operation === "answer"
      ? runtime.answerAsyncQuestion({ ...input, submissionId: "unknown-submission", answers: { mode: { selectedOptionIds: ["fast"] } } })
      : runtime.cancelAsyncQuestion(input);
    const rejected = expect(mutation).rejects.toThrow("old transport closed");
    const replacement = new AsyncQuestionClient(true, () => baseQuestion, undefined, () => ({
      threadId, question: { ...baseQuestion, revision: 2, status: "cancelled" },
    }));
    runtime.attachClient(replacement as never);
    await runtime.refreshAsyncQuestions();
    fail(new Error("old transport closed"));
    await rejected;
    // Another successful read must leave an actionable card, not preserve an
    // obsolete spinner after the internal mutation lock was already released.
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [baseQuestion], mutatingQuestionIds: [], loading: false,
    });
    expect(replacement.calls.every(({ method }) => method === "asyncQuestion/list")).toBe(true);
    // Only a new explicit user action may issue a mutation on the new transport.
    await runtime.cancelAsyncQuestion(input);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [{ status: "cancelled" }], mutatingQuestionIds: [],
    });
  },
);


test("settling an old request preserves another question's in-flight mutation on the new connection", async () => {
  let failOld!: (reason: Error) => void;
  let finishCurrent!: (value: unknown) => void;
  const oldReply = new Promise<never>((_resolve, reject) => { failOld = reject; });
  const currentReply = new Promise<unknown>((resolve) => { finishCurrent = resolve; });
  const oldClient = new AsyncQuestionClient(true, () => baseQuestion, () => oldReply);
  const runtime = await resume(oldClient);
  await runtime.refreshAsyncQuestions();
  const oldMutation = runtime.answerAsyncQuestion({
    questionId: baseQuestion.questionId, expectedRevision: baseQuestion.revision,
    submissionId: "old-submission", answers: { mode: { selectedOptionIds: ["fast"] } },
  });
  const rejected = expect(oldMutation).rejects.toThrow("old transport closed");
  const anotherQuestion = { ...baseQuestion, questionId: "another-current-question" };
  const replacement = new AsyncQuestionClient(true, () => baseQuestion, undefined, () => currentReply);
  const request = replacement.request.bind(replacement);
  vi.spyOn(replacement, "request").mockImplementation((method, params) => method === "asyncQuestion/list"
    ? Promise.resolve({ threadId, questions: [baseQuestion, anotherQuestion] }) as never
    : request(method, params));
  runtime.attachClient(replacement as never);
  await runtime.refreshAsyncQuestions();
  const currentMutation = runtime.cancelAsyncQuestion({ questionId: anotherQuestion.questionId, expectedRevision: baseQuestion.revision });
  const observer = vi.fn();
  const unsubscribe = runtime.subscribe(observer);
  failOld(new Error("old transport closed"));
  await rejected;
  // Readback already retired the old lock. Its late completion has no state to
  // publish and cannot disturb the other question's current request.
  expect(observer).not.toHaveBeenCalled();
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([anotherQuestion.questionId]);
  finishCurrent({ threadId, question: { ...anotherQuestion, revision: 2, status: "cancelled" } });
  await currentMutation;
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
  expect(runtime.getAsyncQuestionSnapshot().questions.find((item) => item.questionId === baseQuestion.questionId))
    .toEqual(baseQuestion);
  unsubscribe();
});

test.each(["answer", "cancel"] as const)(
  "%s releases the internal lock after runtime close without notifying disposed consumers",
  async (operation) => {
    let fail!: (reason: Error) => void;
    const reply = new Promise<never>((_resolve, reject) => { fail = reject; });
    const client = new AsyncQuestionClient(true, () => baseQuestion, () => reply, () => reply);
    const runtime = await resume(client);
    await runtime.refreshAsyncQuestions();
    const input = { questionId: baseQuestion.questionId, expectedRevision: baseQuestion.revision };
    const mutation = operation === "answer"
      ? runtime.answerAsyncQuestion({ ...input, submissionId: "closing-submission", answers: { mode: { selectedOptionIds: ["fast"] } } })
      : runtime.cancelAsyncQuestion(input);
    const rejected = expect(mutation).rejects.toThrow("transport closed");
    runtime.close();
    const observer = vi.fn();
    const unsubscribe = runtime.subscribe(observer);
    fail(new Error("transport closed"));
    await rejected;
    expect(runtime.asyncQuestionMutationIds.size).toBe(0);
    expect(observer).not.toHaveBeenCalled();
    unsubscribe();
  },
);


test.each([
  { operation: "answer", readFails: false },
  { operation: "cancel", readFails: false },
  { operation: "answer", readFails: true },
  { operation: "cancel", readFails: true },
] as const)(
  "$operation failure releases its busy flag before reconciliation settles (readFails=$readFails)",
  async ({ operation, readFails }) => {
    const pending = { ...baseQuestion, revision: 1 };
    const client = new AsyncQuestionClient(true, () => pending);
    const runtime = await resume(client);
    await runtime.refreshAsyncQuestions();
    client.calls.length = 0;
    let finishRead!: (value: unknown) => void;
    let failRead!: (reason: Error) => void;
    const read = new Promise<unknown>((resolve, reject) => {
      finishRead = resolve;
      failRead = reject;
    });
    const originalRequest = client.request.bind(client);
    const failure = new Error("The mutation outcome is unknown");
    vi.spyOn(client, "request").mockImplementation((method, params = {}) => {
      if (method === `asyncQuestion/${operation}`) {
        client.calls.push({ method, params });
        return Promise.reject(failure);
      }
      if (method === "asyncQuestion/list") {
        client.calls.push({ method, params });
        return read as never;
      }
      return originalRequest(method, params);
    });
    const input = { questionId: pending.questionId, expectedRevision: 1 };
    const mutation = operation === "answer"
      ? runtime.answerAsyncQuestion({ ...input, submissionId: "stable-submission",
        answers: { mode: { selectedOptionIds: ["fast"] } } })
      : runtime.cancelAsyncQuestion(input);
    let observedError: unknown;
    const observed = mutation.catch((error) => { observedError = error; });
    try {
      await vi.waitFor(() => {
        expect(observedError).toBe(failure);
        expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
          loading: true, mutatingQuestionIds: [], questions: [pending],
        });
      }, { timeout: 200, interval: 10 });
      expect(client.calls.map(({ method }) => method)).toEqual([
        `asyncQuestion/${operation}`, "asyncQuestion/list",
      ]);
    } finally {
      // Settle the owned read even when the pre-fix assertion fails.
      if (readFails) failRead(new Error("Reconciliation unavailable"));
      else finishRead({ threadId, questions: [{ ...pending, revision: 2, status: "cancelled" }] });
      await observed;
    }
    await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      loading: false, mutatingQuestionIds: [],
      ...(readFails ? { questions: [pending], error: "Reconciliation unavailable" } : {
        questions: [{ questionId: pending.questionId, revision: 2, status: "cancelled" }],
      }),
    }));
  },
);


test.each([false, true])("accepted receipt confirms the exact submitted answers (duplicate=%s)", async (duplicate) => {
  const pending = { ...baseQuestion, revision: 1 };
  const submitted = { mode: { selectedOptionIds: ["fast"], text: " keep spacing " } };
  const mismatches = [
    { mode: { selectedOptionIds: ["fast", "fast"], text: " keep spacing " } },
    { mode: { selectedOptionIds: ["careful"], text: " keep spacing " } },
    { mode: { selectedOptionIds: ["fast"], text: "another answer" } },
    { mode: { selectedOptionIds: ["fast"] } },
    { mode: { selectedOptionIds: ["fast"], text: "keep spacing" } },
    {},
  ];
  for (const answers of mismatches) {
    const client = new AsyncQuestionClient(true, () => pending, () => ({
      threadId, accepted: true, duplicate,
      question: { ...pending, revision: 2, status: "answer_saved",
        answer: { submissionId: "my-submission", answers, acceptedAtMs: 1_800_000_000_001 } },
    }));
    const runtime = await resume(client);
    await runtime.refreshAsyncQuestions();
    client.calls.length = 0;
    await expect(runtime.answerAsyncQuestion({
      questionId: pending.questionId, expectedRevision: 1,
      submissionId: "my-submission", answers: submitted,
    })).rejects.toThrow("invalid async question answer receipt");
    expect(client.calls.map(({ method }) => method)).toEqual([
      "asyncQuestion/answer", "asyncQuestion/list",
    ]);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [pending], mutatingQuestionIds: [],
    });
  }
});


test.each([false, true])("accepted answer comparison preserves Rust defaults (duplicate=%s)", async (duplicate) => {
  const pending = { ...baseQuestion, revision: 1 };
  const payloads = [
    { mode: { text: " keep spacing " } },
    { mode: { selectedOptionIds: ["fast"], text: null } },
    { mode: { selectedOptionIds: ["fast"], text: undefined } },
    { mode: { selectedOptionIds: ["fast"], text: "" } },
  ];
  for (const answers of payloads) {
    const canonical = { mode: { selectedOptionIds: answers.mode.selectedOptionIds ?? [],
      ...(answers.mode.text == null ? {} : { text: answers.mode.text }) } };
    const client = new AsyncQuestionClient(true, () => pending, () => ({
      threadId, accepted: true, duplicate,
      question: { ...pending, revision: 2, status: "answer_saved",
        answer: { submissionId: "my-submission", answers: canonical, acceptedAtMs: 1_800_000_000_001 } },
    }));
    const runtime = await resume(client);
    await runtime.refreshAsyncQuestions();
    await expect(runtime.answerAsyncQuestion({
      questionId: pending.questionId, expectedRevision: 1,
      submissionId: "my-submission", answers,
    })).resolves.toMatchObject({ accepted: true, duplicate, question: { answer: { answers: canonical } } });
  }
});

// RPC serializes immediately; later caller edits must not redefine that input.
test.each([false, true])("answer receipt stays bound to the sent payload when the caller edits input (mismatched receipt: %s)", async (mismatched) => {
  const pending = { ...baseQuestion, revision: 1 };
  const client = new AsyncQuestionClient(true, () => pending);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  let finish!: (value: unknown) => void;
  const receipt = new Promise((resolve) => { finish = resolve; });
  vi.spyOn(client, "request").mockImplementationOnce(() => receipt as never);
  const input = {
    questionId: pending.questionId, expectedRevision: 1, submissionId: "original",
    answers: { mode: { selectedOptionIds: ["fast"], text: "original answer" } },
  };
  const answering = runtime.answerAsyncQuestion(input);
  input.answers.mode.selectedOptionIds[0] = "careful";
  input.answers.mode.text = "edited after send";
  finish({ threadId, accepted: true, duplicate: false, question: {
    ...pending, revision: 2, status: "answer_saved", answer: {
      submissionId: "original", acceptedAtMs: pending.createdAtMs + 1,
      answers: { mode: mismatched
        ? { selectedOptionIds: ["careful"], text: "edited after send" }
        : { selectedOptionIds: ["fast"], text: "original answer" } },
    },
  } });
  if (mismatched) await expect(answering).rejects.toThrow("invalid async question answer receipt");
  else await expect(answering).resolves.toMatchObject({ accepted: true });
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
});

test("cancellation receipt stays bound to the question sent before a caller edit", async () => {
  const pending = { ...baseQuestion, revision: 1 };
  const client = new AsyncQuestionClient(true, () => pending);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  let finish!: (value: unknown) => void;
  vi.spyOn(client, "request").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
  const input = { questionId: pending.questionId, expectedRevision: 1 };
  const cancelling = runtime.cancelAsyncQuestion(input);
  input.questionId = "a-different-question";
  finish({ threadId, question: { ...pending, revision: 2, status: "cancelled" } });
  await expect(cancelling).resolves.toMatchObject({ questionId: pending.questionId, status: "cancelled" });
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
});


test("a burst of async question changes shares one in-flight read and one trailing reconciliation", async () => {
  const client = new AsyncQuestionClient(true, () => baseQuestion);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  const reads: Array<(value: unknown) => void> = [];
  const request = vi.spyOn(client, "request").mockImplementation(() =>
    new Promise((resolve) => { reads.push(resolve); }) as never);
  const refresh = runtime.refreshAsyncQuestions();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  const latest = { ...baseQuestion, revision: baseQuestion.revision + 1 };
  // Replayed notifications keep the same durable identity and revision. Hold
  // replies to reproduce a slow connection while duplicate frames arrive.
  for (let update = 0; update < 130; update++) {
    client.emit({ method: "asyncQuestion/changed", params: { threadId, question: latest } });
  }
  const duringBurst = request.mock.calls.length;
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([latest]);
  // Settle every pre-fix request too, so a failing regression owns no live work.
  for (const resolve of reads) resolve({ threadId, questions: [baseQuestion] });
  await vi.waitFor(() => expect(reads.length).toBeGreaterThan(1));
  reads.at(-1)!({ threadId, questions: [latest] });
  await refresh;
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(duringBurst).toBe(1);
  expect(request).toHaveBeenCalledTimes(2);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [latest], error: undefined });
});

test("a trailing reconciliation failure stays visible without an automatic retry loop", async () => {
  const client = new AsyncQuestionClient(true, () => baseQuestion);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  let finish!: (value: unknown) => void;
  const request = vi.spyOn(client, "request")
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never)
    .mockRejectedValueOnce(new Error("trailing read unavailable"));
  const first = runtime.refreshAsyncQuestions();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const queued = runtime.refreshAsyncQuestions();
  finish({ threadId, questions: [baseQuestion] });
  await Promise.all([first, queued]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    loading: false, questions: [baseQuestion], error: "trailing read unavailable",
  });
});

test("replacement connections refresh without waiting for a previous connection's list", async () => {
  const client = new AsyncQuestionClient(true, () => baseQuestion);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  let finish!: (value: unknown) => void;
  vi.spyOn(client, "request").mockImplementationOnce(() =>
    new Promise((resolve) => { finish = resolve; }) as never);
  const oldRead = runtime.refreshAsyncQuestions();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const oldQueued = runtime.refreshAsyncQuestions();
  const recovered = { ...baseQuestion, revision: 2, status: "cancelled" as const };
  const replacement = new AsyncQuestionClient(true, () => recovered);
  runtime.client = replacement as never;
  runtime.clientGeneration++;
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([recovered]);
  finish({ threadId, questions: [baseQuestion] });
  await Promise.all([oldRead, oldQueued]);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, questions: [recovered] });
  expect(replacement.calls.filter(({ method }) => method === "asyncQuestion/list")).toHaveLength(1);
});


test("an older list cannot hide a newly notified card while the trailing read is pending", async () => {
  const client = new AsyncQuestionClient(true, () => baseQuestion);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  const reads: Array<(value: unknown) => void> = [];
  vi.spyOn(client, "request").mockImplementation(() =>
    new Promise((resolve) => { reads.push(resolve); }) as never);
  const refresh = runtime.refreshAsyncQuestions();
  const newQuestion = { ...baseQuestion, questionId: "new-question", requestId: "new-request",
    createdAtMs: baseQuestion.createdAtMs + 1 };
  client.emit({ method: "asyncQuestion/changed", params: { threadId, question: newQuestion } });
  reads[0]({ threadId, questions: [baseQuestion] });
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  const duringTrailingRead = runtime.getAsyncQuestionSnapshot();
  reads[1]({ threadId, questions: [baseQuestion, newQuestion] });
  await refresh;
  expect(duringTrailingRead).toMatchObject({ loading: true, questions: [baseQuestion, newQuestion] });
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    loading: false, questions: [baseQuestion, newQuestion],
  });
});

test("closing the runtime drops a queued refresh instead of dispatching after disconnect", async () => {
  const client = new AsyncQuestionClient(true, () => baseQuestion);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  let finish!: (value: unknown) => void;
  const request = vi.spyOn(client, "request").mockImplementationOnce(() =>
    new Promise((resolve) => { finish = resolve; }) as never);
  const first = runtime.refreshAsyncQuestions();
  const queued = runtime.refreshAsyncQuestions();
  runtime.close();
  finish({ threadId, questions: [baseQuestion] });
  await Promise.all([first, queued]);
  expect(request.mock.calls.filter(([method]) => method === "asyncQuestion/list")).toHaveLength(1);
});


test("a change arriving as the refresh loop finishes still reads a new snapshot", async () => {
  const client = new AsyncQuestionClient(true, () => baseQuestion);
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  const reads: Array<(value: unknown) => void> = [];
  vi.spyOn(client, "request").mockImplementation(() =>
    new Promise((resolve) => { reads.push(resolve); }) as never);
  const first = runtime.refreshAsyncQuestions();
  const latest = { ...baseQuestion, revision: baseQuestion.revision + 1 };
  try {
    reads[0]({ threadId, questions: [baseQuestion] });
    // The inner read settles first, then the outer refresh loop finishes. Deliver
    // the notification before that loop's Promise completion callback runs.
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(() => {
      client.emit({ method: "asyncQuestion/changed", params: { threadId, question: latest } });
      resolve();
    })));
    expect(reads).toHaveLength(2);
    reads[1]({ threadId, questions: [latest] });
    await first;
    await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
    expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([latest]);
  } finally {
    runtime.close();
    for (const finish of reads) finish({ threadId, questions: [baseQuestion] });
    await first;
  }
});


test.each(["refresh", "notification"] as const)(
  "%s rejects repeated saved selections and recovers with the exact valid payload",
  async (operation) => {
    const pending = { ...baseQuestion, revision: 1 };
    let authoritative: AsyncQuestionRecord = pending;
    const client = new AsyncQuestionClient(true, () => authoritative);
    const runtime = await resume(client);
    await runtime.refreshAsyncQuestions();
    client.calls.length = 0;
    authoritative = {
      ...pending,
      revision: 2,
      status: "queued",
      answer: {
        submissionId: "other-device-submission",
        answers: { mode: { selectedOptionIds: ["fast", "fast"], text: " saved text " } },
        acceptedAtMs: 1_800_000_000_001,
      },
    };
    if (operation === "notification") {
      client.emit({ method: "asyncQuestion/changed", params: { threadId, question: authoritative } });
    } else {
      await runtime.refreshAsyncQuestions();
    }
    await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [pending], loading: false,
      error: "The server returned an invalid async question list.",
    }));
    expect(client.calls.map(({ method }) => method)).toEqual(["asyncQuestion/list"]);

    authoritative = {
      ...authoritative,
      answer: { ...authoritative.answer!,
        answers: { mode: { selectedOptionIds: ["fast"], text: " saved text " } } },
    };
    await runtime.refreshAsyncQuestions();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [authoritative], loading: false, error: undefined,
    });
    expect(client.calls.map(({ method }) => method)).toEqual([
      "asyncQuestion/list", "asyncQuestion/list",
    ]);
  },
);


test.each([
  { name: "unknown value field", value: { selectedOptionIds: ["fast"], text: "valid", extra: true } },
  { name: "null unknown field", value: { selectedOptionIds: ["fast"], text: "valid", extra: null } },
  { name: "null selections", value: { selectedOptionIds: null, text: "valid" } },
  { name: "non-string text", value: { selectedOptionIds: ["fast"], text: 3 } },
  { name: "saved retry with unknown field", value: { selectedOptionIds: ["fast"], text: "valid", extra: true }, saved: true },
])("$name is rejected before dispatch or busy publication and permits a corrected explicit answer", async ({ value, saved }) => {
  const validAnswers = { mode: { selectedOptionIds: ["fast"], text: "valid" } };
  const submissionId = "stable-validated-submission";
  const pending = { ...baseQuestion, revision: 1 };
  const queued: AsyncQuestionRecord = { ...pending, revision: 2, status: "queued",
    answer: { submissionId, answers: validAnswers, acceptedAtMs: 1_800_000_000_001 } };
  const original = saved ? queued : pending;
  const client = new AsyncQuestionClient(true, () => original, () => ({
    threadId, question: queued, accepted: true, duplicate: Boolean(saved),
  }));
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  client.calls.length = 0;
  const listener = vi.fn();
  runtime.subscribe(listener);
  const request = { questionId: original.questionId, expectedRevision: original.revision, submissionId };
  await expect(runtime.answerAsyncQuestion({ ...request,
    answers: { mode: value } as NonNullable<AsyncQuestionRecord["answer"]>["answers"],
  })).rejects.toThrow("Select an option or enter a response for every question.");
  expect(client.calls).toEqual([]);
  expect(listener).not.toHaveBeenCalled();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [original], mutatingQuestionIds: [] });

  await expect(runtime.answerAsyncQuestion({ ...request, answers: validAnswers }))
    .resolves.toMatchObject({ accepted: true, duplicate: Boolean(saved), question: queued });
  expect(client.calls.map(({ method }) => method)).toEqual(["asyncQuestion/answer"]);
});


test.each([
  { name: "omitted selections", value: { text: "valid" } },
  { name: "null optional text", value: { selectedOptionIds: ["fast"], text: null } },
])("outbound validation preserves Rust defaults for $name", async ({ value }) => {
  const pending = { ...baseQuestion, revision: 1 };
  const client = new AsyncQuestionClient(true, () => pending, (params) => ({
    threadId, accepted: true, duplicate: false,
    question: { ...pending, revision: 2, status: "queued", answer: {
      submissionId: params.submissionId, answers: params.answers, acceptedAtMs: 1_800_000_000_001,
    } },
  }));
  const runtime = await resume(client);
  await runtime.refreshAsyncQuestions();
  client.calls.length = 0;
  await expect(runtime.answerAsyncQuestion({ questionId: pending.questionId, expectedRevision: 1,
    submissionId: "stable-defaults-submission", answers: { mode: value },
  })).resolves.toMatchObject({ accepted: true });
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0]).toMatchObject({ method: "asyncQuestion/answer", params: { answers: { mode: value } } });
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
});
