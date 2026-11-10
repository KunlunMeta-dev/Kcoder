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
  test.each(["server-previous", server.id, null])(`${kind}: foreign terminal producer %s cannot close current input`, async serverId => {
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
    const terminal: RpcMessage = { method: "turn/completed", params: { ...binding, sequence: 42,
      turn: { id: "turn", status: "completed" } } };
    // Task/turn IDs can be reused after restart. The current connection's
    // server identity must also agree before a terminal closes its input.
    client.emit({ ...terminal, params: { ...terminal.params, serverId } });
    expect(observed).not.toHaveBeenCalled();
    expect(runtime.pendingInteractions).toEqual([original]);
    expect(runtime.isInteractionActionable(original)).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({ running: true, interactionCount: 1,
      interaction: { requestId: 41 } });
    client.emit(terminal);
    expect(observed).toHaveBeenCalledExactlyOnceWith(terminal);
    expect(runtime.getSnapshot()).toMatchObject({ running: false, interaction: null, interactionCount: 0 });
    expect(client.respond).not.toHaveBeenCalled();
    expect(client.respondError).not.toHaveBeenCalled();
  });
}

for (const method of ["question/resolved", "approval/resolved", "turn/completed"]) {
  test(`${method}: foreign terminal producers cannot exhaust recovery capacity`, () => {
    const client = new FakeClient([]);
    const buffered = bufferNotifications(client as never);
    try {
      for (let sequence = 0; sequence < 513; sequence++) client.emit({ method, params: {
        serverId: "server-previous", threadId: "thread-1", turnId: "turn", sequence,
        requestId: 41, questionId: "original", reason: "client_response",
      } });
      expect(buffered.hasOverflowed()).toBe(false);
      const current: RpcMessage = { method, params: {
        serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn", sequence: 42,
      } };
      const legacy: RpcMessage = { method, params: { threadId: "thread-1", turnId: "turn", sequence: 43 } };
      client.emit(current);
      client.emit(legacy);
      const delivered = vi.fn();
      buffered.activate(delivered);
      expect(delivered.mock.calls).toEqual([[current], [legacy]]);
      client.emit({ method, params: { ...current.params, serverId: "server-previous" } });
      expect(delivered).toHaveBeenCalledTimes(2);
    } finally {
      buffered.cancel();
      client.close();
    }
  });
}
