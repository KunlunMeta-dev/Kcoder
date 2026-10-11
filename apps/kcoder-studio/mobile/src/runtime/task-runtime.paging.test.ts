import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { installThreadDeletionCleanupAuthorityResolver, threadDeletionCleanupKey } from "@/storage/thread-deletion-cleanup";
import { saveWorkspaceState, workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import type {
  GatewayProfile,
  KCoderServer,
} from "@/gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteStoredThread,
  listThreads,
  mapThreadListScopes,
  previewManagedWorktreeArchive,
  taskRuntimeTestHelpers,
  ThreadListPager,
  updateThreadMetadata,
} from "./task-runtime";
import { profile, server } from "./task-runtime/fixture.test-support";
const pagingStorage = vi.hoisted(() => ({ values: new Map<string, string>() }));
let uninstallCleanupAuthority: (() => void) | undefined;
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => pagingStorage.values.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { pagingStorage.values.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { pagingStorage.values.delete(key); }),
  getAllKeys: vi.fn(async () => [...pagingStorage.values.keys()]),
  multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((key) => pagingStorage.values.delete(key)); }),
} }));
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
  pagingStorage.values.clear();
  uninstallCleanupAuthority = undefined;
  installBrowserProfileFixture([profile]);
});
afterEach(() => {
  uninstallCleanupAuthority?.();
  uninstallCleanupAuthority = undefined;
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});
describe("ThreadListPager", () => {
  it("限制同时执行的workspace历史请求数量且保留输入顺序", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapThreadListScopes(
      ["a", "b", "c", "d", "e", "f", "g"],
      async (scope) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return scope.toUpperCase();
      },
    );

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(result).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

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

  it("ThreadListPager使用显式workspace clone建立列表连接", async () => {
    const client = {
      close: vi.fn(),
      request: vi.fn(async () => ({ threads: [] })),
    };
    const connect = vi.fn(async () => client as never);
    taskRuntimeTestHelpers.setConnector(connect as never);
    const workspaceServer = { ...server, workspacePath: "/workspace/registered-b" };
    const pager = new ThreadListPager(profile, workspaceServer, { archived: false });
    try {
      await pager.page(undefined, 50);
      expect(connect).toHaveBeenCalledWith(profile, workspaceServer, "/workspace/registered-b", "runtime", { signal: expect.any(AbortSignal), priority: "foreground" });
    } finally {
      pager.close();
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

  it("历史修改和持久删除清理分别关闭其短连接", async () => {
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    const requestsByClient: Array<Array<{ method: string; params: JsonRecord }>> = [[], [], [], []];
    const clients = requestsByClient.map((owned) => ({
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord) => {
        requests.push({ method, params }); owned.push({ method, params });
        if (method === "thread/delete") {
          const raw = pagingStorage.values.get(threadDeletionCleanupKey(profile.id));
          expect(raw).not.toBeNull();
          const scope = workspaceStateAuthorizationScope(profile, server);
          expect(JSON.parse(raw!)).toEqual([{
            id: JSON.stringify([scope, "thread-1"]),
            scope,
            serverId: server.id,
            threadId: "thread-1",
            cwd: "/workspace/project",
            attachments: ["/attachments/a.png"],
            confirmed: false,
          }]);
        }
        return method === "gateway/attachments/discardRetained"
          ? { cleared: params.paths, pending: [] } : {};
      }),
    }));
    const connect = vi.fn(async (_profile: GatewayProfile, _server: KCoderServer, _cwd?: string) =>
      clients[connect.mock.calls.length - 1] as never);
    taskRuntimeTestHelpers.setConnector(connect as never);
    uninstallCleanupAuthority = installThreadDeletionCleanupAuthorityResolver(() => workspaceStateAuthorizationScope(profile, server));
    await updateThreadMetadata(profile, server, "thread-1", { title: "新标题", archivedAt: null }, "/workspace/project");
    await deleteStoredThread(profile, server, "thread-1", "/workspace/project", ["/attachments/a.png"]);
    await vi.waitFor(() => expect(pagingStorage.values.get(threadDeletionCleanupKey(profile.id))).toBe("[]"));
    expect(requests).toEqual([
      { method: "thread/metadata/update", params: { threadId: "thread-1", title: "新标题", archivedAt: null } },
      { method: "thread/delete", params: { threadId: "thread-1" } },
      { method: "gateway/attachments/discardRetained", params: { threadId: "thread-1", paths: ["/attachments/a.png"] } },
      { method: "runtime.worktrees.conversations.remove", params: { deviceId: "local", path: "/workspace/project", taskId: "thread-1" } },
    ]);
    expect(connect.mock.calls.map(([, , cwd]) => cwd)).toEqual([
      "/workspace/project", "/workspace/project", "/workspace/project", "/workspace",
    ]);
    expect(requestsByClient.map((owned) => owned.map((item) => item.method))).toEqual([
      ["thread/metadata/update"], ["thread/delete"], ["gateway/attachments/discardRetained"], ["runtime.worktrees.conversations.remove"],
    ]);
    expect(clients.map((client) => client.close.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it("删除完成后按持久队列与失败草稿的明确引用去重清理附件，不扫描全部历史", async () => {
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    const attachment = (name: string) => ({ filename: `${name}.png`, mimeType: "image/png", fileSize: 42, path: `/attachments/${name}.png` });
    const scope = workspaceStateAuthorizationScope(profile, server);
    await saveWorkspaceState(profile.id, server.id, "thread-with-attachments", {
      queuedMessages: [{ id: "queued-waiting", content: "never dispatch", createdAt: 1, attachments: [attachment("old"), attachment("queued")] }],
      failedSubmissions: [{ id: "failed", content: "never dispatch", createdAt: 1, outcome: "failed", attachments: [attachment("new")] }],
    }, scope);
    const client = {
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord) => {
        requests.push({ method, params });
        return method === "gateway/attachments/discardRetained" ? { cleared: params.paths, pending: [] } : {};
      }),
    };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    uninstallCleanupAuthority = installThreadDeletionCleanupAuthorityResolver(() => scope);
    await deleteStoredThread(profile, server, "thread-with-attachments", "/workspace/project", ["/attachments/queued.png"]);
    await vi.waitFor(() => expect(pagingStorage.values.get(threadDeletionCleanupKey(profile.id))).toBe("[]"));
    expect(requests).toEqual([
      { method: "thread/delete", params: { threadId: "thread-with-attachments" } },
      { method: "gateway/attachments/discardRetained", params: { threadId: "thread-with-attachments", paths: ["/attachments/queued.png", "/attachments/old.png", "/attachments/new.png"] } },
      { method: "runtime.worktrees.conversations.remove", params: { deviceId: "local", path: "/workspace/project", taskId: "thread-with-attachments" } },
    ]);
    expect(client.close).toHaveBeenCalledTimes(3);
  });
});

beforeEach(() => installBrowserProfileFixture([profile]));
