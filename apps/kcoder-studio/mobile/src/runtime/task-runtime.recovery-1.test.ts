import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import type { ThreadMessage } from "@/gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import {
  FakeClient,
  profile,
  server,
} from "./task-runtime/fixture.test-support";
vi.mock("@/gateway/http", () => ({
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
describe("TaskRuntime 断线恢复", () => {
  it.each([false, true])(
    "索引游标失效只重载一次，重载失败=%s",
    async (failFresh) => {
      let reads = 0;
      const client = {
        subscribe: () => () => undefined,
        respond: () => undefined,
        close: vi.fn(),
        supportsExperimental: (name: string) => name === "threadIndexedPagesV1",
        request: vi.fn(async (method: string, params: JsonRecord = {}) => {
          if (method === "thread/resume")
            return {
              thread: { id: "thread-1", cwd: "/workspace", status: "idle" },
            };
          if (method === "thread/read/indexed") {
            reads++;
            if (params.beforeCursor) throw new Error("TRANSCRIPT_CURSOR_STALE");
            if (reads > 2 && failFresh)
              throw new Error("fresh page unavailable");
            return {
              messages: [
                {
                  id: reads === 1 ? "old-page" : "new-page",
                  role: "user",
                  content: "fixture",
                  timestampMs: reads,
                },
              ],
              hasMoreBefore: reads === 1,
              beforeCursor: reads === 1 ? "tp1:old:1" : null,
            };
          }
          return {};
        }),
      };
      taskRuntimeTestHelpers.setConnector(
        vi.fn(async () => client as never) as never,
      );
      const runtime = await TaskRuntime.resume({
        profile,
        server,
        threadId: "thread-1",
      });
      try {
        expect(
          runtime.getSnapshot().messages.map((message) => message.id),
        ).toEqual(["old-page"]);
        await runtime.loadOlderMessages();
        expect(
          runtime.getSnapshot().messages.map((message) => message.id),
        ).toEqual([failFresh ? "old-page" : "new-page"]);
        if (failFresh)
          expect(runtime.getSnapshot().error).toContain(
            "fresh page unavailable",
          );
        expect(runtime.getSnapshot().loadingOlder).toBe(false);
        expect(reads).toBe(3);
      } finally {
        runtime.close();
      }
    },
  );

  it("把高频 token 合并为单次 React 快照更新", async () => {
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
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });

    for (let index = 0; index < 1_000; index += 1) {
      client.emit({
        method: "item/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-burst",
          delta: { text: "x" },
        },
      });
    }
    expect(notifications).toBe(0);
    await vi.advanceTimersByTimeAsync(79);
    expect(notifications).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(notifications).toBe(1);
    expect(runtime.getSnapshot().messages.at(-1)?.content).toHaveLength(1_000);
    unsubscribe();
    runtime.close();
  });

  it("保留历史时间线中的说明文字和最终正文", async () => {
    const client = new FakeClient([
      {
        id: "assistant-timeline",
        role: "assistant",
        content: "Final answer",
        timestampMs: 1,
        blocks: [
          { id: "text-1", type: "text", content: "Before tools" },
          { id: "tool-1", type: "tool", tool_name: "Read", status: "done" },
          { id: "text-2", type: "text", content: "After tools" },
        ],
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
    expect(runtime.getSnapshot().messages[0].content).toBe(
      "Before tools\n\nAfter tools\n\nFinal answer",
    );
    runtime.close();
  });

  it("从历史块恢复思考、工具结果和附件元数据", async () => {
    const client = new FakeClient([
      {
        id: "user-1",
        role: "user",
        content: "分析图片",
        blocks: [
          {
            type: "attachment",
            attachment: {
              filename: "screen.png",
              mimeType: "image/png",
              fileSize: 42,
              path: "/private/screen.png",
            },
          },
        ],
        timestampMs: 1,
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "完成",
        timestampMs: 2,
        blocks: [
          {
            id: "thinking-1",
            type: "thinking",
            content: "检查截图",
            status: "done",
          },
          {
            id: "todo-1",
            type: "tool",
            tool_name: "TodoWrite",
            tool_input: {
              TodoList: [{ content: "验证历史", status: "completed" }],
            },
            status: "done",
          },
          {
            id: "tool-1",
            type: "tool",
            tool_name: "Read",
            tool_input: { path: "README.md" },
            tool_output: "ok",
            status: "done",
          },
          {
            id: "approval-history-1",
            type: "tool",
            tool_name: "request_user_input",
            status: "done",
            render_payload: {
              kind: "request_user_input",
              questions: [
                {
                  id: "approval-1",
                  header: "Permission request",
                  question: "Command: git status",
                },
              ],
              response: {
                answers: {
                  "approval-1": { answers: ["Always allow for this session"] },
                },
              },
            },
          },
          {
            id: "approval-pending-2",
            type: "tool",
            tool_name: "request_user_input",
            status: "done",
            render_payload: {
              kind: "request_user_input",
              questions: [
                {
                  id: "approval-2",
                  header: "待确认权限",
                  question: "Command: cargo test",
                },
              ],
              response: { answers: {} },
            },
          },
        ],
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

    expect(runtime.getSnapshot().messages[0]).toMatchObject({
      content: "分析图片",
      attachments: [
        { filename: "screen.png", mimeType: "image/png", fileSize: 42 },
      ],
    });
    expect(runtime.getSnapshot().messages[1]).toMatchObject({
      thinking: "检查截图",
      todos: [{ content: "验证历史", status: "completed" }],
      tools: [
        { id: "tool-1", name: "Read", status: "completed", output: "ok" },
        {
          id: "approval-pending-2",
          name: "request_user_input",
          status: "completed",
        },
      ],
      interactionSummaries: [
        {
          id: "approval-1",
          header: "Permission request",
          prompt: "Command: git status",
          answers: ["Always allow for this session"],
        },
      ],
    });
    runtime.close();
  });

  it("从历史恢复没有正文的已停止 assistant 回合", async () => {
    const client = new FakeClient([
      {
        id: "user-1",
        turnId: "turn-1",
        role: "user",
        content: "生成长回答",
        timestampMs: 1,
      },
      {
        id: "assistant-1",
        turnId: "turn-1",
        role: "assistant",
        content: "",
        status: "cancelled",
        timestampMs: 2,
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

    expect(runtime.getSnapshot().messages).toEqual([
      expect.objectContaining({ id: "user-1", role: "user" }),
      expect.objectContaining({
        id: "assistant-1",
        role: "assistant",
        content: "",
        status: "cancelled",
      }),
    ]);
    runtime.close();
  });

  it("归档任务保持只读，恢复后才允许继续发送", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const client = {
      subscribe: () => () => undefined,
      respond: () => undefined,
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord = {}) => {
        calls.push({ method, params });
        if (method === "thread/resume")
          return {
            thread: {
              id: "thread-1",
              title: "已归档",
              cwd: "/workspace",
              status: "idle",
              archivedAt: "2026-07-29T00:00:00Z",
            },
          };
        if (method === "thread/read")
          return {
            thread: {
              id: "thread-1",
              title: "已归档",
              cwd: "/workspace",
              status: "idle",
              archivedAt: "2026-07-29T00:00:00Z",
            },
            messages: [],
          };
        return {};
      }),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    expect(runtime.getSnapshot().archivedAt).toBe("2026-07-29T00:00:00Z");
    await expect(runtime.send("不能发送")).rejects.toThrow("任务已归档");
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);

    await runtime.unarchive();
    expect(runtime.getSnapshot().archivedAt).toBeUndefined();
    expect(calls.at(-1)).toEqual({
      method: "thread/metadata/update",
      params: { threadId: "thread-1", archivedAt: null },
    });
    runtime.close();
  });

  it("运行状态在点击与发送间变化时明确拒绝，避免静默吞掉消息", async () => {
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    client.emit({
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-running" },
    });

    await expect(runtime.send("不能静默丢失")).rejects.toThrow(
      "当前回合仍在运行",
    );
    expect(
      runtime
        .getSnapshot()
        .messages.some((message) => message.content === "不能静默丢失"),
    ).toBe(false);
    runtime.close();
  });

  it("任务内切换模型和推理强度会持久化模型并用于下一回合", async () => {
    const client = new FakeClient([]);
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const originalRequest = client.request.bind(client);
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "turn/start")
        return { turn: { id: "turn-preferences" } } as never;
      if (method === "thread/metadata/update")
        return { updated: true } as never;
      return originalRequest(method, params);
    }) as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    await runtime.setTurnPreferences("kimi-for-coding", "high");
    await runtime.send("使用新模型");

    expect(calls).toContainEqual({
      method: "thread/metadata/update",
      params: { threadId: "thread-1", model: "kimi-for-coding" },
    });
    expect(calls).toContainEqual({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "使用新模型" }],
        clientMessageId: expect.any(String),
        model: "kimi-for-coding",
        reasoningEffort: "high",
      },
    });
    expect(runtime.getSnapshot()).toMatchObject({
      model: "kimi-for-coding",
      reasoningEffort: "high",
    });
    runtime.close();
  });

  it("初次恢复读取历史期间不丢失实时通知", async () => {
    const client = new FakeClient(
      [],
      [
        { method: "turn/started", params: { turnId: "turn-live" } },
        {
          method: "item/delta",
          params: { turnId: "turn-live", delta: { text: "实时回复" } },
        },
      ],
    );
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    expect(runtime.getSnapshot()).toMatchObject({
      running: true,
      activeTurnId: "turn-live",
      messages: [
        { role: "assistant", content: "实时回复", turnId: "turn-live" },
      ],
    });
    runtime.close();
  });

  it("初次只读取最近一页并可按游标载入更早消息", async () => {
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    const client = {
      subscribe: () => () => undefined,
      respond: () => undefined,
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord = {}) => {
        requests.push({ method, params });
        if (method === "thread/resume")
          return {
            thread: {
              id: "thread-1",
              title: "长对话",
              cwd: "/workspace",
              status: "idle",
            },
          };
        if (method === "thread/read" && params.beforeCursor === "2") {
          return {
            messages: [
              {
                id: "message-0",
                role: "user",
                content: "最早",
                timestampMs: 0,
              },
              {
                id: "message-1",
                role: "assistant",
                content: "较早",
                timestampMs: 1,
              },
            ],
            hasMoreBefore: false,
            beforeCursor: null,
          };
        }
        if (method === "thread/read") {
          return {
            messages: [
              {
                id: "message-2",
                role: "user",
                content: "最近",
                timestampMs: 2,
              },
              {
                id: "message-3",
                role: "assistant",
                content: "最新",
                timestampMs: 3,
              },
            ],
            hasMoreBefore: true,
            beforeCursor: "2",
          };
        }
        return {};
      }),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    expect(runtime.getSnapshot()).toMatchObject({
      messages: [{ id: "message-2" }, { id: "message-3" }],
      hasMoreBefore: true,
      beforeCursor: "2",
    });

    await runtime.loadOlderMessages();

    expect(runtime.getSnapshot()).toMatchObject({
      messages: [
        { id: "message-0" },
        { id: "message-1" },
        { id: "message-2" },
        { id: "message-3" },
      ],
      hasMoreBefore: false,
      beforeCursor: null,
      loadingOlder: false,
    });
    expect(
      requests.filter((request) => request.method === "thread/read"),
    ).toEqual([
      { method: "thread/read", params: { threadId: "thread-1", limit: 50 } },
      {
        method: "thread/read",
        params: { threadId: "thread-1", limit: 50, beforeCursor: "2" },
      },
    ]);
    runtime.close();
  });

  it("重新连接后 resume 任务并用服务端历史对账", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const recovered = new FakeClient([
      {
        id: "assistant-1",
        role: "assistant",
        content: "恢复后的消息",
        timestampMs: 2,
      },
    ]);
    const recoveredRequest = recovered.request.bind(recovered);
    recovered.request = vi.fn(
      async (method: string, params: JsonRecord = {}) => {
        if (method === "thread/resume") {
          return {
            thread: {
              id: "thread-1",
              title: "恢复任务",
              cwd: "/workspace",
              status: "idle",
              model: "MiniMax-M3",
            },
          } as never;
        }
        if (method === "thread/read") {
          recovered.emit({
            method: "item/completed",
            params: {
              turnId: "turn-reconnect",
              item: {
                id: "read-reconnect",
                type: "toolCall",
                name: "Read",
                status: "completed",
                output: "reconnected-ok",
              },
            },
          });
          return {
            thread: {
              id: "thread-1",
              title: "历史标题",
              cwd: "/workspace",
              status: "idle",
            },
            messages: [
              {
                id: "assistant-1",
                turnId: "turn-reconnect",
                role: "assistant",
                content: "恢复后的消息",
                timestampMs: 2,
                blocks: [
                  {
                    id: "read-reconnect",
                    type: "tool",
                    tool_name: "Read",
                    tool_input: { path: "README.md" },
                    status: "running",
                  },
                ],
              },
            ],
          } as never;
        }
        return recoveredRequest(method, params);
      },
    ) as never;
    const clients = [initial, recovered];
    const connector = vi.fn(async () => clients.shift() as never);
    taskRuntimeTestHelpers.setConnector(connector as never);

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    initial.emit({
      method: "connection/closed",
      params: { reason: "网络中断" },
    });
    expect(runtime.getSnapshot().connected).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(connector).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot()).toMatchObject({
      connected: true,
      error: null,
      model: "MiniMax-M3",
      messages: [
        {
          content: "恢复后的消息",
          tools: [
            {
              id: "read-reconnect",
              name: "Read",
              status: "completed",
              input: { path: "README.md" },
              output: "reconnected-ok",
            },
          ],
        },
      ],
    });
    runtime.close();
  });

  it("重连握手失败后仅明确401触发重新授权", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const connector = vi
      .fn()
      .mockResolvedValueOnce(initial as never)
      .mockRejectedValue(new Error("握手失败"));
    taskRuntimeTestHelpers.setConnector(connector as never);
    vi.mocked(gatewaySessionExpired).mockResolvedValue(true);
    const onSessionExpired = vi.fn();
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
      onSessionExpired,
    });
    initial.emit({
      method: "connection/closed",
      params: { reason: "服务器已重启" },
    });
    await vi.advanceTimersByTimeAsync(40000);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(connector).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().error).toBe(
      "Gateway 会话已失效，请前往设置重新连接",
    );
    await expect(runtime.reconnectNow()).rejects.toThrow("会话已失效");
    runtime.close();
  });

  it("目标重连次数耗尽不撤销仍有效的Gateway登录", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const connector = vi
      .fn()
      .mockResolvedValueOnce(initial as never)
      .mockRejectedValue(new Error("目标连接失败"));
    const onSessionExpired = vi.fn();
    taskRuntimeTestHelpers.setConnector(connector as never);
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
      onSessionExpired,
    });

    initial.emit({
      method: "connection/closed",
      params: { reason: "Gateway 已重启" },
    });
    await vi.advanceTimersByTimeAsync(40_000);

    expect(connector).toHaveBeenCalledTimes(9);
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({
      connected: false,
      error: "目标连接失败，已停止自动重连。可重试连接；其他目标仍保持登录。",
    });
    connector.mockResolvedValue(new FakeClient([]) as never);
    await runtime.reconnectNow();
    expect(runtime.getSnapshot().connected).toBe(true);
    expect(onSessionExpired).not.toHaveBeenCalled();
    runtime.close();
  });

  it("重连尾页与本地历史不连续时丢弃旧区间并采用新游标", async () => {
    vi.useFakeTimers();
    const oldMessages = Array.from({ length: 60 }, (_, index) => ({
      id: `old-${index + 40}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `旧消息 ${index + 40}`,
      timestampMs: index + 40,
    }));
    const newMessages = Array.from({ length: 50 }, (_, index) => ({
      id: `new-${index + 110}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `新消息 ${index + 110}`,
      timestampMs: index + 110,
    }));
    const initial = new FakeClient(oldMessages, [], {
      hasMoreBefore: true,
      beforeCursor: "40",
    });
    const recovered = new FakeClient(newMessages, [], {
      hasMoreBefore: true,
      beforeCursor: "110",
    });
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    initial.emit({
      method: "connection/closed",
      params: { reason: "断网期间产生大量消息" },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(runtime.getSnapshot().messages).toHaveLength(50);
    expect(runtime.getSnapshot().messages[0]?.id).toBe("new-110");
    expect(runtime.getSnapshot()).toMatchObject({
      hasMoreBefore: true,
      beforeCursor: "110",
    });
    runtime.close();
  });

  it("重连降级为旧服务器时不保留有重叠的索引历史和游标", async () => {
    vi.useFakeTimers();
    const shared: ThreadMessage = {
      id: "shared",
      role: "user",
      content: "shared",
      timestampMs: 2,
    };
    const initial = new FakeClient(
      [{ ...shared, id: "older", timestampMs: 1 }, shared],
      [],
      { hasMoreBefore: true, beforeCursor: "tp1:old:1" },
    );
    const originalRequest = initial.request.bind(initial);
    vi.spyOn(initial, "supportsExperimental").mockImplementation(
      (name) => name === "threadIndexedPagesV1",
    );
    vi.spyOn(initial, "request").mockImplementation((method, params) =>
      originalRequest(
        method === "thread/read/indexed" ? "thread/read" : method,
        params,
      ),
    );
    const recovered = new FakeClient([shared], [], {
      hasMoreBefore: true,
      beforeCursor: "1",
    });
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    try {
      initial.emit({ method: "connection/closed", params: {} });
      await vi.advanceTimersByTimeAsync(500);
      expect(
        runtime.getSnapshot().messages.map((message) => message.id),
      ).toEqual(["shared"]);
      expect(runtime.getSnapshot().beforeCursor).toBe("1");
    } finally {
      runtime.close();
    }
  });
});
