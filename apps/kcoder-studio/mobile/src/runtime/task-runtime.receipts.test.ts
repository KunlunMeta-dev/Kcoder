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
describe("Mobile ordinary send receipts", () => {
  it.each([false, true])(
    "recovers accepted ordinary sends without another mutation, initial receipt missing=%s",
    async (missingFirst) => {
      const history: ThreadMessage[] = [];
      const client = new FakeClient(history);
      client.supportsExperimental = (name) => name === "turnReceiptsV1";
      const original = client.request.bind(client);
      let starts = 0,
        reads = 0;
      let acceptedId: unknown;
      client.request = async <T>(
        method: string,
        params: JsonRecord = {},
      ): Promise<T> => {
        if (method === "turn/start") {
          starts++;
          acceptedId = params.clientMessageId;
          history.push(
            {
              id: "server-user",
              role: "user",
              content: "once",
              timestampMs: Date.now(),
              turnId: "ordinary-turn",
            },
            {
              id: "server-result",
              role: "assistant",
              content: "authoritative result",
              timestampMs: Date.now(),
              turnId: "ordinary-turn",
            },
          );
          throw new MobileRpcError("reply lost");
        }
        if (method === "turn/receipt/read") {
          reads++;
          expect(params.clientMessageId).toBe(acceptedId);
          return {
            receipt:
              missingFirst && reads === 1
                ? null
                : {
                    threadId: "thread-1",
                    turnId: "ordinary-turn",
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
      await task.send("once");
      if (missingFirst) {
        expect(task.getSnapshot().sendAcceptanceUnknown).toBe(true);
        await expect(task.send("once")).rejects.toThrow("先核对执行状态");
        await task.reconcileSendAcceptance();
      }
      expect(starts).toBe(1);
      expect(task.getSnapshot().sendAcceptanceUnknown).toBe(false);
      expect(task.getSnapshot().running).toBe(false);
      expect(
        task
          .getSnapshot()
          .messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      expect(
        task
          .getSnapshot()
          .messages.some(
            (message) => message.content === "authoritative result",
          ),
      ).toBe(true);
      task.close();
    },
  );
});
