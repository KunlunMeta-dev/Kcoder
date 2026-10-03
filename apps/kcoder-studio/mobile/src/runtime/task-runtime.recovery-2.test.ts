import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeReconciledMessages,
  TaskRuntime,
  taskRuntimeTestHelpers,
} from "./task-runtime";
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
  it("忽略旧连接在重连后才返回的分页结果", async () => {
    vi.useFakeTimers();
    let resolveOldPage: ((value: unknown) => void) | undefined;
    let firstRead = true;
    const initial = {
      listeners: new Set<(message: RpcMessage) => void>(),
      subscribe(listener: (message: RpcMessage) => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      respond: () => undefined,
      close: vi.fn(),
      emit(message: RpcMessage) {
        for (const listener of this.listeners) listener(message);
      },
      request: vi.fn(async (method: string) => {
        if (method === "thread/resume")
          return {
            thread: { id: "thread-1", cwd: "/workspace", status: "idle" },
          };
        if (method === "thread/read" && firstRead) {
          firstRead = false;
          return {
            messages: [
              {
                id: "shared",
                role: "assistant",
                content: "当前",
                timestampMs: 10,
              },
            ],
            hasMoreBefore: true,
            beforeCursor: "2",
          };
        }
        if (method === "thread/read")
          return new Promise((resolve) => {
            resolveOldPage = resolve;
          });
        return {};
      }),
    };
    const recovered = new FakeClient(
      [{ id: "shared", role: "assistant", content: "恢复后", timestampMs: 10 }],
      [],
      { hasMoreBefore: true, beforeCursor: "2" },
    );
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const oldLoad = runtime.loadOlderMessages();
    await vi.waitFor(() => expect(resolveOldPage).toBeTypeOf("function"));

    initial.emit({
      method: "connection/closed",
      params: { reason: "网络切换" },
    });
    await vi.advanceTimersByTimeAsync(500);
    resolveOldPage?.({
      messages: [
        { id: "stale", role: "user", content: "过期页", timestampMs: 1 },
      ],
      hasMoreBefore: false,
    });
    await oldLoad;

    expect(
      runtime.getSnapshot().messages.some((message) => message.id === "stale"),
    ).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({
      connected: true,
      beforeCursor: "2",
      hasMoreBefore: true,
      loadingOlder: false,
    });
    runtime.close();
  });

  it("并发交互按 requestId 排队，解决一个不会清除另一个", async () => {
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
      id: 11,
      method: "approval/request",
      params: {
        approvalId: "approval-11",
        reason: "运行测试",
        action: { type: "command", command: "cargo test" },
      },
    });
    client.emit({
      id: 12,
      method: "question/request",
      params: {
        questionId: "question-12",
        questions: [{ id: "db", prompt: "数据库？", options: [] }],
      },
    });
    expect(runtime.getSnapshot().interaction).toMatchObject({
      kind: "approval",
      requestId: 11,
    });

    client.emit({
      method: "approval/resolved",
      params: { requestId: 11, approvalId: "approval-11" },
    });
    expect(runtime.getSnapshot().interaction).toMatchObject({
      kind: "question",
      requestId: 12,
    });

    client.emit({
      method: "approval/resolved",
      params: { requestId: 999, approvalId: "other" },
    });
    expect(runtime.getSnapshot().interaction).toMatchObject({
      kind: "question",
      requestId: 12,
    });
    runtime.close();
  });

  it("取消问题时返回 JSON-RPC error 并等待服务端 resolved 通知出队", async () => {
    const client = new FakeClient([]);
    client.respondError = vi.fn();
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    client.emit({
      id: 12,
      method: "question/request",
      params: {
        questionId: "question-12",
        questions: [{ id: "db", prompt: "数据库？", options: [] }],
      },
    });
    runtime.cancelQuestions();

    expect(client.respondError).toHaveBeenCalledWith(
      12,
      -32800,
      "the user cancelled the question request",
    );
    expect(runtime.getSnapshot().interaction).toMatchObject({
      kind: "question",
      requestId: 12,
      responding: true,
    });

    client.emit({
      method: "question/resolved",
      params: {
        requestId: 12,
        questionId: "question-12",
        reason: "response_error",
      },
    });
    expect(runtime.getSnapshot().interaction).toBeNull();
    runtime.close();
  });

  it("旧轮完成与进程重放不能覆盖新轮后台活动", async () => {
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    client.emit({ method: "turn/started", params: { turnId: "turn-runs" } });
    const send = (
      runId: string,
      eventId: string,
      type: string,
      process = "first",
    ) =>
      client.emit({
        method: "item/event",
        params: {
          threadId: "thread-1",
          turnId: "turn-runs",
          serverId: process,
          sequence: 1,
          identity: {
            run: { parentSessionId: "thread-1", agentId: "agent", runId },
            eventId,
            runSequence: 1,
          },
          event: { type, id: "agent", description: runId, text: runId },
        },
      });
    send("one", "start", "background_job_started");
    send("two", "start", "background_job_started");
    send("one", "terminal", "background_job_completed");
    const activity = () =>
      runtime.getSnapshot().messages.find((item) => item.turnId === "turn-runs")
        ?.activities?.[0];
    expect(activity()).toMatchObject({ label: "two", status: "running" });
    send("two", "terminal", "background_job_completed");
    expect(activity()).toMatchObject({ status: "completed", detail: "two" });
    send("two", "start", "background_job_started", "restarted");
    expect(activity()).toMatchObject({ status: "completed", detail: "two" });
    send("three", "start", "background_job_started");
    send("three", "pause", "background_job_paused");
    expect(activity()).toMatchObject({ status: "paused" });
    send("three", "late-progress", "background_job_progress");
    expect(activity()).toMatchObject({ status: "paused" });
    send("three", "terminal", "background_job_halted");
    expect(activity()).toMatchObject({ status: "cancelled" });
    runtime.close();
  });

  it("保留 todo、后台活动、压缩和取消事件供任务流展示", async () => {
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    client.emit({ method: "turn/started", params: { turnId: "turn-events" } });
    client.emit({
      method: "item/started",
      params: {
        turnId: "turn-events",
        item: {
          id: "read-1",
          type: "toolCall",
          name: "Read",
          input: { path: "README.md" },
        },
      },
    });
    client.emit({
      method: "item/completed",
      params: {
        turnId: "turn-events",
        item: {
          id: "read-1",
          type: "toolCall",
          name: "Read",
          status: "completed",
          output: "ok",
        },
      },
    });
    client.emit({
      method: "item/started",
      params: {
        turnId: "turn-events",
        item: {
          id: "todo-1",
          type: "toolCall",
          name: "TodoWrite",
          input: {
            TodoList: [
              { content: "检查实现", status: "completed" },
              { content: "运行测试", status: "in_progress" },
            ],
          },
        },
      },
    });
    client.emit({
      method: "item/event",
      params: {
        turnId: "turn-events",
        event: {
          type: "background_job_started",
          id: "agent-1",
          description: "独立审查",
        },
      },
    });
    client.emit({
      method: "item/event",
      params: {
        turnId: "turn-events",
        event: {
          type: "background_job_progress",
          id: "agent-1",
          message: "对照界面",
          current: 2,
          total: 3,
        },
      },
    });
    client.emit({
      method: "item/event",
      params: {
        turnId: "turn-events",
        event: {
          type: "system_notice",
          text: "Context auto-compacted: 8000 -> 2000 tokens",
        },
      },
    });
    client.emit({
      method: "item/event",
      params: {
        turnId: "turn-events",
        event: { type: "stream_aborted", reason: "cancelled by user" },
      },
    });

    const message = runtime
      .getSnapshot()
      .messages.find((item) => item.turnId === "turn-events");
    expect(message?.todos).toEqual([
      { content: "检查实现", status: "completed" },
      { content: "运行测试", status: "in_progress" },
    ]);
    expect(message?.tools).toEqual([
      {
        id: "read-1",
        name: "Read",
        status: "completed",
        input: { path: "README.md" },
        output: "ok",
      },
    ]);
    expect(message?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "background-agent-1",
          label: "对照界面",
          status: "running",
          detail: "2 / 3",
        }),
        expect.objectContaining({ type: "compaction", status: "completed" }),
        expect.objectContaining({ type: "cancelled", status: "cancelled" }),
      ]),
    );
    const messageCount = runtime.getSnapshot().messages.length;
    client.emit({
      method: "item/event",
      params: {
        turnId: "unknown-turn",
        event: { type: "tool_input_progress", id: "tool-x", chars: 12 },
      },
    });
    expect(runtime.getSnapshot().messages).toHaveLength(messageCount);
    runtime.close();
  });

  it("按 capability 定向调整一个后台子智能体并关联 applied 通知", async () => {
    const client = new FakeClient([]);
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const originalRequest = client.request.bind(client);
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "agent/steer") {
        return {
          agentId: params.agentId,
          messageId: "msg-mobile-1",
          clientMessageId: params.clientMessageId,
          status: "queued_live",
          queued: true,
          queuePosition: 1,
        } as never;
      }
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
    client.emit({
      method: "turn/started",
      params: { turnId: "turn-mobile-steer" },
    });
    client.emit({
      method: "item/event",
      params: {
        turnId: "turn-mobile-steer",
        event: {
          type: "background_job_started",
          id: "agent-mobile-target",
          description: "目标子智能体",
        },
      },
    });

    const result = await runtime.steerSubagent(
      "agent-mobile-target",
      "change only this agent",
      "client-mobile-1",
    );
    expect(result.status).toBe("queued_live");
    expect(calls).toContainEqual({
      method: "agent/steer",
      params: {
        threadId: "thread-1",
        agentId: "agent-mobile-target",
        message: "change only this agent",
        clientMessageId: "client-mobile-1",
      },
    });
    expect(
      runtime
        .getSnapshot()
        .messages.flatMap((message) => message.activities ?? [])[0],
    ).toMatchObject({
      agentId: "agent-mobile-target",
      steerStatus: "queued_live",
      steerMessageId: "msg-mobile-1",
    });

    client.emit({
      method: "agent/steer/applied",
      params: {
        threadId: "thread-1",
        turnId: "turn-mobile-steer",
        agentId: "agent-mobile-target",
        messageId: "msg-mobile-1",
        clientMessageId: "client-mobile-1",
      },
    });
    expect(
      runtime
        .getSnapshot()
        .messages.flatMap((message) => message.activities ?? [])[0],
    ).toMatchObject({
      steerStatus: "applied",
      clientMessageId: "client-mobile-1",
    });
    client.emit({
      method: "item/event",
      params: {
        turnId: "turn-mobile-steer",
        event: {
          type: "background_job_progress",
          id: "agent-mobile-target",
          current: 2,
          total: 60,
        },
      },
    });
    expect(
      runtime
        .getSnapshot()
        .messages.flatMap((message) => message.activities ?? [])[0],
    ).toMatchObject({
      steerStatus: "applied",
      steerMessageId: "msg-mobile-1",
      clientMessageId: "client-mobile-1",
      detail: "2 / 60",
    });
    runtime.close();
  });

  it("服务端历史对账时保留尚未落盘的本地消息和更长的流式内容", () => {
    const reconciled = mergeReconciledMessages(
      [
        { id: "persisted-user", role: "user", content: "继续", timestampMs: 2 },
        {
          id: "persisted-assistant",
          turnId: "turn-1",
          role: "assistant",
          content: "已",
          timestampMs: 3,
        },
      ],
      [
        {
          id: "assistant-turn-1",
          turnId: "turn-1",
          role: "assistant",
          content: "已完成",
          timestampMs: 3,
        },
        { id: "local-user-2", role: "user", content: "继续", timestampMs: 2 },
        {
          id: "local-user-3",
          role: "user",
          content: "尚未落盘",
          timestampMs: 4,
        },
      ],
    );
    expect(reconciled.map((message) => message.content)).toEqual([
      "继续",
      "已完成",
      "尚未落盘",
    ]);
  });

  it("对账时以服务端已完成工具和文件状态为准", () => {
    const [message] = mergeReconciledMessages(
      [
        {
          id: "assistant",
          turnId: "turn-1",
          role: "assistant",
          content: "完成",
          timestampMs: 3,
          tools: [
            { id: "tool-1", name: "Read", status: "completed", output: "ok" },
          ],
          fileChanges: {
            artifactId: "a",
            workspacePath: "/workspace",
            fileCount: 1,
            additions: 1,
            deletions: 0,
            files: ["a.ts"],
            status: "reverted",
            revertible: false,
          },
        },
      ],
      [
        {
          id: "assistant",
          turnId: "turn-1",
          role: "assistant",
          content: "完",
          timestampMs: 3,
          tools: [{ id: "tool-1", name: "Read", status: "running" }],
          fileChanges: {
            artifactId: "a",
            workspacePath: "/workspace",
            fileCount: 1,
            additions: 1,
            deletions: 0,
            files: ["a.ts"],
            status: "active",
            revertible: true,
          },
        },
      ],
    );
    expect(message.tools).toEqual([
      { id: "tool-1", name: "Read", status: "completed", output: "ok" },
    ]);
    expect(message.fileChanges?.status).toBe("reverted");
  });
});

for (const status of ["cancelled", "interrupted"]) {
  it(`preserves ${status} when the terminal includes a cancellation reason`, async () => {
    const client = new FakeClient([]);
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
    client.emit({ method: "turn/started", params: { turnId: "cancel-turn" } });
    client.emit({ method: "turn/completed", params: {
      turnId: "cancel-turn", turn: { id: "cancel-turn", status },
      error: { message: "cancelled by user" },
    } });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.messages.find(message => message.turnId === "cancel-turn")).toMatchObject({
      status: "cancelled", error: undefined, providerFailure: undefined,
    });
    expect(snapshot.running).toBe(false);
    expect(snapshot.error).toBeNull();
    runtime.close();
  });
}
