import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
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
describe("TaskRuntimeRegistry", () => {
  it("第九个任务不会淘汰仍在运行的最早任务", async () => {
    const clients: Array<{
      client: FakeClient;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => {
        const client = new FakeClient([]);
        const close = vi.fn(() => undefined);
        client.close = close;
        client.request = vi.fn(
          async (method: string, params: JsonRecord = {}) => {
            if (method === "thread/resume")
              return {
                thread: {
                  id: String(params.threadId),
                  title: String(params.threadId),
                  cwd: "/workspace",
                  status: "idle",
                },
              } as never;
            if (method === "thread/read") return { messages: [] } as never;
            return {} as never;
          },
        );
        clients.push({ client, close });
        return client as never;
      }) as never,
    );

    for (let index = 0; index < 9; index += 1) {
      const runtime = await TaskRuntime.resume({
        profile,
        server,
        threadId: `thread-${index}`,
      });
      if (index === 0)
        clients[0].client.emit({
          method: "turn/started",
          params: { turnId: "turn-running" },
        });
      taskRuntimeRegistry.put(profile.id, server.id, runtime);
    }

    expect(clients[0].close).not.toHaveBeenCalled();
    taskRuntimeRegistry.removeProfile(profile.id);
  });

  it("第九个任务不会淘汰仍有后台 PTY 的任务", async () => {
    const clients: Array<{
      client: FakeClient;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => {
        const client = new FakeClient([]);
        const close = vi.fn(() => undefined);
        client.close = close;
        client.request = vi.fn(
          async (method: string, params: JsonRecord = {}) => {
            if (method === "thread/resume")
              return {
                thread: {
                  id: String(params.threadId),
                  title: String(params.threadId),
                  cwd: "/workspace",
                  status: "idle",
                },
              } as never;
            if (method === "thread/read") return { messages: [] } as never;
            if (method === "terminal/start")
              return {
                session_id: "background-pty",
                cwd: "/workspace",
              } as never;
            if (method === "terminal/attach")
              return {
                session_id: params.session_id,
                cwd: "/workspace",
                transcript: "",
                through_sequence: 0,
              } as never;
            return {} as never;
          },
        );
        clients.push({ client, close });
        return client as never;
      }) as never,
    );

    for (let index = 0; index < 9; index += 1) {
      const runtime = await TaskRuntime.resume({
        profile,
        server,
        threadId: `terminal-thread-${index}`,
      });
      if (index === 0) await runtime.terminalSession("terminal-main").start();
      taskRuntimeRegistry.put(profile.id, server.id, runtime);
    }

    expect(clients[0].close).not.toHaveBeenCalled();
    expect(clients[1].close).toHaveBeenCalledOnce();
    taskRuntimeRegistry.removeProfile(profile.id);
  });

  it("归档后从 registry 移除会立即释放 RPC lease", async () => {
    const client = new FakeClient([]);
    const close = vi.fn(() => undefined);
    client.close = close;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-archive",
    });
    await runtime.archive();
    taskRuntimeRegistry.put(profile.id, server.id, runtime);

    taskRuntimeRegistry.remove(
      profile.id,
      server.id,
      runtime.getSnapshot().threadId,
    );

    expect(close).toHaveBeenCalledTimes(1);
  });
});
