import { MobileRpcError } from '@/gateway/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadMessage,
} from "@/gateway/types";
import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import {
  defaultModelOption,
  modelOptionSelector,
  selectedModelOption,
  threadModelSelector,
  mergeReconciledMessages,
  listManagedWorktrees,
  prepareManagedWorktree,
  previewManagedWorktreeArchive,
  archiveManagedWorktree,
  restoreManagedWorktree,
  forgetManagedWorktree,
  TaskRuntime,
  ThreadListPager,
  listThreads,
  deleteStoredThread,
  taskRuntimeRegistry,
  taskRuntimeTestHelpers,
  updateThreadMetadata,
} from "./task-runtime";

const profile: GatewayProfile = {
  id: "gateway-a",
  label: "A",
  baseUrl: "http://127.0.0.1:4173",
  accessToken: "access",
  expiresAt: Number.MAX_SAFE_INTEGER,
  rpcToken: "rpc",
};
const server: KCoderServer = {
  id: "local",
  label: "Local",
  description: "test",
  runtime: "kcoder",
  transport: "local",
  workspacePath: "/workspace",
};

class FakeClient {
  listeners = new Set<(message: RpcMessage) => void>();
  closed = false;

  constructor(
    private readonly history: ThreadMessage[],
    private readonly duringRead: RpcMessage[] = [],
    private readonly historyPage: {
      hasMoreBefore?: boolean;
      beforeCursor?: string | null;
    } = {},
  ) {}

  subscribe(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  supportsExperimental(capability: string): boolean {
    return capability === "agentSteering";
  }

  async request<T>(method: string, _params: JsonRecord = {}): Promise<T> {
    if (method === "thread/resume") {
      return {
        thread: {
          id: "thread-1",
          title: "恢复任务",
          cwd: "/workspace",
          status: "idle",
        },
      } as T;
    }
    if (method === "thread/read") {
      for (const message of this.duringRead.splice(0)) this.emit(message);
      return {
        thread: {
          id: "thread-1",
          title: "恢复任务",
          cwd: "/workspace",
          status: "idle",
        },
        messages: this.history,
        ...this.historyPage,
      } as T;
    }
    return {} as T;
  }

  respond(): void {}
  respondError(): void {}
  close(): void {
    this.closed = true;
  }
  emit(message: RpcMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

// Backoff timing is deterministic here; shared policy tests cover the jitter bounds.
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.5); });

afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});

describe("TaskRuntime.create", () => {
  it('routes session and one-turn modes explicitly and rejects unsupported servers before creation', async () => {
    const client = new FakeClient([]);
    const supportsExperimental = vi.fn(() => false);
    Object.assign(client, { supportsExperimental });
    client.close = vi.fn();
    client.request = vi.fn(async (method: string) => {
      if (method === 'thread/start') return {thread:{id:'mode-thread'}} as never;
      if (method === 'turn/start') return {turn:{id:'mode-turn'}} as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    await expect(TaskRuntime.create({profile,server,cwd:'/workspace',prompt:'test',sessionMode:'orchestrate'})).rejects.toThrow('升级');
    expect(client.request).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    supportsExperimental.mockReturnValue(true);
    const task = await TaskRuntime.create({profile,server,cwd:'/workspace',prompt:'plan',sessionMode:'orchestrate',turnMode:'moa-plan'});
    expect(client.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({sessionMode:'orchestrate'}));
    expect(client.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({turnMode:'moa-plan'}));
    task.close();
  });
  it("turn 启动失败时尽力删除刚创建的空 resident thread", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const client = new FakeClient([]);
    client.close = vi.fn();
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "thread/start")
        return { thread: { id: "empty-thread" } } as never;
      if (method === "turn/start") throw new MobileRpcError("turn rejected", -32602, "remote");
      if (method === "thread/delete") return { deleted: true } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    await expect(
      TaskRuntime.create({
        profile,
        server,
        cwd: "/workspace",
        prompt: "失败创建",
      }),
    ).rejects.toThrow("turn rejected");
    expect(calls.at(-1)).toEqual({
      method: "thread/delete",
      params: { threadId: "empty-thread" },
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("uses the model confirmed by thread/start when the client leaves it unspecified", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const client = new FakeClient([]);
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "thread/start") {
        return {
          thread: { id: "server-default", model: "MiniMax-M3" },
        } as never;
      }
      if (method === "turn/start") return { turn: { id: "turn-1" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.create({
      profile,
      server,
      cwd: "/workspace",
      prompt: "使用服务端默认模型",
    });

    expect(runtime.getSnapshot().model).toBe("MiniMax-M3");
    expect(calls).toContainEqual({
      method: "turn/start",
      params: {
        threadId: "server-default",
        input: [{ type: "text", text: "使用服务端默认模型" }],
        clientMessageId: expect.any(String),
        model: "MiniMax-M3",
      },
    });
    runtime.close();
  });
});

describe("defaultModelOption", () => {
  it.each([false, true])("negotiates old mobile targets without guessing multi-model defaults (%s)", async ambiguous => {
    const client = new FakeClient([]);
    client.request = vi.fn(async (method: string) => {
      if (method === "runtime.models.list") return { data: [
        { providerId: "first", model: "same" }, { providerId: "second", model: "same" },
        ...(ambiguous ? [{ providerId: "second", model: "other" }] : []),
      ] } as never;
      if (method === "thread/start") return { thread: { id: "legacy-thread", model: "same" } } as never;
      if (method === "turn/start") return { turn: { id: "legacy-turn" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const creation = TaskRuntime.create({ profile, server, cwd: "/workspace", prompt: "hello", model: "second::same" });
    if (ambiguous) {
      await expect(creation).rejects.toThrow("升级");
      expect(client.request).not.toHaveBeenCalledWith("thread/start", expect.anything());
    } else {
      const runtime = await creation;
      expect(client.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ model: "second" }));
      expect(client.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ model: "second" }));
      runtime.close();
    }
  });
  it.each(["first::same", "first::other", "second::same"])("sends the complete mobile model selector %s on thread and turn creation", async selector => {
    const client = new FakeClient([]);
    client.supportsExperimental = () => true;
    client.request = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "qualified-thread", model: selector } } as never;
      if (method === "turn/start") return { turn: { id: "qualified-turn" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const runtime = await TaskRuntime.create({ profile, server, cwd: "/workspace", prompt: "hello", model: selector });
    expect(client.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ model: selector }));
    expect(client.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ model: selector }));
    expect(runtime.getSnapshot().model).toBe(selector);
    runtime.close();
  });
  it("keeps same-name models on different providers distinct and accepts legacy bare selections", () => {
    const models = ["first", "second"].map(provider => ({ id: `${provider}::same`, model: "same", displayName: "same", providerId: provider, providerName: provider }));
    expect(models.map(modelOptionSelector)).toEqual(["first::same", "second::same"]);
    expect(selectedModelOption(models, "second::same")).toBe(models[1]);
    expect(selectedModelOption(models, "same")).toBe(models[0]);
    expect(threadModelSelector({ model: "same", modelProvider: "second" })).toBe("second::same");
    expect(threadModelSelector({ model: "second::same", modelProvider: "second" })).toBe("second::same");
    expect(threadModelSelector({ model: "same" })).toBe("same");
  });
  const option = (
    model: string,
    flags: { providerCurrent?: boolean; isDefault?: boolean },
  ) => ({
    id: model,
    model,
    displayName: model,
    providerId: model,
    providerName: model,
    ...flags,
  });

  it("prefers the default model in the current provider", () => {
    const first = option("first", {});
    const defaultElsewhere = option("default-elsewhere", { isDefault: true });
    const currentDefault = option("current-default", {
      providerCurrent: true,
      isDefault: true,
    });

    expect(defaultModelOption([first, defaultElsewhere, currentDefault])).toBe(
      currentDefault,
    );
  });

  it("falls back from default model to current provider and then list order", () => {
    const first = option("first", {});
    const current = option("current", { providerCurrent: true });

    expect(defaultModelOption([first, current])).toBe(current);
    expect(defaultModelOption([first])).toBe(first);
  });
});

