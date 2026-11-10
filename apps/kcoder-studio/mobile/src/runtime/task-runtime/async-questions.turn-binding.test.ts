import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question-1", requestId: "request-1", threadId: "thread-1",
  sourceTurnId: "source-turn", toolCallId: "tool-1", revision: 1,
  createdAtMs: 1_800_000_000_000, status: "pending",
  questions: [{ id: "mode", header: "Mode", question: "Which mode?",
    options: [{ id: "fast", label: "Fast", description: "" }], multiSelect: false }],
};
const answers = { mode: { selectedOptionIds: ["fast"] } };
const saved: AsyncQuestionRecord = {
  ...question, revision: 2, status: "answer_saved",
  answer: { submissionId: "submission-1", answers, acceptedAtMs: question.createdAtMs + 1 },
};

class QuestionClient extends FakeClient {
  readonly calls: Array<{ method: string; params: JsonRecord }> = [];
  result: unknown;
  read?: () => Promise<unknown>;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean {
    return capability === "asyncUserQuestionsV1";
  }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: question.threadId, questions: [question] }) as T;
    if (method === "asyncQuestion/answer") return this.result as T;
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
  client.calls.length = 0;
  const answer = () => runtime.answerAsyncQuestion({ questionId: question.questionId,
    expectedRevision: question.revision, submissionId: "submission-1", answers });
  return { runtime, client, answer };
}

test.each([[true, false], [true, true], [false, false]])(
  "answer receipt rejects a foreign started turn before updating its card (accepted=%s, duplicate=%s)",
  async (accepted, duplicate) => {
    const { runtime, client, answer } = await fixture();
    client.result = { threadId: question.threadId, question: saved, accepted, duplicate,
      startedTurn: { threadId: "another-task", id: "foreign-turn", status: "running" } };
    let finishRead!: (value: unknown) => void;
    client.read = () => new Promise(resolve => { finishRead = resolve; });
    try {
      await expect(answer()).rejects.toThrow("invalid async question answer receipt");
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
        questions: [question], loading: true, mutatingQuestionIds: [],
      });
      expect(runtime.getSnapshot().running).toBe(false);
      expect(client.calls).toEqual([
        { method: "asyncQuestion/answer", params: { threadId: question.threadId,
          questionId: question.questionId, expectedRevision: 1, submissionId: "submission-1", answers } },
        { method: "asyncQuestion/list", params: { threadId: question.threadId, includeTerminal: true } },
      ]);
    } finally {
      // Complete the owned read even when the pre-fix assertion fails.
      finishRead?.({ threadId: question.threadId, questions: [saved] });
    }
    await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [saved], loading: false, mutatingQuestionIds: [],
    }));
    expect(client.calls.filter(call => call.method === "asyncQuestion/answer")).toHaveLength(1);
  },
);

test.each([undefined, null,
  { id: "answer-turn", status: "running" },
  { id: "answer-turn", status: "completed" },
  { id: "answer-turn", turnId: "answer-turn", status: "running" },
  { threadId: question.threadId, id: "answer-turn", status: "running" },
  { threadId: question.threadId, id: "answer-turn", status: "completed" },
])("answer receipt retains valid optional started turns %j", async startedTurn => {
  const { runtime, client, answer } = await fixture();
  client.result = { threadId: question.threadId, question: saved, accepted: true, duplicate: false,
    ...(startedTurn === undefined ? {} : { startedTurn }) };
  await expect(answer()).resolves.toMatchObject({ accepted: true, question: saved });
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [saved], mutatingQuestionIds: [] });
  expect(client.calls.map(call => call.method)).toEqual(["asyncQuestion/answer"]);
});

test.each(["peer-turn", "", null])("answer receipt rejects conflicting turn alias %j before settling the card", async turnId => {
  const { runtime, client, answer } = await fixture();
  client.result = { threadId: question.threadId, question: saved, accepted: true, duplicate: false,
    startedTurn: { threadId: question.threadId, id: "answer-turn", turnId, status: "running" } };
  let finishRead!: (value: unknown) => void;
  client.read = () => new Promise(resolve => { finishRead = resolve; });
  try {
    await expect(answer()).rejects.toThrow("invalid async question answer receipt");
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], mutatingQuestionIds: [] });
    expect(client.calls.map(call => call.method)).toEqual(["asyncQuestion/answer", "asyncQuestion/list"]);
  } finally {
    finishRead?.({ threadId: question.threadId, questions: [saved] });
  }
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [saved], loading: false }));
});

test("answer receipt accepts a matching legacy turn alias", async () => {
  const { runtime, client, answer } = await fixture();
  client.result = { threadId: question.threadId, question: saved, accepted: true, duplicate: false,
    startedTurn: { threadId: question.threadId, id: "answer-turn", turnId: "answer-turn", status: "running" } };
  await expect(answer()).resolves.toMatchObject({ accepted: true, question: saved });
  expect(client.calls.map(call => call.method)).toEqual(["asyncQuestion/answer"]);
});

test.each([
  { status: "running" },
  { id: "answer-turn", status: "unknown" },
  { id: "answer-turn", turnId: "peer-turn", status: "running" },
])("legacy task omission still rejects an invalid started turn %j", async startedTurn => {
  const { runtime, client, answer } = await fixture();
  client.result = { threadId: question.threadId, question: saved, accepted: true, duplicate: false, startedTurn };
  let finishRead!: (value: unknown) => void;
  client.read = () => new Promise(resolve => { finishRead = resolve; });
  try {
    await expect(answer()).rejects.toThrow("invalid async question answer receipt");
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], mutatingQuestionIds: [] });
    expect(client.calls.map(call => call.method)).toEqual(["asyncQuestion/answer", "asyncQuestion/list"]);
  } finally {
    finishRead?.({ threadId: question.threadId, questions: [saved] });
  }
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [saved], loading: false }));
});

test.each(['', '   '].flatMap(id => [false, true].map(explicitTask => ({ id, explicitTask })) ))(
  "a blank canonical turn ID cannot confirm the card ($id, explicit task=$explicitTask)",
  async ({ id, explicitTask }) => {
    const { runtime, client, answer } = await fixture();
    client.result = { threadId: question.threadId, question: saved, accepted: true, duplicate: false,
      startedTurn: { id, status: "running", ...(explicitTask ? { threadId: question.threadId } : {}) } };
    let finishRead!: (value: unknown) => void;
    client.read = () => new Promise(resolve => { finishRead = resolve; });
    try {
      await expect(answer()).rejects.toThrow("invalid async question answer receipt");
      expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], mutatingQuestionIds: [] });
      expect(client.calls.map(call => call.method)).toEqual(["asyncQuestion/answer", "asyncQuestion/list"]);
    } finally {
      finishRead?.({ threadId: question.threadId, questions: [saved] });
    }
    await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [saved], loading: false }));
    expect(client.calls.filter(call => call.method === "asyncQuestion/answer")).toHaveLength(1);
  },
);
