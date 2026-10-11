import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { MobileRpcError } from "@/gateway/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
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
  installBrowserProfileFixture([profile]);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});
describe("TaskRuntime.create", () => {
  it("routes session and one-turn modes explicitly and rejects unsupported servers before creation", async () => {
    const client = new FakeClient([]);
    const supportsExperimental = vi.fn(() => false);
    Object.assign(client, { supportsExperimental });
    client.close = vi.fn();
    client.request = vi.fn(async (method: string) => {
      if (method === "thread/start")
        return { thread: { id: "mode-thread" } } as never;
      if (method === "turn/start")
        return { turn: { id: "mode-turn" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    await expect(
      TaskRuntime.create({
        profile,
        server,
        cwd: "/workspace",
        prompt: "test",
        sessionMode: "orchestrate",
      }),
    ).rejects.toThrow("升级");
    expect(client.request).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    supportsExperimental.mockImplementation((capability?: string) => capability === "sessionModes");
    const task = await TaskRuntime.create({
      profile,
      server,
      cwd: "/workspace",
      prompt: "plan",
      sessionMode: "orchestrate",
      turnMode: "moa-plan",
    });
    expect(client.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({ sessionMode: "orchestrate" }),
    );
    expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ turnMode: "moa-plan" }),
    );
    task.close();
  });

  it("closes the client when thread/start rejects before returning a thread id", async () => {
    const calls: string[] = [];
    const client = new FakeClient([]);
    const startError = new MobileRpcError(
      "thread/start response timed out",
      -1,
      "transport",
    );
    client.close = vi.fn();
    client.request = vi.fn(async (method: string) => {
      calls.push(method);
      if (method === "thread/start") throw startError;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    await expect(
      TaskRuntime.create({
        profile,
        server,
        cwd: "/workspace",
        prompt: "创建任务超时",
      }),
    ).rejects.toBe(startError);

    expect(calls).toEqual(["thread/start"]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up the known empty thread when the managed-worktree connector rejects", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const primaryClient = new FakeClient([]);
    const registryConnectError = new Error("managed-worktree connector failed");
    primaryClient.close = vi.fn();
    primaryClient.request = vi.fn(
      async (method: string, params: JsonRecord = {}) => {
        calls.push({ method, params });
        if (method === "thread/start")
          return {
            thread: { id: "created-before-registry-connect" },
          } as never;
        if (method === "thread/delete") return { deleted: true } as never;
        return {} as never;
      },
    );
    const connector = vi.fn(async (_profile, _server, cwd: string) => {
      if (cwd === "/managed/source") throw registryConnectError;
      return primaryClient as never;
    });
    taskRuntimeTestHelpers.setConnector(connector as never);

    await expect(
      TaskRuntime.create({
        profile,
        server,
        cwd: "/managed/worktree",
        managedWorktreeSourcePath: "/managed/source",
        prompt: "创建worktree任务",
      }),
    ).rejects.toBe(registryConnectError);

    expect(connector).toHaveBeenCalledTimes(2);
    expect(connector.mock.calls.map(([, , cwd]) => cwd)).toEqual([
      "/managed/worktree",
      "/managed/source",
    ]);
    expect(calls).toEqual([
      { method: "thread/start", params: { cwd: "/managed/worktree" } },
      {
        method: "thread/delete",
        params: { threadId: "created-before-registry-connect" },
      },
    ]);
    expect(calls.some(({ method }) => method === "turn/start")).toBe(false);
    expect(primaryClient.close).toHaveBeenCalledTimes(1);
  });

  it("turn 启动失败时尽力删除刚创建的空 resident thread", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const client = new FakeClient([]);
    client.close = vi.fn();
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "thread/start")
        return { thread: { id: "empty-thread" } } as never;
      if (method === "turn/start")
        throw new MobileRpcError("turn rejected", -32602, "remote");
      if (method === "thread/delete") return { deleted: true } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    await expect(
      TaskRuntime.create({
        profile,
        server,
        cwd: "/workspace",
        prompt: "失败创建",
      }),
    ).rejects.toThrow("turn rejected");
    expect(calls.at(-1)).toEqual({
      method: "thread/delete",
      params: { threadId: "empty-thread" },
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("uses the model confirmed by thread/start when the client leaves it unspecified", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const client = new FakeClient([]);
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "thread/start") {
        return {
          thread: { id: "server-default", model: "MiniMax-M3" },
        } as never;
      }
      if (method === "turn/start") return { turn: { id: "turn-1" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.create({
      profile,
      server,
      cwd: "/workspace",
      prompt: "使用服务端默认模型",
    });

    expect(runtime.getSnapshot().model).toBe("MiniMax-M3");
    expect(calls).toContainEqual({
      method: "turn/start",
      params: {
        threadId: "server-default",
        input: [{ type: "text", text: "使用服务端默认模型" }],
        clientMessageId: expect.any(String),
        model: "MiniMax-M3",
      },
    });
    runtime.close();
  });
});