describe("TaskRuntime.resume", () => {
  it("preserves empty failed attempts and their continuation identity in restored history", async () => {
    const client = new FakeClient([
      { id: "failure-1", role: "assistant", content: "", status: "failed", timestampMs: 1,
        turnId: "turn-1", attemptId: "turn-1", continuedByAttemptId: "turn-1-retry-next", error: "service unavailable" },
      { id: "failure-2", role: "assistant", content: "partial", status: "failed", timestampMs: 2,
        turnId: "turn-1", attemptId: "turn-1-retry-next", error: "stream interrupted" },
    ]);
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
    expect(runtime.getSnapshot().messages).toMatchObject([
      { id: "failure-1", status: "failed", content: "", attemptId: "turn-1", continuedByAttemptId: "turn-1-retry-next", error: "service unavailable" },
      { id: "failure-2", status: "failed", content: "partial", attemptId: "turn-1-retry-next" },
    ]);
    runtime.close();
  });

  it("从 agent/list 恢复服务端权威的定向消息队列状态", async () => {
    const client = new FakeClient([]);
    const originalRequest = client.request.bind(client);
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      if (method === "agent/list") {
        return {
          threadId: "thread-1",
          agents: [
            {
              agentId: "agent-resumed",
              agentName: "reviewer",
              status: "paused",
              acceptingMessages: true,
              queueDepth: 1,
              headMessageId: "msg-resumed",
              headStatus: "queued",
            },
          ],
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

    expect(
      runtime
        .getSnapshot()
        .messages.flatMap((message) => message.activities ?? []),
    ).toContainEqual(
      expect.objectContaining({
        agentId: "agent-resumed",
        steerStatus: "queued_paused",
        steerMessageId: "msg-resumed",
      }),
    );
    runtime.close();
  });

  it("restores the conversation model from app-server state", async () => {
    const client = new FakeClient([]);
    client.request = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        return {
          thread: {
            id: "thread-server-model",
            title: "服务端模型",
            cwd: "/workspace",
            status: "idle",
            model: "MiniMax-M3",
          },
        } as never;
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-server-model",
            title: "历史标题",
            cwd: "/workspace",
            status: "idle",
          },
          messages: [],
        } as never;
      }
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-server-model",
      reasoningEffort: "high",
    });

    expect(runtime.getSnapshot()).toMatchObject({
      model: "MiniMax-M3",
      reasoningEffort: "high",
    });
    runtime.close();
  });

  it("向界面返回真实的上下文压缩结果", async () => {
    const client = new FakeClient([]);
    client.request = vi.fn(async (method: string) => {
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-compact",
            title: "压缩任务",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "thread/compact")
        return {
          threadId: "thread-compact",
          compacted: false,
          preTokens: 58,
          postTokens: 58,
        } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-compact",
    });

    await expect(runtime.compact()).resolves.toEqual({
      threadId: "thread-compact",
      compacted: false,
      preTokens: 58,
      postTokens: 58,
    });
    expect(client.request).toHaveBeenLastCalledWith(
      "thread/compact",
      { threadId: "thread-compact" },
      60_000,
    );
    runtime.close();
  });

  it("按 TUI goal 模式设置服务端权威目标", async () => {
    const client = new FakeClient([]);
    client.request = vi.fn(async (method: string) => {
      if (method === "thread/resume")
        return {
          thread: { id: "thread-goal", cwd: "/workspace", status: "idle" },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "thread/goal/set")
        return { goal: { objective: "完成并验证", mode: "strict" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-goal",
    });

    await runtime.setGoal("  完成并验证  ", "strict");

    expect(client.request).toHaveBeenLastCalledWith(
      "thread/goal/set",
      {
        threadId: "thread-goal",
        objective: "完成并验证",
        mode: "strict",
        status: "active",
      },
      undefined,
    );
    runtime.close();
  });

  it("通过 app-server 执行 goal 查询、历史、编辑、状态和清除", async () => {
    const client = new FakeClient([]);
    const goal = {
      threadId: "thread-goal",
      goalId: "goal-1",
      revision: 7,
      objective: "目标",
      mode: "strict",
      verificationKind: "answer",
      status: "paused",
    };
    client.request = vi.fn(async (method: string) => {
      if (method === "thread/resume")
        return {
          thread: { id: "thread-goal", cwd: "/workspace", status: "idle" },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "thread/goal/get") return { goal } as never;
      if (method === "thread/goal/history") return { goals: [goal] } as never;
      if (method === "thread/goal/set") return { goal } as never;
      if (method === "thread/goal/clear") return { cleared: true } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-goal",
    });

    await expect(runtime.getGoal()).resolves.toMatchObject({
      objective: "目标",
    });
    await expect(runtime.getGoalHistory()).resolves.toHaveLength(1);
    await runtime.editGoal("新目标", 2048);
    await runtime.updateGoalStatus("active");
    await expect(runtime.clearGoal()).resolves.toBe(true);

    expect(client.request).toHaveBeenCalledWith(
      "thread/goal/set",
      {
        threadId: "thread-goal",
        objective: "新目标",
        edit: true,
        tokenBudget: 2048,
        expectedGoalId: "goal-1",
        expectedRevision: 7,
      },
      undefined,
    );
    expect(client.request).toHaveBeenCalledWith(
      "thread/goal/set",
      {
        threadId: "thread-goal",
        status: "active",
        expectedGoalId: "goal-1",
        expectedRevision: 7,
      },
      undefined,
    );
    expect(client.request).toHaveBeenCalledWith(
      "thread/goal/clear",
      {
        threadId: "thread-goal",
        expectedGoalId: "goal-1",
        expectedRevision: 7,
      },
      undefined,
    );
    runtime.close();
  });
});

