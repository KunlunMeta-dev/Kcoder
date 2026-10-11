import { describe, expect, it } from "vitest";
import type { KCoderServer, ThreadSummary } from "@/gateway/types";
import type { ThreadListPage } from "./task-runtime";
import { threadMutationServerIdentity, type ThreadMutationEvent } from "./task-runtime/threadDirectory";
import { acknowledgeThreadMutationAtWorkspace, acknowledgeWorkspaceThreadMutation, projectWorkspaceThreadRows, ThreadListProjection, threadListScopeKey, threadListNotice, threadMutationMatchesRow, threadMutationWorkspaceServers } from "./thread-list-projection";

const a = { id: "a", cwd: "/workspace", status: "idle", createdAt: 1, updatedAt: 2 } as ThreadSummary;
const b = { ...a, id: "b", updatedAt: 1 };
const profile = { id: "profile", baseUrl: "https://gateway" };
const server = { id: "local", workspacePath: "/workspace" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("thread list partial projection", () => {
  // Deferred transport responses exercise the ACK/list ordering without timers or model output.
  it.each(["partial", "complete"] as const)("删除ACK后拒绝迟到的%s旧快照，新的完整快照仍可收敛", async (completeness) => {
    const projection = new ThreadListProjection();
    projection.update("scope", { threads: [a, b], completeness: "complete", issueCount: 0 });
    const oldResponse = deferred<ThreadListPage>();
    const oldRevision = projection.revision;
    const pending = oldResponse.promise.then((page) => {
      if (projection.revision === oldRevision) projection.update("scope", page);
    });
    projection.removeThread("scope", b.id);
    oldResponse.resolve({ threads: [a, b], completeness, issueCount: completeness === "partial" ? 1 : 0 });
    await pending;
    expect(projection.get("scope")?.threads).toEqual([a]);

    const freshResponse = deferred<ThreadListPage>();
    const freshRevision = projection.revision;
    const refreshed = freshResponse.promise.then((page) => {
      if (projection.revision === freshRevision) projection.update("scope", page);
    });
    freshResponse.resolve({ threads: [], completeness: "complete", issueCount: 0 });
    await refreshed;
    expect(projection.get("scope")?.threads).toEqual([]);
  });

  it.each(["partial", "complete"] as const)("重命名ACK后拒绝迟到的%s旧标题", async (completeness) => {
    const projection = new ThreadListProjection();
    projection.update("scope", { threads: [a], completeness: "complete", issueCount: 0 });
    const response = deferred<ThreadListPage>();
    const revision = projection.revision;
    const pending = response.promise.then((page) => {
      if (projection.revision === revision) projection.update("scope", page);
    });
    projection.changeThread("scope", { ...a, title: "confirmed title" });
    response.resolve({ threads: [{ ...a, title: "old title" }], completeness, issueCount: completeness === "partial" ? 1 : 0 });
    await pending;
    expect(projection.get("scope")?.threads[0].title).toBe("confirmed title");
  });

  it("连续 partial 保留缺行，后续完整末页才能删除", () => {
    const projection = new ThreadListProjection();
    projection.update("scope", { threads: [a, b], completeness: "complete", issueCount: 0 });
    for (let i = 0; i < 2; i++) {
      expect(projection.update("scope", { threads: [a], completeness: "partial", issueCount: 3 }).threads).toEqual([a, b]);
    }
    expect(projection.get("scope")?.issueCount).toBe(3);
    expect(projection.update("scope", { threads: [a], completeness: "complete", issueCount: 0, nextCursor: "next" }).threads).toEqual([a, b]);
    expect(projection.update("scope", { threads: [a], completeness: "complete", issueCount: 0 }).threads).toEqual([a]);
  });

  it("profile、目标、workspace 和过滤条件的旧行不会串入其它范围", () => {
    const projection = new ThreadListProjection();
    const scope = threadListScopeKey(profile, server, { archived: false });
    projection.update(scope, { threads: [b], completeness: "complete", issueCount: 0 });
    const others = [
      threadListScopeKey({ ...profile, id: "another" }, server, { archived: false }),
      threadListScopeKey({ ...profile, baseUrl: "https://another" }, server, { archived: false }),
      threadListScopeKey(profile, { ...server, id: "ssh" }, { archived: false }),
      threadListScopeKey(profile, { ...server, workspacePath: "/other" }, { archived: false }),
      threadListScopeKey(profile, { ...server, host: "new-target" }, { archived: false }),
      threadListScopeKey(profile, { ...server, profile: "different-runtime-profile" }, { archived: false }),
      threadListScopeKey(profile, server, { archived: true }),
      threadListScopeKey(profile, server, { archived: false, query: "search" }),
    ];
    for (const other of others) {
      expect(projection.update(other, { threads: [a], completeness: "partial", issueCount: 1 }).threads).toEqual([a]);
    }
    expect(threadListScopeKey(profile, server, { archived: false, query: "  " })).toBe(scope);
  });

  it("明确删除与重命名同步投影，不被后续 partial 缺行复活或回滚", () => {
    const projection = new ThreadListProjection();
    projection.update("scope", { threads: [a, b], completeness: "complete", issueCount: 0 });
    projection.changeThread("scope", { ...a, title: "renamed" });
    projection.removeThread("scope", b.id);
    const page = projection.update("scope", { threads: [], completeness: "partial", issueCount: 1 });
    expect(page.threads).toEqual([{ ...a, title: "renamed" }]);
    projection.retainScopes([]);
    expect(projection.get("scope")).toBeUndefined();
  });

  it("Home rename/delete ACK同步已登记workspace投影", () => {
    const projection = new ThreadListProjection();
    const workspaceServer = { ...server, workspacePath: "/workspace/bravo" };
    const workspaceOptions = [{ path: "/workspace/bravo", label: "Bravo", kind: "workspace" as const }];
    const rootScope = threadListScopeKey(profile, server, { archived: false });
    const bravoScope = threadListScopeKey(profile, workspaceServer, { archived: false });
    const bravoThread = { ...b, cwd: "/workspace/bravo", title: "old title" };
    projection.update(rootScope, { threads: [a], completeness: "complete", issueCount: 0 });
    projection.update(bravoScope, { threads: [bravoThread], completeness: "complete", issueCount: 0 });

    acknowledgeWorkspaceThreadMutation(projection, profile, server as KCoderServer, workspaceOptions, {
      kind: "rename",
      thread: { ...bravoThread, title: "confirmed title" },
    });
    expect(projection.get(bravoScope)?.threads[0]?.title).toBe("confirmed title");

    acknowledgeWorkspaceThreadMutation(projection, profile, server as KCoderServer, workspaceOptions, {
      kind: "remove",
      threadId: bravoThread.id,
    });

    expect(projection.get(bravoScope)?.threads).toEqual([]);
    expect(projection.get(rootScope)?.threads).toEqual([a]);
  });

  it("跨screen ACK只更新实际cwd对应的同IDworkspace投影", () => {
    const projection = new ThreadListProjection();
    const rootThread = { ...a, id: "same-id", cwd: "/workspace" };
    const bravoThread = { ...b, id: "same-id", cwd: "/workspace/bravo" };
    const rootScope = threadListScopeKey(profile, server, { archived: false });
    const bravoScope = threadListScopeKey(
      profile,
      { ...server, workspacePath: "/workspace/bravo" },
      { archived: false },
    );
    projection.update(rootScope, { threads: [rootThread], completeness: "complete", issueCount: 0 });
    projection.update(bravoScope, { threads: [bravoThread], completeness: "complete", issueCount: 0 });

    acknowledgeThreadMutationAtWorkspace(
      projection,
      profile,
      server as KCoderServer,
      "/workspace/bravo",
      "/workspace/bravo",
      { archived: false },
      "same-id",
      { kind: "delete" },
    );

    expect(projection.get(rootScope)?.threads).toEqual([rootThread]);
    expect(projection.get(bravoScope)?.threads).toEqual([]);
  });

  it("mutation ACK按连接身份和cwd解析单一scope，default fallback需有显式匹配行", () => {
    const projection = new ThreadListProjection();
    const bravo = { ...server, workspacePath: "/workspace/bravo" } as KCoderServer;
    const rootScope = threadListScopeKey(profile, server, { archived: false });
    const bravoScope = threadListScopeKey(profile, bravo, { archived: false });
    const sameIdRoot = { ...a, id: "same-id", cwd: "/workspace" };
    const sameIdBravo = { ...b, id: "same-id", cwd: "/workspace/bravo" };
    projection.update(rootScope, { threads: [sameIdRoot], completeness: "complete", issueCount: 0 });
    projection.update(bravoScope, { threads: [sameIdBravo], completeness: "complete", issueCount: 0 });

    const event: ThreadMutationEvent = {
      profileId: profile.id,
      profileBaseUrl: profile.baseUrl,
      serverId: bravo.id,
      serverConfigIdentity: threadMutationServerIdentity(bravo),
      threadId: "same-id",
      cwd: "/workspace/bravo/",
      mutation: { kind: "delete" },
    };
    const matched = threadMutationWorkspaceServers(projection, profile, server as KCoderServer, [
      { path: "/workspace/bravo", label: "Bravo", kind: "workspace" },
    ], { archived: false }, event);
    expect(matched).toEqual([bravo]);
    for (const scope of matched)
      acknowledgeThreadMutationAtWorkspace(
        projection,
        profile,
        server as KCoderServer,
        scope.workspacePath,
        event.cwd,
        { archived: false },
        event.threadId,
        event.mutation,
      );
    expect(projection.get(rootScope)?.threads).toEqual([sameIdRoot]);
    expect(projection.get(bravoScope)?.threads).toEqual([]);
    expect(projectWorkspaceThreadRows(
      projection,
      profile,
      server as KCoderServer,
      [{ path: "/workspace/bravo", label: "Bravo", kind: "workspace" }],
      { archived: false },
    )).toEqual([sameIdRoot]);
    expect(threadMutationWorkspaceServers(projection, { ...profile, baseUrl: "https://other" }, server as KCoderServer, [], { archived: false }, event)).toEqual([]);

    const defaultServer = { ...server, workspacePath: undefined } as KCoderServer;
    const defaultScope = threadListScopeKey(profile, defaultServer, { archived: false });
    projection.update(defaultScope, {
      threads: [{ ...sameIdRoot, cwd: "/workspace" }],
      completeness: "complete",
      issueCount: 0,
    });
    const explicitDefaultEvent = {
      ...event,
      serverConfigIdentity: threadMutationServerIdentity(defaultServer),
      cwd: "/workspace",
    };
    expect(threadMutationWorkspaceServers(projection, profile, defaultServer, [], { archived: false }, explicitDefaultEvent)).toEqual([defaultServer]);
    const uncachedEvent = { ...explicitDefaultEvent, cwd: "/workspace/newly-registered" };
    expect(threadMutationWorkspaceServers(projection, profile, defaultServer, [], { archived: false }, uncachedEvent)).toEqual([
      { ...defaultServer, workspacePath: uncachedEvent.cwd },
    ]);
  });

  it("scope内ACK仍按row cwd精确匹配，缺cwd只允许显式workspace路径兜底", () => {
    const projection = new ThreadListProjection();
    const workspaceServer = { ...server, workspacePath: "/workspace/bravo" } as KCoderServer;
    const workspaceScope = threadListScopeKey(profile, workspaceServer, { archived: false });
    const sameIdTarget = { ...a, id: "same-id", cwd: "/workspace/bravo" };
    const sameIdOther = { ...b, id: "same-id", cwd: "/workspace/other" };
    projection.update(workspaceScope, {
      threads: [sameIdTarget, sameIdOther],
      completeness: "complete",
      issueCount: 0,
    });

    acknowledgeThreadMutationAtWorkspace(
      projection,
      profile,
      server as KCoderServer,
      "/workspace/bravo",
      "/workspace/bravo/",
      { archived: false },
      "same-id",
      { kind: "delete" },
    );
    expect(projection.get(workspaceScope)?.threads).toEqual([sameIdOther]);

    const noCwdThread = { ...a, id: "no-cwd", cwd: undefined };
    projection.update(workspaceScope, {
      threads: [noCwdThread],
      completeness: "complete",
      issueCount: 0,
    });
    acknowledgeThreadMutationAtWorkspace(
      projection,
      profile,
      server as KCoderServer,
      "/workspace/bravo",
      "/workspace/bravo",
      { archived: false },
      "no-cwd",
      { kind: "delete" },
    );
    expect(projection.get(workspaceScope)?.threads).toEqual([]);

    const defaultServer = { ...server, workspacePath: undefined } as KCoderServer;
    const defaultScope = threadListScopeKey(profile, defaultServer, { archived: false });
    projection.update(defaultScope, {
      threads: [noCwdThread],
      completeness: "complete",
      issueCount: 0,
    });
    const revision = projection.revision;
    acknowledgeThreadMutationAtWorkspace(
      projection,
      profile,
      defaultServer,
      undefined,
      "/workspace/bravo",
      { archived: false },
      "no-cwd",
      { kind: "delete" },
    );
    expect(projection.get(defaultScope)?.threads).toEqual([noCwdThread]);
    expect(projection.revision).toBeGreaterThan(revision);
    expect(threadMutationMatchesRow(noCwdThread, "no-cwd", "/workspace/bravo", undefined)).toBe(false);
  });

  it.each(["archive", "delete"] as const)("%s ACK后partial nextCursor页不会合并复活旧行", (kind) => {
    const projection = new ThreadListProjection();
    const workspaceServer = { ...server, workspacePath: "/workspace/bravo" } as KCoderServer;
    const scope = threadListScopeKey(profile, workspaceServer, { archived: false });
    const bravoThread = { ...b, cwd: "/workspace/bravo" };
    projection.update(scope, {
      threads: [bravoThread],
      completeness: "complete",
      issueCount: 0,
      nextCursor: "cursor-2",
    });

    acknowledgeThreadMutationAtWorkspace(
      projection,
      profile,
      server as KCoderServer,
      "/workspace/bravo",
      "/workspace/bravo",
      { archived: false },
      bravoThread.id,
      kind === "archive"
        ? { kind, archivedAt: "2026-09-30T00:00:00.000Z" }
        : { kind },
    );

    const partial = projection.update(scope, {
      threads: [],
      completeness: "partial",
      issueCount: 1,
      nextCursor: "cursor-3",
    });
    expect(partial.threads).toEqual([]);
    expect(partial.nextCursor).toBe("cursor-3");
  });

  it("提示区别 partial 和尚有后续页，不冒称空列表完整", () => {
    expect(threadListNotice({ threads: [], completeness: "partial", issueCount: 2 })).toContain("2");
    expect(threadListNotice({ threads: [], completeness: "complete", issueCount: 0, nextCursor: "next" })).toContain("尚未加载完");
    expect(threadListNotice({ threads: [], completeness: "complete", issueCount: 0 })).toBeNull();
  });
});
