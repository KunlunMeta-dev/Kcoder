import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";

beforeEach(() => setLocale("zh-CN"));

const { renderToStaticMarkup } = createRequire(import.meta.url)(
  "react-dom/server",
) as { renderToStaticMarkup(element: React.ReactNode): string };

vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => "modern" }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const host = (tag: string) =>
    function NativeHost({ children, ...props }: Record<string, unknown>) {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (key === "testID") domProps["data-testid"] = value;
        else if (key === "accessibilityRole") domProps.role = value;
        else if (key === "accessibilityLabel") domProps["aria-label"] = value;
        else if (key === "accessibilityState" && value && typeof value === "object") {
          const state = value as Record<string, unknown>;
          if ("expanded" in state) domProps["aria-expanded"] = state.expanded;
          if ("disabled" in state) domProps["aria-disabled"] = state.disabled;
        } else if (key === "onPress") domProps.onClick = value;
        else if (
          key.startsWith("accessibility") ||
          key === "style" ||
          key === "selectable" ||
          key === "numberOfLines" ||
          key === "ellipsizeMode" ||
          key === "onLongPress" ||
          key === "onPressIn" ||
          key === "onPressOut" ||
          key === "nativeID"
        ) {
          continue;
        } else {
          domProps[key] = value;
        }
      }
      return React.createElement(tag, domProps, children as React.ReactNode);
    };

  return {
    ActivityIndicator: host("span"),
    Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) },
    Linking: { openURL: async () => undefined },
    Platform: { OS: "web" },
    Pressable: host("button"),
    ScrollView: host("div"),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host("span"),
    TextInput: host("input"),
    View: host("div"),
  };
});

