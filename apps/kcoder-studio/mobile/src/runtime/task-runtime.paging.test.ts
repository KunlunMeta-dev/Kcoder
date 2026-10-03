import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadMessage,
} from "@/gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteStoredThread,
  listThreads,
  previewManagedWorktreeArchive,
  taskRuntimeTestHelpers,
  ThreadListPager,
  updateThreadMetadata,
} from "./task-runtime";
import { profile, server } from "./task-runtime/fixture.test-support";
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
describe("ThreadListPager", () => {
  it("新协议缺少会话数组时不把响应伪装成完整空列表", async () => {
    const client = {
      close: vi.fn(),
      supportsExperimental: () => true,
      request: vi.fn(async () => ({ completeness: "complete", issueCount: 0 })),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    await expect(listThreads(profile, server)).rejects.toThrow("会话列表");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("分页出现重复 cursor 或完整性变化时关闭短连接且拒绝替换列表", async () => {
    for (const mode of ["cursor", "completeness"]) {
      const client = {
        close: vi.fn(),
        supportsExperimental: () => true,
        request: vi.fn(async (_method: string, params: JsonRecord) => ({
          threads: [],
          nextCursor: "same",
          completeness:
            mode === "completeness" && params.cursor ? "partial" : "complete",
          issueCount: mode === "completeness" && params.cursor ? 2 : 0,
        })),
      };
      taskRuntimeTestHelpers.setConnector(
        vi.fn(async () => client as never) as never,
      );
      await expect(listThreads(profile, server)).rejects.toThrow(
        mode === "cursor" ? "重复" : "完整性",
      );
      expect(client.close).toHaveBeenCalledTimes(1);
    }
  });

  it("自动列表遍历对不断生成的空页有上限", async () => {
    let requests = 0;
    const client = {
      close: vi.fn(),
      supportsExperimental: () => true,
      request: vi.fn(async () => ({
        threads: [],
        completeness: "complete",
        issueCount: 0,
        ...(requests++ < 205 ? { nextCursor: `cursor-${requests}` } : {}),
      })),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    await expect(listThreads(profile, server)).rejects.toThrow("分页");
    expect(requests).toBeLessThanOrEqual(200);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("每页显式选择 partial 并保留完整快照的问题数量", async () => {
    const client = {
      close: vi.fn(),
      supportsExperimental: (name: string) => name === "threadListCompleteness",
      request: vi.fn(async (_method: string, params: JsonRecord) => ({
        threads: [
          {
            id: params.cursor ? "b" : "a",
            status: "idle",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        completeness: "partial",
        issueCount: 2,
        ...(params.cursor ? {} : { nextCursor: "snapshot:1" }),
      })),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const pager = new ThreadListPager(profile, server);
    try {
      const first = await pager.page();
      expect(first).toMatchObject({
        completeness: "partial",
        issueCount: 2,
        nextCursor: "snapshot:1",
      });
      const second = await pager.page(first.nextCursor);
      expect(second).toMatchObject({ completeness: "partial", issueCount: 2 });
      expect(second.threads.map((thread) => thread.id)).toEqual(["a", "b"]);
      expect(
        client.request.mock.calls.map(([, params]) => params.allowPartial),
      ).toEqual([true, true]);
    } finally {
      pager.close();
    }
  });

  it("首页列表排完分页并返回完整性而非仅首页数组", async () => {
    const client = {
      close: vi.fn(),
      supportsExperimental: () => false,
      request: vi.fn(async (_method: string, params: JsonRecord) => ({
        threads: [
          {
            id: params.cursor ? "b" : "a",
            status: "idle",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        ...(params.cursor ? {} : { nextCursor: "snapshot:1" }),
      })),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const result = await listThreads(profile, server);
    expect(result).toMatchObject({ completeness: "complete", issueCount: 0 });
    expect(result.threads.map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(
      client.request.mock.calls.every(
        ([, params]) => !("allowPartial" in params),
      ),
    ).toBe(true);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("关联会话 partial 时拒绝 worktree 归档预检及释放", async () => {
    const client = {
      close: vi.fn(),
      supportsExperimental: () => true,
      request: vi.fn(async (method: string) =>
        method === "thread/list"
          ? { threads: [], completeness: "partial", issueCount: 1 }
          : { preview: {} },
      ),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    await expect(
      previewManagedWorktreeArchive(profile, server, "/worktree"),
    ).rejects.toThrow("不完整");
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/list",
    ]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("在同一条 RPC 连接上按 cursor 分页并在结束时关闭", async () => {
    const requests: JsonRecord[] = [];
    const client = {
      close: vi.fn(),
      request: vi.fn(async (_method: string, params: JsonRecord) => {
        requests.push(params);
        return params.cursor
          ? {
              threads: [
                { id: "thread-1", status: "idle", createdAt: 1, updatedAt: 1 },
              ],
            }
          : {
              threads: [
                { id: "thread-2", status: "idle", createdAt: 2, updatedAt: 2 },
              ],
              nextCursor: "snapshot:1",
            };
      }),
    };
    const connect = vi.fn(async () => client as never);
    taskRuntimeTestHelpers.setConnector(connect as never);
    const pager = new ThreadListPager(profile, server, {
      archived: false,
      query: "workspace",
    });

    const first = await pager.page(undefined, 50);
    const second = await pager.page(first.nextCursor, 50);
    pager.close();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([
      { limit: 50, archived: false, query: "workspace" },
      { limit: 50, cursor: "snapshot:1", archived: false, query: "workspace" },
    ]);
    expect(second.threads.map((thread) => thread.id)).toEqual([
      "thread-2",
      "thread-1",
    ]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("历史列表操作使用短连接并保证关闭", async () => {
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    const requestsByClient: Array<
      Array<{ method: string; params: JsonRecord }>
    > = [[], [], []];
    const clients = requestsByClient.map((clientRequests) => ({
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord) => {
        const request = { method, params };
        requests.push(request);
        clientRequests.push(request);
        return {};
      }),
    }));
    const connect = vi.fn(
      async (
        _profile: GatewayProfile,
        _server: KCoderServer,
        _workspacePath?: string,
      ) => clients[connect.mock.calls.length - 1] as never,
    );
    taskRuntimeTestHelpers.setConnector(connect as never);

    await updateThreadMetadata(
      profile,
      server,
      "thread-1",
      { title: "新标题", archivedAt: null },
      "/workspace/project",
    );
    await deleteStoredThread(
      profile,
      server,
      "thread-1",
      "/workspace/project",
      ["/attachments/a.png"],
    );

    expect(requests).toEqual([
      {
        method: "thread/metadata/update",
        params: { threadId: "thread-1", title: "新标题", archivedAt: null },
      },
      { method: "thread/read", params: { threadId: "thread-1", limit: 50 } },
      { method: "thread/delete", params: { threadId: "thread-1" } },
      {
        method: "runtime.worktrees.conversations.remove",
        params: {
          deviceId: "local",
          path: "/workspace/project",
          taskId: "thread-1",
        },
      },
      { method: "attachment/delete", params: { path: "/attachments/a.png" } },
    ]);
    expect(
      connect.mock.calls.map(([, , workspacePath]) => workspacePath),
    ).toEqual(["/workspace/project", "/workspace/project", "/workspace"]);
    expect(requestsByClient).toEqual([
      [
        {
          method: "thread/metadata/update",
          params: { threadId: "thread-1", title: "新标题", archivedAt: null },
        },
      ],
      [
        { method: "thread/read", params: { threadId: "thread-1", limit: 50 } },
        { method: "thread/delete", params: { threadId: "thread-1" } },
        { method: "attachment/delete", params: { path: "/attachments/a.png" } },
      ],
      [
        {
          method: "runtime.worktrees.conversations.remove",
          params: {
            deviceId: "local",
            path: "/workspace/project",
            taskId: "thread-1",
          },
        },
      ],
    ]);
    expect(clients.map((client) => client.close.mock.calls.length)).toEqual([
      1, 1, 1,
    ]);
  });

  it("永久删除历史任务前分页收集已发送附件并与排队附件去重", async () => {
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    const attachmentMessage = (id: string, path: string): ThreadMessage => ({
      id,
      role: "user",
      content: "附件",
      blocks: [
        {
          type: "attachment",
          attachment: {
            filename: `${id}.png`,
            mimeType: "image/png",
            fileSize: 42,
            path,
          },
        },
      ],
      timestampMs: 1,
    });
    const client = {
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord) => {
        requests.push({ method, params });
        if (method === "thread/read" && !params.beforeCursor) {
          return {
            messages: [
              attachmentMessage("new", "/attachments/new.png"),
              attachmentMessage("duplicate", "/attachments/queued.png"),
            ],
            hasMoreBefore: true,
            beforeCursor: "older:1",
          };
        }
        if (method === "thread/read") {
          return {
            messages: [attachmentMessage("old", "/attachments/old.png")],
            hasMoreBefore: false,
          };
        }
        return {};
      }),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    await deleteStoredThread(
      profile,
      server,
      "thread-with-attachments",
      "/workspace/project",
      ["/attachments/queued.png"],
    );

    expect(requests).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-with-attachments", limit: 50 },
      },
      {
        method: "thread/read",
        params: {
          threadId: "thread-with-attachments",
          limit: 50,
          beforeCursor: "older:1",
        },
      },
      {
        method: "thread/delete",
        params: { threadId: "thread-with-attachments" },
      },
      {
        method: "runtime.worktrees.conversations.remove",
        params: {
          deviceId: "local",
          path: "/workspace/project",
          taskId: "thread-with-attachments",
        },
      },
      {
        method: "attachment/delete",
        params: { path: "/attachments/queued.png" },
      },
      { method: "attachment/delete", params: { path: "/attachments/new.png" } },
      { method: "attachment/delete", params: { path: "/attachments/old.png" } },
    ]);
    expect(client.close).toHaveBeenCalledTimes(2);
  });
});
