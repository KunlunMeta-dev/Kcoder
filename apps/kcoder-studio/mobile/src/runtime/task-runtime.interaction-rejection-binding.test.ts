import { afterEach, expect, test, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { selectorForInteraction } from "./task-runtime/interactions";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(kind: "question" | "approval") {
  const client = new FakeClient([]);
  client.respond = vi.fn();
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  const binding = { threadId: "thread-1", turnId: "current-turn", appServerEpoch: "current-epoch",
    ...(kind === "question" ? { questionId: "current-question" } : { approvalId: "current-approval" }) };
  client.emit({ id: 41, method: `${kind}/request`, params: { ...binding, serverId: client.getAppServerId(),
    ...(kind === "question" ? { questions: [{ id: "choice", prompt: "Continue?", options: [] }] }
      : { reason: "Run", action: { type: "command", command: "echo owned" }, availableDecisions: ["accept"] }) } });
  if (kind === "question") runtime.respondQuestions({ choice: ["yes"] });
  else runtime.respondApproval("accept");
  expect(client.respond).toHaveBeenCalledOnce();
  expect(runtime.pendingInteractions[0]?.responding).toBe(true);
  const reject = (params: Record<string, unknown>) => client.emit({ method: "gateway/interaction/replyRejected",
    params: { requestId: 41, reason: "invalid_response", ...params } });
  return { runtime, client, binding, reject };
}

for (const kind of ["question", "approval"] as const) {
  test.each(["turn", "epoch", "identity", "kind", "incomplete"])(
    `${kind}: a %s rejection cannot unlock the current reused request ID`, async mismatch => {
      const f = await fixture(kind);
      const rejected: Record<string, unknown> = { ...f.binding };
      if (mismatch === "turn") rejected.turnId = "old-turn";
      if (mismatch === "epoch") rejected.appServerEpoch = "old-epoch";
      if (mismatch === "identity") rejected[kind === "question" ? "questionId" : "approvalId"] = "old-item";
      if (mismatch === "kind") {
        delete rejected[kind === "question" ? "questionId" : "approvalId"];
        rejected[kind === "question" ? "approvalId" : "questionId"] = "other-kind";
      }
      if (mismatch === "incomplete") delete rejected.appServerEpoch;
      f.reject(rejected);
      expect(f.runtime.pendingInteractions[0]?.responding).toBe(true);
      f.reject(f.binding);
      expect(f.runtime.pendingInteractions[0]?.responding).toBe(false);
      expect(f.client.respond).toHaveBeenCalledOnce();
    },
  );

  test(`${kind}: an unambiguous legacy rejection retains its existing recovery`, async () => {
    const f = await fixture(kind);
    f.reject({ threadId: "thread-1" });
    expect(f.runtime.pendingInteractions[0]?.responding).toBe(false);
  });

  test(`${kind}: a legacy rejection cannot choose between reused request IDs`, async () => {
    const f = await fixture(kind);
    const current = f.runtime.pendingInteractions[0]!;
    f.runtime.pendingInteractions.unshift({ ...current,
      owner: { ...current.owner, turnId: "old-turn", appServerEpoch: "old-epoch" } });
    f.reject({ threadId: "thread-1" });
    expect(f.runtime.pendingInteractions.every(item => item.responding)).toBe(true);
  });

  test(`${kind}: a fully bound rejection selects its original card among reused IDs`, async () => {
    const f = await fixture(kind);
    const current = f.runtime.pendingInteractions[0]!;
    f.runtime.pendingInteractions.unshift({ ...current,
      owner: { ...current.owner, turnId: "old-turn", appServerEpoch: "old-epoch" } });
    f.reject(f.binding);
    expect(f.runtime.pendingInteractions[0]?.responding).toBe(true);
    expect(f.runtime.pendingInteractions[1]?.responding).toBe(false);
    expect(f.client.respond).toHaveBeenCalledOnce();
  });

  test(`${kind}: a rejection cannot release a previous client generation's busy state`, async () => {
    const f = await fixture(kind);
    f.runtime.pendingInteractions[0]!.owner.originClientGeneration -= 1;
    f.reject(f.binding);
    expect(f.runtime.pendingInteractions[0]?.responding).toBe(true);
  });
}

for (const kind of ["question", "approval"] as const) {
  test(`${kind}: a bound turn-ended rejection closes input without inventing a terminal receipt`, async () => {
    const f = await fixture(kind);
    // A reconnect can miss the turn terminal event. The rejection still proves
    // this exact request no longer accepts input, while its receipt is unknown.
    f.reject({ ...f.binding, reason: "turn_ended" });
    const original = f.runtime.pendingInteractions[0]!;
    expect(original.turnEnded).toBe(true);
    expect(original.responding).toBe(false);
    expect(original.owner.status).toBe("pending");
    expect(f.runtime.isInteractionActionable(original)).toBe(false);
    expect(f.runtime.getSnapshot().interaction).toBeNull();
    expect(() => kind === "question"
      ? f.runtime.respondQuestions({ choice: ["retry"] }, selectorForInteraction(original))
      : f.runtime.respondApproval("accept", selectorForInteraction(original)))
      .toThrow();
    expect(f.client.respond).toHaveBeenCalledOnce();

    // A later request keeps its own input authority and remains visible.
    const nextBinding = { ...f.binding, turnId: "next-turn",
      ...(kind === "question" ? { questionId: "next-question" } : { approvalId: "next-approval" }) };
    f.client.emit({ id: 42, method: `${kind}/request`, params: {
      ...nextBinding, serverId: f.client.getAppServerId(),
      ...(kind === "question" ? { questions: [{ id: "choice", prompt: "Next?", options: [] }] }
        : { reason: "Next", action: { type: "command", command: "echo next" }, availableDecisions: ["accept"] }),
    } });
    expect(f.runtime.getSnapshot().interaction?.requestId).toBe(42);
    // Native may still confirm whether the original reply actually won.
    f.client.emit({ method: `${kind}/resolved`, params: {
      ...f.binding, requestId: 41, reason: "client_response",
    } });
    expect(f.runtime.pendingInteractions.map(item => item.requestId)).toEqual([42]);
  });

  test.each(["turn", "epoch", "identity", "legacy"])(
    `${kind}: a %s turn-ended rejection cannot close the current question`, async mismatch => {
      const f = await fixture(kind);
      const binding: Record<string, unknown> = { ...f.binding };
      if (mismatch === "turn") binding.turnId = "old-turn";
      if (mismatch === "epoch") binding.appServerEpoch = "old-epoch";
      if (mismatch === "identity") binding[kind === "question" ? "questionId" : "approvalId"] = "old-item";
      if (mismatch === "legacy") for (const key of ["turnId", "appServerEpoch", "questionId", "approvalId"]) delete binding[key];
      f.reject({ ...binding, reason: "turn_ended" });
      expect(f.runtime.pendingInteractions[0]?.turnEnded).not.toBe(true);
      expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[0]!)).toBe(true);
    },
  );
}
