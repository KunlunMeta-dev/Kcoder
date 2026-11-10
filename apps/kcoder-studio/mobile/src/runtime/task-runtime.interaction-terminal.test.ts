import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { selectorForInteraction } from "./task-runtime/interactions";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(kind: "question" | "approval") {
  const client = new FakeClient([]);
  const reads: Array<() => void> = [];
  const request = client.request.bind(client);
  client.supportsExperimental = (capability) => capability === "interactionStatusReadV1";
  client.request = <T,>(method: string, params: JsonRecord = {}): Promise<T> => {
    if (method === "interaction/status/read") return new Promise((resolve) => {
      // Capture a real pending status before the terminal event, then delay
      // transport delivery until after the turn has ended.
      reads.push(() => resolve({ ...params, status: "pending" } as T));
    });
    return request<T>(method, params);
  };
  client.respond = vi.fn();
  taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
  const runtime = await TaskRuntime.resume({
    profile, server, threadId: "thread-1", profileActivationEpoch: 1,
    isCurrentInteractionOwner: () => true,
  });
  runtimes.push(runtime);
  const prompt = (turnId: string, id = 41) => client.emit({
    id, method: `${kind}/request`, params: {
      serverId: client.getAppServerId(), threadId: "thread-1", turnId,
      appServerEpoch: "epoch-1",
      ...(kind === "question"
        ? { questionId: `question-${id}`, questions: [{ id: "choice", prompt: "Which?", options: [] }] }
        : { approvalId: `approval-${id}`, action: { type: "command", command: "echo fixture" } }),
    },
  });
  const complete = (status: string) => client.emit({
    method: "turn/completed", params: {
      threadId: "thread-1", turnId: "old-turn", turn: { id: "old-turn", status },
    },
  });
  return { client, runtime, reads, prompt, complete };
}

for (const kind of ["question", "approval"] as const) {
  test.each(["completed", "failed", "cancelled", "interrupted"])(
    `${kind}: a delayed pending receipt cannot reopen a %s turn's card`,
    async (status) => {
      const f = await fixture(kind);
      f.prompt("old-turn");
      const selector = selectorForInteraction(f.runtime.pendingInteractions[0]!);
      const changed = vi.fn();
      f.runtime.setInteractionLedgerObserver({
        ownerFor: () => undefined, wasResolved: () => false,
        changed, resolved: vi.fn(),
      });
      const reconcile = f.runtime.reconcilePendingInteractions(true);
      expect(f.reads).toHaveLength(1);
      f.complete(status);
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ turnEnded: true }), false);
      f.reads.splice(0).forEach((finish) => finish());
      await reconcile;
      await Promise.resolve();

      // Missing terminal interaction receipts stay readable, never fabricated
      // as successful answers or cancellations.
      expect(f.runtime.pendingInteractions).toHaveLength(1);
      expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[0]!)).toBe(false);
      expect(f.runtime.getSnapshot()).toMatchObject({ interaction: null, interactionCount: 0 });
      expect(() => kind === "question"
        ? f.runtime.respondQuestions({ choice: ["yes"] }, selector)
        : f.runtime.respondApproval("accept", selector)).toThrow(/失效|只支持核对/);
      expect(f.client.respond).not.toHaveBeenCalled();
      f.prompt("old-turn");
      expect(f.runtime.getSnapshot()).toMatchObject({ interaction: null, interactionCount: 0 });

      f.client.emit({ method: `${kind}/resolved`, params: {
        threadId: "thread-1", turnId: "old-turn", appServerEpoch: "epoch-1",
        reason: "client_response",
        requestId: 41, ...(kind === "question" ? { questionId: "question-41" } : { approvalId: "approval-41" }),
      } });
      expect(f.runtime.pendingInteractions).toHaveLength(0);
    },
  );

  test(`${kind}: an older turn ending preserves the newer turn's interaction`, async () => {
    const f = await fixture(kind);
    f.prompt("old-turn");
    f.client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "new-turn" } });
    f.prompt("new-turn", 42);
    f.complete("completed");
    expect(f.runtime.getSnapshot()).toMatchObject({
      running: true, activeTurnId: "new-turn", interactionCount: 1,
      interaction: { requestId: 42 },
    });
    expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[0]!)).toBe(false);
    expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[1]!)).toBe(true);
  });

  test(`${kind}: a fresh attempt can ask a new question without reopening the old request`, async () => {
    const f = await fixture(kind);
    f.prompt("old-turn");
    f.complete("failed");
    f.reads.splice(0).forEach((finish) => finish());
    await Promise.resolve();
    f.client.emit({ method: "turn/started", params: {
      threadId: "thread-1", turnId: "old-turn", attemptId: "retry-attempt",
    } });
    f.prompt("old-turn", 42);
    expect(f.runtime.getSnapshot()).toMatchObject({
      running: true, interactionCount: 1, interaction: { requestId: 42 },
    });
    expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[0]!)).toBe(false);
    expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[1]!)).toBe(true);
  });

  test.each(["completed", "failed", "cancelled", "interrupted"])(
    `${kind}: an ended %s turn releases only its focused card and reveals the next request`,
    async (status) => {
      const f = await fixture(kind);
      f.prompt("old-turn");
      const selector = selectorForInteraction(f.runtime.pendingInteractions[0]!);
      f.runtime.focusInteraction(selector);
      f.complete(status);
      f.client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "new-turn" } });
      f.prompt("new-turn", 42);

      // Preserve the unknown original receipt, but never let its obsolete
      // composer focus hide a different turn's actionable card.
      expect(f.runtime.pendingInteractions).toHaveLength(2);
      expect(f.runtime.pendingInteractions[0]?.turnEnded).toBe(true);
      expect(f.runtime.focusedInteractionSelector).toBeNull();
      expect(f.runtime.getSnapshot()).toMatchObject({
        interactionCount: 1, interaction: { requestId: 42 },
      });
      expect(() => kind === "question"
        ? f.runtime.respondQuestions({ choice: ["old answer"] }, selector)
        : f.runtime.respondApproval("accept", selector)).toThrow(/失效|只支持核对/);
      expect(f.client.respond).not.toHaveBeenCalled();
      if (kind === "question") f.runtime.respondQuestions({ choice: ["next answer"] });
      else f.runtime.respondApproval("accept");
      expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(42, kind === "question"
        ? { answers: { choice: { answers: ["next answer"] } } }
        : { decision: "accept" });
    },
  );

  test(`${kind}: an older turn ending does not release a newer request's explicit focus`, async () => {
    const f = await fixture(kind);
    f.prompt("old-turn");
    f.client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "new-turn" } });
    f.prompt("new-turn", 42);
    const selector = selectorForInteraction(f.runtime.pendingInteractions[1]!);
    f.runtime.focusInteraction(selector);
    f.complete("completed");
    expect(f.runtime.focusedInteractionSelector).toEqual(selector);
    expect(f.runtime.getSnapshot()).toMatchObject({ interactionCount: 1, interaction: { requestId: 42 } });
    expect(f.client.respond).not.toHaveBeenCalled();
  });
}
