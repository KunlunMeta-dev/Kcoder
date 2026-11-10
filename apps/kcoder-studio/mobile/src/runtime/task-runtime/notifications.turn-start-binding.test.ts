import { afterEach, expect, test, vi } from "vitest";
import type { RpcMessage } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, appServerId, profile, server } from "./fixture.test-support";
import { bufferNotifications } from "./notificationBuffer";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

const invalidStarts: Array<{ name: string; envelope: Record<string, unknown>; serverId: string }> = [
  { name: "foreign producer", envelope: {}, serverId: "server-previous" },
  { name: "numeric request ID", envelope: { id: 9 }, serverId: appServerId },
  { name: "string request ID", envelope: { id: "request" }, serverId: appServerId },
  { name: "null request ID", envelope: { id: null }, serverId: appServerId },
];

for (const mode of ["live", "buffered"] as const) {
  for (const kind of ["question", "approval"] as const) {
    test.each(invalidStarts)(`${mode} ${kind}: $name cannot replace the attempt that closes original input`, async invalid => {
      const client = new FakeClient([]);
      client.respond = vi.fn();
      client.respondError = vi.fn();
      taskRuntimeTestHelpers.setConnector(async () => client as never);
      const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
        profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
      runtimes.push(runtime);
      const binding = { serverId: appServerId, threadId: "thread-1", turnId: "turn" };
      const started: RpcMessage = { method: "turn/started", params: { ...binding,
        sequence: 42, attemptId: "original-attempt" } };
      client.emit(started);
      client.emit({ id: 41, method: `${kind}/request`, params: { ...binding,
        appServerEpoch: "epoch", [`${kind}Id`]: "original",
        ...(kind === "question" ? { questions: [{ id: "item", prompt: "Continue?", options: [] }] }
          : { action: { type: "command", command: "echo fixture" } }),
      } });
      expect(runtime.isInteractionActionable(runtime.pendingInteractions[0]!)).toBe(true);
      const observed = vi.fn();
      runtime.subscribeProtocol(observed);
      const stale: RpcMessage = { ...started, ...invalid.envelope,
        params: { ...started.params, serverId: invalid.serverId, sequence: 43, attemptId: "foreign-attempt" } };
      if (mode === "buffered") {
        runtime.unsubscribeRpc?.();
        runtime.unsubscribeRpc = null;
        const buffered = bufferNotifications(client as never);
        client.emit(stale);
        runtime.attachBufferedClient(client as never, buffered);
      } else client.emit(stale);

      // A poisoned attempt makes the real completion return before ending input.
      const completed: RpcMessage = { method: "turn/completed", params: { ...binding, sequence: 44,
        turn: { id: "turn", attemptId: "original-attempt", status: "completed" } } };
      client.emit(completed);
      expect(runtime.pendingInteractions[0]?.turnEnded).toBe(true);
      expect(runtime.getSnapshot()).toMatchObject({ running: false, interaction: null, interactionCount: 0 });
      expect(observed).toHaveBeenCalledExactlyOnceWith(completed);
      expect(client.respond).not.toHaveBeenCalled();
      expect(client.respondError).not.toHaveBeenCalled();

      // Discarded envelopes cannot consume a subsequent valid event's sequence.
      const current: RpcMessage = { ...started, params: { ...started.params, sequence: 43, turnId: "next-turn",
        attemptId: "next-attempt" } };
      client.emit(current);
      expect(runtime.getSnapshot()).toMatchObject({ running: true, activeTurnId: "next-turn" });
      expect(observed).toHaveBeenCalledTimes(2);
    });
  }
}

test.each(invalidStarts)("$name turn starts cannot exhaust question recovery capacity", invalid => {
  const client = new FakeClient([]);
  const buffered = bufferNotifications(client as never);
  try {
    for (let sequence = 0; sequence < 513; sequence++) client.emit({
      ...invalid.envelope, method: "turn/started", params: { serverId: invalid.serverId,
        threadId: "thread-1", turnId: "turn", sequence },
    });
    expect(buffered.hasOverflowed()).toBe(false);
    const current: RpcMessage = { method: "turn/started", params: {
      serverId: appServerId, threadId: "thread-1", turnId: "turn", sequence: 42,
    } };
    const legacy: RpcMessage = { method: "turn/started", params: { threadId: "thread-1", turnId: "turn" } };
    client.emit(current);
    client.emit(legacy);
    const delivered = vi.fn();
    buffered.activate(delivered);
    expect(delivered.mock.calls).toEqual([[current], [legacy]]);
    client.emit({ ...current, ...invalid.envelope, params: { ...current.params, serverId: invalid.serverId } });
    expect(delivered).toHaveBeenCalledTimes(2);
  } finally {
    buffered.cancel();
    client.close();
  }
  expect(client.listeners.size).toBe(0);
});
