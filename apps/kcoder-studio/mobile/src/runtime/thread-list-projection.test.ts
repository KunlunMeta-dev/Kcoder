import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "@/gateway/types";
import type { ThreadListPage } from "./task-runtime";
import { ThreadListProjection, threadListScopeKey, threadListNotice } from "./thread-list-projection";

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

  it("提示区别 partial 和尚有后续页，不冒称空列表完整", () => {
    expect(threadListNotice({ threads: [], completeness: "partial", issueCount: 2 })).toContain("2");
    expect(threadListNotice({ threads: [], completeness: "complete", issueCount: 0, nextCursor: "next" })).toContain("尚未加载完");
    expect(threadListNotice({ threads: [], completeness: "complete", issueCount: 0 })).toBeNull();
  });
});
