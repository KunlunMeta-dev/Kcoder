import React from "react";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";

beforeEach(() => setLocale("zh-CN"));

const { renderToStaticMarkup } = createRequire(import.meta.url)(
  "react-dom/server",
) as { renderToStaticMarkup(element: React.ReactNode): string };

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
  ChevronDown: () => null,
  ChevronRight: () => null,
  GitCompareArrows: () => null,
  ListTodo: () => null,
  ShieldCheck: () => null,
  Wrench: () => null,
}));

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
      'data-testid="tool-call-ordered-tool"',
      'data-testid="interaction-summary-ordered-question"',
      'data-testid="ordered-message-segment-text-text-after"',
    ].map((marker) => html.indexOf(marker));

    expect(markers.every((position) => position >= 0)).toBe(true);
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
    expect(html.match(/BEFORE_TEXT/g)).toHaveLength(1);
    expect(html.match(/AFTER_TEXT/g)).toHaveLength(1);
    expect(html).toContain("ORDERED_TOOL");
    expect(html).toContain("ORDERED_SUMMARY");
    expect(html).toContain('data-testid="tool-call-toggle-ordered-tool"');
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
    expect(html).toContain("LEGACY_BODY");
  });
});
