import { negotiateModelSelector } from "../../../../shared/modelSelection";
import { taskClientConnector } from "./connectionFactory";
import { TaskRuntime } from "./core";
import {
  attachmentPathsFromMessages,
  collectThreadAttachmentPaths,
} from "./history";
import {
  type GoalMode,
  type ThreadCompactResult,
  type ThreadGoal,
} from "./types";

export async function rename(this: TaskRuntime, title: string): Promise<void> {
  const normalized = title.trim();
  if (!normalized) throw new Error("任务标题不能为空");
  if (this.client) {
    await this.request("thread/metadata/update", {
      threadId: this.snapshot.threadId,
      title: normalized,
    });
  }
  this.patch({ title: normalized });
}

export async function setTurnPreferences(
  this: TaskRuntime,
  model: string,
  reasoningEffort?: string,
): Promise<void> {
  let normalizedModel = model.trim();
  const normalizedEffort = reasoningEffort?.trim() || undefined;
  if (!normalizedModel || normalizedModel.length > 256)
    throw new Error("模型标识无效");
  if (normalizedEffort && !/^[A-Za-z0-9._-]{1,40}$/.test(normalizedEffort))
    throw new Error("推理强度无效");
  if (this.snapshot.running) throw new Error("当前回合结束后才能切换模型");
  if (this.snapshot.archivedAt)
    throw new Error("任务已归档，请先恢复后再切换模型");
  if (this.client)
    normalizedModel =
      (await negotiateModelSelector(this.client, normalizedModel)) ??
      normalizedModel;
  if (this.client && normalizedModel !== this.snapshot.model) {
    await this.request("thread/metadata/update", {
      threadId: this.snapshot.threadId,
      model: normalizedModel,
    });
  }
  this.patch({ model: normalizedModel, reasoningEffort: normalizedEffort });
}

export async function archive(this: TaskRuntime): Promise<void> {
  const archivedAt = new Date().toISOString();
  if (this.client) {
    await this.request("thread/metadata/update", {
      threadId: this.snapshot.threadId,
      archivedAt,
    });
  }
  this.patch({ archivedAt });
}

export async function unarchive(this: TaskRuntime): Promise<void> {
  if (!this.client) {
    this.patch({ archivedAt: undefined });
    return;
  }
  await this.request("thread/metadata/update", {
    threadId: this.snapshot.threadId,
    archivedAt: null,
  });
  this.patch({ archivedAt: undefined });
}

export async function compact(this: TaskRuntime): Promise<ThreadCompactResult> {
  if (this.snapshot.running) throw new Error("任务运行中不能压缩上下文");
  if (!this.client) {
    return {
      threadId: this.snapshot.threadId,
      compacted: false,
      preTokens: 0,
      postTokens: 0,
    };
  }
  return this.request<ThreadCompactResult>(
    "thread/compact",
    { threadId: this.snapshot.threadId },
    60_000,
  );
}

export async function setGoal(
  this: TaskRuntime,
  objective: string,
  mode: GoalMode = "standard",
  options: {
    tokenBudget?: number;
    verificationKind?: "artifact" | "answer";
    expectedGoal?: Pick<ThreadGoal, "goalId" | "revision">;
    requireNoGoal?: boolean;
  } = {},
): Promise<ThreadGoal | null> {
  const normalized = objective.trim();
  if (!normalized) throw new Error("目标不能为空");
  if (this.snapshot.running) throw new Error("当前回合结束后才能设置目标");
  if (this.snapshot.archivedAt)
    throw new Error("任务已归档，请先恢复后再设置目标");
  if (!this.client) return null;
  const result = await this.request<{ goal: ThreadGoal }>("thread/goal/set", {
    threadId: this.snapshot.threadId,
    objective: normalized,
    mode,
    ...(options.tokenBudget === undefined
      ? {}
      : { tokenBudget: options.tokenBudget }),
    ...(options.verificationKind === undefined
      ? {}
      : { verificationKind: options.verificationKind }),
    ...(options.expectedGoal === undefined
      ? {}
      : {
          expectedGoalId: options.expectedGoal.goalId,
          expectedRevision: options.expectedGoal.revision,
        }),
    ...(options.requireNoGoal ? { requireNoGoal: true } : {}),
    status: "active",
  });
  return result.goal;
}

