import { gatewaySessionExpired } from "@/gateway/http";
import type { RpcMessage } from "@/gateway/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import {
  FakeClient,
  profile,
  server,
} from "./task-runtime/fixture.test-support";
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
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
describe("Mobile bounded restoration notifications", () => {
  it.each(["frames", "bytes"])(
    "rejects %s overflow without replaying an incomplete stream and permits a fresh authoritative read",
    async (kind) => {
      const notifications: RpcMessage[] =
        kind === "frames"
          ? Array.from({ length: 513 }, (_, sequence) => ({
              method: "item/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                sequence,
                delta: { text: "discarded" },
              },
            }))
          : [
              {
                method: "item/delta",
                params: { delta: { text: "x".repeat(1024 * 1024) } },
              },
            ];
      const overflow = new FakeClient([], notifications);
      const recovered = new FakeClient([
        {
          id: "persisted",
          role: "assistant",
          content: "complete authoritative history",
          timestampMs: 1,
        },
      ]);
      const clients = [overflow, recovered];
      taskRuntimeTestHelpers.setConnector(
        vi.fn(async () => clients.shift() as never) as never,
      );
      await expect(
        TaskRuntime.resume({ profile, server, threadId: "thread-1" }),
      ).rejects.toThrow("缓存上限");
      expect(overflow.closed).toBe(true);
      expect(overflow.listeners.size).toBe(0);
      const task = await TaskRuntime.resume({
        profile,
        server,
        threadId: "thread-1",
      });
      expect(
        task.getSnapshot().messages.map((message) => message.content),
      ).toEqual(["complete authoritative history"]);
      task.close();
    },
  );
});
