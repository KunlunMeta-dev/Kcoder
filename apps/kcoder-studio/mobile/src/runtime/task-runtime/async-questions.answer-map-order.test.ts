import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 2, createdAtMs: 1,
  status: "queued",
  questions: ["first", "second"].map(id => ({ id, header: id, question: `Choose ${id}`,
    multiSelect: true, options: ["one", "two"].map(id => ({ id, label: id, description: "" })) })),
  answer: { submissionId: "saved", acceptedAtMs: 2, answers: {
    second: { selectedOptionIds: ["two"], text: " original " },
    first: { selectedOptionIds: ["one", "two"] },
  } },
};
const reordered: AsyncQuestionRecord = { ...question, answer: { ...question.answer!, answers: {
  first: question.answer!.answers.first,
  second: question.answer!.answers.second,
} } };

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
  notify(value = reordered) {
    this.emit({ method: "asyncQuestion/changed", params: {
      threadId: question.threadId, question: structuredClone(value),
    } });
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
  client.reads = 0;
  return { runtime, client };
}

test("reordered saved-answer map replays cannot suspend cards or trigger list reads", async () => {
  const { runtime, client } = await fixture();
  const listener = vi.fn();
  runtime.subscribe(listener);
  for (let index = 0; index < 4; index++) {
    client.notify(index % 2 ? question : reordered);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(client.reads).toBe(0);
  expect(listener).not.toHaveBeenCalled();
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, error: undefined, questions: [question] });
});

test("a reordered replay cannot supersede a failed read with an unrequested trailing read", async () => {
  const { runtime, client } = await fixture();
  client.read = async () => {
    if (client.reads === 1) throw new Error("original read failed");
    return { threadId: question.threadId, questions: [question] };
  };
  const refreshing = runtime.refreshAsyncQuestions();
  client.notify();
  await refreshing;
  expect(client.reads).toBe(1);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ loading: false, error: "original read failed", questions: [question] });
});

test.each(["selection order", "text whitespace"])("map canonicalization still rejects changed %s at the same revision", async change => {
  const { runtime, client } = await fixture();
  const conflicting = structuredClone(reordered);
  if (change === "selection order") conflicting.answer!.answers.first.selectedOptionIds!.reverse();
  else conflicting.answer!.answers.second.text = "original";
  client.read = async () => { throw new Error("reconciliation unavailable"); };
  client.notify(conflicting);
  expect(runtime.getAsyncQuestionSnapshot().error).toContain("conflicting async question update");
  await vi.waitFor(() => expect(runtime.getAsyncQuestionSnapshot().loading).toBe(false));
  expect(client.reads).toBe(1);
  expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ error: "reconciliation unavailable", questions: [question] });
});
