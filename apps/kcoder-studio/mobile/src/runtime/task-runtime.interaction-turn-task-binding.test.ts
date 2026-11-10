import { afterEach, expect, test, vi } from "vitest";
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
  client.respond = vi.fn();
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-1" } });
  client.emit({ id: 41, method: `${kind}/request`, params: {
    serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn-1", appServerEpoch: "epoch-1",
    ...(kind === "question"
      ? { questionId: "question-1", questions: [{ id: "choice", prompt: "Which?", options: [] }] }
      : { approvalId: "approval-1", action: { type: "command", command: "echo fixture" } }),
  } });
  const selector = selectorForInteraction(runtime.pendingInteractions[0]!);
  runtime.focusInteraction(selector);
  return { runtime, client, selector };
}

for (const kind of ["question", "approval"] as const) {
  for (const method of ["turn/started", "turn/completed"] as const) {
    test.each([
      { name: "outer task", binding: { threadId: "peer-task" } },
      { name: "nested task", binding: { turn: { threadId: "peer-task" } } },
      { name: "conflicting nested task", binding: { threadId: "thread-1", turn: { threadId: "peer-task" } } },
    ])(`${kind}: ${method} with a foreign $name preserves the original card and focus`, async ({ binding }) => {
      const { runtime, client, selector } = await fixture(kind);
      const snapshot = runtime.getSnapshot();
      const interaction = runtime.pendingInteractions[0]!;
      // Completion may reuse the original turn ID; a start must not replace it.
      const turnId = method === "turn/started" ? "peer-turn" : "turn-1";
      client.emit({ method, params: { ...binding, turnId,
        turn: { id: turnId, status: method === "turn/started" ? "running" : "completed", ...binding.turn },
      } });
      expect(runtime.getSnapshot()).toBe(snapshot);
      expect(runtime.pendingInteractions[0]).toBe(interaction);
      expect(runtime.focusedInteractionSelector).toEqual(selector);
      expect(runtime.isInteractionActionable(interaction)).toBe(true);
      expect(client.respond).not.toHaveBeenCalled();
      // The original task's actual terminal event still closes its input.
      client.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1",
        turn: { id: "turn-1", threadId: "thread-1", status: "completed" },
      } });
      expect(runtime.pendingInteractions[0]?.turnEnded).toBe(true);
      expect(runtime.focusedInteractionSelector).toBeNull();
      expect(runtime.getSnapshot()).toMatchObject({ running: false, interaction: null, interactionCount: 0 });
    });
  }
}

for (const kind of ["question", "approval"] as const) {
  test(`${kind}: a conflicting nested task cannot consume the original completion replay identity`, async () => {
    const { runtime, client, selector } = await fixture(kind);
    const params = { serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn-1", sequence: 7,
      turn: { id: "turn-1", threadId: "peer-task", status: "completed" } };
    client.emit({ method: "turn/completed", params });
    expect(runtime.pendingInteractions[0]?.turnEnded).not.toBe(true);
    expect(runtime.focusedInteractionSelector).toEqual(selector);
    client.emit({ method: "turn/completed", params: { ...params,
      turn: { ...params.turn, threadId: "thread-1" },
    } });
    expect(runtime.pendingInteractions[0]?.turnEnded).toBe(true);
    expect(runtime.focusedInteractionSelector).toBeNull();
  });

  test.each(["outer", "nested", "legacy"])(`${kind}: an original %s completion still settles its card`, async binding => {
    const { runtime, client } = await fixture(kind);
    client.emit({ method: "turn/completed", params: {
      ...(binding === "outer" ? { threadId: "thread-1" } : {}), turnId: "turn-1",
      turn: { id: "turn-1", status: "completed", ...(binding === "nested" ? { threadId: "thread-1" } : {}) },
    } });
    expect(runtime.pendingInteractions[0]?.turnEnded).toBe(true);
    expect(runtime.focusedInteractionSelector).toBeNull();
    expect(runtime.getSnapshot()).toMatchObject({ running: false, interaction: null, interactionCount: 0 });
    expect(client.respond).not.toHaveBeenCalled();
  });
}