describe("ThreadListPager", () => {
  it("新协议缺少会话数组时不把响应伪装成完整空列表", async () => {
    const client = { close: vi.fn(), supportsExperimental: () => true, request: vi.fn(async () => ({ completeness: "complete", issueCount: 0 })) };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    await expect(listThreads(profile, server)).rejects.toThrow("会话列表");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("分页出现重复 cursor 或完整性变化时关闭短连接且拒绝替换列表", async () => {
    for (const mode of ["cursor", "completeness"]) {
      const client = {
        close: vi.fn(), supportsExperimental: () => true,
        request: vi.fn(async (_method: string, params: JsonRecord) => ({
          threads: [], nextCursor: "same", completeness: mode === "completeness" && params.cursor ? "partial" : "complete",
          issueCount: mode === "completeness" && params.cursor ? 2 : 0,
        })),
      };
      taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
      await expect(listThreads(profile, server)).rejects.toThrow(mode === "cursor" ? "重复" : "完整性");
      expect(client.close).toHaveBeenCalledTimes(1);
    }
  });

  it("自动列表遍历对不断生成的空页有上限", async () => {
    let requests = 0;
    const client = {
      close: vi.fn(), supportsExperimental: () => true,
      request: vi.fn(async () => ({ threads: [], completeness: "complete", issueCount: 0,
        ...(requests++ < 205 ? { nextCursor: `cursor-${requests}` } : {}),
      })),
    };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    await expect(listThreads(profile, server)).rejects.toThrow("分页");
    expect(requests).toBeLessThanOrEqual(200);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  // These fixtures exercise model-independent pagination and archive safety contracts.
  it("每页显式选择 partial 并保留完整快照的问题数量", async () => {
    const client = {
      close: vi.fn(),
      supportsExperimental: (name: string) => name === "threadListCompleteness",
      request: vi.fn(async (_method: string, params: JsonRecord) => ({
        threads: [{ id: params.cursor ? "b" : "a", status: "idle", createdAt: 1, updatedAt: 1 }],
        completeness: "partial",
        issueCount: 2,
        ...(params.cursor ? {} : { nextCursor: "snapshot:1" }),
      })),
    };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const pager = new ThreadListPager(profile, server);
    try {
      const first = await pager.page();
      expect(first).toMatchObject({ completeness: "partial", issueCount: 2, nextCursor: "snapshot:1" });
      const second = await pager.page(first.nextCursor);
      expect(second).toMatchObject({ completeness: "partial", issueCount: 2 });
      expect(second.threads.map((thread) => thread.id)).toEqual(["a", "b"]);
      expect(client.request.mock.calls.map(([, params]) => params.allowPartial)).toEqual([true, true]);
    } finally { pager.close(); }
  });

  it("首页列表排完分页并返回完整性而非仅首页数组", async () => {
    const client = {
      close: vi.fn(),
      supportsExperimental: () => false,
      request: vi.fn(async (_method: string, params: JsonRecord) => ({
        threads: [{ id: params.cursor ? "b" : "a", status: "idle", createdAt: 1, updatedAt: 1 }],
        ...(params.cursor ? {} : { nextCursor: "snapshot:1" }),
      })),
    };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const result = await listThreads(profile, server);
    expect(result).toMatchObject({ completeness: "complete", issueCount: 0 });
    expect(result.threads.map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request.mock.calls.every(([, params]) => !("allowPartial" in params))).toBe(true);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("关联会话 partial 时拒绝 worktree 归档预检及释放", async () => {
    const client = {
      close: vi.fn(),
      supportsExperimental: () => true,
      request: vi.fn(async (method: string) => method === "thread/list"
        ? { threads: [], completeness: "partial", issueCount: 1 }
        : { preview: {} }),
    };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    await expect(previewManagedWorktreeArchive(profile, server, "/worktree")).rejects.toThrow("不完整");
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["thread/list"]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("在同一条 RPC 连接上按 cursor 分页并在结束时关闭", async () => {
    const requests: JsonRecord[] = [];
    const client = {
      close: vi.fn(),
      request: vi.fn(async (_method: string, params: JsonRecord) => {
        requests.push(params);
        return params.cursor
          ? {
              threads: [
                { id: "thread-1", status: "idle", createdAt: 1, updatedAt: 1 },
              ],
            }
          : {
              threads: [
                { id: "thread-2", status: "idle", createdAt: 2, updatedAt: 2 },
              ],
              nextCursor: "snapshot:1",
            };
      }),
    };
    const connect = vi.fn(async () => client as never);
    taskRuntimeTestHelpers.setConnector(connect as never);
    const pager = new ThreadListPager(profile, server, {
      archived: false,
      query: "workspace",
    });

    const first = await pager.page(undefined, 50);
    const second = await pager.page(first.nextCursor, 50);
    pager.close();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([
      { limit: 50, archived: false, query: "workspace" },
      { limit: 50, cursor: "snapshot:1", archived: false, query: "workspace" },
    ]);
    expect(second.threads.map((thread) => thread.id)).toEqual(["thread-2", "thread-1"]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("历史列表操作使用短连接并保证关闭", async () => {
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    const requestsByClient: Array<
      Array<{ method: string; params: JsonRecord }>
    > = [[], [], []];
    const clients = requestsByClient.map((clientRequests) => ({
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord) => {
        const request = { method, params };
        requests.push(request);
        clientRequests.push(request);
        return {};
      }),
    }));
    const connect = vi.fn(
      async (
        _profile: GatewayProfile,
        _server: KCoderServer,
        _workspacePath?: string,
      ) => clients[connect.mock.calls.length - 1] as never,
    );
    taskRuntimeTestHelpers.setConnector(connect as never);

    await updateThreadMetadata(
      profile,
      server,
      "thread-1",
      { title: "新标题", archivedAt: null },
      "/workspace/project",
    );
    await deleteStoredThread(
      profile,
      server,
      "thread-1",
      "/workspace/project",
      ["/attachments/a.png"],
    );

    expect(requests).toEqual([
      {
        method: "thread/metadata/update",
        params: { threadId: "thread-1", title: "新标题", archivedAt: null },
      },
      { method: "thread/read", params: { threadId: "thread-1", limit: 50 } },
      { method: "thread/delete", params: { threadId: "thread-1" } },
      {
        method: "runtime.worktrees.conversations.remove",
        params: {
          deviceId: "local",
          path: "/workspace/project",
          taskId: "thread-1",
        },
      },
      { method: "attachment/delete", params: { path: "/attachments/a.png" } },
    ]);
    expect(
      connect.mock.calls.map(([, , workspacePath]) => workspacePath),
    ).toEqual(["/workspace/project", "/workspace/project", "/workspace"]);
    expect(requestsByClient).toEqual([
      [
        {
          method: "thread/metadata/update",
          params: { threadId: "thread-1", title: "新标题", archivedAt: null },
        },
      ],
      [
        { method: "thread/read", params: { threadId: "thread-1", limit: 50 } },
        { method: "thread/delete", params: { threadId: "thread-1" } },
        { method: "attachment/delete", params: { path: "/attachments/a.png" } },
      ],
      [
        {
          method: "runtime.worktrees.conversations.remove",
          params: {
            deviceId: "local",
            path: "/workspace/project",
            taskId: "thread-1",
          },
        },
      ],
    ]);
    expect(clients.map((client) => client.close.mock.calls.length)).toEqual([
      1, 1, 1,
    ]);
  });

  it("永久删除历史任务前分页收集已发送附件并与排队附件去重", async () => {
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    const attachmentMessage = (id: string, path: string): ThreadMessage => ({
      id,
      role: "user",
      content: "附件",
      blocks: [
        {
          type: "attachment",
          attachment: {
            filename: `${id}.png`,
            mimeType: "image/png",
            fileSize: 42,
            path,
          },
        },
      ],
      timestampMs: 1,
    });
    const client = {
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord) => {
        requests.push({ method, params });
        if (method === "thread/read" && !params.beforeCursor) {
          return {
            messages: [
              attachmentMessage("new", "/attachments/new.png"),
              attachmentMessage("duplicate", "/attachments/queued.png"),
            ],
            hasMoreBefore: true,
            beforeCursor: "older:1",
          };
        }
        if (method === "thread/read") {
          return {
            messages: [attachmentMessage("old", "/attachments/old.png")],
            hasMoreBefore: false,
          };
        }
        return {};
      }),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    await deleteStoredThread(
      profile,
      server,
      "thread-with-attachments",
      "/workspace/project",
      ["/attachments/queued.png"],
    );

    expect(requests).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-with-attachments", limit: 50 },
      },
      {
        method: "thread/read",
        params: {
          threadId: "thread-with-attachments",
          limit: 50,
          beforeCursor: "older:1",
        },
      },
      {
        method: "thread/delete",
        params: { threadId: "thread-with-attachments" },
      },
      {
        method: "runtime.worktrees.conversations.remove",
        params: {
          deviceId: "local",
          path: "/workspace/project",
          taskId: "thread-with-attachments",
        },
      },
      {
        method: "attachment/delete",
        params: { path: "/attachments/queued.png" },
      },
      { method: "attachment/delete", params: { path: "/attachments/new.png" } },
      { method: "attachment/delete", params: { path: "/attachments/old.png" } },
    ]);
    expect(client.close).toHaveBeenCalledTimes(2);
  });
});

describe("TaskRuntimeRegistry", () => {
  it("第九个任务不会淘汰仍在运行的最早任务", async () => {
    const clients: Array<{
      client: FakeClient;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => {
        const client = new FakeClient([]);
        const close = vi.fn(() => undefined);
        client.close = close;
        client.request = vi.fn(
          async (method: string, params: JsonRecord = {}) => {
            if (method === "thread/resume")
              return {
                thread: {
                  id: String(params.threadId),
                  title: String(params.threadId),
                  cwd: "/workspace",
                  status: "idle",
                },
              } as never;
            if (method === "thread/read") return { messages: [] } as never;
            return {} as never;
          },
        );
        clients.push({ client, close });
        return client as never;
      }) as never,
    );

    for (let index = 0; index < 9; index += 1) {
      const runtime = await TaskRuntime.resume({
        profile,
        server,
        threadId: `thread-${index}`,
      });
      if (index === 0)
        clients[0].client.emit({
          method: "turn/started",
          params: { turnId: "turn-running" },
        });
      taskRuntimeRegistry.put(profile.id, server.id, runtime);
    }

    expect(clients[0].close).not.toHaveBeenCalled();
    taskRuntimeRegistry.removeProfile(profile.id);
  });

  it("第九个任务不会淘汰仍有后台 PTY 的任务", async () => {
    const clients: Array<{
      client: FakeClient;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => {
        const client = new FakeClient([]);
        const close = vi.fn(() => undefined);
        client.close = close;
        client.request = vi.fn(
          async (method: string, params: JsonRecord = {}) => {
            if (method === "thread/resume")
              return {
                thread: {
                  id: String(params.threadId),
                  title: String(params.threadId),
                  cwd: "/workspace",
                  status: "idle",
                },
              } as never;
            if (method === "thread/read") return { messages: [] } as never;
            if (method === "terminal/start")
              return {
                session_id: "background-pty",
                cwd: "/workspace",
              } as never;
            if (method === "terminal/attach")
              return {
                session_id: params.session_id,
                cwd: "/workspace",
                transcript: "",
                through_sequence: 0,
              } as never;
            return {} as never;
          },
        );
        clients.push({ client, close });
        return client as never;
      }) as never,
    );

    for (let index = 0; index < 9; index += 1) {
      const runtime = await TaskRuntime.resume({
        profile,
        server,
        threadId: `terminal-thread-${index}`,
      });
      if (index === 0) await runtime.terminalSession("terminal-main").start();
      taskRuntimeRegistry.put(profile.id, server.id, runtime);
    }

    expect(clients[0].close).not.toHaveBeenCalled();
    expect(clients[1].close).toHaveBeenCalledOnce();
    taskRuntimeRegistry.removeProfile(profile.id);
  });

  it("归档后从 registry 移除会立即释放 RPC lease", async () => {
    const client = new FakeClient([]);
    const close = vi.fn(() => undefined);
    client.close = close;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-archive",
    });
    await runtime.archive();
    taskRuntimeRegistry.put(profile.id, server.id, runtime);

    taskRuntimeRegistry.remove(
      profile.id,
      server.id,
      runtime.getSnapshot().threadId,
    );

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("TaskRuntime 终端租约", () => {
  it("首次 fit 早于 terminal/start 时使用最新 PTY 尺寸", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-size-before",
            title: "终端尺寸",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-size-before", cwd: "/workspace" } as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-size-before",
    });
    const terminal = runtime.terminalSession("terminal-size-before");

    terminal.resize(41, 132);
    await terminal.start();

    expect(
      requests.find((request) => request.method === "terminal/start")?.params,
    ).toMatchObject({ rows: 41, cols: 132 });
    runtime.close();
  });

  it("terminal/start 在途时发生 fit 会在会话创建后补发 resize", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    let resolveStart!: (value: { session_id: string; cwd: string }) => void;
    const delayedStart = new Promise<{ session_id: string; cwd: string }>(
      (resolve) => {
        resolveStart = resolve;
      },
    );
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-size-race",
            title: "终端尺寸",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start") return (await delayedStart) as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-size-race",
    });
    const terminal = runtime.terminalSession("terminal-size-race");

    const starting = terminal.start();
    terminal.resize(36, 118);
    resolveStart({ session_id: "pty-size-race", cwd: "/workspace" });
    await starting;

    expect(
      requests.filter((request) => request.method === "terminal/resize"),
    ).toEqual([
      {
        method: "terminal/resize",
        params: { session_id: "pty-size-race", rows: 36, cols: 118 },
      },
    ]);
    runtime.close();
  });

  it("页面卸载后复用同一 PTY，只有显式关闭面板才关闭远端会话", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-1",
            title: "终端",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-1", cwd: "/workspace" } as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    const firstMount = runtime.terminalSession("terminal-main");
    expect(runtime.isLiveTerminalSession("terminal-main")).toBe(false);
    await firstMount.start();
    expect(runtime.isLiveTerminalSession("terminal-main")).toBe(true);
    client.emit({
      method: "terminal/output",
      params: { session_id: "pty-1", sequence: 1, data: "hello\r\n$ " },
    });

    const secondMount = runtime.terminalSession("terminal-main");
    expect(secondMount).toBe(firstMount);
    expect(secondMount.getSnapshot()).toMatchObject({
      sessionId: "pty-1",
      status: "running",
    });
    expect(secondMount.getTranscript()).toContain("hello");
    expect(
      requests.filter((request) => request.method === "terminal/start"),
    ).toHaveLength(1);

    runtime.closeTerminalSession("terminal-main");
    expect(runtime.isLiveTerminalSession("terminal-main")).toBe(false);
    expect(
      requests.filter((request) => request.method === "terminal/close"),
    ).toEqual([{ method: "terminal/close", params: { session_id: "pty-1" } }]);
    runtime.close();
  });

  it("页面刷新后的新 runtime 用持久化 sessionId 附着原 PTY 而不新建 shell", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-persisted-terminal",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "before refresh\r\n$ ",
          through_sequence: 7,
        } as never;
      if (method === "terminal/start") throw new Error("不应创建新终端");
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-persisted-terminal",
    });

    const terminal = runtime.terminalSession("terminal-main", "pty-persisted");
    await terminal.start();

    expect(
      requests.filter((request) => request.method === "terminal/start"),
    ).toHaveLength(0);
    expect(
      requests.filter((request) => request.method === "terminal/attach"),
    ).toEqual([
      {
        method: "terminal/attach",
        params: { session_id: "pty-persisted", rows: 28, cols: 100 },
      },
    ]);
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-persisted",
      status: "running",
      sequence: 1,
    });
    expect(terminal.getTranscript()).toContain("before refresh");
    runtime.close();
  });

  it("断线后保留 sessionId 并用 attach snapshot 去重恢复期间输出", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const recovered = new FakeClient([]);
    const initialRequests: Array<{ method: string; params: JsonRecord }> = [];
    const recoveredRequests: Array<{ method: string; params: JsonRecord }> = [];
    let resolveAttach!: (value: {
      session_id: string;
      cwd: string;
      transcript: string;
      through_sequence: number;
    }) => void;
    const delayedAttach = new Promise<{
      session_id: string;
      cwd: string;
      transcript: string;
      through_sequence: number;
    }>((resolve) => {
      resolveAttach = resolve;
    });
    initial.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      initialRequests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-terminal-reconnect",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-stable", cwd: "/workspace" } as never;
      if (method === "terminal/attach")
        return {
          session_id: "pty-stable",
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    recovered.request = vi.fn(
      async (method: string, params: JsonRecord = {}) => {
        recoveredRequests.push({ method, params });
        if (method === "thread/resume")
          return {
            thread: {
              id: "thread-terminal-reconnect",
              cwd: "/workspace",
              status: "idle",
            },
          } as never;
        if (method === "thread/read") return { messages: [] } as never;
        if (method === "terminal/attach") return (await delayedAttach) as never;
        return {} as never;
      },
    );
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-terminal-reconnect",
    });
    const terminal = runtime.terminalSession("terminal-reconnect");
    await terminal.start();
    initial.emit({
      method: "terminal/output",
      params: { session_id: "pty-stable", sequence: 1, data: "before\r\n" },
    });

    initial.emit({
      method: "connection/closed",
      params: { reason: "network lost" },
    });
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-stable",
      status: "reconnecting",
    });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    recovered.emit({
      method: "terminal/output",
      params: { session_id: "pty-stable", sequence: 3, data: "after\r\n" },
    });
    resolveAttach({
      session_id: "pty-stable",
      cwd: "/workspace",
      transcript: "before\r\nduring\r\n",
      through_sequence: 2,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      recoveredRequests.filter(
        (request) => request.method === "terminal/start",
      ),
    ).toHaveLength(0);
    expect(
      recoveredRequests.filter(
        (request) => request.method === "terminal/attach",
      ),
    ).toHaveLength(1);
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-stable",
      status: "running",
    });
    expect(terminal.getTranscript().match(/before/g)).toHaveLength(1);
    expect(terminal.getTranscript().match(/during/g)).toHaveLength(1);
    expect(terminal.getTranscript().match(/after/g)).toHaveLength(1);
    expect(
      initialRequests.filter((request) => request.method === "terminal/start"),
    ).toHaveLength(1);
    runtime.close();
  });

  it("终端输出 sequence 出现缺口时重新 attach 同一会话", async () => {
    vi.useFakeTimers();
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    let attachCount = 0;
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-terminal-gap",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-gap", cwd: "/workspace" } as never;
      if (method === "terminal/attach") {
        attachCount += 1;
        return {
          session_id: "pty-gap",
          cwd: "/workspace",
          transcript: attachCount === 1 ? "" : "one\r\ntwo\r\n",
          through_sequence: attachCount === 1 ? 0 : 2,
        } as never;
      }
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-terminal-gap",
    });
    const terminal = runtime.terminalSession("terminal-gap");
    await terminal.start();

    client.emit({
      method: "terminal/output",
      params: { session_id: "pty-gap", sequence: 2, data: "two\r\n" },
    });
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-gap",
      status: "reconnecting",
    });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(
      requests.filter((request) => request.method === "terminal/start"),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.method === "terminal/attach"),
    ).toHaveLength(2);
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-gap",
      status: "running",
    });
    expect(terminal.getTranscript().match(/one/g)).toHaveLength(1);
    expect(terminal.getTranscript().match(/two/g)).toHaveLength(1);
    runtime.close();
  });

  it("重连 attach 找不到原终端时清除失效 sessionId 并等待用户显式重启", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const recovered = new FakeClient([]);
    const recoveredRequests: Array<{ method: string; params: JsonRecord }> = [];
    initial.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-terminal-missing",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-missing", cwd: "/workspace" } as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    recovered.request = vi.fn(
      async (method: string, params: JsonRecord = {}) => {
        recoveredRequests.push({ method, params });
        if (method === "thread/resume")
          return {
            thread: {
              id: "thread-terminal-missing",
              cwd: "/workspace",
              status: "idle",
            },
          } as never;
        if (method === "thread/read") return { messages: [] } as never;
        if (method === "terminal/attach") throw new Error("terminal not found");
        return {} as never;
      },
    );
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-terminal-missing",
    });
    const terminal = runtime.terminalSession("terminal-missing");
    await terminal.start();

    initial.emit({
      method: "connection/closed",
      params: { reason: "network lost" },
    });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      recoveredRequests.filter(
        (request) => request.method === "terminal/start",
      ),
    ).toHaveLength(0);
    expect(
      recoveredRequests.filter(
        (request) => request.method === "terminal/attach",
      ),
    ).toHaveLength(1);
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: null,
      status: "error",
      error: "原终端已不可用：terminal not found",
    });
    runtime.close();
  });

  it("新建终端后 attach 失败会清除 sessionId 并关闭孤立的远端会话", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-terminal-attach-failure",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-orphan", cwd: "/workspace" } as never;
      if (method === "terminal/attach") throw new Error("attach failed");
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-terminal-attach-failure",
    });
    const terminal = runtime.terminalSession("terminal-attach-failure");

    await terminal.start();
    await Promise.resolve();

    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: null,
      status: "error",
      error: "attach failed",
    });
    expect(
      requests.filter((request) => request.method === "terminal/close"),
    ).toEqual([
      { method: "terminal/close", params: { session_id: "pty-orphan" } },
    ]);
    runtime.close();
  });
});

