import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveManagedWorktree,
  forgetManagedWorktree,
  listManagedWorktrees,
  prepareManagedWorktree,
  previewManagedWorktreeArchive,
  restoreManagedWorktree,
  taskRuntimeTestHelpers,
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
describe("移动端项目管理", () => {
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
    const client = {
      subscribe: () => () => undefined,
      respond: () => undefined,
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord = {}) => {
        calls.push({ method, params });
        if (method === "runtime.worktrees.prepare") {
          return { success: true, path: "/managed/mobile-test/repository" };
        }
        return { success: true, workspacePath: params.workspacePath };
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
      "runtime.workspaces.open",
      "runtime.worktrees.prepare",
    ]);
    expect(calls[1]?.params).toMatchObject({
      sourcePath: "/external/repository",
      ref: "main",
      permanent: false,
    });
    expect(client.close).toHaveBeenCalledOnce();
  });
});
