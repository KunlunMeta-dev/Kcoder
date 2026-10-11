import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import {
  WORKSPACE_READ_V2,
  WORKSPACE_RECEIPTS_V2,
  WORKSPACE_SCOPE_V2,
  workspaceParamsDigestV2,
  type WorkspaceMutationMethodV2,
} from "@/protocol/workspace-operation-receipts-v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveManagedWorktree,
  forgetManagedWorktree,
  listManagedWorktrees,
  listWorkspaceThreadScopes,
  prepareManagedWorktree,
  previewManagedWorktreeArchive,
  restoreManagedWorktree,
  taskRuntimeTestHelpers,
} from "./task-runtime";
import { profile, server } from "./task-runtime/fixture.test-support";
const operationStorage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => operationStorage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { operationStorage.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { operationStorage.delete(key); }),
  getAllKeys: vi.fn(async () => [...operationStorage.keys()]),
} }));
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));
beforeEach(() => {
  installBrowserProfileFixture([profile]);
  operationStorage.clear();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});
describe("移动端项目管理", () => {
  it("会话目录范围包括默认目录、已登记项目与 active worktree 并按路径去重", async () => {
    const client = {
      close: vi.fn(),
      request: vi.fn(async (method: string) =>
        method === "runtime.workspaces.list"
          ? {
              items: [
                { workspacePath: "/workspace", label: "Workspace root" },
                { workspacePath: "/workspace/project/", label: "Project" },
              ],
            }
          : {
              items: [
                { path: "/workspace/project", state: "active" },
                { path: "/workspace/old", state: "restorable" },
              ],
            },
      ),
    };
    const connect = vi.fn(async () => client as never);
    taskRuntimeTestHelpers.setConnector(connect as never);

    const result = await listWorkspaceThreadScopes(profile, {
      ...server,
      workspacePath: "/workspace/",
    });

    expect(result.error).toBeNull();
    expect(result.options).toEqual([
      { path: "/workspace", label: "Workspace root", kind: "workspace" },
      { path: "/workspace/project/", label: "Project", kind: "workspace" },
      {
        path: "/workspace/project",
        label: "project",
        kind: "worktree",
      },
    ]);
    expect(result.servers.map((item) => item.workspacePath)).toEqual([
      "/workspace/",
      "/workspace/project/",
    ]);
    expect(connect).toHaveBeenCalledWith(
      profile,
      { ...server, workspacePath: "/workspace/" },
      "/workspace/",
      "runtime",
      { signal: expect.any(AbortSignal) },
    );
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("workspace目录读取失败时保留root和先前登记项并显式返回错误", async () => {
    const client = {
      close: vi.fn(),
      request: vi.fn(async (method: string) => {
        if (method === "runtime.workspaces.list")
          throw new Error("workspace registry unavailable");
        return { items: [] };
      }),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const knownOptions = [
      { path: "/workspace/known", label: "Known project", kind: "workspace" as const },
    ];
    const result = await listWorkspaceThreadScopes(
      profile,
      server,
      knownOptions,
    );

    expect(result.error).toBe("workspace registry unavailable");
    expect(result.options).toEqual(knownOptions);
    expect(result.servers.map((item) => item.workspacePath)).toEqual([
      "/workspace",
      "/workspace/known",
    ]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("注册目录响应缺少items时不将其误报为空且完整的目录清单", async () => {
    const client = {
      close: vi.fn(),
      request: vi.fn(async (method: string) =>
        method === "runtime.workspaces.list" ? {} : { items: [] },
      ),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const result = await listWorkspaceThreadScopes(profile, server);

    expect(result.error).toBe("app-server 未返回有效的已登记项目列表");
    expect(result.options).toEqual([]);
    expect(result.servers.map((item) => item.workspacePath)).toEqual([
      server.workspacePath,
    ]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("去重Windows drive root时保留根分隔符", async () => {
    const client = {
      close: vi.fn(),
      request: vi.fn(async (method: string) =>
        method === "runtime.workspaces.list"
          ? { items: [{ workspacePath: "C:/", label: "Drive root" }] }
          : { items: [] },
      ),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const result = await listWorkspaceThreadScopes(profile, {
      ...server,
      workspacePath: "C:\\",
    });

    expect(result.servers.map((item) => item.workspacePath)).toEqual(["C:\\"]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("按 revision 和内容 token 完成 worktree 预检、归档、恢复与永久删除", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const active = {
      deviceId: "local",
      worktreeId: "mobile-safe",
      path: "/managed/mobile-safe/repository",
      repositoryName: "repository",
      permanent: false,
      revision: 3,
      state: "active",
      conversations: [],
    };
    const preview = {
      path: active.path,
      state: "active",
      revision: 3,
      contentToken: "content-token",
      dirty: true,
      untrackedFileCount: 1,
      ignoredEntryCount: 0,
      dirtySubmoduleCount: 0,
      nestedRepositoryCount: 0,
      baselineKnown: true,
      commitsSinceCreation: 1,
      requiresConfirmation: true,
      archiveAllowed: true,
      blockingReasons: [],
      archivedConversations: [],
    };
    const client = {
      subscribe: () => () => undefined,
      respond: () => undefined,
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord = {}) => {
        calls.push({ method, params });
        if (method === "runtime.worktrees.list") return { items: [active] };
        if (method === "thread/list")
          return {
            threads: [
              {
                id: "thread-linked",
                cwd: active.path,
                title: "关联任务",
                model: "test",
                status: "idle",
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          };
        if (method === "runtime.worktrees.archive.preview") return { preview };
        if (method === "runtime.worktrees.archive") {
          return { worktree: { ...active, revision: 5, state: "restorable" } };
        }
        if (method === "runtime.worktrees.restore") {
          return { worktree: { ...active, revision: 7, state: "active" } };
        }
        if (method === "runtime.worktrees.forget") return { forgotten: true };
        return {};
      }),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const [listed] = await listManagedWorktrees(profile, server);
    expect(listed).toMatchObject({
      worktreeId: "mobile-safe",
      revision: 3,
      state: "active",
    });
    const inspected = await previewManagedWorktreeArchive(
      profile,
      server,
      active.path,
    );
    const archived = await archiveManagedWorktree(
      profile,
      server,
      inspected,
      true,
    );
    expect(archived.state).toBe("restorable");
    await restoreManagedWorktree(profile, server, {
      ...listed!,
      revision: 5,
      state: "restorable",
    });
    await forgetManagedWorktree(profile, server, {
      ...listed!,
      revision: 9,
      state: "restorable",
    });

    expect(
      calls.find((call) => call.method === "runtime.worktrees.archive")?.params,
    ).toMatchObject({
      expectedRevision: 3,
      expectedContentToken: "content-token",
      riskAccepted: true,
      archivedConversations: [
        expect.objectContaining({
          threadId: "thread-linked",
          workspacePath: active.path,
        }),
      ],
    });
    expect(
      calls.find((call) => call.method === "runtime.worktrees.restore")?.params,
    ).toMatchObject({ expectedRevision: 5 });
    expect(
      calls.find((call) => call.method === "runtime.worktrees.forget")?.params,
    ).toMatchObject({ expectedRevision: 9, confirmPermanent: true });
    expect(client.close).toHaveBeenCalledTimes(6);
  });

  it("创建 worktree 前先在同一 app-server 登记源项目", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const scope = {
      version: 2 as const,
      rootId: "a".repeat(64),
      scopeId: "b".repeat(64),
      familyId: "c".repeat(64),
    };
    const client = {
      supportsExperimental: (capability: string) => capability === WORKSPACE_RECEIPTS_V2,
      subscribe: () => () => undefined,
      respond: () => undefined,
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord = {}) => {
        calls.push({ method, params });
        if (method === WORKSPACE_SCOPE_V2) return scope;
        if (method === WORKSPACE_READ_V2) return { scope, receipt: null };
        const mutation = method as WorkspaceMutationMethodV2;
        let result: JsonRecord;
        let workspacePath: string;
        if (mutation === "runtime.worktrees.prepareV2") {
          workspacePath = "/managed/mobile-test/repository";
          result = { success: true, path: workspacePath };
        } else if (mutation === "runtime.workspaces.openV2") {
          workspacePath = String(params.workspacePath);
          result = { workspacePath };
        } else {
          throw new Error(`unexpected review RPC: ${method}`);
        }
        return {
          scope,
          receipt: {
            clientRequestId: String(params.clientRequestId),
            method: mutation,
            paramsDigest: workspaceParamsDigestV2(mutation, params),
            status: "ready",
            workspacePath,
          },
          result,
        };
      }),
    };
    const connector = vi.fn(async () => client as never);
    taskRuntimeTestHelpers.setConnector(connector as never);

    await expect(
      prepareManagedWorktree(profile, server, "/external/repository", "main"),
    ).resolves.toBe("/managed/mobile-test/repository");
    expect(connector).toHaveBeenCalledWith(
      profile,
      server,
      server.workspacePath,
    );
    expect(calls.map((call) => call.method)).toEqual([
      WORKSPACE_SCOPE_V2,
      "runtime.workspaces.openV2",
      WORKSPACE_SCOPE_V2,
      "runtime.worktrees.prepareV2",
      WORKSPACE_SCOPE_V2,
    ]);
    expect(calls[1]?.params).toMatchObject({
      workspacePath: "/external/repository",
      label: "repository",
      scopeId: scope.scopeId,
      clientRequestId: expect.any(String),
    });
    expect(calls[3]?.params).toMatchObject({
      sourcePath: "/external/repository",
      ref: "main",
      permanent: false,
      scopeId: scope.scopeId,
      clientRequestId: expect.any(String),
    });
    expect(client.close).toHaveBeenCalledOnce();
  });
});

beforeEach(() => installBrowserProfileFixture([profile]));
