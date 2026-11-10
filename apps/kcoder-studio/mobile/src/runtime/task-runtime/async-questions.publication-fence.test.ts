import { afterEach, expect, test, vi } from "vitest";
import { ensureGatewayAuthorization } from "@/gateway/http";
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

class QuestionClient extends FakeClient {
  readonly calls: string[] = [];
  saved = question;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean {
    return capability === "asyncUserQuestionsV1";
  }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return { threadId: question.threadId, questions: [this.saved] } as T;
    if (method === "asyncQuestion/answer" || method === "asyncQuestion/cancel") {
      this.saved = { ...question, revision: 2,
        status: method === "asyncQuestion/answer" ? "answer_saved" : "cancelled",
        ...(method === "asyncQuestion/answer" ? {
          answer: { submissionId: String(params.submissionId), answers, acceptedAtMs: 2 },
        } : {}),
      };
      return { threadId: question.threadId, question: this.saved,
        ...(method === "asyncQuestion/answer" ? { accepted: true, duplicate: false } : {}),
      } as T;
    }
    return super.request<T>(method, params);
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
  vi.mocked(ensureGatewayAuthorization).mockReset().mockResolvedValue(undefined);
});

async function fixture() {
  const client = new QuestionClient();
  let authorized = true;
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => authorized });
  runtimes.push(runtime);
  await runtime.refreshAsyncQuestions();
  client.calls.length = 0;
  return { runtime, client, revoke: () => { authorized = false; } };
}

function invoke(runtime: TaskRuntime, operation: "list" | "answer" | "cancel") {
  const input = { questionId: question.questionId, expectedRevision: question.revision };
  if (operation === "list") return runtime.refreshAsyncQuestions();
  if (operation === "cancel") return runtime.cancelAsyncQuestion(input);
  return runtime.answerAsyncQuestion({ ...input, submissionId: "submission-1", answers });
}

test.each(["list", "answer", "cancel"] as const)(
  "%s does not dispatch after a loading/busy subscriber revokes the current owner",
  async operation => {
    const { runtime, client, revoke } = await fixture();
    const unsubscribe = runtime.subscribe(() => { unsubscribe(); revoke(); });
    const result = await invoke(runtime, operation).then(value => ({ value, error: undefined }),
      error => ({ value: undefined, error }));
    expect(client.calls).toEqual([]);
    expect(client.saved).toEqual(question);
    expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
    expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
    if (operation !== "list") expect(result.error).toBeInstanceOf(Error);
  },
);

test.each(["list", "answer", "cancel"] as const)(
  "%s does not dispatch on the still-open socket when a loading/busy subscriber starts reconnect",
  async operation => {
    const { runtime, client } = await fixture();
    let release!: () => void;
    let reconnect: Promise<void> | undefined;
    vi.mocked(ensureGatewayAuthorization).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const unsubscribe = runtime.subscribe(() => { unsubscribe(); reconnect = runtime.reconnectNow(); });
    try {
      await invoke(runtime, operation).catch(() => {});
      expect(reconnect).toBeDefined();
      expect(runtime.getSnapshot()).toMatchObject({ connected: false, connectionPhase: "reconnecting" });
      expect(client.isTransportOpen()).toBe(true);
      expect(client.calls).toEqual([]);
      expect(client.saved).toEqual(question);
      expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
    } finally {
      runtime.close();
      release();
      await reconnect;
    }
  },
);

test.each(["answer", "cancel"] as const)("%s still settles while its published owner remains current", async operation => {
  const { runtime, client } = await fixture();
  const listener = vi.fn();
  runtime.subscribe(listener);
  await invoke(runtime, operation);
  expect(client.calls).toEqual([`asyncQuestion/${operation}`]);
  expect(client.saved.status).toBe(operation === "answer" ? "answer_saved" : "cancelled");
  expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([client.saved]);
  expect(runtime.getAsyncQuestionSnapshot().mutatingQuestionIds).toEqual([]);
  expect(listener).toHaveBeenCalled();
});