describe("TaskRuntime 断线恢复", () => {
  it.each([false, true])("索引游标失效只重载一次，重载失败=%s", async failFresh => {
    let reads = 0;
    const client = {
      subscribe: () => () => undefined, respond: () => undefined, close: vi.fn(),
      supportsExperimental: (name: string) => name === "threadIndexedPagesV1",
      request: vi.fn(async (method: string, params: JsonRecord = {}) => {
        if (method === "thread/resume") return { thread: { id: "thread-1", cwd: "/workspace", status: "idle" } };
        if (method === "thread/read/indexed") {
          reads++;
          if (params.beforeCursor) throw new Error("TRANSCRIPT_CURSOR_STALE");
          if (reads > 2 && failFresh) throw new Error("fresh page unavailable");
          return { messages: [{ id: reads === 1 ? "old-page" : "new-page", role: "user", content: "fixture", timestampMs: reads }], hasMoreBefore: reads === 1, beforeCursor: reads === 1 ? "tp1:old:1" : null };
        }
        return {};
      }),
    };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
    try {
      expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["old-page"]);
      await runtime.loadOlderMessages();
      expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual([failFresh ? "old-page" : "new-page"]);
      if (failFresh) expect(runtime.getSnapshot().error).toContain("fresh page unavailable");
      expect(runtime.getSnapshot().loadingOlder).toBe(false);
      expect(reads).toBe(3);
    } finally { runtime.close(); }
  });
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
    const shared: ThreadMessage = { id: "shared", role: "user", content: "shared", timestampMs: 2 };
    const initial = new FakeClient([{ ...shared, id: "older", timestampMs: 1 }, shared], [], { hasMoreBefore: true, beforeCursor: "tp1:old:1" });
    const originalRequest = initial.request.bind(initial);
    vi.spyOn(initial, "supportsExperimental").mockImplementation(name => name === "threadIndexedPagesV1");
    vi.spyOn(initial, "request").mockImplementation((method, params) => originalRequest(method === "thread/read/indexed" ? "thread/read" : method, params));
    const recovered = new FakeClient([shared], [], { hasMoreBefore: true, beforeCursor: "1" });
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => clients.shift() as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
    try {
      initial.emit({ method: "connection/closed", params: {} });
      await vi.advanceTimersByTimeAsync(500);
      expect(runtime.getSnapshot().messages.map(message => message.id)).toEqual(["shared"]);
      expect(runtime.getSnapshot().beforeCursor).toBe("1");
    } finally { runtime.close(); }
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
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
    client.emit({ method: "turn/started", params: { turnId: "turn-runs" } });
    const send = (runId: string, eventId: string, type: string, process = "first") => client.emit({
      method: "item/event",
      params: { threadId: "thread-1", turnId: "turn-runs", serverId: process, sequence: 1,
        identity: { run: { parentSessionId: "thread-1", agentId: "agent", runId }, eventId, runSequence: 1 },
        event: { type, id: "agent", description: runId, text: runId },
      },
    });
    send("one", "start", "background_job_started");
    send("two", "start", "background_job_started");
    send("one", "terminal", "background_job_completed");
    const activity = () => runtime.getSnapshot().messages.find(item => item.turnId === "turn-runs")?.activities?.[0];
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

describe("移动端文件变更规范化", () => {
  it("保留 app-server 文件对象中的路径并兼容旧字符串", () => {
    expect(
      taskRuntimeTestHelpers.fileChangesFromValue({
        artifact_id: "artifact-1",
        workspace_path: "/workspace",
        file_count: 3,
        files: [
          {
            path: "src/main.ts",
            change_type: "modified",
            additions: 2,
            deletions: 1,
          },
          "README.md",
          { change_type: "deleted" },
        ],
        status: "active",
        revertible: true,
      })?.files,
    ).toEqual(["src/main.ts", "README.md"]);
  });
});

describe("移动端项目管理", () => {
  it("按 revision 和内容 token 完成 worktree 预检、归档、恢复与永久删除", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const active = {
      deviceId: "local",
      worktreeId: "mobile-safe",
      path: "/managed/mobile-safe/repository",
      repositoryName: "repository",
      permanent: false,
      revision: 3,
      state: "active",
      conversations: [],
    };
    const preview = {
      path: active.path,
      state: "active",
      revision: 3,
      contentToken: "content-token",
      dirty: true,
      untrackedFileCount: 1,
      ignoredEntryCount: 0,
      dirtySubmoduleCount: 0,
      nestedRepositoryCount: 0,
      baselineKnown: true,
      commitsSinceCreation: 1,
      requiresConfirmation: true,
      archiveAllowed: true,
      blockingReasons: [],
      archivedConversations: [],
    };
    const client = {
      subscribe: () => () => undefined,
      respond: () => undefined,
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord = {}) => {
        calls.push({ method, params });
        if (method === "runtime.worktrees.list") return { items: [active] };
        if (method === "thread/list")
          return {
            threads: [
              {
                id: "thread-linked",
                cwd: active.path,
                title: "关联任务",
                model: "test",
                status: "idle",
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          };
        if (method === "runtime.worktrees.archive.preview") return { preview };
        if (method === "runtime.worktrees.archive") {
          return { worktree: { ...active, revision: 5, state: "restorable" } };
        }
        if (method === "runtime.worktrees.restore") {
          return { worktree: { ...active, revision: 7, state: "active" } };
        }
        if (method === "runtime.worktrees.forget") return { forgotten: true };
        return {};
      }),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const [listed] = await listManagedWorktrees(profile, server);
    expect(listed).toMatchObject({
      worktreeId: "mobile-safe",
      revision: 3,
      state: "active",
    });
    const inspected = await previewManagedWorktreeArchive(
      profile,
      server,
      active.path,
    );
    const archived = await archiveManagedWorktree(
      profile,
      server,
      inspected,
      true,
    );
    expect(archived.state).toBe("restorable");
    await restoreManagedWorktree(profile, server, {
      ...listed!,
      revision: 5,
      state: "restorable",
    });
    await forgetManagedWorktree(profile, server, {
      ...listed!,
      revision: 9,
      state: "restorable",
    });

    expect(
      calls.find((call) => call.method === "runtime.worktrees.archive")?.params,
    ).toMatchObject({
      expectedRevision: 3,
      expectedContentToken: "content-token",
      riskAccepted: true,
      archivedConversations: [
        expect.objectContaining({
          threadId: "thread-linked",
          workspacePath: active.path,
        }),
      ],
    });
    expect(
      calls.find((call) => call.method === "runtime.worktrees.restore")?.params,
    ).toMatchObject({ expectedRevision: 5 });
    expect(
      calls.find((call) => call.method === "runtime.worktrees.forget")?.params,
    ).toMatchObject({ expectedRevision: 9, confirmPermanent: true });
    expect(client.close).toHaveBeenCalledTimes(6);
  });

  it("创建 worktree 前先在同一 app-server 登记源项目", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const client = {
      subscribe: () => () => undefined,
      respond: () => undefined,
      close: vi.fn(),
      request: vi.fn(async (method: string, params: JsonRecord = {}) => {
        calls.push({ method, params });
        if (method === "runtime.worktrees.prepare") {
          return { success: true, path: "/managed/mobile-test/repository" };
        }
        return { success: true, workspacePath: params.workspacePath };
      }),
    };
    const connector = vi.fn(async () => client as never);
    taskRuntimeTestHelpers.setConnector(connector as never);

    await expect(
      prepareManagedWorktree(profile, server, "/external/repository", "main"),
    ).resolves.toBe("/managed/mobile-test/repository");
    expect(connector).toHaveBeenCalledWith(
      profile,
      server,
      server.workspacePath,
    );
    expect(calls.map((call) => call.method)).toEqual([
      "runtime.workspaces.open",
      "runtime.worktrees.prepare",
    ]);
    expect(calls[1]?.params).toMatchObject({
      sourcePath: "/external/repository",
      ref: "main",
      permanent: false,
    });
    expect(client.close).toHaveBeenCalledOnce();
  });
});

