import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
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

const source = { parentSessionId: "thread-1", agentId: "worker",
  backgroundRun: { parentSessionId: "thread-1", agentId: "worker", runId: "run-1" } };

async function fixture() {
  const client = new FakeClient([]);
  client.respond = vi.fn();
  client.respondError = vi.fn();
  client.supportsExperimental = capability => capability === "interactionStatusReadV1";
  const request = client.request.bind(client);
  const reads: Array<(status: "pending" | "resolved") => void> = [];
  client.request = <T,>(method: string, params: JsonRecord = {}): Promise<T> => {
    if (method === "interaction/status/read") return new Promise(resolve => {
      reads.push(status => resolve({ ...params, status } as T));
    });
    return request<T>(method, params);
  };
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
    profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
  const registry = new TaskRuntimeRegistry();
  registries.push(registry);
  registry.put(profile.id, server.id, runtime);
  const emit = (sourceAgent: JsonRecord = source) => client.emit({ id: 41, method: "question/request", params: {
    serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn-1",
    appServerEpoch: "epoch-1", questionId: "question-1", sourceAgent,
    questions: [{ id: "choice", prompt: "Original question", options: [] }],
  } });
  emit();
  const original = runtime.pendingInteractions[0]!;
  const selector = selectorForInteraction(original);
  return { client, runtime, registry, emit, reads, original, selector };
}

test.each(["before", "during"])(
  "a source conflict %s status reconciliation cannot reopen the original question", async when => {
    const f = await fixture();
    let reconciliation: Promise<void> | undefined;
    if (when === "during") reconciliation = f.runtime.reconcilePendingInteractions(true);
    f.emit({ ...source, agentId: "different-worker" });
    expect(f.runtime.pendingInteractions[0]?.owner.status).toBe("unsupported");
    if (when === "before") reconciliation = f.runtime.reconcilePendingInteractions(true);
    f.reads.splice(0).forEach(finish => finish("pending"));
    await reconciliation;
    const current = f.runtime.pendingInteractions[0]!;
    expect(f.runtime.isInteractionActionable(current)).toBe(false);
    expect(f.runtime.getSnapshot()).toMatchObject({ interaction: null, interactionCount: 0 });
    expect(f.registry.interactionInboxRows(f.original.owner.profileAuthorizationScopeKey))
      .toEqual([expect.objectContaining({ requestId: 41, liveActionable: false, status: "unsupported" })]);
    expect(() => f.runtime.respondAgentQuestions("worker", 41, { choice: ["answer"] }, false, f.selector))
      .toThrow(/失效|只支持核对/);
    expect(() => f.runtime.cancelQuestions(f.selector)).toThrow(/失效|只支持核对/);
    expect(f.client.respond).not.toHaveBeenCalled();
    expect(f.client.respondError).not.toHaveBeenCalled();
    // An exact replay cannot remove the local conflict evidence either.
    f.emit();
    expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[0]!)).toBe(false);
    const resolved = f.runtime.reconcilePendingInteractions(true);
    f.reads.splice(0).forEach(finish => finish("resolved"));
    await resolved;
    expect(f.runtime.pendingInteractions).toHaveLength(0);
  },
);

test.each([
  { ...source, backgroundRun: { ...source.backgroundRun, runId: "run-2" } },
  { ...source, backgroundRun: { ...source.backgroundRun, agentId: "different-worker" } },
  { ...source, backgroundRun: { ...source.backgroundRun, parentSessionId: "different-parent" } },
  { parentSessionId: source.parentSessionId, agentId: source.agentId },
])("a changed exact background run closes input: %j", async replacement => {
  const f = await fixture();
  f.emit(replacement);
  expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[0]!)).toBe(false);
  expect(f.runtime.pendingInteractions[0]).toMatchObject({
    kind: "question", sourceAgent: source,
    questions: f.original.kind === "question" ? f.original.questions : [],
  });
  expect(() => f.runtime.respondAgentQuestions("worker", 41, { choice: ["answer"] }, false, f.selector))
    .toThrow(/失效|只支持核对/);
  expect(f.client.respond).not.toHaveBeenCalled();
});

test("an exact source replay and a pending status read preserve a valid original response", async () => {
  const f = await fixture();
  // Field ordering in a JSON transport does not change the run identity.
  f.emit({ agentId: source.agentId, parentSessionId: source.parentSessionId,
    backgroundRun: { runId: "run-1", agentId: "worker", parentSessionId: "thread-1" } });
  const reconciliation = f.runtime.reconcilePendingInteractions(true);
  f.reads.splice(0).forEach(finish => finish("pending"));
  await reconciliation;
  expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[0]!)).toBe(true);
  f.runtime.respondAgentQuestions("worker", 41, { choice: ["answer"] }, false, f.selector);
  expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(41, { answers: { choice: { answers: ["answer"] } } });
});

test.each([
  { parentSessionId: "foreign-parent", agentId: "worker" },
  { parentSessionId: "thread-1", agentId: "" },
  { ...source, backgroundRun: { ...source.backgroundRun, parentSessionId: "foreign-parent" } },
  { ...source, backgroundRun: { ...source.backgroundRun, agentId: "different-worker" } },
  { ...source, backgroundRun: { parentSessionId: "thread-1", agentId: "worker" } },
  { ...source, backgroundRun: { ...source.backgroundRun, runId: " " } },
  { ...source, backgroundRun: [] },
])("an initially invalid source stays read-only after status refresh: %j", async sourceAgent => {
  const f = await fixture();
  // Use a distinct request so this tests initial validation, not replay detection.
  f.client.emit({ id: 42, method: "question/request", params: {
    serverId: f.client.getAppServerId(), threadId: "thread-1", turnId: "turn-1",
    appServerEpoch: "epoch-1", questionId: "invalid-source-question", sourceAgent,
    questions: [{ id: "choice", prompt: "Untrusted source", options: [] }],
  } });
  const invalid = f.runtime.pendingInteractions[1]!;
  expect(invalid.owner.status).toBe("unsupported");
  const reconciliation = f.runtime.reconcilePendingInteractions(true);
  // Reconciliation reads requests sequentially.
  f.reads.splice(0).forEach(finish => finish("pending"));
  await vi.waitFor(() => expect(f.reads).toHaveLength(1));
  f.reads.splice(0).forEach(finish => finish("pending"));
  await reconciliation;
  expect(f.runtime.isInteractionActionable(f.runtime.pendingInteractions[1]!)).toBe(false);
  expect(() => f.runtime.respondQuestions({ choice: ["answer"] }, selectorForInteraction(invalid)))
    .toThrow(/失效|只支持核对/);
  expect(f.client.respond).not.toHaveBeenCalled();
});
