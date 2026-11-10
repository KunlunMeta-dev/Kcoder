import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { selectorForInteraction } from "./task-runtime/interactions";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

for (const kind of ["question", "approval"] as const) {
  test.each(["profileAuthorizationScopeKey", "serverId", "serverConfigIdentity"] as const)(
    `${kind}: status read settles only its captured owner when %s differs`, async field => {
      const client = new FakeClient([]);
      const request = client.request.bind(client);
      let finish!: () => void;
      client.supportsExperimental = capability => capability === "interactionStatusReadV1";
      client.request = <T,>(method: string, params: JsonRecord = {}): Promise<T> => {
        if (method !== "interaction/status/read") return request<T>(method, params);
        return new Promise(resolve => { finish = () => resolve({ ...params, status: "resolved" } as T); });
      };
      client.respond = vi.fn();
      client.respondError = vi.fn();
      taskRuntimeTestHelpers.setConnector(async () => client as never);
      const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
        profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
      runtimes.push(runtime);
      client.emit({ id: 41, method: `${kind}/request`, params: {
        serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn-1", appServerEpoch: "epoch-1",
        ...(kind === "question"
          ? { questionId: "question-41", questions: [{ id: "choice", prompt: "Which?", options: [] }] }
          : { approvalId: "approval-41", action: { type: "command", command: "echo fixture" } }),
      } });
      const original = runtime.pendingInteractions[0]!;
      const reading = runtime.reconcilePendingInteractions(true);
      // A retained projection from another target/auth scope can name the same
      // native request. Its scope was not checked by this in-flight status read.
      runtime.enqueueInteraction({ ...original, owner: { ...original.owner, [field]: "other-owner" } });
      const retained = runtime.pendingInteractions[1]!;
      expect(retained).toBeDefined();
      const selector = selectorForInteraction(retained);
      expect(runtime.focusInteraction(selector)).toBe("readOnly");
      const settled = vi.fn();
      runtime.notifyInteractionResolved = settled;
      finish();
      await reading;
      expect(runtime.pendingInteractions).toEqual([retained]);
      expect(runtime.focusedInteractionSelector).toEqual(selector);
      expect(settled).toHaveBeenCalledOnce();
      expect(selectorForInteraction(settled.mock.calls[0]![0])).toEqual(selectorForInteraction(original));
      expect(client.respond).not.toHaveBeenCalled();
      expect(client.respondError).not.toHaveBeenCalled();
    },
  );
}
