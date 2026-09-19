import { describe, expect, it } from "vitest";
import { isWorkspaceTab, normalizeWorkspaceViewState, workspaceStateKeysForProfile, workspaceStateStorageKey, workspaceTabStorageKey } from "./workspace-preferences";
import { MAX_ATTACHMENT_BYTES } from "@/protocol/attachment-limits";

describe("workspace preferences", () => {
  it("只接受受支持的工作区标签", () => {
    expect(["agent", "changes", "terminal", "browser", "files"].every(isWorkspaceTab)).toBe(true);
    expect(isWorkspaceTab("settings")).toBe(false);
    expect(isWorkspaceTab(null)).toBe(false);
  });

  it("对存储键中的路由标识进行编码", () => {
    expect(workspaceTabStorageKey("host:4174", "ssh/a", "thread?1")).toBe(
      "kcoder-studio:mobile-workspace-tab:v1:host%3A4174:ssh%2Fa:thread%3F1",
    );
  });

  it("规范化可恢复的面板实体状态并拒绝危险值", () => {
    expect(normalizeWorkspaceViewState({
      activeTab: "files",
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
      composerDraft: "下一条消息",
      browserUrl: "https://example.com/docs",
      directoryPath: "/workspace/src",
      fileDraft: { path: "/workspace/src/a.ts", revision: "rev-1", content: "changed", updatedAt: 42 },
    })).toEqual({
      activeTab: "files",
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
      composerDraft: "下一条消息",
      browserUrl: "https://example.com/docs",
      directoryPath: "/workspace/src",
      fileDraft: { path: "/workspace/src/a.ts", revision: "rev-1", content: "changed", updatedAt: 42 },
    });
    expect(normalizeWorkspaceViewState({ activeTab: "bad", model: " ", reasoningEffort: "../../bad", browserUrl: "javascript:alert(1)", directoryPath: "relative" }))
      .toEqual({ activeTab: "agent", model: undefined, reasoningEffort: undefined, composerDraft: undefined, browserUrl: undefined, directoryPath: undefined, fileDraft: undefined });
  });

  it("持久化多个独立终端、浏览器和文件标签并过滤伪造标签", () => {
    const state = normalizeWorkspaceViewState({
      activeTab: "browser",
      activePanelId: "browser-2",
      panels: [
        { id: "agent", kind: "agent", title: "智能体" },
        { id: "terminal-1", kind: "terminal", title: "终端 1", terminalSessionId: "pty-session-1" },
        { id: "terminal-2", kind: "terminal", title: "终端 2", terminalSessionId: "../../bad" },
        { id: "browser-2", kind: "browser", title: "文档", browserUrl: "https://example.com/docs" },
        { id: "files-2", kind: "files", title: "README", directoryPath: "/repo", fileDraft: { path: "/repo/README.md", revision: "r1", content: "edit", updatedAt: 10 } },
        { id: "../../bad", kind: "browser", title: "bad", browserUrl: "javascript:alert(1)" },
      ],
    });
    expect(state.activePanelId).toBe("browser-2");
    expect(state.panels?.map((panel) => panel.id)).toEqual(["agent", "terminal-1", "terminal-2", "browser-2", "files-2"]);
    expect(state.panels?.find((panel) => panel.id === "terminal-1")?.terminalSessionId).toBe("pty-session-1");
    expect(state.panels?.find((panel) => panel.id === "terminal-2")?.terminalSessionId).toBeUndefined();
    expect(state.panels?.find((panel) => panel.id === "browser-2")?.browserUrl).toBe("https://example.com/docs");
    expect(state.panels?.find((panel) => panel.id === "files-2")?.fileDraft?.content).toBe("edit");
  });

  it("为带变更面板的完整工作区状态使用 v3 键", () => {
    expect(workspaceStateStorageKey("host:4174", "ssh/a", "thread?1")).toBe(
      "kcoder-studio:mobile-workspace-state:v3:host%3A4174:ssh%2Fa:thread%3F1",
    );
  });

  it("恢复允许范围内的大附件队列并拒绝超过 50 MiB 的伪造记录", () => {
    const state = normalizeWorkspaceViewState({
      queuedMessages: [{
        id: "queued-large-1",
        content: "检查大附件",
        createdAt: 1,
        attachments: [
          { filename: "large.bin", mimeType: "application/octet-stream", path: "/tmp/large.bin", fileSize: 300 * 1024 },
          { filename: "too-large.bin", mimeType: "application/octet-stream", path: "/tmp/too-large.bin", fileSize: MAX_ATTACHMENT_BYTES + 1 },
        ],
      }],
    });
    expect(state.queuedMessages?.[0]?.attachments).toEqual([
      { filename: "large.bin", mimeType: "application/octet-stream", path: "/tmp/large.bin", fileSize: 300 * 1024 },
    ]);
  });

  it("删除 Gateway 时只筛出所属的新版和旧版工作区状态", () => {
    expect(workspaceStateKeysForProfile([
      workspaceStateStorageKey("gateway-a", "local", "thread-1"),
      workspaceTabStorageKey("gateway-a", "ssh", "thread-2"),
      workspaceStateStorageKey("gateway-b", "local", "thread-1"),
      "unrelated",
    ], "gateway-a")).toEqual([
      workspaceStateStorageKey("gateway-a", "local", "thread-1"),
      workspaceTabStorageKey("gateway-a", "ssh", "thread-2"),
    ]);
  });
});
