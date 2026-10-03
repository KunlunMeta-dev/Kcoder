import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { MobileRpcError } from "@/gateway/rpc";
import type { ThreadMessage } from "@/gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import {
  FakeClient,
  profile,
  server,
} from "./task-runtime/fixture.test-support";
vi.mock("@/gateway/http", () => ({
  gatewaySessionExpired: vi.fn(async () => false),
}));
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});
describe("TaskRuntime failed-attempt continuation", () => {
  const initial = (): ThreadMessage[] => [
    {
      id: "user-original",
      role: "user",
      turnId: "turn-1",
      content: "Original request",
      timestampMs: 1,
    },
    {
      id: "failure-original",
      role: "assistant",
      turnId: "turn-1",
      attemptId: "turn-1",
      status: "failed",
      content: "original partial",
      error: "fixture outage",
      timestampMs: 2,
    },
  ];
  const modern = (client: FakeClient) =>
    Object.assign(client, {
      supportsExperimental: (name: string) =>
        [
          "failedTurnContinuationV1",
          "turnRetryOperationV1",
          "turnAttemptRetryV1",
          "turnReceiptsV1",
        ].includes(name),
    });
  it("does not resend input and preserves separate failures across repeated continuations and late acknowledgements", async () => {
    const client = modern(new FakeClient(initial()));
    const original = client.request.bind(client);
    let count = 0;
    const requests: JsonRecord[] = [];
    client.request = async <T>(
      method: string,
      params: JsonRecord = {},
    ): Promise<T> => {
      if (method !== "turn/start") return original<T>(method, params);
      requests.push(params);
      count++;
      const attemptId = `continued-${count}`;
      const context = {
        serverId: "local",
        threadId: "thread-1",
        turnId: "turn-1",
      };
      client.emit({
        method: "turn/started",
        params: {
          ...context,
          sequence: count * 3,
          attemptId,
          turn: { id: "turn-1", attemptId },
        },
      });
      client.emit({
        method: "item/delta",
        params: {
          ...context,
          sequence: count * 3 + 1,
          delta: { text: `attempt ${count} text` },
        },
      });
      client.emit({
        method: "turn/completed",
        params: {
          ...context,
          sequence: count * 3 + 2,
          turn: {
            id: "turn-1",
            attemptId,
            status: count === 1 ? "failed" : "completed",
          },
          ...(count === 1 ? { error: { message: "second outage" } } : {}),
        },
      });
      return { turn: { id: "turn-1", attemptId, status: "running" } } as T;
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const task = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
      cwd: "/workspace",
    });
    await task.continueFailed("failure-original");
    expect(task.getSnapshot().running).toBe(false);
    const nextFailure = task
      .getSnapshot()
      .messages.find((item) => item.attemptId === "continued-1")!;
    expect(nextFailure.status).toBe("failed");
    await task.continueFailed(nextFailure.id);
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (request) =>
          Array.isArray(request.input) &&
          request.input.length === 0 &&
          !("model" in request),
      ),
    ).toBe(true);
    expect(requests[1]).toMatchObject({
      retryFromTurnId: "turn-1",
      retryFromAttemptId: "continued-1",
    });
    expect(
      task.getSnapshot().messages.filter((item) => item.role === "user"),
    ).toHaveLength(1);
    expect(
      task.getSnapshot().messages.find((item) => item.id === "failure-original")
        ?.content,
    ).toBe("original partial");
    expect(
      task.getSnapshot().messages.filter((item) => item.status === "failed"),
    ).toHaveLength(2);
    expect(task.getSnapshot().running).toBe(false);
    task.close();
  });

  it("refuses old servers without executing any mutation", async () => {
    const client = new FakeClient(initial());
    const request = vi.spyOn(client, "request");
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const task = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    request.mockClear();
    await expect(task.continueFailed("failure-original")).rejects.toThrow(
      "升级",
    );
    expect(request).not.toHaveBeenCalled();
    task.close();
  });

  it("queries ambiguous acceptance and keeps uncertainty read-only", async () => {
    const history = initial();
    const client = modern(new FakeClient(history));
    const original = client.request.bind(client);
    let starts = 0,
      queries = 0;
    client.request = async <T>(
      method: string,
      params: JsonRecord = {},
    ): Promise<T> => {
      if (method === "turn/start") {
        starts++;
        throw new MobileRpcError("lost response");
      }
      if (method === "turn/receipt/read") {
        queries++;
        if (queries === 1) return { receipt: null } as T;
        history[1].continuedByAttemptId = "recovered";
        history.push({
          id: "done",
          role: "assistant",
          turnId: "turn-1",
          content: "restored completion",
          status: "completed",
          timestampMs: 3,
        });
        return {
          receipt: {
            threadId: "thread-1",
            turnId: "turn-1",
            attemptId: "recovered",
            status: "completed",
          },
        } as T;
      }
      return original<T>(method, params);
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const task = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    await expect(task.continueFailed("failure-original")).rejects.toThrow(
      "未知",
    );
    expect(task.continuationState("failure-original").unknown).toBe(true);
    await expect(task.send("new work")).rejects.toThrow("先核对执行状态");
    expect(starts).toBe(1);
    await task.continueFailed("failure-original");
    expect(starts).toBe(1);
    expect(queries).toBe(2);
    expect(task.getSnapshot().running).toBe(false);
    expect(
      task
        .getSnapshot()
        .messages.some((item) => item.content === "restored completion"),
    ).toBe(true);
    task.close();
  });
});
