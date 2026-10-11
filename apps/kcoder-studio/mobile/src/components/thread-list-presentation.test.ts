import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "@/gateway/types";
import {
  hiddenThreadCount,
  groupThreadsByWorkspace,
  projectVisibleThreads,
  threadStatusTone,
} from "./thread-list-presentation";

function threads(count: number): ThreadSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `thread-${index}`,
    status: "idle",
    createdAt: index,
    updatedAt: index,
  }));
}

describe("thread list presentation", () => {
  it("默认限制列表并允许完整展开", () => {
    const items = threads(11);
    expect(projectVisibleThreads(items, false).map((item) => item.id)).toEqual(
      threads(8).map((item) => item.id),
    );
    expect(projectVisibleThreads(items, true)).toHaveLength(11);
    expect(hiddenThreadCount(items, false)).toBe(3);
    expect(hiddenThreadCount(items, true)).toBe(0);
  });

  it("完整映射会话状态色调", () => {
    expect(threadStatusTone("idle")).toBe("idle");
    expect(threadStatusTone("running")).toBe("running");
    expect(threadStatusTone("waiting_for_approval")).toBe("waiting");
    expect(threadStatusTone("waiting_for_answer")).toBe("waiting");
    expect(threadStatusTone("failed")).toBe("failed");
  });

  it("按真实 cwd 分组，并保留尚无任务的已登记 workspace", () => {
    const items = threads(3);
    items[0].cwd = "/repo/main/";
    items[1].cwd = "/repo/worktree";
    items[2].cwd = "/repo/unregistered";
    const groups = groupThreadsByWorkspace(items, [
      { path: "/repo/main", label: "主项目", kind: "workspace" },
      { path: "/repo/worktree", label: "功能分支", kind: "worktree" },
      { path: "/repo/empty", label: "空工作区", kind: "workspace" },
    ], "/repo/main");

    expect(groups.map((group) => [group.path, group.label, group.threads.map((item) => item.id)])).toEqual([
      ["/repo/main", "主项目", ["thread-0"]],
      ["/repo/worktree", "功能分支", ["thread-1"]],
      ["/repo/empty", "空工作区", []],
      ["/repo/unregistered", "unregistered", ["thread-2"]],
    ]);
  });
});
