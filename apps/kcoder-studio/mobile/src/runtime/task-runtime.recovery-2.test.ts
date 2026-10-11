import { gatewaySessionExpired } from "@/gateway/http";
import { MobileRpcError, type JsonRecord, type RpcMessage } from "@/gateway/rpc";
import type { ThreadMessage } from "@/gateway/types";
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
describe("TaskRuntime 断线恢复", () => {
  it("重连恢复仍在运行的已知回合后仍可停止该回合", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const recovered = new FakeClient([]);
    const activeThread = {
      id: "thread-1",
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
    const recoveredRequest = recovered.request.bind(recovered);
    recovered.request = vi.fn(
      async <T>(method: string, params: JsonRecord = {}) => {
        if (method === "thread/resume") return { thread: activeThread } as T;
        if (method === "thread/read")
          return { thread: activeThread, messages: [] } as T;
        return recoveredRequest<T>(method, params);
      },
    ) as never;
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
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-active" },
    });
    initial.emit({
      method: "connection/closed",
      params: { reason: "网络切换" },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(runtime.getSnapshot()).toMatchObject({
      connected: true,
      running: true,
    });
    await runtime.interrupt();
    expect(recovered.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-active",
    });
    runtime.close();
  });

  it("权威恢复确认回合已结束后清除旧的停止目标", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const recovered = new FakeClient([]);
    const idleThread = {
      id: "thread-1",
      cwd: "/workspace",
      status: "idle",
      runSummary: {
        mainTurn: "idle",
        pendingApprovals: 0,
        pendingQuestions: 0,
        activeJobs: 0,
        tasksPending: 0,
        tasksRunning: 0,
        pendingFollowups: 0,
        pendingGoals: 0,
      },
    };
    const recoveredRequest = recovered.request.bind(recovered);
    recovered.request = vi.fn(
      async <T>(method: string, params: JsonRecord = {}) => {
        if (method === "thread/resume") return { thread: idleThread } as T;
        if (method === "thread/read")
          return { thread: idleThread, messages: [] } as T;
        return recoveredRequest<T>(method, params);
      },
    ) as never;
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
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-ended" },
    });
    initial.emit({
      method: "connection/closed",
      params: { reason: "网络切换" },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(runtime.getSnapshot()).toMatchObject({
      connected: true,
      running: false,
      activeTurnId: null,
    });
    await runtime.interrupt();
    expect(recovered.request).not.toHaveBeenCalledWith(
      "turn/interrupt",
      expect.anything(),
    );
    runtime.close();
  });

  it("新恢复的运行中任务没有权威 turnId 时不猜测停止目标", async () => {
    const client = new FakeClient([]);
    const activeThread = {
      id: "thread-1",
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
    const calls: string[] = [];
    client.request = vi.fn(async <T>(method: string) => {
      calls.push(method);
      if (method === "thread/resume") return { thread: activeThread } as T;
      if (method === "thread/read")
        return { thread: activeThread, messages: [] } as T;
      return {} as T;
    }) as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    expect(runtime.getSnapshot()).toMatchObject({
      connected: true,
      running: true,
      activeTurnId: null,
    });
    await runtime.interrupt();

    expect(calls).not.toContain("turn/interrupt");
    runtime.close();
  });

  it("普通 turn/start ACK 按 optimistic message id 绑定本地用户回合", async () => {
    const client = new FakeClient([]);
    const originalRequest = client.request.bind(client);
    client.request = vi.fn(async <T>(method: string, params: JsonRecord = {}) => {
      if (method === "turn/start")
        return { turn: { id: "turn-direct-ack", status: "running" } } as T;
      return originalRequest<T>(method, params);
    }) as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    await runtime.send("accepted directly");

    expect(
      runtime.getSnapshot().messages.find(
        (message) => message.role === "user" && message.content === "accepted directly",
      ),
    ).toMatchObject({
      turnId: "turn-direct-ack",
      clientMessageId: expect.any(String),
    });
    runtime.close();
  });

  it("显式核对延迟回执时按 clientMessageId 归并权威历史", async () => {
    const history: ThreadMessage[] = [];
    const client = new FakeClient(history);
    client.supportsExperimental = (capability) => capability === "turnReceiptsV1";
    const originalRequest = client.request.bind(client);
    let receiptReads = 0;
    let turnStarts = 0;
    client.request = vi.fn(async <T>(method: string, params: JsonRecord = {}) => {
      if (method === "turn/start") {
        turnStarts++;
        history.push({
          id: "server-late-user",
          role: "user",
          content: "late acceptance",
          timestampMs: Date.now(),
          turnId: "turn-late-accepted",
        });
        throw new MobileRpcError("turn/start ACK lost");
      }
      if (method === "turn/receipt/read") {
        receiptReads++;
        return {
          receipt:
            receiptReads === 1
              ? null
              : {
                  threadId: "thread-1",
                  turnId: "turn-late-accepted",
                  status: "completed",
                },
        } as T;
      }
      return originalRequest<T>(method, params);
    }) as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    await runtime.send("late acceptance", [], undefined, {
      clientMessageId: "client-late-accepted",
    });
    expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(true);
    await runtime.reconcileSendAcceptance();

    const userMessages = runtime
      .getSnapshot()
      .messages.filter((message) => message.role === "user");
    expect(turnStarts).toBe(1);
    expect(receiptReads).toBe(2);
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      id: "server-late-user",
      turnId: "turn-late-accepted",
      content: "late acceptance",
    });
    runtime.close();
  });

  it("重连后的模型策略清除不兼容的旧推理强度再发送", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const recovered = new FakeClient([]);
    const thread = (model: string) => ({
      id: "thread-1",
      cwd: "/workspace",
      status: "idle",
      model,
    });
    const configuration = (
      modelId: string,
      efforts: string[],
      defaultEffort: string,
    ) => ({
      providerId: `provider-${modelId.toLowerCase()}`,
      modelId,
      revision: modelId === "M1" ? "a".repeat(64) : "b".repeat(64),
      boundary: "session_snapshot",
      reasoningEffort: defaultEffort,
      reasoningPolicy: { mode: "optional", efforts },
    });
    const configureClient = (
      client: FakeClient,
      modelId: string,
      efforts: string[],
      defaultEffort: string,
    ) => {
      client.supportsExperimental = (capability) =>
        capability === "qualifiedModelSelectionV1";
      client.request = vi.fn(
        async <T>(method: string, _params: JsonRecord = {}) => {
          if (method === "thread/resume")
            return { thread: thread(modelId) } as T;
          if (method === "thread/read")
            return { thread: thread(modelId), messages: [] } as T;
          if (method === "runtime.models.list")
            return {
              activeConfiguration: configuration(
                modelId,
                efforts,
                defaultEffort,
              ),
            } as T;
          if (method === "turn/start")
            return { turn: { id: "turn-after-reconnect", status: "running" } } as T;
          return {} as T;
        },
      ) as never;
    };
    configureClient(initial, "M1", ["low", "medium", "ultra"], "medium");
    configureClient(recovered, "M2", ["low", "medium"], "medium");
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
      reasoningEffort: "ultra",
    });

    expect(runtime.getSnapshot()).toMatchObject({
      model: "M1",
      reasoningEffort: "ultra",
    });
    initial.emit({
      method: "connection/closed",
      params: { reason: "网络切换" },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(runtime.getSnapshot()).toMatchObject({
      connected: true,
      model: "M2",
      reasoningEffort: "medium",
    });
    await runtime.send("next turn");
    expect(recovered.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "thread-1",
        model: "M2",
        reasoningEffort: "medium",
      }),
    );
    const turnStartParams = vi.mocked(recovered.request).mock.calls.find(
      ([method]) => method === "turn/start",
    )?.[1] as JsonRecord | undefined;
    expect(turnStartParams?.reasoningEffort).not.toBe("ultra");
    runtime.close();
  });

  it.each([
    {
      status: "interrupted",
      expected: "cancelled",
      snapshotError: null,
      messageError: null,
    },
    {
      status: "failed",
      expected: "failed",
      snapshotError: "cancelled by user",
      messageError: "cancelled by user",
    },
  ])("保留 turn/completed 的权威 $status 状态并忽略终态错误覆盖", async ({
    status,
    expected,
    snapshotError,
    messageError,
  }) => {
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
      params: { threadId: "thread-1", turnId: "turn-terminal" },
    });
    client.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-terminal", status },
        error: { message: "cancelled by user" },
      },
    });

    expect(runtime.getSnapshot().messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        turnId: "turn-terminal",
        status: expected,
      }),
    );
    const message = runtime
      .getSnapshot()
      .messages.find((item) => item.turnId === "turn-terminal");
    if (messageError === null)
      expect(message).not.toHaveProperty("error");
    else expect(message?.error).toBe(messageError);
    expect(runtime.getSnapshot()).toMatchObject({
      running: false,
      activeTurnId: null,
      error: snapshotError,
    });
    runtime.close();
  });

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
        {
          id: "persisted-user",
          role: "user",
          turnId: "turn-1",
          content: "继续",
          timestampMs: 2,
        },
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
        {
          id: "local-user-2",
          role: "user",
          turnId: "turn-1",
          content: "继续",
          timestampMs: 2,
        },
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

  it.each(["running", "completed"] as const)(
    "历史缺页时不把重复文案的新附件并到旧回合，%s 回执后按回合归并",
    async (receiptStatus) => {
      const prompt = "同一句话再发一次";
      const attachment = {
        filename: "new-turn.txt",
        mimeType: "text/plain",
        fileSize: 4,
        path: "/attachments/new-turn.txt",
      };
      const createdAt = Date.now();
      const oldHistory = [
        {
          id: "persisted-user-old",
          role: "user",
          turnId: "turn-old",
          content: prompt,
          timestampMs: createdAt - 60_000,
          blocks: [],
        },
        {
          id: "persisted-assistant-old",
          role: "assistant",
          turnId: "turn-old",
          content: "上一轮已完成",
          timestampMs: createdAt - 20_000,
          blocks: [],
        },
      ];
      const activeThread = {
        id: "thread-1",
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
      const idleThread = { ...activeThread, status: "idle", runSummary: { ...activeThread.runSummary, mainTurn: "idle" } };
      const receiptThread = receiptStatus === "running" ? activeThread : idleThread;
      const clients: FakeClient[] = [
        new FakeClient([]),
        new FakeClient([]),
        new FakeClient([]),
      ];
      const requests = clients.map(() => [] as Array<{ method: string; params: JsonRecord }>);
      let rejectStart: ((error: Error) => void) | undefined;
      let startParams: JsonRecord | undefined;
      let localTimestamp: number | undefined;

      clients.forEach((client, index) => {
        client.supportsExperimental = (capability: string) =>
          capability === "threadIndexedPagesV1" || capability === "turnReceiptsV1";
        const defaultRequest = client.request.bind(client);
        client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
          requests[index].push({ method, params });
          if (method === "thread/resume")
            return { thread: index === 0 ? idleThread : receiptThread } as never;
          if (method === "thread/read/indexed") {
            const messages = index < 2
              ? oldHistory
              : [
                  ...oldHistory,
                  {
                    id: "persisted-user-new",
                    role: "user",
                    turnId: "turn-new",
                    content: prompt,
                    timestampMs: localTimestamp,
                    attachments: [attachment],
                    blocks: [],
                  },
                ];
            return {
              thread: index === 0 ? idleThread : receiptThread,
              messages,
              hasMoreBefore: false,
              beforeCursor: null,
              rangeStart: 0,
              rangeEnd: messages.length,
            } as never;
          }
          if (method === "turn/start") {
            startParams = params;
            return new Promise((resolve, reject) => {
              rejectStart = reject;
            }) as never;
          }
          if (method === "turn/receipt/read")
            return {
              receipt: {
                threadId: params.threadId,
                turnId: "turn-new",
                status: receiptStatus,
              },
            } as never;
          return defaultRequest(method, params);
        }) as never;
      });
      const originalClose = clients[0].close.bind(clients[0]);
      clients[0].close = () => {
        originalClose();
        rejectStart?.(
          new MobileRpcError("controlled accepted request lost its ACK", -1, "transport", "unknown"),
        );
      };

      let nextClient = 0;
      taskRuntimeTestHelpers.setConnector(
        vi.fn(async () => clients[nextClient++] as never) as never,
      );
      const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
      const send = runtime.send(prompt, [attachment], undefined, {
        clientMessageId: "client-new",
      });
      await vi.waitFor(() => expect(startParams).toBeDefined());
      const optimistic = runtime.getSnapshot().messages.find(
        (message) => message.role === "user" && message.id.startsWith("local-user-"),
      );
      localTimestamp = optimistic?.timestampMs;
      expect(startParams?.clientMessageId).toBe("client-new");

      await runtime.reconnectNow();
      await expect(send).resolves.toBeUndefined();

      const recoveredUsers = runtime.getSnapshot().messages.filter(
        (message) => message.role === "user",
      );
      expect(requests[1].filter((request) => request.method === "turn/start")).toHaveLength(0);
      expect(requests[1].filter((request) => request.method === "turn/receipt/read")).toEqual([
        {
          method: "turn/receipt/read",
          params: { threadId: "thread-1", clientMessageId: "client-new" },
        },
      ]);
      expect(recoveredUsers).toHaveLength(2);
      expect(recoveredUsers[0]).toMatchObject({
        id: "persisted-user-old",
        turnId: "turn-old",
        content: prompt,
        attachments: undefined,
      });
      expect(recoveredUsers[1]).toMatchObject({
        id: expect.stringMatching(/^local-user-/),
        turnId: "turn-new",
        content: prompt,
        attachments: [expect.objectContaining({ path: attachment.path })],
      });

      await runtime.reconnectNow();
      const reconciledUsers = runtime.getSnapshot().messages.filter(
        (message) => message.role === "user",
      );
      expect(reconciledUsers).toHaveLength(2);
      expect(reconciledUsers).toContainEqual(
        expect.objectContaining({
          id: "persisted-user-new",
          turnId: "turn-new",
          content: prompt,
          attachments: [expect.objectContaining({ path: attachment.path })],
        }),
      );
      expect(reconciledUsers.some((message) => message.id.startsWith("local-user-") && message.turnId === "turn-new")).toBe(false);
      expect(runtime.getSnapshot()).toMatchObject(
        receiptStatus === "running"
          ? { running: true, activeTurnId: "turn-new" }
          : { running: false, activeTurnId: null },
      );
      runtime.close();
    },
  );

  it("历史项和本地用户消息都没有身份时不靠相同文案猜测合并", () => {
    const attachment = {
      filename: "new-turn.txt",
      mimeType: "text/plain",
      fileSize: 4,
      path: "/attachments/new-turn.txt",
    };
    const reconciled = mergeReconciledMessages(
      [
        { id: "legacy-user", role: "user", content: "重复提示", timestampMs: 100 },
      ],
      [
        {
          id: "local-user-new",
          role: "user",
          content: "重复提示",
          timestampMs: 101,
          attachments: [attachment],
        },
      ],
    );

    expect(reconciled).toHaveLength(2);
    expect(reconciled.map((message) => message.id)).toEqual([
      "legacy-user",
      "local-user-new",
    ]);
    expect(reconciled[0]?.attachments).toBeUndefined();
    expect(reconciled[1]?.attachments?.[0]?.path).toBe(attachment.path);
  });

  it("同回合也要求文本和双方已知附件路径一致才归并", () => {
    const reconciled = mergeReconciledMessages(
      [
        {
          id: "persisted-user",
          role: "user",
          turnId: "turn-same",
          content: "same payload",
          timestampMs: 100,
          attachments: [{ filename: "server.txt", mimeType: "text/plain", fileSize: 1, path: "/server.txt" }],
        },
      ],
      [
        {
          id: "local-user",
          role: "user",
          turnId: "turn-same",
          content: "same payload",
          timestampMs: 101,
          attachments: [{ filename: "local.txt", mimeType: "text/plain", fileSize: 1, path: "/local.txt" }],
        },
      ],
    );

    expect(reconciled).toHaveLength(2);
    expect(reconciled.map((message) => message.id)).toEqual([
      "persisted-user",
      "local-user",
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
    const message = snapshot.messages.find(message => message.turnId === "cancel-turn");
    expect(message?.status).toBe("cancelled");
    expect(message?.error).toBeUndefined();
    expect(message?.providerFailure).toBeUndefined();
    expect(snapshot.running).toBe(false);
    expect(snapshot.error).toBeNull();
    runtime.close();
  });
}
