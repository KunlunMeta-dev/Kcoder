import { prepareThreadDeletionCleanup, confirmThreadDeletionCleanup, retryThreadDeletionCleanup, ThreadDeletionCleanupConfirmationPendingError } from "@/storage/thread-deletion-cleanup";
import { MobileRpcError } from "@/gateway/rpc";
import { t } from "@/i18n";
import { isPermissionMode, type PermissionMode } from "@/protocol/task-permission-mode";
import type { ThreadSummary } from "@/gateway/types";
import { threadModelSelector, restoreReasoningEffortForThread } from "./modelCatalog";
import { negotiateModelSelector } from "../../../../shared/modelSelection";
import { taskClientConnector } from "./connectionFactory";
import { TaskRuntime } from "./core";
import { captureGoalProjection, goalCanEdit, publishGoal } from "./goalProjection";

import { loadWorkspaceState, workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { workspaceAttachmentPathsForThreadDeletion } from "@/storage/workspace-attachment-paths";
import {
  type GoalMode,
  type ThreadCompactResult,
  type ThreadGoal,
} from "./types";
import {
  publishThreadMutation,
  type ThreadMutation,
} from "./threadDirectory";

async function requestGoalWrite(runtime: TaskRuntime, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (runtime.snapshot.goalMutationUnknown) throw new Error(t("task.goal_write_unknown"));
  const projection = captureGoalProjection(runtime);
  try { return await runtime.request(method, params); }
  catch (error) {
    if (projection.current() && error instanceof MobileRpcError && error.reason !== "remote" && error.delivery !== "not-sent") {
      runtime.metadataRevisions.set("goalUnknownWrite", (runtime.metadataRevisions.get("goalUnknownWrite") ?? 0) + 1);
      runtime.patch({ goalMutationUnknown: true, goalError: t("task.goal_write_unknown") });
    }
    throw error;
  }
}
function publishCurrentThreadMutation(
  runtime: TaskRuntime,
  mutation: ThreadMutation,
): void {
  const context = runtime.reconnectContext;
  if (!context?.threadCwd) return;
  publishThreadMutation(
    context.profile,
    context.server,
    runtime.snapshot.threadId,
    context.threadCwd,
    mutation,
  );
}

function isAmbiguous(error: unknown): boolean {
  return error instanceof MobileRpcError && error.reason !== "remote" && error.delivery !== "not-sent";
}

function projectMetadata(runtime: TaskRuntime, key: "title" | "archivedAt", value: string | undefined): Promise<void> {
  const sequence = (runtime.metadataRevisions.get(key) ?? 0) + 1;
  runtime.metadataRevisions.set(key, sequence);
  if (!runtime.metadataConfirmed.has(key)) runtime.metadataConfirmed.set(key, runtime.snapshot[key]);
  const current = () => !runtime.disposed && runtime.metadataRevisions.get(key) === sequence;
  const publish = (projected: string | undefined) => publishCurrentThreadMutation(runtime, key === "title" ? { kind: "rename", title: projected ?? "" } : projected ? { kind: "archive", archivedAt: projected } : { kind: "unarchive" });
  runtime.patch({ [key]: value, metadataPending: [...new Set([...(runtime.snapshot.metadataPending ?? []), key])], metadataUnknown: runtime.snapshot.metadataUnknown?.filter((item) => item !== key) });
  if (runtime.client) publish(value);
  const operation = runtime.metadataTail.catch(() => {}).then(async () => {
    let authoritative = value;
    let failure: unknown;
    try {
      if (runtime.client) await runtime.request("thread/metadata/update", { threadId: runtime.snapshot.threadId, [key]: value ?? null });
    } catch (error) {
      failure = error;
      if (isAmbiguous(error)) {
        try {
          const result = await runtime.request<{ thread?: ThreadSummary }>("thread/read", { threadId: runtime.snapshot.threadId, limit: 1 });
          if (!result.thread || result.thread.id !== runtime.snapshot.threadId) throw error;
          authoritative = result.thread[key] ?? undefined;
        } catch {
          if (current()) runtime.patch({ metadataUnknown: [...new Set([...(runtime.snapshot.metadataUnknown ?? []), key])], error: "操作结果仍未知，保留待确认状态；请重新连接核对。" });
          throw error;
        }
      } else authoritative = runtime.metadataConfirmed.get(key) as string | undefined;
    }
    runtime.metadataConfirmed.set(key, authoritative);
    if (current()) {
      runtime.patch({ [key]: authoritative, metadataPending: runtime.snapshot.metadataPending?.filter((item) => item !== key), metadataUnknown: runtime.snapshot.metadataUnknown?.filter((item) => item !== key) });
      if (runtime.client && authoritative !== value) publish(authoritative);
    }
    if (failure && authoritative !== value) throw failure;
  });
  runtime.metadataTail = operation;
  return operation;
}

export function rename(this: TaskRuntime, title: string): Promise<void> {
  const normalized = title.trim();
  if (!normalized) return Promise.reject(new Error("任务标题不能为空"));
  return projectMetadata(this, "title", normalized);
}

/** Keeps a local selection for future submissions; the server applies it temporarily per turn. */
export function setPermissionMode(this: TaskRuntime, mode: PermissionMode): void {
  if (this.disposed) return;
  if (!isPermissionMode(mode)) throw new Error(t("task.permission_mode_invalid"));
  if (
    this.snapshot.running ||
    this.snapshot.activeTurnId ||
    this.snapshot.continuationPending ||
    this.snapshot.sendAcceptanceUnknown ||
    this.snapshot.continuationUnknown ||
    this.snapshot.interaction
  )
    throw new Error(t("task.permission_mode_wait_for_turn"));
  if (this.snapshot.archivedAt)
    throw new Error(t("task.permission_mode_restore_task"));
  if (mode !== "default" && !this.supportsTurnPermissions())
    throw new Error(t("task.permission_mode_unavailable"));
  this.patch({ permissionMode: mode === "default" ? undefined : mode });
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
  if (this.snapshot.pendingTurnPreferences) throw new Error("模型切换仍在处理中");
  const previousModel = this.snapshot.model;
  const previousEffort = this.snapshot.reasoningEffort;
  this.patch({ pendingTurnPreferences: { model: normalizedModel, reasoningEffort: normalizedEffort }, configurationReady: false });
  try {
    if (this.client) normalizedModel = (await negotiateModelSelector(this.client, normalizedModel)) ?? normalizedModel;
    if (this.client && normalizedModel !== previousModel) await this.request("thread/metadata/update", { threadId: this.snapshot.threadId, model: normalizedModel });
    this.patch({ model: normalizedModel, reasoningEffort: normalizedEffort, pendingTurnPreferences: undefined, configurationReady: true });
  } catch (error) {
    if (isAmbiguous(error)) {
      try {
        const result = await this.request<{ thread?: ThreadSummary }>("thread/read", { threadId: this.snapshot.threadId, limit: 1 });
        const confirmed = threadModelSelector(result.thread);
        if (!confirmed) throw error;
        const effort = await restoreReasoningEffortForThread(this.client!, this.snapshot.threadId, confirmed, confirmed === normalizedModel ? normalizedEffort : previousEffort);
        this.patch({ model: confirmed, reasoningEffort: effort, pendingTurnPreferences: undefined, configurationReady: true });
        if (confirmed === normalizedModel) return;
      } catch {
        this.patch({ error: "模型切换结果仍未知，请重新连接核对；暂不派发新消息。" });
        throw error;
      }
    } else this.patch({ pendingTurnPreferences: undefined, configurationReady: true });
    throw error;
  }
}

export function archive(this: TaskRuntime): Promise<void> {
  return projectMetadata(this, "archivedAt", new Date().toISOString());
}

export function unarchive(this: TaskRuntime): Promise<void> {
  return projectMetadata(this, "archivedAt", undefined);
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
  mode?: GoalMode,
  options?: {
    tokenBudget?: number;
    verificationKind?: "artifact" | "answer";
    expectedGoal?: Pick<ThreadGoal, "goalId" | "revision">;
    requireNoGoal?: boolean;
  },
): Promise<ThreadGoal | null> {
  if (mode === undefined) mode = "standard";
  if (options === undefined) options = {};
  const normalized = objective.trim();
  if (!normalized) throw new Error("目标不能为空");
  if (this.snapshot.running) throw new Error("当前回合结束后才能设置目标");
  if (this.snapshot.archivedAt)
    throw new Error("任务已归档，请先恢复后再设置目标");
  if (!this.client) return null;
  const projection = captureGoalProjection(this);
  const result = await requestGoalWrite(this, "thread/goal/set", {
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
  }) as { goal: ThreadGoal };
  if (projection.current()) publishGoal(this, result.goal, projection.version);
  return result.goal;
}

export async function getGoal(this: TaskRuntime, acknowledgeUnknown?: boolean): Promise<ThreadGoal | null> {
  if (!this.client) return null;
  const projection = captureGoalProjection(this);
  const editObservation = this.metadataRevisions.get("goalEditObservation") ?? 0;
  const unknownWrite = this.metadataRevisions.get("goalUnknownWrite") ?? 0;
  const result = await this.request<{ threadId: string; goal?: ThreadGoal | null }>(
    "thread/goal/get",
    {
      threadId: this.snapshot.threadId,
    },
  );
  if (!projection.current()) throw new Error(t("task.goal_connection_changed"));
  if ((result.threadId !== this.snapshot.threadId) ||
      (result.goal != null && result.goal.threadId !== this.snapshot.threadId)) throw new Error(t("task.goal_response_wrong_thread"));
  const published = publishGoal(this, result.goal ?? null, projection.version);
  if (published && editObservation === (this.metadataRevisions.get("goalEditObservation") ?? 0)) this.patch({ goalEditReadRequired: false });
  if (acknowledgeUnknown && published && unknownWrite === (this.metadataRevisions.get("goalUnknownWrite") ?? 0)) this.patch({ goalMutationUnknown: false, goalError: null });
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
  expectedGoal?: Pick<ThreadGoal, "goalId" | "revision">,
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
  const projection = captureGoalProjection(this);
  const current = expectedGoal ?? (await this.getGoal());
  if (!projection.current()) throw new Error(t("task.goal_connection_changed"));
  if (!current) throw new Error("当前没有目标");
  if (this.snapshot.goal !== undefined && (this.snapshot.goal?.goalId !== current.goalId || this.snapshot.goal?.revision !== current.revision))
    throw new Error(t("task.goal_changed_refresh"));
  projection.version = this.goalProjectionVersion;
  const result = await requestGoalWrite(this, "thread/goal/set", {
    threadId: this.snapshot.threadId,
    status,
    expectedGoalId: current.goalId,
    expectedRevision: current.revision,
  }) as { goal: ThreadGoal };
  if (projection.current()) publishGoal(this, result.goal, projection.version);
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
  if (this.snapshot.goalEditReadRequired) throw new Error(t("task.goal_edit_refresh_required"));
  const projection = captureGoalProjection(this);
  const observed = this.snapshot.goal ?? (await this.getGoal());
  const current = expectedGoal ?? observed;
  if (!projection.current()) throw new Error(t("task.goal_connection_changed"));
  if (!current) throw new Error("当前没有目标");
  if (!goalCanEdit(observed)) throw new Error(t("task.goal_terminal_readonly"));
  if (this.snapshot.goal !== undefined && (this.snapshot.goal?.goalId !== current.goalId || this.snapshot.goal?.revision !== current.revision))
    throw new Error(t("task.goal_changed_refresh"));
  projection.version = this.goalProjectionVersion;
  try {
    const result = await requestGoalWrite(this, "thread/goal/set", {
      threadId: this.snapshot.threadId,
      objective: normalized,
      edit: true,
      expectedGoalId: current.goalId,
      expectedRevision: current.revision,
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
    }) as { goal: ThreadGoal };
    if (projection.current()) publishGoal(this, result.goal, projection.version);
    return result.goal;
  } catch (error) {
    // A rejected CAS/edit can race a terminal transition. Observe; never replay the write.
    if (projection.current() && error instanceof MobileRpcError && error.reason === "remote") {
      this.metadataRevisions.set("goalEditObservation", (this.metadataRevisions.get("goalEditObservation") ?? 0) + 1);
      this.patch({ goalEditReadRequired: true });
      await this.getGoal().catch(() => {});
      if (projection.current() && this.snapshot.goal && !goalCanEdit(this.snapshot.goal))
        throw new Error(t("task.goal_terminal_readonly"));
    }
    throw error;
  }
}

export async function clearGoal(
  this: TaskRuntime,
  expectedGoal?: Pick<ThreadGoal, "goalId" | "revision">,
): Promise<boolean> {
  if (!this.client) return false;
  const projection = captureGoalProjection(this);
  const current = expectedGoal ?? (await this.getGoal());
  if (!projection.current()) throw new Error(t("task.goal_connection_changed"));
  if (!current) return false;
  if (this.snapshot.goal !== undefined && (this.snapshot.goal?.goalId !== current.goalId || this.snapshot.goal?.revision !== current.revision))
    throw new Error(t("task.goal_changed_refresh"));
  projection.version = this.goalProjectionVersion;
  const result = await requestGoalWrite(this,
    "thread/goal/clear",
    {
      threadId: this.snapshot.threadId,
      expectedGoalId: current.goalId,
      expectedRevision: current.revision,
    },
  ) as { cleared?: boolean };
  if (result.cleared === true && projection.current()) publishGoal(this, null, projection.version);
  return result.cleared === true;
}

export async function deleteThread(this: TaskRuntime): Promise<void> {
  if (this.snapshot.running) throw new Error("请先停止当前回合");
  if (!this.client) return;
  const context = this.reconnectContext;
  // Materialized history attachments are removed by the target's thread/delete.
  // Only unsent local uploads need their original connection's staged release.
  const attachmentPaths = context ? workspaceAttachmentPathsForThreadDeletion(await loadWorkspaceState(context.profile.id, context.server.id, this.snapshot.threadId, workspaceStateAuthorizationScope(context.profile, context.server))) : [];
  const cleanupId = context ? await prepareThreadDeletionCleanup(context.profile, context.server, this.snapshot.threadId, this.snapshot.cwd, attachmentPaths, context.managedWorktreeSourcePath ?? context.server.workspacePath) : null;
  await this.request("thread/delete", { threadId: this.snapshot.threadId });
  publishCurrentThreadMutation(this, { kind: "delete" });
  // The target removed materialized session artifacts. The durable cleanup
  // ticket is the sole staged-release owner; do not race it with direct deletes.
  if (context && cleanupId) {
    // Cleanup has its own durable ticket and cannot undo the remote ACK.
    try { await confirmThreadDeletionCleanup(context.profile.id, cleanupId); }
    catch {
      const pending = new ThreadDeletionCleanupConfirmationPendingError(t("task.remote_delete_ack_cleanup_pending"));
      this.patch({ error: pending.message });
      throw pending;
    }
    void retryThreadDeletionCleanup(context.profile, [context.server]).catch(() => {});
  }
}
