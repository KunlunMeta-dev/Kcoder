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
  const field = kind === "question" ? "questionId" : "approvalId";
  const conflicts: Array<[string, Record<string, unknown>]> = [
    ["another turn", { turnId: "another-turn" }],
    ["another app-server lifetime", { appServerEpoch: "another-epoch" }],
    ["another interaction", { [field]: "another-interaction" }],
    ["another transport request", { requestId: 8 }],
    ["missing interaction identity", { [field]: undefined }],
  ];
  test.each(conflicts)(`${kind}: %s cannot consume the original recovery receipt`, async (_name, conflict) => {
    const client = new FakeClient([]);
    client.respond = vi.fn();
    taskRuntimeTestHelpers.setConnector(async () => client as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
      profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
    runtimes.push(runtime);
    const binding = { threadId: "thread-1", turnId: "turn", appServerEpoch: "epoch", [field]: "original" };
    client.emit({ id: 7, method: `${kind}/request`, params: {
      ...binding, serverId: client.getAppServerId(),
      ...(kind === "question"
        ? { questions: [{ id: "item", prompt: "Which mode?", options: [] }] }
        : { action: { type: "command", command: "echo fixture" } }),
    } });
    const original = runtime.pendingInteractions[0]!;
    const resolved = vi.fn();
    runtime.setInteractionLedgerObserver({ ownerFor: () => undefined, wasResolved: () => false,
      changed: vi.fn(), resolved });
    const receipt = { ...binding, requestId: 7, serverId: client.getAppServerId(), sequence: 42,
      reason: "client_response", ...(kind === "approval" ? { decision: "accept" } : {}) };

    client.emit({ method: `${kind}/resolved`, params: { ...receipt, ...conflict } });
    expect(runtime.pendingInteractions).toEqual([original]);
    expect(resolved).not.toHaveBeenCalled();
    // A rejected binding cannot reserve the sequenced identity of the real result.
    client.emit({ method: `${kind}/resolved`, params: receipt });
    expect(runtime.pendingInteractions).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({ interactionCount: 0, interaction: null });
    expect(resolved).toHaveBeenCalledExactlyOnceWith(original);
    client.emit({ method: `${kind}/resolved`, params: receipt });
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(client.respond).not.toHaveBeenCalled();
  });
}
