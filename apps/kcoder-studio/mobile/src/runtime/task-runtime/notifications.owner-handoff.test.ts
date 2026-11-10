import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { appServerId, FakeClient, profile, server } from "./fixture.test-support";
import { bufferNotifications } from "./notificationBuffer";
import type { AsyncQuestionRecord } from "./types";
import { isAsyncQuestionChangedNotification } from "../../../../shared/generated/contracts";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const question: AsyncQuestionRecord = {
  questionId: "question", requestId: "request", threadId: "thread-1",
  sourceTurnId: "source", toolCallId: "tool", revision: 1, createdAtMs: 1,
  status: "pending", questions: [{ id: "item", header: "Mode", question: "Which mode?",
    multiSelect: false, options: [] }],
};
const cancelled: AsyncQuestionRecord = { ...question, revision: 2, status: "cancelled" };

class QuestionClient extends FakeClient {
  record = question;
  calls: string[] = [];
  constructor() { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "asyncQuestion/list") return { threadId: question.threadId, questions: [this.record] } as T;
    return super.request<T>(method, params);
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

for (const kind of ["asyncQuestion/changed", "question/request", "approval/request"] as const) {
  for (const mode of ["live", "buffered"] as const) {
    test.each(["replace", "close"] as const)(
      `${mode} ${kind} stops if a protocol observer %ss its original connection`, async handoff => {
        const original = new QuestionClient(), replacement = new QuestionClient();
        taskRuntimeTestHelpers.setConnector((async () => original as never) as never);
        const runtime = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
          profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
        runtimes.push(runtime);
        await runtime.refreshAsyncQuestions();
        original.calls.length = 0;
        const message: RpcMessage = { method: kind,
          ...(kind === "asyncQuestion/changed" ? {} : { id: 2000001 }),
          params: kind === "asyncQuestion/changed" ? { threadId: question.threadId, question: cancelled }
            : { serverId: appServerId, threadId: question.threadId, turnId: "source",
              appServerEpoch: "original-epoch", sequence: 42,
              ...(kind === "question/request" ? { questionId: "blocking-question", questions: [
                { id: "item", prompt: "Choose", options: [] },
              ] } : { approvalId: "approval", action: { type: "command", command: "echo owned" } }),
          },
        };
        if (kind === "asyncQuestion/changed") expect(isAsyncQuestionChangedNotification(message.params)).toBe(true);
        const stop = runtime.subscribeProtocol(() => {
          stop();
          if (handoff === "close") runtime.close();
          else runtime.attachClient(replacement as never);
        });
        if (mode === "buffered") {
          runtime.unsubscribeRpc?.();
          runtime.unsubscribeRpc = null;
          const buffered = bufferNotifications(original as never);
          original.emit(message);
          runtime.attachBufferedClient(original as never, buffered);
        } else original.emit(message);

        // The old frame cannot acquire the replacement generation's authority
        // or publish a question after the task has already been closed.
        expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([question]);
        expect(runtime.pendingInteractions).toEqual([]);
        expect(original.calls).toEqual([]);
        expect(replacement.calls).toEqual([]);
        if (handoff === "replace") {
          // Discarded frames must leave their replay identity available for
          // the original task's current connection, including a new card.
          replacement.record = cancelled;
          replacement.emit(structuredClone(message));
          if (kind === "asyncQuestion/changed") {
            await runtime.refreshAsyncQuestions();
            expect(runtime.getAsyncQuestionSnapshot().questions).toEqual([cancelled]);
          } else {
            expect(runtime.pendingInteractions).toHaveLength(1);
            expect(runtime.pendingInteractions[0].owner.originClientGeneration).toBe(runtime.clientGeneration);
          }
          replacement.emit(structuredClone(message));
          expect(runtime.pendingInteractions).toHaveLength(kind === "asyncQuestion/changed" ? 0 : 1);
        }
      },
    );
  }
}
