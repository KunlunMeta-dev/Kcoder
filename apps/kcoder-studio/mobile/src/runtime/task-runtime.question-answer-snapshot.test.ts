import { afterEach, expect, test, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { selectorForInteraction } from "./task-runtime/interactions";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(sourceAgent: boolean) {
  const client = new FakeClient([]);
  const replies: unknown[] = [];
  client.respond = vi.fn((...reply: unknown[]) => {
    const [id, result] = reply;
    replies.push(JSON.parse(JSON.stringify({ id, result })));
  });
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({
    profile, server, threadId: "thread-1", profileActivationEpoch: 1,
    isCurrentInteractionOwner: () => true,
  });
  runtimes.push(runtime);
  client.emit({ id: 41, method: "question/request", params: {
    serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn-1",
    appServerEpoch: "epoch-1", questionId: "original-question",
    ...(sourceAgent ? { sourceAgent: { parentSessionId: "thread-1", agentId: "worker" } } : {}),
    questions: [{ id: "choice", prompt: "Which?", options: [], allowsFreeform: true }],
  } });
  const selector = selectorForInteraction(runtime.pendingInteractions[0]!);
  const answer = (answers: Record<string, string[]>) => sourceAgent
    ? runtime.respondAgentQuestions("worker", 41, answers, false, selector)
    : runtime.respondQuestions(answers, selector);
  return { client, runtime, answer, replies };
}

for (const sourceAgent of [false, true]) {
  const route = sourceAgent ? "source agent" : "main task";

  test(`${route}: busy-state publication cannot change the validated answer`, async () => {
    const f = await fixture(sourceAgent);
    const answers: Record<string, string[]> = { choice: ["original answer"] };
    const changed = vi.fn(() => {
      if (!f.runtime.pendingInteractions[0]?.responding) return;
      answers.choice.push("later draft edit");
      answers.foreign = ["belongs to another question"];
    });
    f.runtime.setInteractionLedgerObserver({
      ownerFor: () => undefined, wasResolved: () => false,
      changed, resolved: vi.fn(),
    });
    changed.mockClear();

    f.answer(answers);

    expect(changed).toHaveBeenCalled();
    expect(answers).toHaveProperty("foreign");
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(41, {
      answers: { choice: { answers: ["original answer"] } },
    });
    expect(f.replies).toEqual([{
      id: 41, result: { answers: { choice: { answers: ["original answer"] } } },
    }]);
    expect(f.runtime.getSnapshot().interaction?.responding).toBe(true);
  });

  test(`${route}: later draft edits cannot mutate an already handed-off answer`, async () => {
    const f = await fixture(sourceAgent);
    const answers = { choice: ["original answer"] };
    f.answer(answers);
    answers.choice.push("later edit");

    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(41, {
      answers: { choice: { answers: ["original answer"] } },
    });
  });
}
