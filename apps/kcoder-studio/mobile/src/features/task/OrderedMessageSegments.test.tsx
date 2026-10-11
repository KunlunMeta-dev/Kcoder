import React from "react";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

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
          if ("selected" in state) domProps["aria-selected"] = state.selected;
        } else if (key === "onPress") domProps.onClick = value;
        else if (
          key.startsWith("accessibility") ||
          key === "style" ||
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
  Check: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  GitCompareArrows: () => null,
  ListTodo: () => null,
  ShieldCheck: () => null,
  Wrench: () => null,
}));

import { OrderedMessageSegments } from "./OrderedMessageSegments";
import type {
  AssistantTranscriptBlock,
  TaskRuntime,
} from "@/runtime/task-runtime";

describe("OrderedMessageSegments", () => {
  it("renders interleaved text, tools, thinking, summaries, and notices in input order", () => {
    const task = {
      steerSubagent: vi.fn(async () => ({ queued: true })),
    } as unknown as TaskRuntime;
    // The runtime has already merged producer streams into array order; sequence
    // is provenance for that merge and must not trigger a second UI sort.
    const orderedBlocks = [
      {
        kind: "text",
        id: "text-before",
        content: "BEFORE_TEXT",
        sequence: 90,
      },
      {
        kind: "tool",
        id: "tool-first",
        name: "FIRST_TOOL",
        status: "completed",
        input: { path: "first.ts" },
        output: "first tool detail",
        interactionSummaries: [
          {
            id: "question-first",
            header: "QUESTION_SUMMARY",
            prompt: "Which file?",
            answers: ["first.ts"],
          },
        ],
        sequence: 1,
      },
      {
        kind: "text",
        id: "text-between",
        content: "BETWEEN_TEXT",
        sequence: 70,
      },
      {
        kind: "thinking",
        id: "thinking-before-second-tool",
        content: "THINKING_DETAIL",
        sequence: 2,
      },
      {
        kind: "tool",
        id: "tool-second",
        name: "SECOND_TOOL",
        status: "failed",
        output: "second tool detail",
        sequence: 20,
      },
      {
        kind: "activity",
        id: "notice-after-tool",
        activity: {
          id: "notice-after-tool",
          type: "notice",
          label: "RUNTIME_NOTICE",
          status: "completed",
        },
        sequence: 3,
      },
      {
        kind: "text",
        id: "text-after",
        content: "AFTER_TEXT",
        sequence: 10,
      },
    ] satisfies AssistantTranscriptBlock[];

    const html = renderToStaticMarkup(
      <OrderedMessageSegments
        orderedBlocks={orderedBlocks}
        task={task}
        renderText={(content, blockId) => (
          <span data-testid={`ordered-text-${blockId}`}>{content}</span>
        )}
      />,
    );
    const markers = [
      'data-testid="ordered-message-segment-text-text-before"',
      'data-testid="tool-call-tool-first"',
      'data-testid="interaction-summary-question-first"',
      'data-testid="ordered-message-segment-text-text-between"',
      'data-testid="ordered-message-segment-thinking-thinking-before-second-tool"',
      'data-testid="tool-call-tool-second"',
      'data-testid="activity-notice-after-tool"',
      'data-testid="ordered-message-segment-text-text-after"',
    ].map((marker) => html.indexOf(marker));

    expect(markers.every((position) => position >= 0)).toBe(true);
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
    expect(html.match(/BEFORE_TEXT/g)).toHaveLength(1);
    expect(html.match(/BETWEEN_TEXT/g)).toHaveLength(1);
    expect(html.match(/AFTER_TEXT/g)).toHaveLength(1);
    expect(html).toContain("FIRST_TOOL");
    expect(html).toContain("SECOND_TOOL");
    expect(html).toContain("QUESTION_SUMMARY");
    expect(html).toContain("RUNTIME_NOTICE");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("THINKING_DETAIL");
    expect(html).not.toContain("first tool detail");
    expect(html).not.toContain("second tool detail");
  });
});