export async function getGoal(this: TaskRuntime): Promise<ThreadGoal | null> {
  if (!this.client) return null;
  const result = await this.request<{ goal?: ThreadGoal | null }>(
    "thread/goal/get",
    {
      threadId: this.snapshot.threadId,
    },
  );
  return result.goal ?? null;
}

export async function getGoalHistory(this: TaskRuntime): Promise<ThreadGoal[]> {
  if (!this.client) return [];
  const result = await this.request<{ goals?: ThreadGoal[] }>(
    "thread/goal/history",
    {
      threadId: this.snapshot.threadId,
    },
  );
  return result.goals ?? [];
}

export async function updateGoalStatus(
  this: TaskRuntime,
  status: "active" | "paused" | "cancelled",
): Promise<ThreadGoal> {
  if (!this.client) throw new Error("当前任务未连接");
  if (
    status === "cancelled" &&
    this.client.supportsExperimental?.("goalCancellationV1") !== true
  ) {
    throw new Error(
      "Goal cancellation is unsupported by this server; update the remote KCoder server first.",
    );
  }
  const current = await this.getGoal();
  if (!current) throw new Error("当前没有目标");
  const result = await this.request<{ goal: ThreadGoal }>("thread/goal/set", {
    threadId: this.snapshot.threadId,
    status,
    expectedGoalId: current.goalId,
    expectedRevision: current.revision,
  });
  return result.goal;
}

export async function editGoal(
  this: TaskRuntime,
  objective: string,
  tokenBudget?: number,
  expectedGoal?: Pick<ThreadGoal, "goalId" | "revision">,
): Promise<ThreadGoal> {
  const normalized = objective.trim();
  if (!normalized) throw new Error("目标不能为空");
  if (!this.client) throw new Error("当前任务未连接");
  const current = expectedGoal ?? (await this.getGoal());
  if (!current) throw new Error("当前没有目标");
  const result = await this.request<{ goal: ThreadGoal }>("thread/goal/set", {
    threadId: this.snapshot.threadId,
    objective: normalized,
    edit: true,
    expectedGoalId: current.goalId,
    expectedRevision: current.revision,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  });
  return result.goal;
}

export async function clearGoal(
  this: TaskRuntime,
  expectedGoal?: Pick<ThreadGoal, "goalId" | "revision">,
): Promise<boolean> {
  if (!this.client) return false;
  const current = expectedGoal ?? (await this.getGoal());
  if (!current) return false;
  const result = await this.request<{ cleared?: boolean }>(
    "thread/goal/clear",
    {
      threadId: this.snapshot.threadId,
      expectedGoalId: current.goalId,
      expectedRevision: current.revision,
    },
  );
  return result.cleared === true;
}

export async function deleteThread(this: TaskRuntime): Promise<void> {
  if (this.snapshot.running) throw new Error("请先停止当前回合");
  if (!this.client) return;
  const attachmentPaths = await collectThreadAttachmentPaths(
    this.client,
    this.snapshot.threadId,
    attachmentPathsFromMessages(this.snapshot.messages),
  );
  await this.request("thread/delete", { threadId: this.snapshot.threadId });
  if (this.reconnectContext) {
    const registryClient = await taskClientConnector(
      this.reconnectContext.profile,
      this.reconnectContext.server,
      this.reconnectContext.managedWorktreeSourcePath ??
        this.reconnectContext.server.workspacePath,
    ).catch(() => null);
    await registryClient
      ?.request("runtime.worktrees.conversations.remove", {
        deviceId: this.reconnectContext.server.id,
        path: this.snapshot.cwd,
        taskId: this.snapshot.threadId,
      })
      .catch(() => {});
    registryClient?.close();
  }
  for (const path of attachmentPaths) {
    await this.request("attachment/delete", { path }).catch(() => {});
  }
}
