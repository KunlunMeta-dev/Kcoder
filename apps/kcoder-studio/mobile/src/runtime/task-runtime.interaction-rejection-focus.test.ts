import { afterEach, expect, test, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { selectorForInteraction } from "./task-runtime/interactions";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

for (const kind of ["question", "approval"] as const) {
  test.each(["original", "readOnly", "next"] as const)(`${kind}: a turn-ended rejection releases only the original focus (focused=%s)`, async focus => {
    const client = new FakeClient([]);
    client.respond = vi.fn();
    const request = client.request.bind(client);
    client.supportsExperimental = capability => capability === "interactionStatusReadV1";
    client.request = async (method, params = {}) => method === "interaction/status/read"
      ? { ...params, status: "unknown" } as never : request(method, params);
    taskRuntimeTestHelpers.setConnector(async () => client as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
      profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
    runtimes.push(runtime);
    const binding = (id: number) => ({ threadId: "thread-1", turnId: `turn-${id}`,
      appServerEpoch: "epoch", ...(kind === "question"
        ? { questionId: `question-${id}` } : { approvalId: `approval-${id}` }) });
    const prompt = (id: number) => client.emit({ id, method: `${kind}/request`, params: {
      ...binding(id), serverId: client.getAppServerId(), ...(kind === "question"
        ? { questions: [{ id: "choice", prompt: "Continue?", options: [] }] }
        : { action: { type: "command", command: "echo fixture" }, availableDecisions: ["accept"] }),
    } });
    prompt(41);
    const originalSelector = selectorForInteraction(runtime.pendingInteractions[0]!);
    runtime.focusInteraction(originalSelector);
    if (kind === "question") runtime.respondQuestions({ choice: ["original"] });
    else runtime.respondApproval("accept");
    if (focus === "readOnly") {
      await runtime.reconcilePendingInteractions(true);
      expect(runtime.focusInteraction(originalSelector)).toBe("readOnly");
    }
    prompt(42);
    const nextSelector = selectorForInteraction(runtime.pendingInteractions[1]!);
    if (focus === "next") runtime.focusInteraction(nextSelector);

    // A stale refusal cannot change either request's input authority or focus.
    client.emit({ method: "gateway/interaction/replyRejected", params: {
      ...binding(41), appServerEpoch: "foreign-epoch", requestId: 41, reason: "turn_ended",
    } });
    expect(runtime.focusedInteractionSelector).toEqual(focus === "next" ? nextSelector : originalSelector);
    expect(runtime.pendingInteractions[0]?.turnEnded).not.toBe(true);

    // The terminal turn event was lost. The exact refusal is the only evidence
    // that this request's input closed; its answer outcome must remain unknown.
    client.emit({ method: "gateway/interaction/replyRejected", params: {
      ...binding(41), requestId: 41, reason: "turn_ended",
    } });
    expect(runtime.pendingInteractions).toHaveLength(2);
    expect(runtime.pendingInteractions[0]).toMatchObject({ turnEnded: true, responding: false });
    expect(runtime.focusedInteractionSelector).toEqual(focus === "next" ? nextSelector : null);
    expect(runtime.getSnapshot()).toMatchObject({ interactionCount: 1, interaction: { requestId: 42 },
      interactionFocusStatus: undefined });
    expect(client.respond).toHaveBeenCalledTimes(1);
    expect(() => kind === "question"
      ? runtime.respondQuestions({ choice: ["late answer"] }, originalSelector)
      : runtime.respondApproval("accept", originalSelector)).toThrow();
    if (kind === "question") runtime.respondQuestions({ choice: ["next answer"] });
    else runtime.respondApproval("accept");
    expect(client.respond).toHaveBeenLastCalledWith(42, kind === "question"
      ? { answers: { choice: { answers: ["next answer"] } } } : { decision: "accept" });

    client.emit({ method: `${kind}/resolved`, params: {
      ...binding(41), requestId: 41, reason: "client_response",
    } });
    expect(runtime.pendingInteractions.map(item => item.requestId)).toEqual([42]);
  });
}
