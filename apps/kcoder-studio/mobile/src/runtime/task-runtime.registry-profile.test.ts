import { gatewaySessionExpired } from "@/gateway/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TaskRuntime,
  taskRuntimeRegistry,
  taskRuntimeTestHelpers,
} from "./task-runtime";
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
describe("TaskRuntime 注册表", () => {
  it("删除 Gateway 时关闭该 profile 的全部 runtime", async () => {
    const first = new FakeClient([]);
    const second = new FakeClient([]);
    const clients = [first, second];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const one = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const two = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-2",
    });
    taskRuntimeRegistry.put(profile.id, server.id, one);
    taskRuntimeRegistry.put(profile.id, server.id, two);

    taskRuntimeRegistry.removeProfile(profile.id);

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(
      taskRuntimeRegistry.get(profile.id, server.id, "thread-1"),
    ).toBeUndefined();
  });
});
