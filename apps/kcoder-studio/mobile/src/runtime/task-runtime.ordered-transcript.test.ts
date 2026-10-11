import { gatewaySessionExpired } from "@/gateway/http";
import type { ThreadMessage } from "@/gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import {
  FakeClient,
  profile,
  server,
} from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});

describe("Mobile ordered assistant transcript projection", () => {
  it("preserves typed thread/read block order and places scalar content last", async () => {
    const history: ThreadMessage[] = [
      {
        id: "assistant-history-row",
        turnId: "turn-history",
        attemptId: "attempt-history",
        role: "assistant",
        content: "Final answer",
        timestampMs: 50,
        blocks: [
          {
            id: "text-before",
            type: "text",
            content: "Before tool",
            status: "done",
          },
          {
            id: "thinking-middle",
            type: "thinking",
            content: "Considering the result",
            status: "done",
          },
          {
            id: "read-1",
            type: "tool",
            tool_name: "Read",
            status: "done",
            tool_input: { path: "README.md" },
            tool_output: "read output",
          },
          {
            id: "text-after-tool",
            type: "text",
            content: "The file says",
            status: "done",
          },
        ],
      },
    ];
    const client = new FakeClient(history);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    try {
      expect(runtime.getSnapshot().messages[0]?.orderedBlocks).toMatchObject([
        { kind: "text", id: "text-before", content: "Before tool" },
        {
          kind: "thinking",
          id: "thinking-middle",
          content: "Considering the result",
        },
        {
          kind: "tool",
          id: "read-1",
          name: "Read",
          status: "completed",
          input: { path: "README.md" },
          output: "read output",
        },
        {
          kind: "text",
          id: "text-after-tool",
          content: "The file says",
        },
        {
          kind: "text",
          id: "assistant-history-row:content",
          content: "Final answer",
        },
      ]);
      expect(runtime.getSnapshot().messages[0]?.content).toBe(
        "Before tool\n\nThe file says\n\nFinal answer",
      );
    } finally {
      runtime.close();
    }
  });

  it("orders live text, thinking, activity, and parallel tool items by event sequence", async () => {
    vi.useFakeTimers();
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const context = (sequence: number) => ({
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId: "turn-live",
      sequence,
    });
    const delta = (sequence: number, itemId: string, value: string) => ({
      method: "item/delta",
      params: {
        ...context(sequence),
        itemId,
        delta: { text: value },
      },
    });
    const started = (
      sequence: number,
      item: Record<string, unknown>,
    ) => ({
      method: "item/started",
      params: { ...context(sequence), item },
    });
    const completed = (
      sequence: number,
      item: Record<string, unknown>,
    ) => ({
      method: "item/completed",
      params: { ...context(sequence), item },
    });

    try {
      client.emit({
        method: "turn/started",
        params: {
          ...context(0),
          attemptId: "attempt-live",
          turn: {
            id: "turn-live",
            attemptId: "attempt-live",
            threadId: "thread-1",
            status: "running",
          },
        },
      });

      // The delta is delivered before its start frame; the later start has the
      // earlier source sequence and must enrich the same text item in place.
      const beforeDelta = delta(2, "text-before", "Before ");
      client.emit(beforeDelta);
      client.emit(beforeDelta);
      client.emit(started(1, { id: "text-before", type: "agentMessage" }));
      client.emit(delta(3, "text-before", "the tools"));
      client.emit({
        method: "item/event",
        params: {
          ...context(4),
          event: { type: "assistant_thinking_delta", text: "Reasoning" },
        },
      });
      client.emit({
        method: "item/event",
        params: {
          ...context(5),
          event: { type: "system_notice", text: "Context compacted" },
        },
      });
      client.emit(
        started(6, {
          id: "read-a",
          type: "toolCall",
          name: "Read",
          input: { path: "a.txt" },
        }),
      );
      client.emit(
        started(7, {
          id: "read-b",
          type: "toolCall",
          name: "Read",
          input: { path: "b.txt" },
        }),
      );
      // B finishes first; each result must stay attached to its call position.
      client.emit(
        completed(9, {
          id: "read-b",
          type: "toolCall",
          name: "Read",
          status: "completed",
          output: "result b",
        }),
      );
      client.emit(
        completed(8, {
          id: "read-a",
          type: "toolCall",
          name: "Read",
          status: "completed",
          output: "result a",
        }),
      );

      // The final delta remains buffered until the normal 80 ms flush.
      client.emit(started(11, { id: "text-after", type: "agentMessage" }));
      client.emit(delta(12, "text-after", "After tools"));
      const pending = runtime
        .getSnapshot()
        .messages.find((message) => message.turnId === "turn-live");
      expect(pending?.content).not.toContain("After tools");

      await vi.advanceTimersByTimeAsync(80);

      const message = runtime
        .getSnapshot()
        .messages.find((item) => item.turnId === "turn-live");
      expect(message?.orderedBlocks).toMatchObject([
        {
          kind: "text",
          id: "text-before:segment:2",
          content: "Before the tools",
        },
        { kind: "thinking", content: "Reasoning" },
        { kind: "activity", activity: { label: "上下文已压缩" } },
        {
          kind: "tool",
          id: "read-a",
          name: "Read",
          status: "completed",
          output: "result a",
        },
        {
          kind: "tool",
          id: "read-b",
          name: "Read",
          status: "completed",
          output: "result b",
        },
        {
          kind: "text",
          id: "text-after:segment:12",
          content: "After tools",
        },
      ]);
      expect(message?.content).toBe("Before the toolsAfter tools");
    } finally {
      runtime.close();
    }
  });

  it("extends the latest live text chunk without rebuilding its existing prefix", async () => {
    vi.useFakeTimers();
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const context = (sequence: number) => ({
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId: "turn-incremental-text",
      sequence,
    });
    const emitDelta = (sequence: number, delta: string) =>
      client.emit({
        method: "item/delta",
        params: {
          ...context(sequence),
          itemId: "incremental-agent-item",
          delta: { text: delta },
        },
      });
    try {
      client.emit({
        method: "turn/started",
        params: {
          ...context(0),
          attemptId: "attempt-incremental-text",
          turn: {
            id: "turn-incremental-text",
            attemptId: "attempt-incremental-text",
            threadId: "thread-1",
            status: "running",
          },
        },
      });
      emitDelta(1, "prefix ");
      await vi.advanceTimersByTimeAsync(80);
      const first = runtime
        .getSnapshot()
        .messages.find((message) => message.turnId === "turn-incremental-text")
        ?.orderedBlocks?.find((block) => block.kind === "text");
      expect(first?.kind).toBe("text");
      if (first?.kind !== "text" || !first.chunkTail) {
        throw new Error("First live text chunk was not retained");
      }

      emitDelta(2, "suffix");
      await vi.advanceTimersByTimeAsync(80);

      const textBlock = runtime
        .getSnapshot()
        .messages.find((message) => message.turnId === "turn-incremental-text")
        ?.orderedBlocks?.find((block) => block.kind === "text");
      expect(textBlock).toMatchObject({ kind: "text", content: "prefix suffix" });
      expect(textBlock?.kind === "text" ? textBlock.chunkTail?.previous : null).toBe(
        first.chunkTail,
      );
    } finally {
      runtime.close();
    }
  });

  it("keeps history page order while retaining each page's block order", async () => {
    const latestPage: ThreadMessage[] = [
      {
        id: "latest-assistant",
        turnId: "turn-latest",
        role: "assistant",
        content: "latest end",
        timestampMs: 100,
        blocks: [
          { id: "latest-tool", type: "tool", tool_name: "Read", status: "done" },
          { id: "latest-text", type: "text", content: "latest after tool" },
        ],
      },
    ];
    const olderPage: ThreadMessage[] = [
      {
        id: "older-assistant",
        turnId: "turn-older",
        role: "assistant",
        content: "older end",
        timestampMs: 100,
        blocks: [
          { id: "older-text", type: "text", content: "older before tool" },
          { id: "older-tool", type: "tool", tool_name: "Read", status: "done" },
        ],
      },
    ];
    const client = new FakeClient(latestPage, [], {
      hasMoreBefore: true,
      beforeCursor: "cursor-older",
      rangeStart: 9,
      rangeEnd: 10,
    });
    const request = client.request.bind(client);
    client.request = vi.fn(async <T>(method: string, params = {}) => {
      if (method === "thread/read" && "beforeCursor" in params) {
        return {
          thread: {
            id: "thread-1",
            title: "恢复任务",
            cwd: "/workspace",
            status: "idle",
          },
          messages: olderPage,
          rangeStart: 8,
          rangeEnd: 9,
          hasMoreBefore: false,
          beforeCursor: null,
        } as T;
      }
      return request<T>(method, params);
    }) as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    try {
      await runtime.loadOlderMessages();
      const messages = runtime.getSnapshot().messages;
      expect(messages.map((message) => message.id)).toEqual([
        "older-assistant",
        "latest-assistant",
      ]);
      expect(messages.map((message) => message.historyOrdinal)).toEqual([8, 9]);
      expect(messages[0]?.orderedBlocks?.map((block) => block.id)).toEqual([
        "older-text",
        "older-tool",
        "older-assistant:content",
      ]);
      expect(messages[1]?.orderedBlocks?.map((block) => block.id)).toEqual([
        "latest-tool",
        "latest-text",
        "latest-assistant:content",
      ]);
    } finally {
      runtime.close();
    }
  });

  it("reconciles buffered MoA-plan output that reaches history before its live delta", async () => {
    vi.useFakeTimers();
    const turnId = "turn-moa-read-ahead";
    const attemptId = "attempt-moa-read-ahead";
    const history: ThreadMessage[] = [
      {
        id: "history-moa-read-ahead-failed",
        turnId,
        attemptId: "attempt-moa-read-ahead-old",
        role: "assistant",
        content: "The previous attempt failed.",
        status: "failed",
        timestampMs: 90,
        blocks: [],
      },
      {
        id: "history-moa-read-ahead",
        turnId,
        role: "assistant",
        content: "The plan is ready.",
        timestampMs: 100,
        blocks: [],
      },
    ];
    const context = (sequence: number) => ({
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId,
      sequence,
    });
    const firstClient = new FakeClient([]);
    const reconnectClient = new FakeClient(history, [
      {
        method: "turn/started",
        params: {
          ...context(1),
          attemptId,
          turn: {
            id: turnId,
            attemptId,
            threadId: "thread-1",
            status: "running",
          },
        },
      },
      {
        method: "item/event",
        params: {
          ...context(2),
          event: { type: "system_notice", text: "Plan generation finished" },
        },
      },
      {
        method: "item/delta",
        params: {
          ...context(3),
          itemId: "moa-plan-final-item",
          delta: { text: "The plan is ready." },
        },
      },
      {
        method: "turn/completed",
        params: {
          ...context(4),
          turn: {
            id: turnId,
            attemptId,
            threadId: "thread-1",
            status: "completed",
          },
        },
      },
    ]);
    const connector = vi
      .fn()
      .mockResolvedValueOnce(firstClient as never)
      .mockResolvedValueOnce(reconnectClient as never);
    taskRuntimeTestHelpers.setConnector(connector as never);
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    try {
      await runtime.reconnectNow();
      const messages = runtime
        .getSnapshot()
        .messages.filter((message) => message.turnId === turnId);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        id: "history-moa-read-ahead-failed",
        attemptId: "attempt-moa-read-ahead-old",
        status: "failed",
        continuedByAttemptId: attemptId,
      });
      expect(messages[1]).toMatchObject({
        id: "history-moa-read-ahead",
        attemptId,
        status: "completed",
        content: "The plan is ready.",
        orderedBlocks: [
          { kind: "activity", activity: { label: "Plan generation finished" } },
          {
            kind: "text",
            producerId: "moa-plan-final-item",
            content: "The plan is ready.",
            sequence: 3,
          },
        ],
      });
    } finally {
      runtime.close();
    }
  });

  it("does not append a resumed MoA-plan delta twice when turn/started was not replayed", async () => {
    vi.useFakeTimers();
    const turnId = "turn-moa-no-start";
    const history: ThreadMessage[] = [
      {
        id: "history-moa-no-start",
        turnId,
        role: "assistant",
        content: "The plan is ready.",
        timestampMs: 100,
        blocks: [],
      },
    ];
    const client = new FakeClient(history, [
      {
        method: "item/delta",
        params: {
          serverId: "app-server-1",
          threadId: "thread-1",
          turnId,
          sequence: 3,
          itemId: "moa-plan-unreplayed-item",
          delta: { text: "The plan is ready." },
        },
      },
    ]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    try {
      await vi.advanceTimersByTimeAsync(80);
      const messages = runtime
        .getSnapshot()
        .messages.filter((message) => message.turnId === turnId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "history-moa-no-start",
        content: "The plan is ready.",
        orderedBlocks: [
          {
            kind: "text",
            producerId: "moa-plan-unreplayed-item",
            content: "The plan is ready.",
            sequence: 3,
          },
        ],
      });
    } finally {
      runtime.close();
    }
  });

  it("keeps a live notice before MoA history text across same-runtime reconnect", async () => {
    vi.useFakeTimers();
    const turnId = "turn-moa-notice-reconnect";
    const attemptId = "attempt-moa-notice-reconnect";
    const failedHistory: ThreadMessage = {
      id: "history-moa-notice-failed",
      turnId,
      attemptId: "attempt-moa-notice-old",
      role: "assistant",
      content: "The previous attempt failed.",
      status: "failed",
      timestampMs: 90,
      blocks: [],
    };
    const persistedAnswer: ThreadMessage = {
      id: "history-moa-notice-answer",
      turnId,
      role: "assistant",
      content: "The plan is ready.",
      status: "completed",
      timestampMs: 100,
      blocks: [],
    };
    const context = (sequence: number) => ({
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId,
      sequence,
    });
    const firstClient = new FakeClient([failedHistory]);
    const reconnectClient = new FakeClient(
      [failedHistory, persistedAnswer],
      [
        {
          method: "item/delta",
          params: {
            ...context(3),
            itemId: "moa-notice-final-item",
            delta: { text: "The plan is ready." },
          },
        },
      ],
    );
    const activeThread = {
      id: "thread-1",
      title: "恢复任务",
      cwd: "/workspace",
      status: "running",
      runSummary: {
        mainTurn: "running",
        pendingApprovals: 0,
        pendingQuestions: 0,
        activeJobs: 0,
        tasksPending: 0,
        tasksRunning: 0,
        pendingFollowups: 0,
        pendingGoals: 0,
      },
    };
    const request = reconnectClient.request.bind(reconnectClient);
    reconnectClient.request = vi.fn(async <T>(method: string, params = {}) => {
      if (method === "thread/resume") return { thread: activeThread } as T;
      const result = await request<T>(method, params);
      if (method === "thread/read")
        return { ...(result as object), thread: activeThread } as T;
      return result;
    }) as never;
    const connector = vi
      .fn()
      .mockResolvedValueOnce(firstClient as never)
      .mockResolvedValueOnce(reconnectClient as never);
    taskRuntimeTestHelpers.setConnector(connector as never);
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    try {
      firstClient.emit({
        method: "turn/started",
        params: {
          ...context(1),
          attemptId,
          turn: {
            id: turnId,
            attemptId,
            threadId: "thread-1",
            status: "running",
          },
        },
      });
      firstClient.emit({
        method: "item/event",
        params: {
          ...context(2),
          event: {
            type: "system_notice",
            text: "Plan generation finished",
          },
        },
      });
      expect(
        runtime
          .getSnapshot()
          .messages.find((message) => message.turnId === turnId)
          ?.continuedByAttemptId,
      ).toBe(attemptId);

      await runtime.reconnectNow();
      expect(runtime.getSnapshot()).toMatchObject({
        running: true,
        activeTurnId: turnId,
      });
      await vi.advanceTimersByTimeAsync(80);

      const messages = runtime
        .getSnapshot()
        .messages.filter((message) => message.turnId === turnId);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        id: "history-moa-notice-failed",
        status: "failed",
        continuedByAttemptId: attemptId,
      });
      expect(messages[1]).toMatchObject({
        id: "history-moa-notice-answer",
        attemptId,
        status: "completed",
        content: "The plan is ready.",
        orderedBlocks: [
          {
            kind: "activity",
            id: "notice-2",
            activity: { label: "Plan generation finished" },
            sequence: 2,
          },
          {
            kind: "text",
            producerId: "moa-notice-final-item",
            content: "The plan is ready.",
            sequence: 3,
          },
        ],
        activities: [{ id: "notice-2", label: "Plan generation finished" }],
      });
    } finally {
      runtime.close();
    }
  });

  it("splits one live assistant item around thinking and tool boundaries", async () => {
    vi.useFakeTimers();
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const context = (sequence: number) => ({
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId: "turn-shared-item",
      sequence,
    });
    const delta = (sequence: number, value: string) => ({
      method: "item/delta",
      params: {
        ...context(sequence),
        itemId: "assistant-item-reused-across-thinking",
        delta: { text: value },
      },
    });
    try {
      client.emit({
        method: "turn/started",
        params: {
          ...context(0),
          attemptId: "attempt-shared-item",
          turn: {
            id: "turn-shared-item",
            attemptId: "attempt-shared-item",
            threadId: "thread-1",
            status: "running",
          },
        },
      });
      client.emit({
        method: "item/started",
        params: {
          ...context(1),
          item: {
            id: "assistant-item-reused-across-thinking",
            type: "agentMessage",
          },
        },
      });
      client.emit(delta(2, "First run "));
      client.emit({
        method: "item/event",
        params: {
          ...context(3),
          event: { type: "assistant_thinking_delta", text: "thinking" },
        },
      });
      client.emit(delta(4, "second run"));
      await vi.advanceTimersByTimeAsync(80);

      let message = runtime
        .getSnapshot()
        .messages.find((item) => item.turnId === "turn-shared-item");
      expect(message?.orderedBlocks).toMatchObject([
        {
          kind: "text",
          id: "assistant-item-reused-across-thinking:segment:2",
          producerId: "assistant-item-reused-across-thinking",
          content: "First run ",
        },
        { kind: "thinking", content: "thinking" },
        {
          kind: "text",
          id: "assistant-item-reused-across-thinking:segment:4",
          producerId: "assistant-item-reused-across-thinking",
          content: "second run",
        },
      ]);

      // A later flush for the same item may append within its current segment,
      // but cumulative item completion data must not duplicate the text.
      client.emit(delta(5, " plus"));
      client.emit(
        {
          method: "item/started",
          params: {
            ...context(6),
            item: {
              id: "tool-between-text-segments",
              type: "toolCall",
              name: "Read",
              input: { path: "middle.txt" },
            },
          },
        },
      );
      client.emit(
        {
          method: "item/completed",
          params: {
            ...context(7),
            item: {
              id: "tool-between-text-segments",
              type: "toolCall",
              name: "Read",
              status: "completed",
              output: "middle result",
            },
          },
        },
      );
      client.emit({
        method: "item/event",
        params: {
          ...context(8),
          event: { type: "system_notice", text: "between text segments" },
        },
      });
      client.emit(delta(9, " after activity"));
      client.emit({
        method: "item/completed",
        params: {
          ...context(10),
          item: {
            id: "assistant-item-reused-across-thinking",
            type: "agentMessage",
            content: "First run second run plus after activity",
          },
        },
      });
      await vi.advanceTimersByTimeAsync(80);
      message = runtime
        .getSnapshot()
        .messages.find((item) => item.turnId === "turn-shared-item");
      expect(message?.orderedBlocks?.map((block) => block.kind)).toEqual([
        "text",
        "thinking",
        "text",
        "tool",
        "activity",
        "text",
      ]);
      expect(
        message?.orderedBlocks?.filter((block) => block.kind === "text")
          .map((block) => block.content),
      ).toEqual([
        "First run ",
        "second run plus",
        " after activity",
      ]);
    } finally {
      runtime.close();
    }
  });

  it("does not place an empty started item before earlier thinking", async () => {
    vi.useFakeTimers();
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const context = (sequence: number) => ({
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId: "turn-thinking-first",
      sequence,
    });
    try {
      client.emit({
        method: "turn/started",
        params: {
          ...context(0),
          attemptId: "attempt-thinking-first",
          turn: {
            id: "turn-thinking-first",
            attemptId: "attempt-thinking-first",
            threadId: "thread-1",
            status: "running",
          },
        },
      });
      client.emit({
        method: "item/started",
        params: {
          ...context(1),
          item: { id: "shared-agent-item", type: "agentMessage" },
        },
      });
      client.emit({
        method: "item/event",
        params: {
          ...context(2),
          event: { type: "assistant_thinking_delta", text: "Reasoning first" },
        },
      });
      client.emit({
        method: "item/delta",
        params: {
          ...context(3),
          itemId: "shared-agent-item",
          delta: { text: "Answer second" },
        },
      });
      await vi.advanceTimersByTimeAsync(80);
      const message = runtime
        .getSnapshot()
        .messages.find((item) => item.turnId === "turn-thinking-first");
      expect(message?.orderedBlocks?.map((block) => block.kind)).toEqual([
        "thinking",
        "text",
      ]);
      expect(message?.orderedBlocks).toMatchObject([
        { kind: "thinking", content: "Reasoning first" },
        {
          kind: "text",
          id: "shared-agent-item:segment:3",
          content: "Answer second",
        },
      ]);
    } finally {
      runtime.close();
    }
  });

  it("uses notification arrival order when an older server omits sequence", async () => {
    vi.useFakeTimers();
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const legacyContext = {
      serverId: "app-server-legacy",
      threadId: "thread-1",
      turnId: "turn-legacy",
    };
    try {
      client.emit({
        method: "turn/started",
        params: {
          ...legacyContext,
          attemptId: "attempt-legacy",
          turn: {
            id: "turn-legacy",
            attemptId: "attempt-legacy",
            threadId: "thread-1",
            status: "running",
          },
        },
      });
      client.emit({
        method: "item/started",
        params: {
          ...legacyContext,
          item: { id: "legacy-agent-item", type: "agentMessage" },
        },
      });
      client.emit({
        method: "item/event",
        params: {
          ...legacyContext,
          event: { type: "assistant_thinking_delta", text: "Reasoning" },
        },
      });
      client.emit({
        method: "item/delta",
        params: {
          ...legacyContext,
          itemId: "legacy-agent-item",
          delta: { text: "Answer" },
        },
      });
      await vi.advanceTimersByTimeAsync(80);
      const message = runtime
        .getSnapshot()
        .messages.find((item) => item.turnId === "turn-legacy");
      expect(message?.orderedBlocks?.map((block) => block.kind)).toEqual([
        "thinking",
        "text",
      ]);
      expect(message?.orderedBlocks).toMatchObject([
        { kind: "thinking", content: "Reasoning" },
        { kind: "text", content: "Answer" },
      ]);
    } finally {
      runtime.close();
    }
  });

  it("resegments live text when an earlier background activity arrives late", async () => {
    vi.useFakeTimers();
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const context = (sequence: number) => ({
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId: "turn-late-activity",
      sequence,
    });
    try {
      client.emit({
        method: "turn/started",
        params: {
          ...context(0),
          attemptId: "attempt-late-activity",
          turn: {
            id: "turn-late-activity",
            attemptId: "attempt-late-activity",
            threadId: "thread-1",
            status: "running",
          },
        },
      });
      client.emit({
        method: "item/started",
        params: {
          ...context(1),
          item: { id: "late-item", type: "agentMessage" },
        },
      });
      const delta = (sequence: number, value: string) =>
        client.emit({
          method: "item/delta",
          params: {
            ...context(sequence),
            itemId: "late-item",
            delta: { text: value },
          },
        });
      delta(2, "before");
      await vi.advanceTimersByTimeAsync(80);
      delta(4, "after");
      await vi.advanceTimersByTimeAsync(80);
      let message = runtime
        .getSnapshot()
        .messages.find((item) => item.turnId === "turn-late-activity");
      expect(message?.orderedBlocks?.map((block) => block.kind)).toEqual([
        "text",
      ]);
      expect(message?.orderedBlocks?.[0]).toMatchObject({
        kind: "text",
        content: "beforeafter",
      });

      // A different producer can deliver an earlier sequence after the text
      // flush. Retained delta provenance lets the reducer split that segment.
      client.emit({
        method: "item/event",
        params: {
          ...context(3),
          event: { type: "system_notice", text: "arrived late" },
        },
      });
      message = runtime
        .getSnapshot()
        .messages.find((item) => item.turnId === "turn-late-activity");
      expect(message?.orderedBlocks?.map((block) => block.kind)).toEqual([
        "text",
        "activity",
        "text",
      ]);
      expect(
        message?.orderedBlocks?.map((block) =>
          block.kind === "activity"
            ? block.activity.label
            : block.kind === "tool"
              ? block.output
              : block.content,
        ),
      ).toEqual(["before", "arrived late", "after"]);
    } finally {
      runtime.close();
    }
  });

  it("reconciles history block coverage with a live retry tail by attempt", async () => {
    vi.useFakeTimers();
    const failedHistory: ThreadMessage = {
      id: "persisted-failed-attempt",
      turnId: "turn-reconnect",
      attemptId: "attempt-old",
      role: "assistant",
      content: "failed answer",
      status: "failed",
      timestampMs: 200,
      blocks: [
        { id: "failed-text", type: "text", content: "failed answer" },
      ],
    };
    const persistedCurrent: ThreadMessage = {
      id: "persisted-current-attempt",
      turnId: "turn-reconnect",
      role: "assistant",
      content: "",
      status: "completed",
      timestampMs: 200,
      blocks: [
        { id: "history-text-before", type: "text", content: "same" },
        {
          id: "history-thinking",
          type: "thinking",
          content: "same thought",
        },
        {
          id: "reconnect-tool",
          type: "tool",
          tool_name: "Read",
          status: "done",
          tool_output: "tool result",
        },
        { id: "history-text-after", type: "text", content: "same" },
      ],
    };
    const firstClient = new FakeClient([]);
    const duplicateLiveTail = {
      method: "item/delta",
      params: {
        serverId: "app-server-1",
        threadId: "thread-1",
        turnId: "turn-reconnect",
        sequence: 12,
        itemId: "live-agent-item",
        delta: { text: "live tail" },
      },
    };
    const reconnectClient = new FakeClient(
      [failedHistory, persistedCurrent],
      [duplicateLiveTail],
    );
    const connector = vi
      .fn()
      .mockResolvedValueOnce(firstClient as never)
      .mockResolvedValueOnce(reconnectClient as never);
    taskRuntimeTestHelpers.setConnector(connector as never);
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const context = (sequence: number, attemptId?: string) => ({
      serverId: "app-server-1",
      threadId: "thread-1",
      turnId: "turn-reconnect",
      sequence,
      ...(attemptId ? { attemptId } : {}),
    });
    try {
      firstClient.emit({
        method: "turn/started",
        params: {
          ...context(0),
          attemptId: "attempt-old",
          turn: {
            id: "turn-reconnect",
            attemptId: "attempt-old",
            threadId: "thread-1",
            status: "running",
          },
        },
      });
      firstClient.emit({
        method: "item/started",
        params: {
          ...context(1),
          item: { id: "old-agent-item", type: "agentMessage" },
        },
      });
      firstClient.emit({
        method: "item/delta",
        params: {
          ...context(2),
          itemId: "old-agent-item",
          delta: { text: "failed answer" },
        },
      });
      firstClient.emit({
        method: "turn/completed",
        params: {
          ...context(3),
          turn: {
            id: "turn-reconnect",
            attemptId: "attempt-old",
            threadId: "thread-1",
            status: "failed",
          },
        },
      });
      firstClient.emit({
        method: "turn/started",
        params: {
          ...context(4),
          attemptId: "attempt-current",
          turn: {
            id: "turn-reconnect",
            attemptId: "attempt-current",
            threadId: "thread-1",
            status: "running",
          },
        },
      });
      firstClient.emit({
        method: "item/started",
        params: {
          ...context(5),
          item: { id: "live-agent-item", type: "agentMessage" },
        },
      });
      firstClient.emit({
        method: "item/delta",
        params: {
          ...context(6),
          itemId: "live-agent-item",
          delta: { text: "same" },
        },
      });
      firstClient.emit({
        method: "item/event",
        params: {
          ...context(7),
          event: { type: "assistant_thinking_delta", text: "same thought" },
        },
      });
      firstClient.emit({
        method: "item/event",
        params: {
          ...context(8),
          event: { type: "system_notice", text: "live notice before tool" },
        },
      });
      firstClient.emit({
        method: "item/started",
        params: {
          ...context(9),
          item: {
            id: "reconnect-tool",
            type: "toolCall",
            name: "Read",
            input: { path: "file.txt" },
          },
        },
      });
      firstClient.emit({
        method: "item/completed",
        params: {
          ...context(10),
          item: {
            id: "reconnect-tool",
            type: "toolCall",
            name: "Read",
            status: "completed",
            output: "tool result",
          },
        },
      });
      firstClient.emit({
        method: "item/delta",
        params: {
          ...context(11),
          itemId: "live-agent-item",
          delta: { text: "same" },
        },
      });
      firstClient.emit(duplicateLiveTail);
      await vi.advanceTimersByTimeAsync(80);

      await runtime.reconnectNow();
      const messages = runtime.getSnapshot().messages.filter(
        (message) => message.turnId === "turn-reconnect",
      );
      expect(messages).toHaveLength(2);
      expect(messages[0]?.attemptId).toBe("attempt-old");
      expect(messages[0]?.status).toBe("failed");
      expect(messages[1]?.id).toBe("persisted-current-attempt");
      expect(messages[1]?.orderedBlocks?.map((block) => block.kind)).toEqual([
        "text",
        "thinking",
        "activity",
        "tool",
        "text",
      ]);
      expect(messages[1]?.orderedBlocks).toMatchObject([
        { kind: "text", content: "same" },
        { kind: "thinking", content: "same thought" },
        { kind: "activity", activity: { label: "live notice before tool" } },
        { kind: "tool", id: "reconnect-tool", output: "tool result" },
        { kind: "text", content: "samelive tail" },
      ]);
    } finally {
      runtime.close();
    }
  });
});
