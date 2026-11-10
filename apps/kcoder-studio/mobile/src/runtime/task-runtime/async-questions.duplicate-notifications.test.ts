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
  authoritative = question;
  read?: () => Promise<unknown>;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    if (method !== "asyncQuestion/list") return super.request<T>(method, params);
    this.reads++;
    return (this.read ? await this.read() : { threadId: question.threadId, questions: [this.authoritative] }) as T;
  }
  notify(value = this.authoritative) {
    this.emit({ method: "asyncQuestion/changed", params: { threadId: question.threadId, question: structuredClone(value) } });
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(authoritative = question) {
  const client = new QuestionClient();
  client.authoritative = authoritative;
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.reads = 0;
  return { runtime, client };
}

test("serial duplicate notifications do not refetch the list or publish loading state", async () => {
  const { runtime, client } = await fixture();
  const snapshots: boolean[] = [];
  runtime.listeners.add(() => snapshots.push(runtime.getAsyncQuestionSnapshot().loading));
  for (let index = 0; index < 20; index++) {
    client.notify();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(client.reads).toBe(0);
  expect(snapshots).toEqual([]);
  client.authoritative = { ...question, revision: 2, status: "cancelled" };
  client.notify();
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(client.reads).toBe(1);
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([client.authoritative]);
});

test("a duplicate during a refresh cannot discard its failure or schedule a trailing read", async () => {
  const { runtime, client } = await fixture();
  let fail!: (reason: Error) => void;
  client.read = () => new Promise((_, reject) => { fail = reject; });
  const refreshing = runtime.refreshAsyncQuestions();
  client.notify();
  fail(new Error("original list unavailable"));
  await new Promise<void>(resolve => setImmediate(resolve));
  // Settle any pre-fix trailing work before asserting, keeping this test owned.
  if (client.reads > 1) fail(new Error("unexpected trailing read"));
  await refreshing;
  expect(client.reads).toBe(1);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    loading: false, questions: [question], error: "original list unavailable",
  });
});

test("same-revision conflicting content still reconciles the authoritative list", async () => {
  const { runtime, client } = await fixture();
  client.notify({ ...question, questions: [{ ...question.questions[0], question: "Conflicting content" }] });
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(client.reads).toBe(1);
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
});

test("duplicates preserve a visible read error while explicit refresh can recover", async () => {
  const { runtime, client } = await fixture();
  client.read = async () => { throw new Error("list unavailable"); };
  await runtime.refreshAsyncQuestions();
  client.notify();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(client.reads).toBe(1);
  expect(runtime.getAsyncQuestionSnapshot().error).toBe("list unavailable");
  client.read = undefined;
  await runtime.refreshAsyncQuestions();
  expect(client.reads).toBe(2);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, error: undefined, questions: [question] });
});


test("out-of-order older notifications do not refetch or publish over a newer terminal record", async () => {
  const latest: AsyncQuestionRecord = { ...question, revision: 3, status: "cancelled" };
  const { runtime, client } = await fixture(latest);
  const listener = vi.fn();
  runtime.subscribe(listener);
  for (let index = 0; index < 20; index++) {
    client.notify(question);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(client.reads).toBe(0);
  expect(listener).not.toHaveBeenCalled();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, questions: [latest] });
});

test("an older notification cannot supersede an in-flight read and discard its original failure", async () => {
  const latest: AsyncQuestionRecord = { ...question, revision: 3, status: "cancelled" };
  const { runtime, client } = await fixture(latest);
  let fail!: (reason: Error) => void;
  client.read = () => new Promise((_, reject) => { fail = reject; });
  const refreshing = runtime.refreshAsyncQuestions();
  client.notify(question);
  fail(new Error("current list unavailable"));
  await new Promise<void>(resolve => setImmediate(resolve));
  // Settle pre-fix trailing work so the regression owns every pending read.
  if (client.reads > 1) fail(new Error("unexpected stale-event read"));
  await refreshing;
  expect(client.reads).toBe(1);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({
    loading: false, questions: [latest], error: "current list unavailable",
  });
});

test("older replays preserve a visible failure while a genuinely newer revision still reconciles", async () => {
  const latest: AsyncQuestionRecord = { ...question, revision: 3, status: "queued",
    answer: { submissionId: "winner", answers: { item: { selectedOptionIds: ["fast"] } }, acceptedAtMs: 2 } };
  const { runtime, client } = await fixture(latest);
  client.read = async () => { throw new Error("original read failed"); };
  await runtime.refreshAsyncQuestions();
  const listener = vi.fn();
  runtime.subscribe(listener);
  client.notify(question);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(client.reads).toBe(1);
  expect(listener).not.toHaveBeenCalled();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [latest], error: "original read failed" });

  client.read = undefined;
  client.authoritative = { ...latest, revision: 4, status: "context_applied" };
  client.notify();
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(client.reads).toBe(2);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [client.authoritative], error: undefined });
});
