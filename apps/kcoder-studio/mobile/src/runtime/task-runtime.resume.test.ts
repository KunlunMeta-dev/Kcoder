import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
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
describe("TaskRuntime.resume", () => {
  it("preserves empty failed attempts and their continuation identity in restored history", async () => {
    const client = new FakeClient([
      {
        id: "failure-1",
        role: "assistant",
        content: "",
        status: "failed",
        timestampMs: 1,
        turnId: "turn-1",
        attemptId: "turn-1",
        continuedByAttemptId: "turn-1-retry-next",
        error: "service unavailable",
      },
      {
        id: "failure-2",
        role: "assistant",
        content: "partial",
        status: "failed",
        timestampMs: 2,
        turnId: "turn-1",
        attemptId: "turn-1-retry-next",
        error: "stream interrupted",
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
    expect(runtime.getSnapshot().messages).toMatchObject([
      {
        id: "failure-1",
        status: "failed",
        content: "",
        attemptId: "turn-1",
        continuedByAttemptId: "turn-1-retry-next",
        error: "service unavailable",
      },
      {
        id: "failure-2",
        status: "failed",
        content: "partial",
        attemptId: "turn-1-retry-next",
      },
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

  it("reconciles a saved effort with the resumed model policy before sending", async () => {
    const client = new FakeClient([]);
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    client.supportsExperimental = (capability) =>
      capability === "qualifiedModelSelectionV1";
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-server-model",
            cwd: "/workspace",
            status: "idle",
            model: "M2",
          },
        } as never;
      if (method === "thread/read")
        return { messages: [], hasMoreBefore: false } as never;
      if (method === "runtime.models.list")
        return {
          activeConfiguration: {
            providerId: "provider-2",
            modelId: "M2",
            revision: "a".repeat(64),
            boundary: "session_snapshot",
            reasoningEffort: "medium",
            reasoningPolicy: {
              mode: "optional",
              efforts: ["low", "medium"],
            },
          },
        } as never;
      if (method === "turn/start")
        return { turn: { id: "turn-next", status: "running" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-server-model",
      reasoningEffort: "ultra",
    });

    await vi.waitFor(() => expect(runtime.getSnapshot().configurationReady).not.toBe(false));
    expect(runtime.getSnapshot()).toMatchObject({
      model: "M2",
      reasoningEffort: "medium",
    });
    expect(client.request).toHaveBeenCalledWith("runtime.models.list", {
      threadId: "thread-server-model",
    });
    await runtime.send("next turn");
    const turnStart = calls.find((call) => call.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: "thread-server-model",
      model: "M2",
      reasoningEffort: "medium",
    });
    expect(turnStart?.params.reasoningEffort).not.toBe("ultra");
    runtime.close();
  });

  it("keeps a saved effort allowed by the resumed model policy", async () => {
    const client = new FakeClient([]);
    client.request = vi.fn(async (method: string) => {
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-server-model",
            cwd: "/workspace",
            status: "idle",
            model: "M2",
          },
        } as never;
      if (method === "thread/read")
        return { messages: [], hasMoreBefore: false } as never;
      if (method === "runtime.models.list")
        return {
          activeConfiguration: {
            providerId: "provider-2",
            modelId: "M2",
            revision: "b".repeat(64),
            boundary: "session_snapshot",
            reasoningEffort: "medium",
            reasoningPolicy: {
              mode: "optional",
              efforts: ["low", "medium", "ultra"],
            },
          },
        } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-server-model",
      reasoningEffort: "ultra",
    });

    await vi.waitFor(() => expect(runtime.getSnapshot().configurationReady).not.toBe(false));
    expect(runtime.getSnapshot()).toMatchObject({
      model: "M2",
      reasoningEffort: "ultra",
    });
    runtime.close();
  });

  it.each([
    { name: "no policy projection", projection: undefined },
    { name: "old server model catalog error", projection: "error" },
  ])("keeps the saved effort when %s is unavailable", async ({ projection }) => {
    const client = new FakeClient([]);
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-server-model",
            cwd: "/workspace",
            status: "idle",
            model: "M2",
          },
        } as never;
      if (method === "thread/read")
        return { messages: [], hasMoreBefore: false } as never;
      if (method === "runtime.models.list") {
        if (projection === "error") throw new Error("method not found");
        return {
          activeConfiguration: {
            providerId: "provider-2",
            modelId: "M2",
            revision: "c".repeat(64),
            boundary: "session_snapshot",
            reasoningEffort: "medium",
          },
        } as never;
      }
      if (method === "turn/start")
        return { turn: { id: "turn-next", status: "running" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-server-model",
      reasoningEffort: "ultra",
    });

    await vi.waitFor(() => expect(runtime.getSnapshot().configurationReady).not.toBe(false));
    expect(runtime.getSnapshot().reasoningEffort).toBe("ultra");
    await runtime.send("next turn");
    const turnStart = calls.find((call) => call.method === "turn/start");
    expect(turnStart?.params.reasoningEffort).toBe("ultra");
    runtime.close();
  });

  it.each([
    {
      mode: "hidden",
      efforts: ["ultra"],
      defaultEffort: "ultra",
    },
    {
      mode: "always_off",
      efforts: ["ultra"],
      defaultEffort: "ultra",
    },
    {
      mode: "optional",
      efforts: ["low", "medium"],
      defaultEffort: "ultra",
    },
  ])(
    "does not send an effort unavailable under $mode policy",
    async ({ mode, efforts, defaultEffort }) => {
      const client = new FakeClient([]);
      const calls: Array<{ method: string; params: JsonRecord }> = [];
      client.request = vi.fn(
        async (method: string, params: JsonRecord = {}) => {
          calls.push({ method, params });
          if (method === "thread/resume")
            return {
              thread: {
                id: "thread-server-model",
                cwd: "/workspace",
                status: "idle",
                model: "M2",
              },
            } as never;
          if (method === "thread/read")
            return { messages: [], hasMoreBefore: false } as never;
          if (method === "runtime.models.list")
            return {
              activeConfiguration: {
                providerId: "provider-2",
                modelId: "M2",
                revision: "d".repeat(64),
                boundary: "session_snapshot",
                reasoningEffort: defaultEffort,
                reasoningPolicy: { mode, efforts },
              },
            } as never;
          if (method === "turn/start")
            return { turn: { id: "turn-next", status: "running" } } as never;
          return {} as never;
        },
      );
      taskRuntimeTestHelpers.setConnector(
        vi.fn(async () => client as never) as never,
      );

      const runtime = await TaskRuntime.resume({
        profile,
        server,
        threadId: "thread-server-model",
        reasoningEffort: "ultra",
      });

      await vi.waitFor(() => expect(runtime.getSnapshot().configurationReady).not.toBe(false));
      expect(runtime.getSnapshot().reasoningEffort).toBeUndefined();
      await runtime.send("next turn");
      const turnStart = calls.find((call) => call.method === "turn/start");
      expect(turnStart?.params).not.toHaveProperty("reasoningEffort");
      runtime.close();
    },
  );

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
