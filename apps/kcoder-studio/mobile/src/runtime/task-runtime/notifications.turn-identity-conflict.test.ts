import { afterEach, expect, test, vi } from "vitest";
import type { RpcMessage } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, appServerId, profile, server } from "./fixture.test-support";
import { bufferNotifications } from "./notificationBuffer";
import { hasConflictingTurnIdentity } from "../../../../shared/turnNotificationIdentity";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

for (const kind of ["question", "approval"] as const) {
  for (const mode of ["live", "buffered"] as const) {
    test(`${mode} ${kind}: a conflicting turn identity cannot close original input`, async () => {
      const client = new FakeClient([]);
      client.respond = vi.fn();
      client.respondError = vi.fn();
      taskRuntimeTestHelpers.setConnector(async () => client as never);
      const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
        profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
      runtimes.push(runtime);
      let buffered: ReturnType<typeof bufferNotifications> | undefined;
      if (mode === "buffered") {
        runtime.unsubscribeRpc?.();
        runtime.unsubscribeRpc = null;
        buffered = bufferNotifications(client as never);
      }
      const binding = { serverId: appServerId, threadId: "thread-1", turnId: "turn" };
      client.emit({ method: "turn/started", params: binding });
      client.emit({ id: 41, method: `${kind}/request`, params: { ...binding,
        appServerEpoch: "epoch", [`${kind}Id`]: "original",
        ...(kind === "question" ? { questions: [{ id: "item", prompt: "Continue?", options: [] }] }
          : { action: { type: "command", command: "echo fixture" } }),
      } });
      const observed = vi.fn();
      runtime.subscribeProtocol(observed);
      const terminal: RpcMessage = { method: "turn/completed", params: { ...binding, sequence: 42,
        turn: { id: "turn", status: "completed" } } };
      const conflicting: RpcMessage = { ...terminal,
        params: { ...terminal.params, turn: { id: "peer-turn", status: "completed" } } };
      client.emit(conflicting);
      if (buffered) {
        runtime.attachBufferedClient(client as never, buffered);
      }
      const original = runtime.pendingInteractions[0]!;
      expect(runtime.isInteractionActionable(original)).toBe(true);
      expect(runtime.getSnapshot()).toMatchObject({ running: true, interactionCount: 1 });
      expect(observed.mock.calls.some(([message]) => message.method === "turn/completed")).toBe(false);
      observed.mockClear();
      // The conflicting frame must not reserve the real completion's sequence.
      client.emit(terminal);
      expect(runtime.pendingInteractions[0]?.turnEnded).toBe(true);
      expect(runtime.getSnapshot()).toMatchObject({ running: false, interaction: null, interactionCount: 0 });
      expect(observed).toHaveBeenCalledExactlyOnceWith(terminal);
      expect(client.respond).not.toHaveBeenCalled();
      expect(client.respondError).not.toHaveBeenCalled();
    });
  }
}

test("conflicting turn identities cannot exhaust original-question recovery capacity", () => {
  const client = new FakeClient([]);
  const buffered = bufferNotifications(client as never);
  try {
    for (let sequence = 0; sequence < 513; sequence++) client.emit({ method: "turn/completed", params: {
      serverId: appServerId, threadId: "thread-1", turnId: "turn", sequence,
      turn: { id: "peer-turn", status: "completed" },
    } });
    expect(buffered.hasOverflowed()).toBe(false);
    const terminal: RpcMessage = { method: "turn/completed", params: {
      threadId: "thread-1", turnId: "turn", turn: { id: "turn", status: "completed" },
    } };
    client.emit(terminal);
    const delivered = vi.fn();
    buffered.activate(delivered);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(terminal);
  } finally {
    buffered.cancel();
    client.close();
  }
});

test.each([
  { thread_id: "peer-thread" },
  { thread: { threadId: "peer-thread" } },
  { thread: { id: "peer-thread" } },
  { widget: { threadId: "peer-thread" } },
  { turn: { threadId: "peer-thread" } },
  { turn_id: "peer-turn" },
  { turn: { turnId: "peer-turn" } },
  { turn: { id: "peer-turn" } },
  { turnId: "" },
  { turnId: " " },
  { turnId: 7 },
  { turn: { id: {} } },
])("conflicting or invalid compatibility locator %j is rejected", aliases => {
  for (const method of ["turn/started", "turn/completed"]) {
    expect(hasConflictingTurnIdentity({ method, params: {
      threadId: "thread-1", turnId: "turn", ...aliases,
    } })).toBe(true);
  }
});

