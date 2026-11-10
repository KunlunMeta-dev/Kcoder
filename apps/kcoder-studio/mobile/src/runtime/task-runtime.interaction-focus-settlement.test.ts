import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { selectorForInteraction } from "./task-runtime/interactions";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(kind: "question" | "approval") {
  const client = new FakeClient([]);
  const request = client.request.bind(client);
  let finishRead!: (status: string) => void;
  client.supportsExperimental = capability => capability === "interactionStatusReadV1";
  client.request = <T,>(method: string, params: JsonRecord = {}): Promise<T> => {
    if (method !== "interaction/status/read") return request<T>(method, params);
    return new Promise(resolve => {
      finishRead = status => resolve({ ...params, status } as T);
    });
  };
  client.respond = vi.fn();
  client.respondError = vi.fn();
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  const prompt = (id: number, turnId: string) => client.emit({ id, method: `${kind}/request`, params: {
    serverId: client.getAppServerId(), threadId: "thread-1", turnId, appServerEpoch: "epoch-1",
    ...(kind === "question"
      ? { questionId: `question-${id}`, questions: [{ id: "choice", prompt: "Which?", options: [] }] }
      : { approvalId: `approval-${id}`, action: { type: "command", command: "echo fixture" } }),
  } });
  prompt(41, "old-turn");
  const reconcile = runtime.reconcilePendingInteractions(true);
  // The pending status read makes the original card read-only until authority
  // is known. Selecting it exposes the same warning used by the composer.
  expect(runtime.focusInteraction(selectorForInteraction(runtime.pendingInteractions[0]!))).toBe("readOnly");
  prompt(42, "new-turn");
  client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "new-turn" } });
  return { client, runtime, reconcile, finish: (status: string) => finishRead(status) };
}

for (const kind of ["question", "approval"] as const) {
  for (const outcome of ["notification", "receipt", "terminal"] as const) {
    test(`${kind}: ${outcome} clears the settled focus warning and leaves the next request usable`, async () => {
      const f = await fixture(kind);
      if (outcome === "receipt") f.finish("resolved");
      else {
        f.client.emit(outcome === "notification" ? { method: `${kind}/resolved`, params: {
          threadId: "thread-1", turnId: "old-turn", appServerEpoch: "epoch-1", requestId: 41, reason: "client_response",
          ...(kind === "question" ? { questionId: "question-41" } : { approvalId: "approval-41" }),
        } } : { method: "turn/completed", params: { threadId: "thread-1", turnId: "old-turn",
          turn: { id: "old-turn", status: "completed" } } });
        f.finish("pending");
      }
      await f.reconcile;
      expect(f.runtime.focusedInteractionSelector).toBeNull();
      expect(f.runtime.getSnapshot().interactionFocusStatus).toBeUndefined();
      expect(f.runtime.getSnapshot()).toMatchObject({ interaction: { requestId: 42 }, interactionCount: 1 });
      expect(f.client.respond).not.toHaveBeenCalled();
      if (kind === "question") f.runtime.respondQuestions({ choice: ["next answer"] });
      else f.runtime.respondApproval("accept");
      expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(42, kind === "question"
        ? { answers: { choice: { answers: ["next answer"] } } } : { decision: "accept" });
    });

    test(`${kind}: ${outcome} preserves another request's selected read-only warning`, async () => {
      const f = await fixture(kind);
      f.runtime.markInteractionsDisconnected();
      const peer = selectorForInteraction(f.runtime.pendingInteractions[1]!);
      expect(f.runtime.focusInteraction(peer)).toBe("readOnly");
      if (outcome === "receipt") f.finish("resolved");
      else {
        f.client.emit(outcome === "notification" ? { method: `${kind}/resolved`, params: {
          threadId: "thread-1", turnId: "old-turn", appServerEpoch: "epoch-1", requestId: 41, reason: "client_response",
          ...(kind === "question" ? { questionId: "question-41" } : { approvalId: "approval-41" }),
        } } : { method: "turn/completed", params: { threadId: "thread-1", turnId: "old-turn",
          turn: { id: "old-turn", status: "completed" } } });
        f.finish("pending");
      }
      await f.reconcile;
      expect(f.runtime.focusedInteractionSelector).toEqual(peer);
      expect(f.runtime.getSnapshot()).toMatchObject({ interactionFocusStatus: "readOnly", interaction: null });
      expect(f.client.respond).not.toHaveBeenCalled();
      expect(f.client.respondError).not.toHaveBeenCalled();
    });
  }
}