describe("TaskRuntime 注册表", () => {
  it("删除 Gateway 时关闭该 profile 的全部 runtime", async () => {
    const first = new FakeClient([]);
    const second = new FakeClient([]);
    const clients = [first, second];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const one = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const two = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-2",
    });
    taskRuntimeRegistry.put(profile.id, server.id, one);
    taskRuntimeRegistry.put(profile.id, server.id, two);

    taskRuntimeRegistry.removeProfile(profile.id);

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(
      taskRuntimeRegistry.get(profile.id, server.id, "thread-1"),
    ).toBeUndefined();
  });
});


describe('TaskRuntime failed-attempt continuation', () => {
  const initial = (): ThreadMessage[] => [
    { id: 'user-original', role: 'user', turnId: 'turn-1', content: 'Original request', timestampMs: 1 },
    { id: 'failure-original', role: 'assistant', turnId: 'turn-1', attemptId: 'turn-1', status: 'failed', content: 'original partial', error: 'fixture outage', timestampMs: 2 },
  ];
  const modern = (client: FakeClient) => Object.assign(client, { supportsExperimental: (name: string) =>
    ['failedTurnContinuationV1', 'turnRetryOperationV1', 'turnAttemptRetryV1', 'turnReceiptsV1'].includes(name) });

  it('does not resend input and preserves separate failures across repeated continuations and late acknowledgements', async () => {
    const client = modern(new FakeClient(initial()));
    const original = client.request.bind(client);
    let count = 0;
    const requests: JsonRecord[] = [];
    client.request = async <T,>(method: string, params: JsonRecord = {}): Promise<T> => {
      if (method !== 'turn/start') return original<T>(method, params);
      requests.push(params); count++;
      const attemptId = `continued-${count}`;
      const context = { serverId: 'local', threadId: 'thread-1', turnId: 'turn-1' };
      client.emit({ method: 'turn/started', params: { ...context, sequence: count * 3, attemptId, turn: { id: 'turn-1', attemptId } } });
      client.emit({ method: 'item/delta', params: { ...context, sequence: count * 3 + 1, delta: { text: `attempt ${count} text` } } });
      client.emit({ method: 'turn/completed', params: { ...context, sequence: count * 3 + 2,
        turn: { id: 'turn-1', attemptId, status: count === 1 ? 'failed' : 'completed' },
        ...(count === 1 ? { error: { message: 'second outage' } } : {}),
      } });
      return { turn: { id: 'turn-1', attemptId, status: 'running' } } as T;
    };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const task = await TaskRuntime.resume({ profile, server, threadId: 'thread-1', cwd: '/workspace' });
    await task.continueFailed('failure-original');
    expect(task.getSnapshot().running).toBe(false);
    const nextFailure = task.getSnapshot().messages.find(item => item.attemptId === 'continued-1')!;
    expect(nextFailure.status).toBe('failed');
    await task.continueFailed(nextFailure.id);
    expect(requests).toHaveLength(2);
    expect(requests.every(request => Array.isArray(request.input) && request.input.length === 0 && !('model' in request))).toBe(true);
    expect(requests[1]).toMatchObject({ retryFromTurnId: 'turn-1', retryFromAttemptId: 'continued-1' });
    expect(task.getSnapshot().messages.filter(item => item.role === 'user')).toHaveLength(1);
    expect(task.getSnapshot().messages.find(item => item.id === 'failure-original')?.content).toBe('original partial');
    expect(task.getSnapshot().messages.filter(item => item.status === 'failed')).toHaveLength(2);
    expect(task.getSnapshot().running).toBe(false);
    task.close();
  });

  it('refuses old servers without executing any mutation', async () => {
    const client = new FakeClient(initial());
    const request = vi.spyOn(client, 'request');
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const task = await TaskRuntime.resume({ profile, server, threadId: 'thread-1' });
    request.mockClear();
    await expect(task.continueFailed('failure-original')).rejects.toThrow('升级');
    expect(request).not.toHaveBeenCalled();
    task.close();
  });

  it('queries ambiguous acceptance and keeps uncertainty read-only', async () => {
    const history = initial();
    const client = modern(new FakeClient(history));
    const original = client.request.bind(client);
    let starts = 0, queries = 0;
    client.request = async <T,>(method: string, params: JsonRecord = {}): Promise<T> => {
      if (method === 'turn/start') { starts++; throw new MobileRpcError('lost response'); }
      if (method === 'turn/receipt/read') {
        queries++;
        if (queries === 1) return { receipt: null } as T;
        history[1].continuedByAttemptId = 'recovered';
        history.push({ id: 'done', role: 'assistant', turnId: 'turn-1', content: 'restored completion', status: 'completed', timestampMs: 3 });
        return { receipt: { threadId: 'thread-1', turnId: 'turn-1', attemptId: 'recovered', status: 'completed' } } as T;
      }
      return original<T>(method, params);
    };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const task = await TaskRuntime.resume({ profile, server, threadId: 'thread-1' });
    await expect(task.continueFailed('failure-original')).rejects.toThrow('未知');
    expect(task.continuationState('failure-original').unknown).toBe(true);
    await expect(task.send('new work')).rejects.toThrow('先核对执行状态');
    expect(starts).toBe(1);
    await task.continueFailed('failure-original');
    expect(starts).toBe(1); expect(queries).toBe(2);
    expect(task.getSnapshot().running).toBe(false);
    expect(task.getSnapshot().messages.some(item => item.content === 'restored completion')).toBe(true);
    task.close();
  });
});