test.each([
  {},
  { thread_id: "thread-1", turn_id: "turn" },
  { thread: { id: "thread-1", threadId: "thread-1" },
    turn: { id: "turn", turnId: "turn", threadId: "thread-1" } },
  { thread_id: null, turn_id: null, turn: null },
])("matching or omitted compatibility locator %j stays accepted", aliases => {
  for (const method of ["turn/started", "turn/completed"]) {
    expect(hasConflictingTurnIdentity({ method, params: {
      threadId: "thread-1", turnId: "turn", ...aliases,
    } })).toBe(false);
  }
});

for (const kind of ["question", "approval"] as const) {
  for (const mode of ["live", "buffered"] as const) {
    for (const method of ["turn/started", "turn/completed"] as const) {
      test.each([
        { thread_id: "peer-thread" },
        { thread: { threadId: "peer-thread" } },
        { thread: { id: "peer-thread" } },
        { widget: { threadId: "peer-thread" } },
      ])(`${mode} ${kind}: ${method} with only a foreign compatibility task %j preserves original input`, async locator => {
        const client = new FakeClient([]);
        client.respond = vi.fn();
        client.respondError = vi.fn();
        taskRuntimeTestHelpers.setConnector(async () => client as never);
        const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
          profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
        runtimes.push(runtime);
        let buffered: ReturnType<typeof bufferNotifications> | undefined;
        if (mode === "buffered") {
          runtime.unsubscribeRpc?.();
          runtime.unsubscribeRpc = null;
          buffered = bufferNotifications(client as never);
        }
        const binding = { serverId: appServerId, threadId: "thread-1", turnId: "turn" };
        client.emit({ method: "turn/started", params: { ...binding, attemptId: "original-attempt" } });
        client.emit({ id: 41, method: `${kind}/request`, params: { ...binding,
          appServerEpoch: "epoch", [`${kind}Id`]: "original",
          ...(kind === "question" ? { questions: [{ id: "item", prompt: "Continue?", options: [] }] }
            : { action: { type: "command", command: "echo fixture" } }),
        } });
        const observed = vi.fn();
        runtime.subscribeProtocol(observed);
        const foreign: RpcMessage = { method, params: { serverId: appServerId,
          ...locator, turnId: "turn", sequence: 42,
          ...(method === "turn/started" ? { attemptId: "foreign-attempt" }
            : { turn: { id: "turn", status: "completed" } }),
        } };
        client.emit(foreign);
        if (buffered) runtime.attachBufferedClient(client as never, buffered);
        expect(runtime.isInteractionActionable(runtime.pendingInteractions[0]!)).toBe(true);
        expect(runtime.getSnapshot()).toMatchObject({ running: true, interactionCount: 1 });
        expect(runtime.attemptByTurn.get("turn")).toBe("original-attempt");
        expect(observed.mock.calls.some(([message]) => message === foreign)).toBe(false);
        // An authoritative event can reuse the discarded foreign sequence.
        const terminal: RpcMessage = { method: "turn/completed", params: { ...binding, sequence: 42,
          turn: { id: "turn", attemptId: "original-attempt", status: "completed" } } };
        client.emit(terminal);
        expect(runtime.pendingInteractions[0]?.turnEnded).toBe(true);
        expect(runtime.getSnapshot()).toMatchObject({ running: false, interaction: null, interactionCount: 0 });
        expect(client.respond).not.toHaveBeenCalled();
        expect(client.respondError).not.toHaveBeenCalled();
      });
    }
  }
}

test.each([
  { thread_id: "thread-1" },
  { thread: { threadId: "thread-1" } },
  { thread: { id: "thread-1" } },
  { widget: { threadId: "thread-1" } },
  { thread_id: null },
  { thread: { threadId: null } },
  { thread: { id: null } },
  { widget: { threadId: null } },
])("matching or nullable task compatibility locator %j retains terminal handling", async locator => {
  const client = new FakeClient([]);
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  client.emit({ method: "turn/started", params: { turnId: "turn" } });
  expect(runtime.getSnapshot().running).toBe(true);
  client.emit({ method: "turn/completed", params: { ...locator,
    turnId: "turn", turn: { id: "turn", status: "completed" } } });
  expect(runtime.getSnapshot().running).toBe(false);
  expect(runtime.finishedAttempts.has("turn")).toBe(true);
});
