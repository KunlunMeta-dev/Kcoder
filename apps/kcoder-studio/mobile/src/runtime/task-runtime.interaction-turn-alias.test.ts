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

async function fixture() {
  const client = new FakeClient([]);
  client.respond = vi.fn();
  client.respondError = vi.fn();
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  runtimes.push(runtime);
  return { runtime, client };
}

const aliases = [
  { name: "turn_id", binding: { turn_id: "old-turn" } },
  { name: "turn.turnId", binding: { turn: { turnId: "old-turn" } } },
];

for (const { name, binding } of aliases) {
  test(`${name}: a started turn keeps its original execution identity`, async () => {
    const { runtime, client } = await fixture();
    client.emit({ method: "turn/started", params: { threadId: "thread-1", ...binding } });
    expect(runtime.getSnapshot()).toMatchObject({ running: true, activeTurnId: "old-turn" });
    expect(runtime.attemptByTurn.has("old-turn")).toBe(true);
    expect(runtime.attemptByTurn.has("current-turn")).toBe(false);
  });

  for (const kind of ["question", "approval"] as const) {
    test.each([false, true])(
      `${kind}, ${name}: an older completion closes only its original card (conflicting nested id=%s)`,
      async conflictingId => {
        const { runtime, client } = await fixture();
        const prompt = (id: number, turnId: string) => client.emit({ id, method: `${kind}/request`, params: {
          serverId: client.getAppServerId(), threadId: "thread-1", turnId, appServerEpoch: "epoch-1",
          ...(kind === "question"
            ? { questionId: `question-${id}`, questions: [{ id: "choice", prompt: "Which?", options: [] }] }
            : { approvalId: `approval-${id}`, action: { type: "command", command: "echo fixture" } }),
        } });
        prompt(41, "old-turn");
        runtime.focusInteraction(selectorForInteraction(runtime.pendingInteractions[0]!));
        client.emit({ method: "turn/started", params: { threadId: "thread-1", turnId: "new-turn" } });
        prompt(42, "new-turn");
        // Gateway's existing routing gives these aliases precedence over turn.id.
        client.emit({ method: "turn/completed", params: { threadId: "thread-1", ...binding,
          turn: { ...binding.turn, status: "completed", ...(conflictingId ? { id: "new-turn" } : {}) },
        } });

        expect(runtime.pendingInteractions[0]?.turnEnded).toBe(true);
        expect(runtime.isInteractionActionable(runtime.pendingInteractions[0]!)).toBe(false);
        expect(runtime.isInteractionActionable(runtime.pendingInteractions[1]!)).toBe(true);
        expect(runtime.focusedInteractionSelector).toBeNull();
        expect(runtime.getSnapshot()).toMatchObject({ running: true, activeTurnId: "new-turn",
          interaction: { requestId: 42 }, interactionCount: 1 });
        expect(client.respond).not.toHaveBeenCalled();
        expect(client.respondError).not.toHaveBeenCalled();
        if (kind === "question") runtime.respondQuestions({ choice: ["next answer"] });
        else runtime.respondApproval("accept");
        expect(client.respond).toHaveBeenCalledExactlyOnceWith(42, kind === "question"
          ? { answers: { choice: { answers: ["next answer"] } } } : { decision: "accept" });
      },
    );
  }
}