vi.mock("lucide-react-native", () => ({
  ArrowUp: () => null,
  Bot: () => null,
  Check: () => null,
  Clock: () => <span data-testid="thinking-live-icon" />,
  ChevronDown: () => null,
  ChevronRight: () => null,
  Copy: () => null,
  Link: () => null,
  MoreHorizontal: () => null,
  ThumbsUp: () => null,
  ThumbsDown: () => null,
  GitCompareArrows: () => null,
  ListTodo: () => null,
  Lightbulb: () => null,
  Share2: () => null,
  ShieldCheck: () => null,
  Wrench: () => null,
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

vi.mock("react-native-markdown-display", async () => {
  const React = await import("react");
  return {
    default: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("article", { "data-testid": "message-markdown" }, children),
  };
});

vi.mock("@/components/failure-continuation", () => ({
  FailureContinuation: () => "FAILURE_CONTINUATION",
}));

vi.mock("./TaskAttachments", async () => {
  const React = await import("react");
  return {
    MessageAttachment: ({ attachment }: { attachment: { filename: string } }) =>
      React.createElement(
        "div",
        { "data-testid": `attachment-${attachment.filename}` },
        attachment.filename,
      ),
  };
});

import { MessageBubble } from "./MessageBubble";
import type { ChatMessage, TaskRuntime } from "@/runtime/task-runtime";
import { setStringAsync } from "expo-clipboard";

describe("MessageBubble ordered transcript integration", () => {
  const task = {
    getSnapshot: () => ({ cwd: "/workspace" }),
    steerSubagent: vi.fn(async () => ({ queued: true })),
  } as unknown as TaskRuntime;
  const bubbleProps = {
    task,
    continuationBusy: false,
    connected: true,
    onOpenFile: vi.fn(() => false),
    onOpenChanges: vi.fn(),
  };

  it("keeps historical plans readable while allowing the current plan to be shown only in the footer", () => {
    const message: ChatMessage = { id: "current-plan", role: "assistant", content: "Visible reply", timestampMs: 1,
      todos: [{ content: "Current plan item", status: "pending" }] };
    const historical = renderToStaticMarkup(<MessageBubble {...bubbleProps} message={message} />);
    const current = renderToStaticMarkup(<MessageBubble {...bubbleProps} message={message} showTodos={false} />);
    expect(historical).toContain('data-testid="todo-card"');
    expect(current).not.toContain('data-testid="todo-card"');
    expect(current).toContain("Visible reply");
  });

  it("keeps status-less live reasoning in progress until its turn actually ends, without text animation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      const message: ChatMessage = { id: "live-thinking", turnId: "active-turn", role: "assistant", timestampMs: 1,
        content: "", orderedBlocks: [{ id: "reasoning", kind: "thinking", content: "Still reasoning" }] };
      await act(async () => { renderer = create(<MessageBubble {...bubbleProps} message={message} turnRunning animateText={false} />); });
      const summary = () => renderer!.root.findByProps({ "data-testid": "ordered-message-processing-reasoning-toggle" }).props["aria-label"];
      expect(summary()).toContain("进行中");
      expect(summary()).not.toContain("已完成");
      await act(async () => { renderer!.update(<MessageBubble {...bubbleProps} message={{ ...message,
        orderedBlocks: [{ id: "reasoning", kind: "thinking", content: "Still reasoning after a delta" }] }} turnRunning />); });
      expect(summary()).toContain("进行中");
      await act(async () => { renderer!.update(<MessageBubble {...bubbleProps} message={{ ...message, status: "completed" }} />); });
      expect(summary()).toContain("已完成");
      expect(summary()).not.toContain("进行中");
    } finally {
      if (renderer) await act(async () => { renderer!.unmount(); });
      vi.unstubAllGlobals();
    }
  });

  it.each([["completed", "已完成"], ["failed", "失败"], ["cancelled", "已停止"], ["unknown", "暂不可识别"]])("preserves explicit %s reasoning even if the parent turn is still active", (status, label) => {
    const message: ChatMessage = { id: "settled-thinking", role: "assistant", timestampMs: 1, status, content: "",
      orderedBlocks: [{ id: "settled-reasoning", kind: "thinking", content: "Settled reasoning" }] };
    const html = renderToStaticMarkup(<MessageBubble {...bubbleProps} message={message} turnRunning />);
    expect(html).toContain(label);
    expect(html).not.toContain("进行中");
  });

  it("uses the active turn for legacy reasoning but keeps read-only and unowned history inactive", () => {
    const message: ChatMessage = { id: "legacy-live-thinking", role: "assistant", timestampMs: 1, content: "", thinking: "Legacy reasoning" };
    expect(renderToStaticMarkup(<MessageBubble {...bubbleProps} message={message} turnRunning />)).toContain("进行中");
    expect(renderToStaticMarkup(<MessageBubble {...bubbleProps} message={message} turnRunning readOnly />)).not.toContain("进行中");
    expect(renderToStaticMarkup(<MessageBubble {...bubbleProps} task={undefined} message={message} turnRunning />)).not.toContain("进行中");
  });

  it("copies the complete received text during pacing and flushes before a following tool", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;
    try {
      // Live runtime messages acquire their terminal status only when the turn ends.
      const empty: ChatMessage = { id: "paced", role: "assistant", timestampMs: 1, content: "", orderedBlocks: [] };
      await act(async () => { renderer = create(<MessageBubble {...bubbleProps} message={empty} animateText />); });
      const content = "RECEIVED_TEXT ".repeat(120);
      const full: ChatMessage = { ...empty, content, orderedBlocks: [{ kind: "text", id: "body", content }] };
      await act(async () => { renderer!.update(<MessageBubble {...bubbleProps} message={full} animateText />); await vi.advanceTimersByTimeAsync(24); });
      const body = () => renderer!.root.findAllByType("article").map(node => node.children.join("")).join("");
      expect(body().length).toBeLessThan(content.length);
      await act(async () => { renderer!.root.findByProps({ testID: "assistant-response-copy" }).props.onPress(); });
      expect(setStringAsync).toHaveBeenLastCalledWith(content);
      const tool: ChatMessage = { ...full, orderedBlocks: [...full.orderedBlocks!, { kind: "tool", id: "tool-after", name: "READ", status: "failed", output: "failure" }] };
      await act(async () => { renderer!.update(<MessageBubble {...bubbleProps} message={tool} animateText />); });
      expect(body()).toContain(content);
      expect(renderer!.root.findAllByProps({ "data-testid": "ordered-message-processing-tool-after" }).length).toBeGreaterThan(0);
    } finally {
      await act(async () => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals();
    }
  });

  it("keeps one failure detail owner instead of repeating its raw error in an activity", () => {
    const error = "configuration root is writable by other users";
    const message = { id: "unsafe-config", role: "assistant", status: "failed", timestampMs: 1, content: "", error,
      orderedBlocks: [{ kind: "activity", id: "runtime-failed", activity: { id: "runtime-failed", type: "activity", label: "运行失败", status: "failed", detail: error } }],
    } as ChatMessage;
    const html = renderToStaticMarkup(<MessageBubble {...bubbleProps} message={message} />);
    expect(html).not.toContain("运行失败");
    expect(html).toContain("FAILURE_CONTINUATION");
    expect(html).not.toContain(error);
    const cached = renderToStaticMarkup(<MessageBubble {...bubbleProps} message={message} readOnly />);
    expect(cached).toContain("FAILURE_CONTINUATION");
    expect(cached).not.toContain(error);
  });

  it("renders ordered blocks once and ignores duplicate legacy projections", () => {
    const message = {
      id: "assistant-ordered",
      role: "assistant",
      turnId: "turn-1",
      status: "failed",
      timestampMs: 1,
      // Runtime scalar content is an aggregate for compatibility. The ordered
      // text blocks are canonical, so it must not be rendered a second time.
      content: "BEFORE_TEXT\n\nAFTER_TEXT",
      thinking: "LEGACY_THINKING",
      tools: [
        {
          id: "legacy-tool",
          name: "LEGACY_TOOL",
          status: "completed",
        },
      ],
      activities: [
        {
          id: "legacy-activity",
          type: "notice",
          label: "LEGACY_ACTIVITY",
          status: "completed",
        },
      ],
      interactionSummaries: [
        {
          id: "legacy-question",
          header: "LEGACY_SUMMARY",
          answers: ["legacy answer"],
        },
      ],
      todos: [{ content: "TODO_ADJUNCT", status: "pending" }],
      attachments: [
        {
          filename: "ordered.txt",
          mimeType: "text/plain",
          fileSize: 12,
          path: "/workspace/ordered.txt",
        },
      ],
      fileChanges: {
        artifactId: "changes-1",
        workspacePath: "/workspace",
        fileCount: 1,
        additions: 1,
        deletions: 0,
        files: ["src/example.ts"],
        status: "active",
        revertible: true,
      },
      orderedBlocks: [
        {
          kind: "text",
          id: "text-before",
          content: "BEFORE_TEXT",
          sequence: 1,
        },
        {
          kind: "tool",
          id: "ordered-tool",
          name: "ORDERED_TOOL",
          status: "completed",
          input: { path: "src/example.ts" },
          output: "tool output",
          interactionSummaries: [
            {
              id: "ordered-question",
              header: "ORDERED_SUMMARY",
              answers: ["yes"],
            },
          ],
          sequence: 2,
        },
        {
          kind: "text",
          id: "text-after",
          content: "AFTER_TEXT",
          sequence: 3,
        },
      ],
    } satisfies ChatMessage;

    const html = renderToStaticMarkup(
      <MessageBubble {...bubbleProps} message={message} />,
    );
    const markers = [
      'data-testid="ordered-message-segment-text-text-before"',
      'data-testid="ordered-message-processing-ordered-tool"',
      'data-testid="ordered-message-segment-text-text-after"',
    ].map((marker) => html.indexOf(marker));

    expect(markers.every((position) => position >= 0)).toBe(true);
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
    expect(html.match(/BEFORE_TEXT/g)).toHaveLength(1);
    expect(html.match(/AFTER_TEXT/g)).toHaveLength(1);
    expect(html).not.toContain("ORDERED_TOOL");
    expect(html).not.toContain("ORDERED_SUMMARY");
    expect(html).not.toContain('data-testid="tool-call-toggle-ordered-tool"');
    expect(html).toContain('data-testid="assistant-response-actions"');
    expect(html).toContain('data-testid="assistant-response-copy"');
    expect(html).not.toContain("assistantLabel");
    expect(html).not.toContain("LEGACY_THINKING");
    expect(html).not.toContain("LEGACY_TOOL");
    expect(html).not.toContain("LEGACY_ACTIVITY");
    expect(html).not.toContain("LEGACY_SUMMARY");
    expect(html).not.toContain("message-processing-toggle");
    expect(html).toContain('data-testid="message-attempt-failure"');
    expect(html).toContain("FAILURE_CONTINUATION");
    expect(html).toContain("TODO_ADJUNCT");
    expect(html).toContain('data-testid="attachment-ordered.txt"');
    expect(html).toContain("文件变更 · 1");
  });

  it("keeps the legacy disclosure and body path when ordered blocks are absent", () => {
    const message = {
      id: "assistant-legacy",
      role: "assistant",
      turnId: "turn-legacy",
      status: "completed",
      timestampMs: 2,
      content: "LEGACY_BODY",
      tools: [
        {
          id: "legacy-tool",
          name: "LEGACY_TOOL",
          status: "completed",
        },
      ],
    } satisfies ChatMessage;

    const html = renderToStaticMarkup(
      <MessageBubble {...bubbleProps} message={message} />,
    );

    expect(html).toContain('data-testid="message-processing-toggle"');
    expect(html).toContain("工具调用");
    expect(html).toContain("LEGACY_BODY");
  });
  it("keeps legacy thinking inside the collapsed processing disclosure", () => {
    const message = {
      id: "assistant-legacy-thinking",
      role: "assistant",
      turnId: "turn-legacy-thinking",
      status: "completed",
      timestampMs: 4,
      thinking: "LEGACY_THINKING_MARKDOWN",
      content: "LEGACY_THINKING_BODY",
    } satisfies ChatMessage;

    const html = renderToStaticMarkup(
      <MessageBubble {...bubbleProps} message={message} />,
    );

    expect(html).toContain('data-testid="message-processing-toggle"');
    expect(html).not.toContain("LEGACY_THINKING_MARKDOWN");
    expect(html).toContain("LEGACY_THINKING_BODY");
  });

  it("uses an activity label instead of claiming thinking when the legacy row has only activity", () => {
    const message = {
      id: "assistant-activity-only",
      role: "assistant",
      status: "completed",
      timestampMs: 3,
      content: "",
      activities: [
        {
          id: "activity-1",
          type: "notice",
          label: "ACTIVITY_LABEL",
          status: "completed",
        },
      ],
    } satisfies ChatMessage;

    const html = renderToStaticMarkup(
      <MessageBubble {...bubbleProps} message={message} />,
    );
    expect(html).toContain("活动与记录");
    expect(html).not.toContain("思考</span>");
  });

  it("uses a localized text fallback for Studio widgets while preserving user text and the stored message", () => {
    const content = 'Before\n::kcoder-widget{widget_id="w-1" revision=1}\nAfter';
    const message: ChatMessage = { id: "widget-history", role: "assistant", status: "completed", timestampMs: 1, content,
      orderedBlocks: [{ id: "widget-text", kind: "text", content }] };
    const html = renderToStaticMarkup(<MessageBubble {...bubbleProps} message={message} />);
    expect(html).toContain("KCoder Studio");
    expect(html).toContain("Before"); expect(html).toContain("After");
    expect(html).not.toContain("::kcoder-widget");
    expect(html).not.toContain("<iframe");
    expect(message.content).toBe(content);
    const user = renderToStaticMarkup(<MessageBubble {...bubbleProps} message={{ ...message, role: "user", orderedBlocks: undefined }} />);
    expect(user).toContain("::kcoder-widget");
  });
});

