import React from "react";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import { setLocale } from "@/i18n";

const { renderToStaticMarkup } = createRequire(import.meta.url)(
  "react-dom/server",
) as { renderToStaticMarkup(element: React.ReactNode): string };

const appPreferences = vi.hoisted(() => ({
  snapshot: {
    interfaceVersion: "modern",
    language: "system",
    theme: "system",
    terminalScrollbackLines: 10_000,
    conversationFontScale: "normal",
    conversationLineSpacing: "normal",
    thinkingCollapsedByDefault: true,
    toolsCollapsedByDefault: true,
    quickPhrases: [],
  },
}));

vi.mock("@/storage/app-preferences", () => ({
  getAppPreferencesSnapshot: () => appPreferences.snapshot,
  subscribeAppPreferences: () => () => {},
}));

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
    ActivityIndicator: host("activity-indicator"),
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

vi.mock("lucide-react-native", async () => {
  const React = await import("react");
  return {
    ArrowUp: () => null,
    Check: () => null,
    ChevronDown: () => null,
    ChevronRight: () => null,
    Clock: () => React.createElement("span", { "data-testid": "processing-live-glyph" }),
    GitCompareArrows: () => null,
    ListTodo: () => null,
    Lightbulb: () => null,
    ShieldCheck: () => null,
    Wrench: () => null,
  };
});

import {
  groupOrderedBlocks,
  OrderedMessageSegments,
  type OrderedSegment,
} from "./OrderedMessageSegments";
import {
  safeThinkingContentEnd,
  ThinkingDisclosure,
} from "./ThinkingDisclosure";
import { InteractionSummaryCard, ToolCallCard } from "./MessageCards";
import { ProcessingStep } from "./TranscriptDisclosure";
import type {
  AssistantTranscriptBlock,
  TaskRuntime,
} from "@/runtime/task-runtime";

