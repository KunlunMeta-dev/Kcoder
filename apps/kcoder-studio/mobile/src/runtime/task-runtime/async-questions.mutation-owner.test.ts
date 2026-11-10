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
const input = { questionId: question.questionId, expectedRevision: 1 };
type Operation = "answer" | "cancel";

class QuestionClient extends FakeClient {
  readonly mutations: string[] = [];
  pending?: { resolve(value: unknown): void; reject(error: Error): void };
  readError = false;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    if (method === "asyncQuestion/list") {
      if (this.readError) throw new Error("recovery read failed");
      return { threadId: question.threadId, questions: [question] } as T;
    }
    if (method === "asyncQuestion/answer" || method === "asyncQuestion/cancel") {
      this.mutations.push(method);
      return new Promise<T>((resolve, reject) => { this.pending = { resolve: value => resolve(value as T), reject }; });
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
  return { runtime, client };
}

function mutate(runtime: TaskRuntime, operation: Operation) {
  const promise = operation === "answer"
    ? runtime.answerAsyncQuestion({ ...input, submissionId: "original-submission", answers })
    : runtime.cancelAsyncQuestion(input);
  return promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
}

function receipt(operation: Operation) {
  return { threadId: question.threadId, ...(operation === "answer" ? { accepted: true, duplicate: false } : {}),
    question: { ...question, revision: 2, status: operation === "answer" ? "answer_saved" : "cancelled",
      ...(operation === "answer" ? { answer: { submissionId: "original-submission", answers, acceptedAtMs: 2 } } : {}) } };
}

for (const oldOperation of ["answer", "cancel"] as const) {
  for (const newOperation of ["answer", "cancel"] as const) {
    for (const oldFails of [false, true]) {
      test(`recovered ${newOperation} owns its busy flag after stale ${oldOperation} settles (fails=${oldFails})`, async () => {
        const { runtime, client } = await fixture();
        const oldMutation = mutate(runtime, oldOperation);
        expect(client.mutations).toEqual([`asyncQuestion/${oldOperation}`]);
        const replacement = new QuestionClient();
        runtime.attachClient(replacement as never);
        await runtime.refreshAsyncQuestions();
        expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
        expect(replacement.mutations, "readback never replays a mutation").toEqual([]);

        const newMutation = mutate(runtime, newOperation);
        expect(replacement.mutations).toEqual([`asyncQuestion/${newOperation}`]);
        if (oldFails) client.pending!.reject(new Error("old transport lost"));
        else client.pending!.resolve(receipt(oldOperation));
        expect((await oldMutation).error).toBeInstanceOf(Error);
        expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [question], mutatingQuestionIds: [question.questionId] });
        expect((await mutate(runtime, newOperation)).error?.message).toContain("in progress");
        expect(replacement.mutations).toHaveLength(1);
        replacement.pending!.resolve(receipt(newOperation));
        expect((await newMutation).error).toBeUndefined();
        expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
      });
    }
  }
}

test("failed reconnect readback keeps input closed until an authoritative snapshot recovers", async () => {
  const { runtime, client } = await fixture();
  const oldMutation = mutate(runtime, "answer");
  const replacement = new QuestionClient();
  replacement.readError = true;
  taskRuntimeTestHelpers.setConnector((async () => replacement as never) as never);
  await runtime.reconnectNow();
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().error).toBe("recovery read failed");
  expect((await mutate(runtime, "answer")).error?.message).toContain("no longer current");
  expect(replacement.mutations).toEqual([]);
  replacement.readError = false;
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ error: undefined, mutatingQuestionIds: [] });
  client.pending!.resolve(receipt("answer"));
  expect((await oldMutation).error).toBeInstanceOf(Error);
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
});

test("a refresh on the same live connection keeps its pending mutation locked", async () => {
  const { runtime, client } = await fixture();
  const pending = mutate(runtime, "answer");
  await runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([question.questionId]);
  expect((await mutate(runtime, "cancel")).error?.message).toContain("in progress");
  expect(client.mutations).toEqual(["asyncQuestion/answer"]);
  client.pending!.resolve(receipt("answer"));
  expect((await pending).error).toBeUndefined();
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
});
