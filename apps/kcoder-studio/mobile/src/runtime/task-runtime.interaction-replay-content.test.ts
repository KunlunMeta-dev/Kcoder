import { afterEach, expect, test, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { TaskRuntimeRegistry } from "./task-runtime/registry";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { selectorForInteraction } from "./task-runtime/interactions";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const registries: TaskRuntimeRegistry[] = [];
afterEach(() => {
  registries.splice(0).forEach(registry => registry.removeProfile(profile.id));
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(kind: "question" | "approval", agent = false) {
  const client = new FakeClient([]);
  client.respond = vi.fn();
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({
    profile, server, threadId: "thread-1", profileActivationEpoch: 1,
    isCurrentInteractionOwner: () => true,
  });
  const registry = new TaskRuntimeRegistry();
  registries.push(registry);
  registry.put(profile.id, server.id, runtime);
  const request = {
    id: 41, method: `${kind}/request`, params: {
      serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn-1",
      appServerEpoch: "epoch-1",
      ...(kind === "question" ? {
        questionId: "question-1",
        questions: [{ id: "original-item", prompt: "Original question", options: [
          { label: "Original option", value: "original-option" },
        ] }],
        ...(agent ? { sourceAgent: { agentId: "worker", parentSessionId: "thread-1" } } : {}),
      } : {
        approvalId: "approval-1", reason: "Original reason",
        action: { type: "command", command: "echo original" },
        availableDecisions: ["accept", "cancel"],
      }),
    },
  };
  client.emit(request);
  const original = runtime.pendingInteractions[0]!;
  const selector = selectorForInteraction(original);
  const respond = () => kind === "approval"
    ? runtime.respondApproval("accept", selector)
    : agent
      ? runtime.respondAgentQuestions("worker", 41, { "original-item": ["original-option"] }, false, selector)
      : runtime.respondQuestions({ "original-item": ["original-option"] }, selector);
  return { runtime, client, request, original, respond };
}

for (const agent of [false, true]) {
  test.each([false, true])(
    `question (agent=${agent}): replay cannot replace the question bound to an original answer (responding=%s)`,
    async responding => {
      const f = await fixture("question", agent);
      if (responding) f.respond();
      f.client.emit({ ...f.request, params: { ...f.request.params,
        questions: [{ id: "replacement-item", prompt: "Different question", options: [] }],
      } });
      expect(f.runtime.pendingInteractions).toHaveLength(1);
      expect(f.runtime.pendingInteractions[0]).toMatchObject({
        kind: "question", questions: f.original.kind === "question" ? f.original.questions : [],
      });
      expect(f.runtime.pendingInteractions[0]?.responding).toBe(responding ? true : undefined);
      if (!responding) f.respond();
      expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(41, {
        answers: { "original-item": { answers: ["original-option"] } },
      });
    },
  );
}

test.each([false, true])("approval replay retains the original action and decisions (responding=%s)", async responding => {
  const f = await fixture("approval");
  if (responding) f.respond();
  f.client.emit({ ...f.request, params: { ...f.request.params,
    reason: "Replacement reason", action: { type: "command", command: "replacement command" },
    availableDecisions: ["decline"],
  } });
  expect(f.runtime.pendingInteractions[0]).toMatchObject({
    kind: "approval", reason: "Original reason", action: { type: "command", command: "echo original" },
    availableDecisions: ["accept", "cancel"],
  });
  if (!responding) f.respond();
  expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(41, { decision: "accept" });
});

test("a conflicting source-agent replay still closes input without replacing the original question", async () => {
  const f = await fixture("question", true);
  f.client.emit({ ...f.request, params: { ...f.request.params,
    sourceAgent: { agentId: "other-worker", parentSessionId: "thread-1" },
    questions: [{ id: "replacement-item", prompt: "Different question", options: [] }],
  } });
  expect(f.runtime.pendingInteractions[0]).toMatchObject({
    kind: "question", owner: { status: "unsupported" }, sourceAgent: { agentId: "worker" },
    questions: f.original.kind === "question" ? f.original.questions : [],
  });
  expect(() => f.respond()).toThrow(/失效|只支持核对/);
  expect(f.client.respond).not.toHaveBeenCalled();
});