describe("OrderedMessageSegments", () => {
  it("collapses repeated provider retries and lets the failure summary own final diagnostics", () => {
    const retries: AssistantTranscriptBlock[] = [1, 2, 3].map(attempt => ({ kind: "activity", id: `retry-${attempt}`, activity: { id: `retry-${attempt}`, type: "notice", label: `Provider main request failed for fixture model model-a (HTTP 503); retrying ${attempt}/3 after 100ms...`, status: "completed" } }));
    const streaming = renderToStaticMarkup(<OrderedMessageSegments orderedBlocks={retries} messageStatus="streaming" renderText={text => <span>{text}</span>} />);
    expect(streaming.match(/data-testid="provider-retry-notice"/g)).toHaveLength(1);
    expect(streaming).toContain("正在重试（3/3）");
    expect(streaming).not.toContain("Provider main request failed");
    expect(streaming).not.toContain("完成");
    const failed = renderToStaticMarkup(<OrderedMessageSegments orderedBlocks={retries} messageStatus="failed" failureHandled renderText={text => <span>{text}</span>} />);
    expect(failed).not.toContain("provider-retry-notice");
    const resumed = renderToStaticMarkup(<OrderedMessageSegments orderedBlocks={[...retries, { kind: "text", id: "answer", content: "resumed answer" }]} messageStatus="streaming" renderText={text => <span>{text}</span>} />);
    expect(resumed).not.toContain("正在重试");
    expect(resumed).toContain("resumed answer");
  });

  it.each([["streaming", "进行中"], ["completed", "已完成"], ["failed", "失败"], ["cancelled", "已停止"], ["unknown", "暂不可识别"]])("keeps %s on the latest reasoning segment across a trailing activity notice", (messageStatus, label) => {
    const html = renderToStaticMarkup(<OrderedMessageSegments messageStatus={messageStatus} orderedBlocks={[
      { kind: "thinking", id: "past-thought", content: "Earlier reasoning" },
      { kind: "text", id: "separator", content: "Earlier answer" },
      { kind: "thinking", id: "current-thought", content: "Latest reasoning" },
      { kind: "activity", id: "notice", activity: { id: "notice", type: "notice", label: "Notice", status: "completed" } },
    ]} renderText={content => <span>{content}</span>} />);
    expect(html).toContain(`aria-label="思考. ${label}"`);
    expect(html).toContain('aria-label="思考. 已完成"');
  });

  it("paces only the selected text fragment while retaining tool outcomes and full source text", () => {
    const orderedBlocks: AssistantTranscriptBlock[] = [
      { kind: "text", id: "before", content: "COMPLETE_EARLIER_TEXT" },
      { kind: "tool", id: "failed", name: "READ", status: "failed", output: "IMMEDIATE_FAILURE" },
      { kind: "text", id: "tail", content: "RECEIVED_COMPLETE_TAIL" },
    ];
    const html = renderToStaticMarkup(<OrderedMessageSegments orderedBlocks={orderedBlocks}
      messageStatus="streaming" textOverride={{ id: "tail", content: "VISIBLE_PREFIX" }}
      renderText={content => <span>{content}</span>} />);
    expect(html).toContain("COMPLETE_EARLIER_TEXT");
    expect(html).toContain("VISIBLE_PREFIX");
    expect(html).not.toContain("RECEIVED_COMPLETE_TAIL");
    expect(html).toContain("失败");
    expect(orderedBlocks.at(-1)).toEqual({ kind: "text", id: "tail", content: "RECEIVED_COMPLETE_TAIL" });
  });
  beforeEach(() => {
    setLocale("zh-CN");
    appPreferences.snapshot.interfaceVersion = "modern";
    appPreferences.snapshot.thinkingCollapsedByDefault = true;
    appPreferences.snapshot.toolsCollapsedByDefault = true;
  });

  it("keeps V3 thinking before tools, bounded details and failure state without a second thinking disclosure", () => {
    appPreferences.snapshot.interfaceVersion = "v3";
    appPreferences.snapshot.thinkingCollapsedByDefault = false;
    appPreferences.snapshot.toolsCollapsedByDefault = false;
    const html = renderToStaticMarkup(<OrderedMessageSegments orderedBlocks={[
      { kind: "thinking", id: "v3-thought", content: "V3_THOUGHT" },
      { kind: "tool", id: "v3-tool", name: "READ_FILE", status: "failed", input: { path: "file.txt" }, output: "READ_FAILED" },
      { kind: "text", id: "v3-reply", content: "V3_REPLY" },
    ]} messageStatus="failed" renderText={content => <span>{content}</span>} />);
    expect(html.indexOf("V3_THOUGHT")).toBeLessThan(html.indexOf("READ_FILE"));
    expect(html.indexOf("READ_FAILED")).toBeLessThan(html.indexOf("V3_REPLY"));
    expect(html).toContain('data-testid="tool-status-v3-tool"');
    expect(html).toContain("失败");
    expect(html).toContain('data-testid="bounded-output"');
    expect(html).not.toContain('data-testid="processing-step-v3-thought"');
    expect(html).not.toContain('data-testid="ordered-message-segment-thinking-v3-thought-toggle"');
  });

  it("lets V3 readers expand and collapse a complete past approval prompt", async () => {
    appPreferences.snapshot.interfaceVersion = "v3";
    const prompt = "Past approval details. ".repeat(20);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<InteractionSummaryCard compact summary={{
      id: "past-approval", header: "Permission request", prompt, answers: ["Allow once"],
    }} />); });
    const row = () => renderer.root.findByProps({ testID: "interaction-summary-prompt-past-approval" });
    expect(row().props.accessibilityState.expanded).toBe(false);
    await act(async () => { row().props.onPress(); });
    expect(row().props.accessibilityState.expanded).toBe(true);
    expect(row().props.numberOfLines).toBeUndefined();
    expect(row().props.children).toBe(prompt);
    await act(async () => { row().props.onPress(); });
    expect(row().props.accessibilityState.expanded).toBe(false);
    await act(async () => { renderer.unmount(); });
  });

  it("applies the saved default when the first visible streaming processing node mounts", () => {
    const task = { steerSubagent: vi.fn(async () => ({ queued: true })) } as unknown as TaskRuntime;
    const renderSegments = (orderedBlocks: AssistantTranscriptBlock[]) => renderToStaticMarkup(
      <OrderedMessageSegments
        orderedBlocks={orderedBlocks}
        task={task}
        messageStatus="streaming"
        renderText={(content) => <span>{content}</span>}
      />,
    );

    expect(renderSegments([])).not.toContain("ordered-message-processing");
    appPreferences.snapshot.toolsCollapsedByDefault = false;
    const firstTool = renderSegments([{
      kind: "tool",
      id: "first-streamed-tool",
      name: "FIRST_TOOL",
      status: "completed",
      input: { path: "first.ts" },
      output: "first tool detail",
    }]);
    expect(firstTool).toContain('aria-expanded="true"');

    appPreferences.snapshot.thinkingCollapsedByDefault = false;
    const firstThinking = renderSegments([{
      kind: "thinking",
      id: "first-streamed-thinking",
      content: "first thought",
    }]);
    expect(firstThinking).toContain('aria-expanded="true"');
  });

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
      'data-testid="ordered-message-processing-tool-first"',
      'data-testid="ordered-message-segment-text-text-between"',
      'data-testid="ordered-message-processing-thinking-before-second-tool"',
      'data-testid="activity-notice-after-tool"',
      'data-testid="ordered-message-segment-text-text-after"',
    ].map((marker) => html.indexOf(marker));

    expect(markers.every((position) => position >= 0)).toBe(true);
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
    expect(html.match(/BEFORE_TEXT/g)).toHaveLength(1);
    expect(html.match(/BETWEEN_TEXT/g)).toHaveLength(1);
    expect(html.match(/AFTER_TEXT/g)).toHaveLength(1);
    expect(html).not.toContain("FIRST_TOOL");
    expect(html).not.toContain("SECOND_TOOL");
    expect(html).not.toContain("QUESTION_SUMMARY");
    expect(html).toContain("RUNTIME_NOTICE");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("THINKING_DETAIL");
    expect(html).not.toContain("first tool detail");
    expect(html).not.toContain("second tool detail");
  });

  it("reveals ordered thinking content with the processing group and has no nested toggle", () => {
    appPreferences.snapshot.thinkingCollapsedByDefault = false;
    const html = renderToStaticMarkup(
      <OrderedMessageSegments
        orderedBlocks={[
          { kind: "thinking", id: "thought", content: "THOUGHT_BODY" },
          { kind: "tool", id: "tool", name: "read", status: "completed" },
        ]}
        renderText={(content) => <span>{content}</span>}
      />,
    );

    expect(html).toContain(
      'data-testid="ordered-message-processing-thought-toggle"',
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(
      'data-testid="ordered-message-segment-thinking-thought-content"',
    );
    expect(html).toContain("THOUGHT_BODY");
    expect(html).not.toContain(
      'data-testid="ordered-message-segment-thinking-thought-toggle"',
    );
  });

  it("reveals collapsed ordered thinking after one real processing-group press", () => {
    let renderer!: ReturnType<typeof TestRenderer.create>;
    act(() => {
      renderer = TestRenderer.create(
        <OrderedMessageSegments
          orderedBlocks={[
            { kind: "thinking", id: "press-thought", content: "THOUGHT_BODY" },
            { kind: "tool", id: "press-tool", name: "read", status: "completed" },
          ]}
          renderText={(content) => <span data-testid="ordered-thinking-body">{content}</span>}
        />,
      );
    });
    const toggleID = "ordered-message-processing-press-thought-toggle";
    const bodyID = "ordered-message-segment-thinking-press-thought-content";

    expect(renderer.root.findByProps({ "data-testid": toggleID }).props["aria-expanded"])
      .toBe(false);
    expect(renderer.root.findAllByProps({ "data-testid": bodyID })).toHaveLength(0);
    act(() => {
      renderer.root.findByProps({ "data-testid": toggleID }).props.onClick();
    });

    expect(renderer.root.findByProps({ "data-testid": toggleID }).props["aria-expanded"])
      .toBe(true);
    expect(renderer.root.findByProps({ "data-testid": "ordered-thinking-body" }).props.children)
      .toBe("THOUGHT_BODY");
    expect(renderer.root.findAllByProps({
      "data-testid": "ordered-message-segment-thinking-press-thought-toggle",
    })).toHaveLength(0);
  });

  it("groups only adjacent thinking and tools and keeps the first key stable as a run grows", () => {
    const blocks = [
      { kind: "text", id: "answer", content: "Visible" },
      { kind: "tool", id: "tool-1", name: "one", status: "completed" },
    ] satisfies AssistantTranscriptBlock[];
    const initial = groupOrderedBlocks(blocks);
    const initialRun = initial[1];
    expect(initialRun?.kind).toBe("processing");

    const extended = groupOrderedBlocks([
      ...blocks,
      { kind: "thinking", id: "thought-1", content: "real thought" },
      { kind: "tool", id: "tool-2", name: "two", status: "running" },
      {
        kind: "activity",
        id: "activity-1",
        activity: {
          id: "activity-1",
          type: "notice",
          label: "Notice",
          status: "completed",
        },
      },
      { kind: "tool", id: "tool-3", name: "three", status: "completed" },
    ] satisfies AssistantTranscriptBlock[]);
    const runs = extended.filter(
      (segment): segment is Extract<OrderedSegment, { kind: "processing" }> =>
        segment.kind === "processing",
    );

    expect(runs).toHaveLength(2);
    expect(runs[0]?.key).toBe(
      (initialRun as Extract<OrderedSegment, { kind: "processing" }>).key,
    );
    expect(runs[0]?.blocks.map((block) => `${block.kind}:${block.id}`)).toEqual([
      "tool:tool-1",
      "thinking:thought-1",
      "tool:tool-2",
    ]);
    expect(runs[1]?.blocks.map((block) => `${block.kind}:${block.id}`)).toEqual([
      "tool:tool-3",
    ]);
  });

  it("keeps a standalone legacy thinking disclosure independently collapsed and accessible", () => {
    const renderContent = vi.fn((content: string) => <span>{content}</span>);
    const html = renderToStaticMarkup(
      <ThinkingDisclosure
        testID="thinking-detail"
        content="**markdown thought**"
        renderContent={renderContent}
      />,
    );

    expect(html).toContain('data-testid="thinking-detail-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("思考");
    expect(html).not.toContain("markdown thought");
    expect(renderContent).not.toHaveBeenCalled();
    expect(html.indexOf("transcript-node-thinking-detail-toggle")).toBeLessThan(html.indexOf("</span>"));
    expect(html.indexOf("transcript-chevron-thinking-detail-toggle")).toBeGreaterThan(html.indexOf("</span>"));
  });

  it("preserves legacy thinking expansion progress across disclosure collapse", () => {
    const content = "x".repeat(18_000);
    let renderer!: ReturnType<typeof TestRenderer.create>;
    act(() => {
      renderer = TestRenderer.create(
        <ThinkingDisclosure
          testID="legacy-progress"
          content={content}
          renderContent={(body) => <span data-testid="legacy-thinking-body">{body}</span>}
        />,
      );
    });
    const toggleID = "legacy-progress-toggle";
    const moreID = "legacy-progress-more";

    act(() => {
      renderer.root.findByProps({ "data-testid": toggleID }).props.onClick();
    });
    expect(renderer.root.findByProps({ "data-testid": "legacy-thinking-body" }).props.children)
      .toHaveLength(8_000);
    act(() => {
      renderer.root.findByProps({ "data-testid": moreID }).props.onClick();
    });
    expect(renderer.root.findByProps({ "data-testid": "legacy-thinking-body" }).props.children)
      .toHaveLength(16_000);
    act(() => {
      renderer.root.findByProps({ "data-testid": toggleID }).props.onClick();
    });
    expect(renderer.root.findAllByProps({ "data-testid": "legacy-thinking-body" })).toHaveLength(0);
    act(() => {
      renderer.root.findByProps({ "data-testid": toggleID }).props.onClick();
    });

    expect(renderer.root.findByProps({ "data-testid": "legacy-thinking-body" }).props.children)
      .toHaveLength(16_000);
    renderer.unmount();
  });

  it("preserves ordered thinking expansion progress across processing-group collapse", () => {
    const content = "z".repeat(18_000);
    let renderer!: ReturnType<typeof TestRenderer.create>;
    act(() => {
      renderer = TestRenderer.create(
        <OrderedMessageSegments
          orderedBlocks={[{ kind: "thinking", id: "ordered-long", content }]}
          renderText={(body) => <span data-testid="ordered-long-body">{body}</span>}
        />,
      );
    });
    const toggleID = "ordered-message-processing-ordered-long-toggle";
    const moreID = "ordered-message-segment-thinking-ordered-long-more";

    act(() => {
      renderer.root.findByProps({ "data-testid": toggleID }).props.onClick();
    });
    expect(renderer.root.findByProps({ "data-testid": "ordered-long-body" }).props.children)
      .toHaveLength(8_000);
    act(() => {
      renderer.root.findByProps({ "data-testid": moreID }).props.onClick();
    });
    expect(renderer.root.findByProps({ "data-testid": "ordered-long-body" }).props.children)
      .toHaveLength(16_000);
    act(() => {
      renderer.root.findByProps({ "data-testid": toggleID }).props.onClick();
    });
    expect(renderer.root.findAllByProps({ "data-testid": "ordered-long-body" })).toHaveLength(0);
    act(() => {
      renderer.root.findByProps({ "data-testid": toggleID }).props.onClick();
    });

    expect(renderer.root.findByProps({ "data-testid": "ordered-long-body" }).props.children)
      .toHaveLength(16_000);
    renderer.unmount();
  });

  it("connects consecutive steps but leaves a standalone step unconnected", () => {
    const single = renderToStaticMarkup(<ProcessingStep first last testID="single">one</ProcessingStep>);
    expect(single).not.toContain("single-connector");
    const steps = renderToStaticMarkup(<>
      <ProcessingStep first last={false} testID="first">thinking</ProcessingStep>
      <ProcessingStep first={false} last={false} testID="middle">tool</ProcessingStep>
      <ProcessingStep first={false} last testID="last">thinking</ProcessingStep>
    </>);
    expect(steps).toContain("first-connector");
    expect(steps).toContain("middle-connector");
    expect(steps).toContain("last-connector");
  });

  it("clips thinking output in 8k increments without splitting a surrogate pair", () => {
    const content = `${"a".repeat(7_999)}😀tail`;

    expect(safeThinkingContentEnd(content, 8_000)).toBe(7_999);
    expect(safeThinkingContentEnd(content, 16_000)).toBe(content.length);
    expect(safeThinkingContentEnd(`${"a".repeat(7_999)}\ud83d`, 8_000)).toBe(
      7_999,
    );
  });

  it("shows each collapsed exception count without truncating or exposing tool names", () => {
    const task = { steerSubagent: vi.fn() } as unknown as TaskRuntime;
    const html = renderToStaticMarkup(
      <OrderedMessageSegments
        task={task}
        orderedBlocks={[
          {
            kind: "tool",
            id: "failed-tool",
            name: "FAILED_TOOL_WITH_A_LONG_INTERNAL_NAME",
            status: "failed",
          },
          {
            kind: "tool",
            id: "unknown-tool",
            name: "UNKNOWN_TOOL_WITH_A_LONG_INTERNAL_NAME",
            status: "unknown",
            rawStatus: "future_status",
          },
          {
            kind: "tool",
            id: "cancelled-tool",
            name: "CANCELLED_TOOL_WITH_A_LONG_INTERNAL_NAME",
            status: "unknown",
            rawStatus: "cancelled",
          },
        ]}
        renderText={(content) => <span>{content}</span>}
      />,
    );

    expect(html).toContain("1 项失败");
    expect(html).toContain("1 项未知");
    expect(html).toContain("1 项已取消");
    expect(html).not.toContain("FAILED_TOOL_WITH_A_LONG_INTERNAL_NAME");
    expect(html).not.toContain("UNKNOWN_TOOL_WITH_A_LONG_INTERNAL_NAME");
    expect(html).not.toContain("CANCELLED_TOOL_WITH_A_LONG_INTERNAL_NAME");
    expect(html).not.toContain("numberoflines");
    expect(html).toContain("aria-label=");
    expect(html).toContain("1 项失败. 1 项未知. 1 项已取消");
    expect(html).not.toContain('data-testid="tool-call-failed-tool"');
    expect(html).not.toContain('data-testid="tool-call-unknown-tool"');
    expect(html).not.toContain('data-testid="tool-call-cancelled-tool"');
  });

  it("uses a static live glyph for an active processing group", () => {
    const task = { steerSubagent: vi.fn() } as unknown as TaskRuntime;
    const html = renderToStaticMarkup(
      <OrderedMessageSegments
        task={task}
        messageStatus="streaming"
        orderedBlocks={[
          { kind: "thinking", id: "thinking-live", content: "Current thought" },
          { kind: "tool", id: "tool-live", name: "ACTIVE_TOOL", status: "running" },
        ]}
        renderText={(content) => <span>{content}</span>}
      />,
    );

    expect(html).toContain('data-testid="processing-live-glyph"');
    expect(html).not.toContain("activity-indicator");
    expect(html).toContain("进行中");
  });

  it("ignores empty text placeholders but splits the run if that body later arrives", () => {
    const firstTool = {
      kind: "tool",
      id: "tool-before-placeholder",
      name: "before",
      status: "completed",
    } satisfies AssistantTranscriptBlock;
    const placeholder = {
      kind: "text",
      id: "pending-text",
      content: "",
    } satisfies AssistantTranscriptBlock;
    const lastTool = {
      kind: "tool",
      id: "tool-after-placeholder",
      name: "after",
      status: "completed",
    } satisfies AssistantTranscriptBlock;
    const beforeTextArrives = groupOrderedBlocks([
      firstTool,
      placeholder,
      lastTool,
    ]);
    const initialRun = beforeTextArrives[0];
    expect(initialRun?.kind).toBe("processing");
    if (initialRun?.kind !== "processing") return;
    expect(initialRun.blocks).toHaveLength(2);

    const afterTextArrives = groupOrderedBlocks([
      firstTool,
      { ...placeholder, content: "Visible body" },
      lastTool,
    ]);
    const runs = afterTextArrives.filter(
      (segment): segment is Extract<OrderedSegment, { kind: "processing" }> =>
        segment.kind === "processing",
    );
    expect(runs).toHaveLength(2);
    expect(runs[0]?.key).toBe(initialRun.key);
  });

  it("shows an explicitly canceled tool as canceled instead of unknown", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        tool={{
          id: "cancelled-tool",
          name: "CANCELLED_TOOL",
          status: "unknown",
          rawStatus: "cancelled",
        }}
      />,
    );
    expect(html).toContain("已取消");
    expect(html).not.toContain("未知");
  });
});
