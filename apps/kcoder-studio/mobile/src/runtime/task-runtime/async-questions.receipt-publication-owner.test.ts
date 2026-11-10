import { afterEach, expect, test, vi } from "vitest";
import { ensureGatewayAuthorization } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import type { AsyncQuestionRecord } from "./types";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 1, createdAtMs: 1,
  status: "pending", questions: [
    { id: "item", header: "Note", question: "Any details?", multiSelect: false, options: [] },
  ],
};
const answers = { item: { text: "Keep the original answer" } };

class QuestionClient extends FakeClient {
  calls: string[] = [];
  saved = question;
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
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

for (const operation of ["answer", "cancel"] as const) {
  test.each(["receipt", "busy release"] as const)(
    `${operation} cannot confirm input after a %s subscriber starts reconnect`, async publication => {
      const client = new QuestionClient();
      taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
      const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
        profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
      runtimes.push(runtime);
      await runtime.refreshAsyncQuestions();
      client.calls = [];
      let release!: () => void;
      let reconnect: Promise<void> | undefined;
      vi.mocked(ensureGatewayAuthorization).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      const unsubscribe = runtime.subscribe(() => {
        const snapshot = runtime.getAsyncQuestionSnapshot();
        if (snapshot.questions[0]?.status === "pending" ||
            (publication === "busy release" && snapshot.mutatingQuestionIds.length > 0)) return;
        unsubscribe();
        reconnect = runtime.reconnectNow();
      });
      try {
        const input = { questionId: question.questionId, expectedRevision: 1 };
        const mutation = operation === "answer"
          ? runtime.answerAsyncQuestion({ ...input, submissionId: "original", answers })
          : runtime.cancelAsyncQuestion(input);
        const outcome = await mutation.then(value => ({ value, error: undefined }),
          error => ({ value: undefined, error }));
        expect(reconnect).toBeDefined();
        expect(runtime.getSnapshot()).toMatchObject({ connected: false, connectionPhase: "reconnecting" });
        expect(outcome.error).toMatchObject({ message: expect.stringContaining("task owner changed") });
        expect(outcome.value).toBeUndefined();
        // A lost presentation owner does not undo the target's saved fact.
        expect(runtime.getAsyncQuestionSnapshot()).toMatchObject({ questions: [client.saved], mutatingQuestionIds: [] });
        expect(client.calls).toEqual([`asyncQuestion/${operation}`]);
      } finally {
        unsubscribe();
        runtime.close();
        release?.();
        await reconnect;
      }
    },
  );
}