it("read-only history preserves text and attachment names while omitting continuation, steering and file actions", () => {
  const task = { getSnapshot: () => ({ cwd: "/workspace" }), steerSubagent: vi.fn() } as unknown as TaskRuntime;
  const base = { task, continuationBusy: false, connected: true, onOpenFile: vi.fn(() => false), onOpenChanges: vi.fn() };
  for (const ordered of [false, true]) {
    const message: ChatMessage = { id: "failed-history", role: "assistant", content: "READABLE_TEXT", timestampMs: 1, status: "failed", error: "READABLE_FAILURE",
      activities: [{ id: "activity", type: "activity", label: "AGENT_ACTIVITY", status: "running", agentId: "agent-1" }],
      ...(ordered ? { orderedBlocks: [
        { id: "text", kind: "text", content: "READABLE_TEXT" },
        { id: "activity", kind: "activity", activity: { id: "activity", type: "activity", label: "AGENT_ACTIVITY", status: "running", agentId: "agent-1" } },
      ] as ChatMessage["orderedBlocks"] } : {}),
      attachments: [{ path: "/private/source", filename: "source.txt", mimeType: "text/plain", fileSize: 1 }],
      fileChanges: { artifactId: "changes", workspacePath: "/workspace", fileCount: 1, additions: 1, deletions: 0, files: ["a.ts"], status: "ready", revertible: true },
    };
    const html = renderToStaticMarkup(<MessageBubble {...base} message={message} readOnly />);
    expect(html).toContain("READABLE_TEXT"); expect(html).toContain("FAILURE_CONTINUATION"); expect(html).toContain("source.txt");
    expect(html).not.toContain('data-testid="attachment-source.txt"');
    expect(html).not.toContain("新子代理指令"); expect(html).not.toContain("在文件中查看更改");
    expect(html).not.toContain('data-testid="subagent-steer-open"');
  }
  expect(task.steerSubagent).not.toHaveBeenCalled(); expect(base.onOpenFile).not.toHaveBeenCalled(); expect(base.onOpenChanges).not.toHaveBeenCalled();
});

it("renders cached text without constructing a runtime", () => {
  const message: ChatMessage = { id: "cached", role: "assistant", timestampMs: 1, content: "CACHED_BODY",
    orderedBlocks: [{ id: "text", kind: "text", content: "CACHED_BODY" }] };
  const html = renderToStaticMarkup(<MessageBubble message={message} cwd="/workspace" readOnly
    continuationBusy={false} connected={false} onOpenFile={() => false} onOpenChanges={() => {}} />);
  expect(html).toContain("CACHED_BODY");
  expect(html).not.toContain("FAILURE_CONTINUATION");
});