describe('Mobile bounded restoration notifications', () => {
  it.each(['frames', 'bytes'])('rejects %s overflow without replaying an incomplete stream and permits a fresh authoritative read', async kind => {
    const notifications: RpcMessage[] = kind === 'frames'
      ? Array.from({ length: 513 }, (_, sequence) => ({ method: 'item/delta', params: { threadId: 'thread-1', turnId: 'turn-1', sequence, delta: { text: 'discarded' } } }))
      : [{ method: 'item/delta', params: { delta: { text: 'x'.repeat(1024 * 1024) } } }];
    const overflow = new FakeClient([], notifications);
    const recovered = new FakeClient([{ id: 'persisted', role: 'assistant', content: 'complete authoritative history', timestampMs: 1 }]);
    const clients = [overflow, recovered];
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => clients.shift() as never) as never);
    await expect(TaskRuntime.resume({ profile, server, threadId: 'thread-1' })).rejects.toThrow('缓存上限');
    expect(overflow.closed).toBe(true);
    expect(overflow.listeners.size).toBe(0);
    const task = await TaskRuntime.resume({ profile, server, threadId: 'thread-1' });
    expect(task.getSnapshot().messages.map(message => message.content)).toEqual(['complete authoritative history']);
    task.close();
  });
});


it('does not delete a newly accepted thread when its first turn response is lost', async () => {
  const client = new FakeClient([]);
  const calls: string[] = [];
  client.request = async <T,>(method: string): Promise<T> => {
    calls.push(method);
    if (method === 'thread/start') return { thread: { id: 'accepted-thread' } } as T;
    if (method === 'turn/start') throw new MobileRpcError('response lost');
    return {} as T;
  };
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  const task = await TaskRuntime.create({ profile, server, cwd: '/workspace', prompt: 'once' });
  expect(task.getSnapshot().sendAcceptanceUnknown).toBe(true);
  await expect(task.send('duplicate')).rejects.toThrow('先核对执行状态');
  expect(calls.filter(method => method === 'turn/start')).toHaveLength(1);
  expect(calls).not.toContain('thread/delete');
  expect(client.closed).toBe(false);
  task.close();
  expect(client.closed).toBe(true);
});


