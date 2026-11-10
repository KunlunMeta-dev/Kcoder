import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionAnswerPayload, AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const limit = 16 * 1024;
const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 1, createdAtMs: 1,
  status: "pending", questions: [
    { id: "mode", header: "Mode", question: "Which mode?", multiSelect: false,
      options: [{ id: "fast", label: "Fast", description: "" }] },
    { id: "note", header: "Note", question: "Any details?", multiSelect: false, options: [] },
  ],
};

// State serializes AsyncQuestionAnswerValue after serde has applied these
// defaults. Keep the fixture's server receipt faithful to that wire shape.
function persisted(answers: AsyncQuestionAnswerPayload): AsyncQuestionAnswerPayload {
  return Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, {
    selectedOptionIds: value.selectedOptionIds ?? [],
    ...(value.text == null ? {} : { text: value.text }),
  }]));
}

function boundaryAnswer(bytes: number, unit: string, nullText: boolean): AsyncQuestionAnswerPayload {
  const answers: AsyncQuestionAnswerPayload = {
    mode: { selectedOptionIds: ["fast"], ...(nullText ? { text: null } : {}) },
    note: { ...(nullText ? { selectedOptionIds: [] } : {}), text: "" },
  };
  const remaining = bytes - Buffer.byteLength(JSON.stringify(persisted(answers)));
  const unitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2;
  answers.note.text = unit.repeat(Math.floor(remaining / unitBytes)) + "a".repeat(remaining % unitBytes);
  expect(Buffer.byteLength(JSON.stringify(persisted(answers)))).toBe(bytes);
  return answers;
}

class QuestionClient extends FakeClient {
  calls: string[] = [];
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return { threadId: question.threadId, questions: [question] } as T;
    if (method === "asyncQuestion/answer") {
      const answers = persisted(params.answers as AsyncQuestionAnswerPayload);
      if (Buffer.byteLength(JSON.stringify(answers)) > limit)
        throw new Error("async answer exceeds its size limit");
      return {
        threadId: question.threadId, accepted: true, duplicate: false,
        question: { ...question, revision: 2, status: "answer_saved", answer: {
          submissionId: params.submissionId, acceptedAtMs: 2, answers,
        } },
      } as T;
    }
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

for (const [name, unit] of [["ASCII", "a"], ["Unicode", "中😀"], ["JSON escaping", '\"\n']] as const) {
  test(`${name}: omitted selection defaults count toward the State budget before busy state or dispatch`, async () => {
    const { runtime, client } = await fixture();
    const answers = boundaryAnswer(limit + 1, unit, false);
    expect(Buffer.byteLength(JSON.stringify(answers))).toBeLessThan(limit);
    const listener = vi.fn();
    runtime.subscribe(listener);
    await expect(runtime.answerAsyncQuestion({ questionId: question.questionId,
      expectedRevision: 1, submissionId: "submission", answers })).rejects.toThrow("too long");
    expect(client.calls).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], mutatingQuestionIds: [] });
  });

  test(`${name}: null text does not reject an answer at the persisted State budget`, async () => {
    const { runtime, client } = await fixture();
    const answers = boundaryAnswer(limit, unit, true);
    expect(Buffer.byteLength(JSON.stringify(answers))).toBeGreaterThan(limit);
    const original = structuredClone(answers);
    await expect(runtime.answerAsyncQuestion({ questionId: question.questionId,
      expectedRevision: 1, submissionId: "submission", answers })).resolves.toMatchObject({ accepted: true });
    expect(answers).toEqual(original);
    expect(client.calls).toEqual(["asyncQuestion/answer"]);
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
      questions: [{ status: "answer_saved", answer: { submissionId: "submission" } }], mutatingQuestionIds: [],
    });
  });
}
