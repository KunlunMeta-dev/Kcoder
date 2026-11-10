import { afterEach, expect, test, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

for (const kind of ["question", "approval"] as const) {
  const outcomes: Array<[string, Record<string, unknown>]> = [
    ["missing reason", {}],
    ["null reason", { reason: null }],
    ["object reason", { reason: { status: "client_response" } }],
  ];
  if (kind === "approval") outcomes.push(["invalid decision", { reason: "client_response", decision: "unknown" }]);
  test.each(outcomes)(`${kind}: %s cannot close the original card or consume its recovery receipt`, async (_name, outcome) => {
    const client = new FakeClient([]);
    client.respond = vi.fn();
    taskRuntimeTestHelpers.setConnector((async () => client as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
      profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
    runtimes.push(runtime);
    const binding = { threadId: "thread-1", turnId: "original-turn", appServerEpoch: "epoch",
      ...(kind === "question" ? { questionId: "question" } : { approvalId: "approval" }) };
    client.emit({ id: 7, method: `${kind}/request`, params: {
      ...binding, serverId: client.getAppServerId(),
      ...(kind === "question"
        ? { questions: [{ id: "item", prompt: "Which mode?", options: [] }] }
        : { action: { type: "command", command: "echo fixture" } }),
    } });
    const original = runtime.pendingInteractions[0]!;
    const receipt = { ...binding, requestId: 7, serverId: client.getAppServerId(), sequence: 42 };
    const resolved = vi.fn();
    runtime.setInteractionLedgerObserver({ ownerFor: () => undefined, wasResolved: () => false,
      changed: vi.fn(), resolved });

    client.emit({ method: `${kind}/resolved`, params: { ...receipt, ...outcome } });
    expect(runtime.pendingInteractions).toEqual([original]);
    expect(runtime.getSnapshot()).toMatchObject({ interactionCount: 1, interaction: { requestId: 7 } });
    expect(resolved).not.toHaveBeenCalled();

    // Reuse the same sequenced identity: an invalid result must not claim it.
    client.emit({ method: `${kind}/resolved`, params: { ...receipt, reason: "client_response",
      ...(kind === "approval" ? { decision: "accept_for_session" } : {}) } });
    expect(runtime.pendingInteractions).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({ interactionCount: 0, interaction: null });
    expect(resolved).toHaveBeenCalledExactlyOnceWith(original);
    expect(client.respond).not.toHaveBeenCalled();
  });
}