describe('Mobile ordinary send receipts', () => {
  it.each([false, true])('recovers accepted ordinary sends without another mutation, initial receipt missing=%s', async missingFirst => {
    const history: ThreadMessage[] = [];
    const client = new FakeClient(history);
    client.supportsExperimental = name => name === 'turnReceiptsV1';
    const original = client.request.bind(client);
    let starts = 0, reads = 0;
    let acceptedId: unknown;
    client.request = async <T,>(method: string, params: JsonRecord = {}): Promise<T> => {
      if (method === 'turn/start') {
        starts++; acceptedId = params.clientMessageId;
        history.push({ id: 'server-user', role: 'user', content: 'once', timestampMs: Date.now(), turnId: 'ordinary-turn' },
          { id: 'server-result', role: 'assistant', content: 'authoritative result', timestampMs: Date.now(), turnId: 'ordinary-turn' });
        throw new MobileRpcError('reply lost');
      }
      if (method === 'turn/receipt/read') {
        reads++;
        expect(params.clientMessageId).toBe(acceptedId);
        return { receipt: missingFirst && reads === 1 ? null : { threadId: 'thread-1', turnId: 'ordinary-turn', status: 'completed' } } as T;
      }
      return original<T>(method, params);
    };
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const task = await TaskRuntime.resume({ profile, server, threadId: 'thread-1' });
    await task.send('once');
    if (missingFirst) {
      expect(task.getSnapshot().sendAcceptanceUnknown).toBe(true);
      await expect(task.send('once')).rejects.toThrow('先核对执行状态');
      await task.reconcileSendAcceptance();
    }
    expect(starts).toBe(1);
    expect(task.getSnapshot().sendAcceptanceUnknown).toBe(false);
    expect(task.getSnapshot().running).toBe(false);
    expect(task.getSnapshot().messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(task.getSnapshot().messages.some(message => message.content === 'authoritative result')).toBe(true);
    task.close();
  });
});
