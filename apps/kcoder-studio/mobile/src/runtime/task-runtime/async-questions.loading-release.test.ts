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

class QuestionClient extends FakeClient {
  reads = 0;
  read?: () => Promise<unknown>;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    if (method !== "asyncQuestion/list") return super.request<T>(method, params);
    this.reads++;
    return (this.read ? await this.read() : { threadId: question.threadId, questions: [question] }) as T;
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture() {
  const client = new QuestionClient();
  let authorized = true;
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => authorized });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.reads = 0;
  return { runtime, client, authorize: (value: boolean) => { authorized = value; } };
}

test("a refresh invalidated by its loading subscriber releases loading without sending an RPC", async () => {
  const { runtime, client, authorize } = await fixture();
  const unsubscribe = runtime.subscribe(() => { unsubscribe(); authorize(false); });
  await runtime.refreshAsyncQuestions();
  expect(client.reads).toBe(0);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, questions: [question] });
  authorize(true);
  await runtime.refreshAsyncQuestions();
  expect(client.reads).toBe(1);
  expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false);
});

test.each([false, true])("a settled stale list releases loading and retains cards (read fails=%s)", async fails => {
  const { runtime, client, authorize } = await fixture();
  let finish!: () => void;
  client.read = () => new Promise((resolve, reject) => {
    finish = () => fails ? reject(new Error("old owner read failed"))
      : resolve({ threadId: question.threadId, questions: [] });
  });
  const read = runtime.refreshAsyncQuestions();
  const queued = runtime.refreshAsyncQuestions();
  expect(runtime.getAsyncQuestionSnapshot().loading).toBe(true);
  authorize(false);
  finish();
  await Promise.all([read, queued]);
  expect(client.reads).toBe(1);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, questions: [question], error: undefined });
});

test.each([false, true])("an old read cannot release the replacement read's loading (old finishes first=%s)", async oldFirst => {
  const { runtime, client } = await fixture();
  let finishOld!: (value: unknown) => void;
  client.read = () => new Promise(resolve => { finishOld = resolve; });
  const oldRead = runtime.refreshAsyncQuestions();
  const replacement = new QuestionClient();
  let finishNew!: (value: unknown) => void;
  replacement.read = () => new Promise(resolve => { finishNew = resolve; });
  runtime.attachClient(replacement as never);
  const newRead = runtime.refreshAsyncQuestions();
  const latest = { ...question, revision: 2, status: "cancelled" as const };
  if (oldFirst) {
    finishOld({ threadId: question.threadId, questions: [] });
    await oldRead;
    expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: true, questions: [question] });
  }
  finishNew({ threadId: question.threadId, questions: [latest] });
  await newRead;
  if (!oldFirst) {
    finishOld({ threadId: question.threadId, questions: [] });
    await oldRead;
  }
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, questions: [latest] });
  expect(client.reads).toBe(1);
  expect(replacement.reads).toBe(1);
});
