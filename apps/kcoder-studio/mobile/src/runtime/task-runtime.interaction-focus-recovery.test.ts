import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { selectorForInteraction } from "./task-runtime/interactions";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(kind: "question" | "approval") {
  const client = new FakeClient([]);
  const request = client.request.bind(client);
  let finishRead!: (status: string, overrides?: JsonRecord) => void;
  client.supportsExperimental = (capability) => capability === "interactionStatusReadV1";
  client.request = <T,>(method: string, params: JsonRecord = {}): Promise<T> => {
    if (method !== "interaction/status/read") return request<T>(method, params);
    return new Promise((resolve) => {
      finishRead = (status, overrides = {}) => resolve({ ...params, status, ...overrides } as T);
    });
  };
  client.respond = vi.fn();
  client.respondError = vi.fn();
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({
    profile, server, threadId: "thread-1", profileActivationEpoch: 1,
    isCurrentInteractionOwner: () => true,
  });
  runtimes.push(runtime);
  const prompt = (id: number) => client.emit({ id, method: `${kind}/request`, params: {
    serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn-1",
    appServerEpoch: "epoch-1",
    ...(kind === "question"
      ? { questionId: `question-${id}`, questions: [{ id: "choice", prompt: "Which?", options: [] }] }
      : { approvalId: `approval-${id}`, action: { type: "command", command: "echo fixture" } }),
  } });
  prompt(41);
  runtime.focusInteraction(selectorForInteraction(runtime.pendingInteractions[0]!));
  const reconcile = runtime.reconcilePendingInteractions(true);
  // A second request arrives after the read captured the first request. The
  // missing resolved notification must not leave the original focus blocking it.
  prompt(42);
  return { client, runtime, reconcile, finish: (status: string, overrides?: JsonRecord) => finishRead(status, overrides) };
}

for (const kind of ["question", "approval"] as const) {
  test(`${kind}: resolving a focused request by status read reveals the next card without replaying input`, async () => {
    const f = await fixture(kind);
    f.finish("resolved");
    await f.reconcile;
    expect(f.runtime.pendingInteractions.map((item) => item.requestId)).toEqual([42]);
    expect(f.runtime.getSnapshot()).toMatchObject({ interactionCount: 1, interaction: { requestId: 42 } });
    expect(f.client.respond).not.toHaveBeenCalled();
    expect(f.client.respondError).not.toHaveBeenCalled();
    if (kind === "question") f.runtime.respondQuestions({ choice: ["next answer"] });
    else f.runtime.respondApproval("accept");
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(42, kind === "question"
      ? { answers: { choice: { answers: ["next answer"] } } }
      : { decision: "accept" });
  });

  test(`${kind}: a late resolved read preserves a different request selected while waiting`, async () => {
    const f = await fixture(kind);
    const peer = selectorForInteraction(f.runtime.pendingInteractions[1]!);
    f.runtime.focusInteraction(peer);
    f.finish("resolved");
    await f.reconcile;
    expect(f.runtime.focusedInteractionSelector).toEqual(peer);
    expect(f.runtime.getSnapshot()).toMatchObject({ interaction: { requestId: 42 } });
  });

  test(`${kind}: a foreign resolved receipt cannot remove the focused request or expose another answer target`, async () => {
    const f = await fixture(kind);
    f.finish("resolved", { turnId: "foreign-turn" });
    await f.reconcile;
    expect(f.runtime.pendingInteractions.map((item) => item.requestId)).toEqual([41, 42]);
    expect(f.runtime.getSnapshot()).toMatchObject({ interactionCount: 1, interaction: null });
    expect(f.client.respond).not.toHaveBeenCalled();
    expect(f.client.respondError).not.toHaveBeenCalled();
  });
}
