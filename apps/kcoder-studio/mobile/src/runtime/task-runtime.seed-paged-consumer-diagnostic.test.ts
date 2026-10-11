import { afterEach, expect, it } from "vitest";
import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import type { ThreadMessage } from "@/gateway/types";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";

const threadId = "mock-active-session";
const serverId = "backend4a";
const historyCount = 499;
const pageSize = 50;
const marker = "seed-after-500-unmounted";
const turnId = `ux-profile-turn-${marker}`;
const attemptId = `ux-profile-attempt-${marker}`;
const itemId = `ux-profile-item-${marker}`;
const deltaText = `\n\n${marker} synchronous task fixture update.`;
const fixtureWorkspace = server.workspacePath;

interface ReadPageEvidence {
  beforeCursor: string | null;
  limit: number;
  rangeStart: number;
  rangeEnd: number;
  messageIds: string[];
}

class PagedHistoryClient extends FakeClient {
  readonly calls: Array<{ method: string; params: JsonRecord }> = [];
  readonly readPages: ReadPageEvidence[] = [];

  constructor() {
    super([]);
    this.supportsExperimental = () => false;
  }

  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push({ method, params: { ...params } });
    if (method === "thread/resume") {
      return {
        thread: {
          id: threadId,
          title: "Mobile transcript fixture",
          cwd: fixtureWorkspace,
          status: "idle",
          createdAt: 1_790_000_000_000,
          updatedAt: 1_790_000_499_000,
        },
      } as T;
    }
    if (method === "thread/read") {
      const requestedLimit = Number.isSafeInteger(params.limit) && Number(params.limit) > 0
        ? Math.min(Number(params.limit), pageSize)
        : pageSize;
      const beforeCursor = typeof params.beforeCursor === "string"
        ? params.beforeCursor
        : null;
      const page = makeHistoryPage(historyCount, beforeCursor, requestedLimit);
      this.readPages.push({
        beforeCursor,
        limit: requestedLimit,
        rangeStart: page.rangeStart,
        rangeEnd: page.rangeEnd,
        messageIds: page.messages.map((message) => message.id),
      });
      return {
        thread: {
          id: threadId,
          title: "Mobile transcript fixture",
          cwd: fixtureWorkspace,
          status: "idle",
          createdAt: 1_790_000_000_000,
          updatedAt: 1_790_000_499_000,
        },
        ...page,
      } as T;
    }
    throw new Error(`Unexpected TaskRuntime fixture request: ${method}`);
  }
}

const runtimes = new Set<TaskRuntime>();
afterEach(() => {
  for (const runtime of runtimes) runtime.close();
  runtimes.clear();
  taskRuntimeTestHelpers.resetConnector();
});

function makeHistoryPage(total: number, beforeCursor: string | null, limit: number) {
  let end = total;
  if (beforeCursor && /^ux:\d+$/.test(beforeCursor))
    end = Number(beforeCursor.slice(3));
  const rangeStart = Math.max(0, end - Math.min(limit, pageSize));
  const messages = Array.from(
    { length: end - rangeStart },
    (_, offset) => makeHistoryMessage(rangeStart + offset),
  );
  return {
    messages,
    rangeStart,
    rangeEnd: end,
    hasMoreBefore: rangeStart > 0,
    beforeCursor: rangeStart > 0 ? `ux:${rangeStart}` : null,
  };
}

