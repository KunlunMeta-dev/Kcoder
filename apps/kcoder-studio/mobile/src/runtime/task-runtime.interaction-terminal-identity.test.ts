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
  for (const legacy of [false, true]) {
    test.each([
      ["foreign server", { serverId: "another-app-server" }],
      ["conflicting interaction kind", kind === "question"
        ? { approvalId: "unrelated-approval" } : { questionId: "unrelated-question" }],
    ])(`${kind} (legacy recovery=${legacy}): a terminal receipt with %s preserves the original card`, async (_name, conflicting) => {
      const client = new FakeClient([]);
      client.respond = vi.fn();
      taskRuntimeTestHelpers.setConnector(async () => client as never);
      const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
        profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
      runtimes.push(runtime);
      const binding = { serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn-1",
        appServerEpoch: "epoch-1", ...(kind === "question"
          ? { questionId: "question" } : { approvalId: "approval" }) };
      client.emit({ id: 41, method: `${kind}/request`, params: { ...binding,
        ...(kind === "question"
          ? { questions: [{ id: "item", prompt: "Continue?", options: [] }] }
          : { action: { type: "command", command: "echo fixture" } }),
      } });
      const original = runtime.pendingInteractions[0]!;
      const resolved = vi.fn();
      runtime.setInteractionLedgerObserver({ ownerFor: () => undefined, wasResolved: () => false,
        changed: vi.fn(), resolved });
      const receipt = { ...binding, requestId: 41, sequence: 42, reason: "client_response" };

      client.emit({ method: `${kind}/resolved`, params: { ...receipt, ...conflicting } });
      expect(runtime.pendingInteractions).toEqual([original]);
      expect(runtime.getSnapshot()).toMatchObject({ interactionCount: 1, interaction: { requestId: 41 } });
      expect(resolved).not.toHaveBeenCalled();

      // Invalid receipts cannot claim the sequence of the real recovery receipt.
      const { serverId: _serverId, ...legacyReceipt } = receipt;
      client.emit({ method: `${kind}/resolved`, params: legacy
        ? { ...legacyReceipt, ...(kind === "question" ? { approvalId: null } : { questionId: null }) }
        : receipt });
      expect(runtime.pendingInteractions).toEqual([]);
      expect(resolved).toHaveBeenCalledExactlyOnceWith(original);
      client.emit({ method: `${kind}/resolved`, params: receipt });
      expect(resolved).toHaveBeenCalledTimes(1);
      expect(client.respond).not.toHaveBeenCalled();
    });
  }
}
