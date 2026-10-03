import { gatewaySessionExpired } from "@/gateway/http";
import { MobileRpcError } from "@/gateway/rpc";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
it("does not delete a newly accepted thread when its first turn response is lost", async () => {
  const client = new FakeClient([]);
  const calls: string[] = [];
  client.request = async <T>(method: string): Promise<T> => {
    calls.push(method);
    if (method === "thread/start")
      return { thread: { id: "accepted-thread" } } as T;
    if (method === "turn/start") throw new MobileRpcError("response lost");
    return {} as T;
  };
  taskRuntimeTestHelpers.setConnector(
    vi.fn(async () => client as never) as never,
  );
  const task = await TaskRuntime.create({
    profile,
    server,
    cwd: "/workspace",
    prompt: "once",
  });
  expect(task.getSnapshot().sendAcceptanceUnknown).toBe(true);
  await expect(task.send("duplicate")).rejects.toThrow("先核对执行状态");
  expect(calls.filter((method) => method === "turn/start")).toHaveLength(1);
  expect(calls).not.toContain("thread/delete");
  expect(client.closed).toBe(false);
  task.close();
  expect(client.closed).toBe(true);
});
