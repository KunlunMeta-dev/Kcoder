import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { MobileRpcError } from "@/gateway/rpc";
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
    supportsExperimental.mockReturnValue(true);
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
