import { afterEach, expect, test, vi } from "vitest";
import type { RpcMessage } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import { bufferNotifications } from "./notificationBuffer";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

for (const kind of ["question", "approval"] as const) {
  for (const method of [`${kind}/resolved`, "turn/completed"]) {
    test.each([null, 41, "legacy-request"])(`${kind}: ${method} with id=%s cannot end the original input`, async id => {
      const client = new FakeClient([]);
      client.respond = vi.fn();
      client.respondError = vi.fn();
      taskRuntimeTestHelpers.setConnector(async () => client as never);
      const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
        profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
      runtimes.push(runtime);
      const binding = { serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn",
        appServerEpoch: "epoch", [`${kind}Id`]: "original" };
      client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "turn" } });
      client.emit({ id: 41, method: `${kind}/request`, params: { ...binding,
        ...(kind === "question" ? { questions: [{ id: "item", prompt: "Continue?", options: [] }] }
          : { action: { type: "command", command: "echo fixture" } }),
      } });
      const original = runtime.pendingInteractions[0]!;
      const observed = vi.fn();
      runtime.subscribeProtocol(observed);
      const receipt: RpcMessage = { method, params: { ...binding, requestId: 41, sequence: 42,
        reason: "client_response", turn: { id: "turn", status: "completed" } } };
      client.emit({ ...receipt, id } as RpcMessage);
      expect(observed).not.toHaveBeenCalled();
      expect(runtime.pendingInteractions).toEqual([original]);
      expect(runtime.isInteractionActionable(original)).toBe(true);
      expect(runtime.getSnapshot()).toMatchObject({ running: true, interactionCount: 1,
        interaction: { requestId: 41 } });
      // A malformed envelope cannot reserve the real receipt's replay identity.
      client.emit(receipt);
      expect(observed).toHaveBeenCalledOnce();
      expect(runtime.getSnapshot()).toMatchObject({ interaction: null, interactionCount: 0 });
      if (method === "turn/completed") expect(runtime.getSnapshot().running).toBe(false);
      else expect(runtime.pendingInteractions).toEqual([]);
      expect(client.respond).not.toHaveBeenCalled();
      expect(client.respondError).not.toHaveBeenCalled();
    });
  }
}

for (const method of ["question/resolved", "approval/resolved", "turn/completed"]) {
  test(`${method} request envelopes cannot exhaust original-task recovery`, () => {
    const client = new FakeClient([]);
    const buffered = bufferNotifications(client as never);
    try {
      for (let id = 0; id < 513; id++) client.emit({ id, method, params: { sequence: id } });
      client.emit({ id: null, method, params: {} } as unknown as RpcMessage);
      expect(buffered.hasOverflowed()).toBe(false);
      const valid: RpcMessage = { method, params: { threadId: "thread-1", turnId: "turn", sequence: 42 } };
      client.emit(valid);
      const delivered = vi.fn();
      buffered.activate(delivered);
      expect(delivered).toHaveBeenCalledExactlyOnceWith(valid);
      client.emit({ id: 7, method, params: {} });
      expect(delivered).toHaveBeenCalledTimes(1);
    } finally {
      buffered.cancel();
      client.close();
    }
  });
}
