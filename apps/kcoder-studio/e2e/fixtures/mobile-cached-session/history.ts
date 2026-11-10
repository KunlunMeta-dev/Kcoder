import type { ThreadMessage } from "../../../mobile/src/gateway/types";
import { projectConfirmedTranscript, decodeConfirmedTranscript } from "../../../mobile/src/storage/session-transcript-projection";
import type { SessionTranscriptScope } from "../../../mobile/src/storage/session-transcript-scope";

// Synthetic display data only: no real account, Gateway, filesystem or stored history.
const scope: SessionTranscriptScope = {
  version: 1,
  profile: { id: "cache-layout-fixture", baseUrl: "https://cache-layout.invalid", authorizationGeneration: "fixture-v1", authMode: "legacy" },
  target: { id: "fixture-local", transport: "local", connectionFingerprint: "0".repeat(64), principalId: null, role: null, workspacePath: "/workspace/fixture-project" },
  cwd: "/workspace/fixture-project",
  threadId: "cached-layout-history",
};
const confirmedAt = Date.parse("2026-10-18T03:00:00Z");

export function createCachedHistory(english: boolean, short: boolean) {
  const turns = english ? [
    ["Hello", "Hello! I can help you review the mobile conversation layout."],
    ["Summarize the workspace.", "## Workspace overview\n\n- A shared conversation view for Mobile Web and native apps.\n- Markdown, thinking and completed tools remain readable in cached history.\n- Project location: `/workspace/fixture-project`.\n\n> Keep the conversation readable on a narrow screen."],
    ["Show a code example.", "The layout uses the same shared components:\n\n```tsx\n<CachedSessionView\n  cached={history}\n  offline={false}\n  composerDraft={draft}\n/>\n```\n\nLong identifiers should wrap or scroll inside their own block."],
    ["What states can I inspect?", "| Area | Current state |\n| --- | --- |\n| History | Cached, read only |\n| Composer | Draft preserved |\n| Model and permissions | Waiting for connection |\n\nYou can scroll upward, expand thinking and inspect the composer without a live Gateway."],
    ["Keep this page open while we adjust its layout.", "The sample history stays on this cached conversation screen. Refreshing the page restores the same content.\n\nThis last reply includes **bold text**, a `short identifier`, and a longer paragraph to check line spacing and the gap above the composer. We can now adjust the header, message list, cache status and input area together."],
  ] : [
    ["你好", "你好！我是 KCoder，可以帮你检查移动端会话界面的布局。"],
    ["先介绍一下这个项目。", "## 项目概况\n\n- Mobile Web 与 App 复用同一套会话组件。\n- 缓存历史保留正文、思考过程与已完成的工具结果。\n- 示例目录：`/workspace/fixture-project`。\n\n> 小屏幕上也应保持清晰的阅读层级。"],
    ["给我看一个代码示例。", "这页直接使用现有的共享组件：\n\n```tsx\n<CachedSessionView\n  cached={history}\n  offline={false}\n  composerDraft={draft}\n/>\n```\n\n较长的标识符应在自己的内容块中换行或滚动，不挤压输入区。"],
    ["这里能检查哪些状态？", "| 区域 | 当前状态 |\n| --- | --- |\n| 历史 | 缓存、只读 |\n| 输入区 | 保留草稿 |\n| 模型与权限 | 等待连接 |\n\n向上滚动可以检查较早的消息，也可以展开思考和工具结果。"],
    ["先停留在这个页面，我来调整布局。", "示例历史会一直停留在这个缓存会话页面，刷新后仍显示相同内容。\n\n这条回复包含 **加粗文字**、`简短代码`，以及一段稍长的正文，用来检查行距、消息间距和输入区上方的留白。现在可以逐项调整标题栏、历史列表、缓存状态和输入区域。"],
  ];
  const messages: ThreadMessage[] = turns.slice(short ? -1 : 0).flatMap(([user, assistant], index) => {
    const timestampMs = confirmedAt - (turns.length - index) * 60_000;
    const thinking = english ? "Review the cached conversation structure and preserve the current draft." : "检查缓存会话的内容结构，并保留当前草稿。";
    return [
      { id: `fixture-user-${index}`, role: "user", content: user, status: "done", timestampMs },
      { id: `fixture-assistant-${index}`, role: "assistant", content: "", status: "done", timestampMs: timestampMs + 1000,
        blocks: [{ type: "thinking", content: thinking },
          ...(index === 1 ? [{ type: "tool", id: "fixture-tool", tool_name: "Read", status: "done", tool_input: { path: "/workspace/fixture-project/README.md" }, tool_output: "# KCoder\nShared mobile conversation layout." }] : []),
          { type: "text", content: assistant }] },
    ];
  });
  const record = projectConfirmedTranscript(scope, { messages, hasMoreBefore: true }, {
    title: english ? "Mobile conversation layout" : "移动端会话布局",
    updatedAt: confirmedAt,
    anchor: { messageId: messages.at(-1)!.id, offset: 0, followsLatest: true },
  });
  const cached = decodeConfirmedTranscript(JSON.stringify(record), scope);
  if (!cached || cached.view.messages.length !== messages.length) throw new Error("Invalid cached conversation fixture");
  return cached;
}
