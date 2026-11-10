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
      recentFiles: ["/workspace/src/a.ts", "relative", "/workspace/src/a.ts"],
      fileDraft: { path: "/workspace/src/a.ts", revision: "rev-1", content: "changed", updatedAt: 42 },
    })).toEqual({
      activeTab: "files",
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
      composerDraft: "下一条消息",
      browserUrl: "https://example.com/docs",
      directoryPath: "/workspace/src",
      recentFiles: ["/workspace/src/a.ts"],
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

  it("normalizes recent file history for Windows drive and UNC roots", () => {
    expect(normalizeWorkspaceViewState({ recentFiles: [
      "C:\\workspace\\src\\main.ts",
      "\\\\server\\share\\workspace\\docs\\guide.md",
      "relative.txt",
      "C:\\workspace\\bad\u0001name.ts",
    ] }).recentFiles).toEqual([
      "C:\\workspace\\src\\main.ts",
      "\\\\server\\share\\workspace\\docs\\guide.md",
    ]);
  });

  it("restores Windows drive and UNC current directories at workspace and files-panel scope", () => {
    const state = normalizeWorkspaceViewState({
      directoryPath: "C:\\workspace\\src",
      panels: [
        { id: "agent", kind: "agent", title: "智能体" },
        { id: "files-1", kind: "files", title: "Files", directoryPath: "\\\\server\\share\\workspace\\docs" },
      ],
    });

    expect(state.directoryPath).toBe("C:\\workspace\\src");
    expect(state.panels?.find((panel) => panel.id === "files-1")?.directoryPath)
      .toBe("\\\\server\\share\\workspace\\docs");
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
        permissionMode: "bypass",
      }],
    });
    expect(state.queuedMessages?.[0]?.permissionMode).toBe("bypass");
    expect(state.queuedMessages?.[0]?.attachments).toEqual([
      { filename: "large.bin", mimeType: "application/octet-stream", path: "/tmp/large.bin", fileSize: 300 * 1024 },
    ]);
  });

  it("持久化失败消息的可重试字段且移除本地预览/运行时字段", () => {
    const failed = {
      id: "composer-1759227-a1b2c3d4",
      content: "请检查附件",
      createdAt: 12,
      outcome: "failed",
      retrying: true,
      error: "网络暂时不可用",
      permissionMode: "accept_edits",
      attachments: [
        {
          filename: "notes.txt",
          mimeType: "text/plain",
          path: "/attachments/notes.txt",
          fileSize: 42,
          localPreviewUri: "blob:temporary-preview",
          ownsLocalPreviewUri: true,
        },
      ],
    };
    const state = normalizeWorkspaceViewState({ failedSubmissions: [failed] });

    expect(state.failedSubmissions).toEqual([
      {
        id: failed.id,
        content: failed.content,
        createdAt: failed.createdAt,
        outcome: "failed",
        error: failed.error,
        permissionMode: "accept_edits",
        attachments: [
          {
            filename: "notes.txt",
            mimeType: "text/plain",
            path: "/attachments/notes.txt",
            fileSize: 42,
          },
        ],
      },
    ]);
    expect(
      normalizeWorkspaceViewState(
        JSON.parse(JSON.stringify(state)),
      ).failedSubmissions,
    ).toEqual(state.failedSubmissions);
  });

  it("兼容旧队列权限字段并将损坏的已冻结模式收敛到服务器默认", () => {
    const legacy = {
      id: "queued-legacy",
      content: "old queued text",
      createdAt: 1,
      attachments: [],
    };
    const corrupted = {
      ...legacy,
      id: "queued-corrupt",
      permissionMode: "made_up",
    };
    const state = normalizeWorkspaceViewState({ queuedMessages: [legacy, corrupted] });
    expect(state.queuedMessages?.[0]).not.toHaveProperty("permissionMode");
    expect(state.queuedMessages?.[1]?.permissionMode).toBe("default");
  });

  it("丢弃路径无效或字段不完整的失败记录", () => {
    const state = normalizeWorkspaceViewState({
      failedSubmissions: [
        {
          id: "composer-valid",
          content: "retry with no bad attachment",
          attachments: [
            { filename: "bad.txt", mimeType: "text/plain", path: "relative.txt", fileSize: 1 },
          ],
          createdAt: 1,
          outcome: "failed",
        },
        {
          id: "../unsafe",
          content: "invalid id",
          attachments: [],
          createdAt: 1,
          outcome: "failed",
        },
      ],
    });
    expect(state.failedSubmissions).toEqual([]);
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


describe("accepted submission observation compatibility", () => {
  const base = { id: "composer-accepted", content: "original", attachments: [], createdAt: 42, outcome: "unknown" };
  const acceptedTurn = { threadId: "thread-1", turnId: "turn-2", attemptId: "attempt-3" };
  it("roundtrips an accepted observation without changing the old unknown outcome", () => {
    const state = normalizeWorkspaceViewState({ failedSubmissions: [{ ...base, acceptedTurn }] });
    expect(state.failedSubmissions).toEqual([{ ...base, acceptedTurn }]);
    expect(normalizeWorkspaceViewState(JSON.parse(JSON.stringify(state))).failedSubmissions).toEqual(state.failedSubmissions);
    expect(normalizeWorkspaceViewState({ failedSubmissions: [base] }).failedSubmissions).toEqual([base]);
  });
  it.each([null, {}, { threadId: "thread-1" }, { ...acceptedTurn, turnId: " " }, { ...acceptedTurn, attemptId: "" }, { ...acceptedTurn, extra: true }, { ...acceptedTurn, threadId: "x".repeat(513) }, { ...acceptedTurn, turnId: "bad\u0085id" }])(
    "retains the unknown recovery row when optional accepted metadata is malformed (%j)", value => {
      expect(normalizeWorkspaceViewState({ failedSubmissions: [{ ...base, acceptedTurn: value }] }).failedSubmissions).toEqual([base]);
    });
  it("does not turn a failed row into an accepted observation", () => {
    expect(normalizeWorkspaceViewState({ failedSubmissions: [{ ...base, outcome: "failed", acceptedTurn }] }).failedSubmissions).toEqual([{ ...base, outcome: "failed" }]);
  });
});
