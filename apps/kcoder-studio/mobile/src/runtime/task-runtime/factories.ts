import { GatewayRpcClient, MobileRpcError } from "@/gateway/rpc";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadSummary,
} from "@/gateway/types";
import { timestampMs } from "@/protocol/normalizers";
import { negotiateModelSelector } from "../../../../shared/modelSelection";
import {
  parseThreadRunSummary,
  threadRunActivity,
  threadRunSummaryIsActive,
} from "../../../../shared/threadRunSummary";
import { taskClientConnector } from "./connectionFactory";
import { TaskRuntime } from "./core";
import { readHistoryPage } from "./history";
import { threadModelSelector } from "./modelCatalog";
import { bufferNotifications } from "./notificationBuffer";
import type { ReconnectContext, TaskSnapshot } from "./types";
import { type AgentListResult } from "./types";
type TaskRuntimeConstructor = (
  client: GatewayRpcClient | null,
  initial: TaskSnapshot,
  context?: ReconnectContext | null,
) => TaskRuntime;

export async function create(
  createRuntime: TaskRuntimeConstructor,
  input: {
    sessionMode?: "default" | "orchestrate";
    turnMode?: "standard" | "moa" | "moa-plan";
    profile: GatewayProfile;
    server: KCoderServer;
    cwd: string;
    prompt: string;
    model?: string;
    reasoningEffort?: string;
    managedWorktreeSourcePath?: string;
    onSessionExpired?: () => void;
  },
): Promise<TaskRuntime> {
  const client = await taskClientConnector(
    input.profile,
    input.server,
    input.cwd,
  );
  if (
    (input.sessionMode === "orchestrate" ||
      (input.turnMode && input.turnMode !== "standard")) &&
    !client.supportsExperimental?.("sessionModes")
  ) {
    client.close();
    throw new Error("目标 KCoder 不支持特殊执行模式，请升级后重试");
  }
  let wireModel: string | undefined;
  try {
    wireModel = await negotiateModelSelector(client, input.model);
  } catch (error) {
    client.close();
    throw error;
  }
  const started = await client.request<{ thread?: ThreadSummary }>(
    "thread/start",
    {
      cwd: input.cwd,
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      ...(wireModel ? { model: wireModel } : {}),
    },
  );
  const thread = started.thread;
  if (!thread?.id) {
    client.close();
    throw new Error("KCoder app-server 未返回 thread id");
  }
  const effectiveModel =
    input.model?.includes("::") && wireModel !== input.model
      ? wireModel
      : (threadModelSelector(thread) ?? input.model);
  const title = input.prompt.split(/\r?\n/, 1)[0].slice(0, 80) || "新任务";
  if (input.managedWorktreeSourcePath) {
    const registryClient = await taskClientConnector(
      input.profile,
      input.server,
      input.managedWorktreeSourcePath,
    );
    try {
      const now = Date.now();
      await registryClient.request("runtime.worktrees.conversations.link", {
        deviceId: input.server.id,
        path: input.cwd,
        conversation: {
          deviceId: input.server.id,
          taskId: thread.id,
          threadId: thread.id,
          workspacePath: input.cwd,
          title,
          model: effectiveModel ?? null,
          createdAt: timestampMs(thread.createdAt) || now,
          updatedAt: timestampMs(thread.updatedAt) || now,
        },
      });
    } catch (error) {
      await client
        .request("thread/delete", { threadId: thread.id })
        .catch(() => {});
      client.close();
      throw error;
    } finally {
      registryClient.close();
    }
  }
  const runtime = createRuntime(
    client,
    {
      threadId: thread.id,
      title,
      cwd: input.cwd,
      model: effectiveModel,
      reasoningEffort: input.reasoningEffort,
      messages: [
        {
          id: `local-user-${Date.now()}`,
          role: "user",
          content: input.prompt,
          timestampMs: Date.now(),
        },
      ],
      hasMoreBefore: false,
      beforeCursor: null,
      loadingOlder: false,
      running: true,
      connected: true,
      activeTurnId: null,
      interaction: null,
      error: null,
    },
    {
      profile: input.profile,
      server: input.server,
      managedWorktreeSourcePath: input.managedWorktreeSourcePath,
      onSessionExpired: input.onSessionExpired,
    },
  );
  try {
    await client.request("thread/metadata/update", {
      threadId: thread.id,
      title,
      ...(effectiveModel ? { model: effectiveModel } : {}),
    });
  } catch {
    // Continue the conversation when an older app-server lacks metadata support.
  }
  try {
    await runtime.startOrdinaryTurn({
      threadId: thread.id,
      input: [{ type: "text", text: input.prompt }],
      ...(input.turnMode ? { turnMode: input.turnMode } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(input.reasoningEffort
        ? { reasoningEffort: input.reasoningEffort }
        : {}),
    });
    return runtime;
  } catch (error) {
    if (runtime.snapshot.sendAcceptanceUnknown) return runtime;
    // A transport failure says nothing about acceptance. Never delete a task
    // merely because its turn/start response was lost.
    if (
      error instanceof MobileRpcError &&
      error.reason === "remote" &&
      !runtime.snapshot.activeTurnId &&
      runtime.finishedAttempts.size === 0
    ) {
      try {
        await client.request("thread/delete", { threadId: thread.id });
      } catch {
        // Reclaim only an explicitly rejected empty thread, best effort.
      }
    }
    runtime.close();
    throw error;
  }
}

export async function resume(
  createRuntime: TaskRuntimeConstructor,
  input: {
    profile: GatewayProfile;
    server: KCoderServer;
    threadId: string;
    cwd?: string;
    title?: string;
    reasoningEffort?: string;
    onSessionExpired?: () => void;
  },
): Promise<TaskRuntime> {
  const client = await taskClientConnector(
    input.profile,
    input.server,
    input.cwd,
  );
  const buffered = bufferNotifications(client);
  try {
    const resumed = await client.request<{ thread?: ThreadSummary }>(
      "thread/resume",
      {
        threadId: input.threadId,
      },
    );
    const history = await readHistoryPage(client, input.threadId);
    const agents =
      client.supportsExperimental?.("agentSteering") === true
        ? await client
            .request<AgentListResult>("agent/list", {
              threadId: input.threadId,
            })
            .then((result) =>
              Array.isArray(result.agents) ? result.agents : [],
            )
            .catch(() => [])
        : [];
    const historyThread = history.thread;
    const resumedThread = resumed.thread;
    const runtime = createRuntime(
      null,
      {
        threadId: input.threadId,
        title:
          historyThread?.title ??
          resumedThread?.title ??
          input.title ??
          "KCoder 任务",
        cwd: historyThread?.cwd ?? resumedThread?.cwd ?? input.cwd ?? "/",
        model:
          threadModelSelector(resumedThread) ??
          threadModelSelector(historyThread),
        archivedAt: historyThread?.archivedAt ?? resumedThread?.archivedAt,
        reasoningEffort: input.reasoningEffort,
        messages: history.messages,
        hasMoreBefore: history.hasMoreBefore,
        beforeCursor: history.beforeCursor,
        loadingOlder: false,
        running: threadRunSummaryIsActive(
          threadRunActivity(
            historyThread?.status ?? resumedThread?.status,
            parseThreadRunSummary(
              historyThread?.runSummary ?? resumedThread?.runSummary,
            ),
          ),
        ),
        connected: true,
        activeTurnId: null,
        interaction: null,
        error: null,
      },
      {
        profile: input.profile,
        server: input.server,
        onSessionExpired: input.onSessionExpired,
      },
    );
    runtime.applySubagentSnapshot(agents);
    runtime.attachBufferedClient(client, buffered);
    runtime.flushPendingDeltas();
    return runtime;
  } catch (error) {
    buffered.cancel();
    client.close();
    throw error;
  }
}

export function demo(
  createRuntime: TaskRuntimeConstructor,
  threadId: string,
): TaskRuntime {
  return createRuntime(null, {
    threadId,
    title:
      threadId === "demo-2" ? "修复移动端登录" : "设计 React Native 客户端",
    cwd: "/data/projects/kcoder",
    model: "MiniMax-M3",
    reasoningEffort: "medium",
    messages: [
      {
        id: "demo-user-1",
        role: "user",
        content:
          "请检查当前项目，并设计一个能远程控制多个 KCoder 服务器的手机客户端。",
        timestampMs: Date.now() - 65_000,
      },
      {
        id: "demo-assistant-1",
        role: "assistant",
        content:
          "我已经完成架构检查。移动端会使用 **Expo + React Native**，通过 Gateway 的 Bearer 会话和 app-server JSON-RPC 与本地或 SSH 服务器通信。\n\n下一步将实现任务历史、实时对话、审批、终端和远程浏览器。",
        timestampMs: Date.now() - 58_000,
        tools: [
          {
            id: "tool-1",
            name: "Read",
            status: "completed",
            output: "已读取项目结构",
          },
          {
            id: "tool-2",
            name: "TodoWrite",
            status: "completed",
            output: "已更新实现计划",
          },
        ],
        fileChanges: {
          artifactId: "demo-file-changes-1",
          workspacePath: "/data/projects/kcoder",
          fileCount: 2,
          additions: 18,
          deletions: 4,
          files: ["src/app.tsx", "src/theme.ts"],
          status: "applied",
          revertible: true,
        },
      },
    ],
    hasMoreBefore: false,
    beforeCursor: null,
    loadingOlder: false,
    running: false,
    connected: true,
    activeTurnId: null,
    interaction: null,
    error: null,
  });
}
