import { describe, expect, it } from "vitest";
import { matchesLiveTaskTarget, threadCanBeArchivedOrDeleted } from "./thread-actions-policy";

describe("thread actions policy", () => {
  it("只允许终态或空闲任务归档和删除", () => {
    expect(threadCanBeArchivedOrDeleted("idle")).toBe(true);
    expect(threadCanBeArchivedOrDeleted("failed")).toBe(true);
    expect(threadCanBeArchivedOrDeleted("running")).toBe(false);
    expect(threadCanBeArchivedOrDeleted("waiting_for_approval")).toBe(false);
    expect(threadCanBeArchivedOrDeleted("waiting_for_answer")).toBe(false);
  });

  it("同时使用 server 和 thread 标识匹配实时任务", () => {
    expect(matchesLiveTaskTarget("server-a", "thread-1", "server-a", "thread-1")).toBe(true);
    expect(matchesLiveTaskTarget("server-a", "thread-1", "server-b", "thread-1")).toBe(false);
    expect(matchesLiveTaskTarget("server-a", "thread-1", "server-a", "thread-2")).toBe(false);
  });
});