function makeHistoryMessage(index: number): ThreadMessage {
  const messageMarker = `HISTORY-${String(index).padStart(4, "0")}`;
  const code = Array.from(
    { length: 18 },
    (_, line) => `export function fixture_${index}_${line}(value: number) { return value + ${line}; }`,
  ).join("\n");
  const content = [
    `# ${messageMarker}: mobile transcript fixture`,
    "",
    `This is a long Markdown history entry used only by the isolated Chromium render profile. It contains a paragraph with enough prose to exercise line wrapping, text layout, and memoized row rendering at a 390 CSS-pixel viewport. ${"A fixed deterministic sentence gives this message a stable text shape. ".repeat(8)}`,
    "",
    "| step | result | detail |",
    "| --- | --- | --- |",
    `| parse | complete | synthetic fixture row ${index} |`,
    "| render | measured | no model request |",
    "",
    "```typescript",
    code,
    "```",
  ].join("\n");
  const blocks: unknown[] = [];
  if (index % 3 === 1) {
    blocks.push({
      type: "tool",
      id: `tool-${index}`,
      tool_name: "read_file",
      status: "done",
      tool_input: { path: `src/fixture-${index}.ts`, range: { start: 1, end: 80 } },
      tool_output: `${"tool output line for a long source excerpt; deterministic mock only.\n".repeat(18)}${messageMarker}-TOOL-END`,
    });
  }
  if (index % 5 === 2) {
    blocks.push({
      type: "file_changes",
      fileChanges: {
        artifactId: `history-artifact-${index}`,
        workspacePath: fixtureWorkspace,
        fileCount: 12,
        additions: 88,
        deletions: 16,
        files: Array.from(
          { length: 12 },
          (_, fileIndex) => `${fixtureWorkspace}/history-${index}-${fileIndex}.ts`,
        ),
        status: "active",
        revertible: true,
      },
    });
  }
  return {
    id: `history-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    blocks,
    timestampMs: 1_790_000_000_000 + index * 1000,
  };
}

function seedFrames(): RpcMessage[] {
  const common = { serverId, threadId, turnId, attemptId };
  return [
    {
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        ...common,
        sequence: 1,
        turn: { id: turnId, attemptId, threadId, status: "running" },
      },
    },
    {
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        ...common,
        sequence: 2,
        item: { id: itemId, type: "agentMessage" },
      },
    },
    {
      jsonrpc: "2.0",
      method: "item/delta",
      params: {
        ...common,
        sequence: 3,
        itemId,
        delta: { text: deltaText },
      },
    },
    {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        ...common,
        sequence: 4,
        turn: { id: turnId, attemptId, threadId, status: "completed" },
        fileChanges: {
          artifactId: `seed-artifact-${marker}`,
          workspacePath: fixtureWorkspace,
          fileCount: 16,
          additions: 160,
          deletions: 24,
          files: Array.from(
            { length: 16 },
            (_, index) => `${fixtureWorkspace}/seed-${index}.ts`,
          ),
          status: "active",
          revertible: true,
        },
      },
    },
  ];
}

it("projects the ordered 499-row paged history before the four app-facing seed frames", async () => {
  const client = new PagedHistoryClient();
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({
    profile,
    server: { ...server, id: serverId },
    threadId,
  });
  runtimes.add(runtime);

  expect(runtime.getSnapshot().messages).toHaveLength(pageSize);
  expect(runtime.getSnapshot().messages[0]).toMatchObject({
    id: "history-449",
    historyOrdinal: 449,
    timestampMs: 1_790_000_449_000,
  });
  expect(client.readPages).toHaveLength(1);

  let pageLoads = 0;
  while (runtime.getSnapshot().hasMoreBefore && pageLoads < 10) {
    await runtime.loadOlderMessages();
    pageLoads += 1;
  }

  const expectedRanges = [
    [449, 499], [399, 449], [349, 399], [299, 349], [249, 299],
    [199, 249], [149, 199], [99, 149], [49, 99], [0, 49],
  ];
  expect(pageLoads).toBe(9);
  expect(client.readPages).toHaveLength(10);
  expect(client.readPages.map(({ rangeStart, rangeEnd }) => [rangeStart, rangeEnd]))
    .toEqual(expectedRanges);
  expect(client.readPages.map(({ beforeCursor }) => beforeCursor)).toEqual([
    null, "ux:449", "ux:399", "ux:349", "ux:299", "ux:249", "ux:199",
    "ux:149", "ux:99", "ux:49",
  ]);

  const history = runtime.getSnapshot().messages;
  expect(history).toHaveLength(historyCount);
  expect(history.map(({ id }) => id)).toEqual(
    Array.from({ length: historyCount }, (_, index) => `history-${index}`),
  );
  expect(new Set(history.map(({ id }) => id)).size).toBe(historyCount);
  expect(history.map(({ historyOrdinal }) => historyOrdinal)).toEqual(
    Array.from({ length: historyCount }, (_, index) => index),
  );
  expect(history[0]).toMatchObject({
    content: expect.stringContaining("HISTORY-0000"),
    timestampMs: 1_790_000_000_000,
  });
  expect(history[1]?.blocks).toEqual([
    expect.objectContaining({ type: "tool", id: "tool-1" }),
  ]);
  expect(history[2]?.blocks).toEqual([
    expect.objectContaining({ type: "file_changes" }),
  ]);

  const frames = seedFrames();
  for (const frame of frames) client.emit(frame);

  const afterSeed = runtime.getSnapshot();
  expect(afterSeed.messages).toHaveLength(historyCount + 1);
  expect(afterSeed.messages.slice(0, historyCount).map(({ id }) => id)).toEqual(
    Array.from({ length: historyCount }, (_, index) => `history-${index}`),
  );
  expect(afterSeed.messages.slice(historyCount)).toHaveLength(1);
  const assistant = afterSeed.messages.at(-1)!;
  expect(assistant).toMatchObject({
    id: `assistant-${attemptId}`,
    role: "assistant",
    turnId,
    attemptId,
    status: "completed",
    content: deltaText,
  });
  expect(assistant.orderedBlocks).toEqual([
    expect.objectContaining({
      kind: "text",
      producerId: itemId,
      content: deltaText,
    }),
  ]);
  expect(afterSeed).toMatchObject({ running: false, activeTurnId: null, connected: true });
  expect(client.readPages).toHaveLength(10);

  await runtime.loadOlderMessages();
  expect(client.readPages).toHaveLength(10);
  expect(runtime.getSnapshot().messages.at(-1)).toMatchObject({
    id: `assistant-${attemptId}`,
    status: "completed",
    content: deltaText,
  });
  expect(client.listeners.size).toBe(1);
});
