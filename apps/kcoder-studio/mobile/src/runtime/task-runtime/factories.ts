import { readTurnReceipt } from "../../../../shared/turnReceipt";
import { withWorkspaceScopeSession, verifyWorkspaceTaskHandoffInSession } from "@/storage/pending-workspace-operation-v2";
import { WORKSPACE_SCOPE_V2, workspaceScopeV2, sameWorkspaceScopeV2 } from "@/protocol/workspace-operation-receipts-v2";
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc } from "@/storage/workspace-profile-fence";
import { loadPendingThreadCreation, savePendingThreadCreation, clearPendingThreadCreation, pendingThreadCreationKey, readWorkspaceTaskHandoff, updateWorkspaceTaskHandoff, startWorkspaceTaskHandoffRpc, linkedCreationIntent, type PendingThreadCreation } from "@/storage/pending-thread-creation";
import { saveWorkspaceState, workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
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
import { inlineResumeHistoryPage, normalizeHistoryPage, readHistoryPage } from "./history";
import {
  restoreReasoningEffortForThread,
  threadModelSelector,
} from "./modelCatalog";
import { bufferNotifications } from "./notificationBuffer";
import type { ReconnectContext, TaskSnapshot, TaskCreationInput, TaskCreationClaim } from "./types";
import { type AgentListResult } from "./types";
import type { TaskCreationRegistration, TaskRuntimeRegistry } from "./registry";
type TaskRuntimeConstructor = (
  client: GatewayRpcClient | null,
  initial: TaskSnapshot,
  context?: ReconnectContext | null,
) => TaskRuntime;

async function createConnected(
  createRuntime: TaskRuntimeConstructor,
  input: TaskCreationInput,
): Promise<TaskRuntime> {
  if (input.workspaceHandoff) return createLinkedConnected(createRuntime, input);
  if ((await loadPendingThreadCreation(pendingThreadCreationKey(input.profile, input.server, input.cwd)))?.linked) throw new Error("原任务交接尚未确认；请恢复原任务，不会创建另一个任务");
  const workspaceProfileIdentity = captureWorkspaceProfileIdentity(input.profile);
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
  const receiptSupported = client.supportsExperimental?.("threadCreationReceiptsV1") === true;
  const creationKey = pendingThreadCreationKey(input.profile, input.server, input.cwd);
  const intent = JSON.stringify([input.cwd, input.prompt, wireModel, input.sessionMode, input.turnMode, input.reasoningEffort, input.managedWorktreeSourcePath]);
  let pending: PendingThreadCreation | null = null;
  let started: { thread?: ThreadSummary };
  const readCreation = async () => {
    const result = await client.request<{ receipt?: { threadId?: string; status?: string; thread?: ThreadSummary } }>("thread/creation/read", { clientRequestId: pending!.clientRequestId });
    if (result.receipt?.status !== "ready" || !result.receipt.thread?.id || result.receipt.threadId !== result.receipt.thread.id)
      throw new Error("任务创建结果仍未知，请核对同一创建请求；不会重复创建任务。");
    return { thread: result.receipt.thread };
  };
  try {
    if (receiptSupported) {
      pending = await loadPendingThreadCreation(creationKey);
      if (pending && pending.intent !== intent) throw new Error("还有未确认的创建请求，请恢复原始任务内容后核对；不会创建第二个任务。");
      if (pending?.dispatched) {
        started = await readCreation();
        client.close();
        const recovered = await resume(createRuntime, { ...input, threadId: started.thread!.id });
        if (pending.turnDispatched) {
          recovered.uncertainSend = { threadId: started.thread!.id, clientMessageId: `${pending.clientRequestId}-initial-turn` };
          recovered.patch({ sendAcceptanceUnknown: true, error: "首次发送结果待核对，不会重复派发。" });
          await recovered.reconcileSendAcceptance().catch(() => {});
        } else {
          await saveWorkspaceState(input.profile.id, input.server.id, started.thread!.id, { composerDraft: input.prompt }, workspaceStateAuthorizationScope(input.profile, input.server), workspaceProfileIdentity);
        }
        if (!recovered.snapshot.sendAcceptanceUnknown) await clearPendingThreadCreation(creationKey);
        return recovered;
      }
      pending = pending ?? { clientRequestId: `mobile-create-${Date.now()}-${Math.random().toString(36).slice(2)}`, intent, dispatched: false };
      await savePendingThreadCreation(creationKey, input.profile.id, pending);
      pending = { ...pending, dispatched: true };
      await savePendingThreadCreation(creationKey, input.profile.id, pending);
    }
    try {
      started = await client.request<{ thread?: ThreadSummary }>("thread/start", {
        cwd: input.cwd,
        ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
        ...(wireModel ? { model: wireModel } : {}),
        ...(pending ? { clientRequestId: pending.clientRequestId } : {}),
      });
    } catch (error) {
      if (pending && error instanceof MobileRpcError && error.reason !== "remote" && error.delivery !== "not-sent") started = await readCreation();
      else {
        if (pending) await clearPendingThreadCreation(creationKey);
        throw error;
      }
    }
  } catch (error) {
    client.close();
    throw error;
  }
  const thread = started.thread;
  if (!thread?.id) {
    client.close();
    throw new Error("KCoder app-server 未返回 thread id");
  }
  if (pending) {
    pending = { ...pending, threadId: thread.id };
    try {
      await savePendingThreadCreation(creationKey, input.profile.id, pending);
    } catch (error) {
      client.close();
      throw error;
    }
  }
  const effectiveModel =
    input.model?.includes("::") && wireModel !== input.model
      ? wireModel
      : (threadModelSelector(thread) ?? input.model);
  const threadCwd =
    typeof thread.cwd === "string" && thread.cwd.length > 0
      ? thread.cwd
      : input.cwd;
  const title = input.prompt.split(/\r?\n/, 1)[0].slice(0, 80) || "新任务";
  if (input.managedWorktreeSourcePath) {
    let registryClient: typeof client | null = null;
    try {
      registryClient = await taskClientConnector(
        input.profile,
        input.server,
        input.managedWorktreeSourcePath,
      );
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
      try {
        await client.request("thread/delete", { threadId: thread.id });
      } catch {
        // Reclaim only the known empty thread, best effort.
      }
      try {
        client.close();
      } catch {
        // Preserve the connector or worktree-link failure.
      }
      throw error;
    } finally {
      try {
        registryClient?.close();
      } catch {
        // Closing this auxiliary client must not hide the task creation result.
      }
    }
  }
  const runtime = createRuntime(
    client,
    {
      threadId: thread.id,
      title,
      cwd: threadCwd,
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
      threadCwd,
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
    if (pending) {
      pending = { ...pending, turnDispatched: true };
      await savePendingThreadCreation(creationKey, input.profile.id, pending);
    }
    await runtime.startOrdinaryTurn({
      threadId: thread.id,
      ...(pending ? { clientMessageId: `${pending.clientRequestId}-initial-turn` } : {}),
      input: [{ type: "text", text: input.prompt }],
      ...(input.turnMode ? { turnMode: input.turnMode } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(input.reasoningEffort
        ? { reasoningEffort: input.reasoningEffort }
        : {}),
    });
    if (pending) await clearPendingThreadCreation(creationKey).catch(() => {});
    return runtime;
  } catch (error) {
    if (runtime.snapshot.sendAcceptanceUnknown) {
      return runtime;
    }
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
    try { runtime.close(); } catch { console.warn("task_creation_cleanup_pending"); }
    throw error;
  }
}

/** Linked creation owns its original identities beyond a form/runtime lifetime. */
async function createLinkedConnected(createRuntime: TaskRuntimeConstructor, input: TaskCreationInput): Promise<TaskRuntime> {
  return withWorkspaceScopeSession(input.profile, input.server, async sourceSession => {
    const handoff = input.workspaceHandoff!;
    let pending = await verifyWorkspaceTaskHandoffInSession(sourceSession, handoff);
    if (handoff.key !== pendingThreadCreationKey(input.profile, input.server, input.cwd) || pending.linked!.creationIntent !== linkedCreationIntent(input)) throw new Error("原任务内容与交接记录不匹配；不会创建另一个任务");
    sourceSession.assertCurrent();
    const client = await taskClientConnector(input.profile, input.server, pending.linked!.input.cwd);
    let runtime: TaskRuntime | undefined;
    const fresh = async (connected = client) => {
      await verifyWorkspaceTaskHandoffInSession(sourceSession, handoff);
      const sent = await startWorkspaceProfileRpc(pending.linked!.authorization, () => { sourceSession.assertCurrent(); return connected.request(WORKSPACE_SCOPE_V2, {}); });
      const scope = workspaceScopeV2(await sent.response);
      sourceSession.assertCurrent();
      pending = await readWorkspaceTaskHandoff(handoff);
      sourceSession.assertCurrent();
      if (pending.linked!.taskScope && !sameWorkspaceScopeV2(pending.linked!.taskScope, scope)) throw new Error("原任务目录身份已变化；原创建和首次发送 ID 已保留");
      return scope;
    };
    const readCreation = async (): Promise<ThreadSummary> => {
      const sent = await startWorkspaceProfileRpc(pending.linked!.authorization, () => { sourceSession.assertCurrent(); return client.request<{ receipt?: { status?: string; threadId?: string; thread?: ThreadSummary } }>("thread/creation/read", { clientRequestId: handoff.clientRequestId }); });
      const reply = await sent.response;
      sourceSession.assertCurrent();
      if (reply.receipt?.status !== "ready" || !reply.receipt.thread?.id || reply.receipt.thread.id !== reply.receipt.threadId || pending.threadId && pending.threadId !== reply.receipt.threadId) throw new Error("原任务创建结果仍未知；保留原 ID，不会重复创建");
      return reply.receipt.thread;
    };
    try {
      sourceSession.assertCurrent();
      if (!client.supportsExperimental("threadCreationReceiptsV1") || !client.supportsExperimental("turnReceiptsV1")) throw new Error("目标不支持原任务和首次发送回执核对；请升级目标，原 ID 已保留");
      if ((input.sessionMode === "orchestrate" || input.turnMode && input.turnMode !== "standard") && !client.supportsExperimental("sessionModes")) throw new Error("目标不支持原任务执行模式；原 ID 已保留");
      const taskScope = await fresh();
      if (!pending.linked!.startParams) {
        const model = await negotiateModelSelector(client, pending.linked!.input.model);
        pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, taskScope,
          startParams: { cwd: value.linked!.input.cwd, clientRequestId: value.clientRequestId, ...(value.linked!.input.sessionMode ? { sessionMode: value.linked!.input.sessionMode } : {}), ...(model ? { model } : {}) } } }));
      }
      let thread: ThreadSummary;
      if (pending.dispatched && pending.linked!.threadPhase !== "not-sent") thread = await readCreation();
      else {
        await fresh();
        const sent = await startWorkspaceTaskHandoffRpc(handoff, value => {
          if (value.dispatched && value.linked!.threadPhase !== "not-sent") throw new Error("原创建已派发，请核对原 ID");
          return { ...value, dispatched: true, linked: { ...value.linked!, threadPhase: "sent" } };
        }, () => { sourceSession.assertCurrent(); return client.request<{ thread?: ThreadSummary }>("thread/start", pending.linked!.startParams!); });
        try {
          const reply = await sent.response;
          if (!reply.thread?.id) throw new Error("原任务创建回包无效");
          thread = reply.thread;
        } catch (error) {
          if (error instanceof MobileRpcError && error.delivery === "not-sent") {
            await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, threadPhase: "not-sent" } })); throw error;
          }
          // A remote error can follow durable server reservation. It is not absence evidence.
          try { thread = await readCreation(); }
          catch (cause) {
            await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, threadPhase: "unknown" } })); throw cause;
          }
        }
      }
      await fresh();
      pending = await updateWorkspaceTaskHandoff(handoff, value => {
        if (value.threadId && value.threadId !== thread.id) throw new Error("原创建 ID 返回了其他任务");
        return { ...value, threadId: thread.id, linked: { ...value.linked!, threadPhase: "ready" } };
      });
      const captured = pending.linked!.input;
      if (captured.managedWorktreeSourcePath) {
        if (!pending.linked!.worktreeLink) {
          const timestamp = timestampMs(thread.createdAt) || Date.now();
          const params = { deviceId: input.server.id, path: captured.cwd, conversation: { deviceId: input.server.id, taskId: thread.id, threadId: thread.id, workspacePath: captured.cwd, title: captured.prompt.split(/\r?\n/, 1)[0].slice(0, 80) || "新任务", model: pending.linked!.startParams!.model ?? null, createdAt: timestamp, updatedAt: timestampMs(thread.updatedAt) || timestamp } };
          pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, worktreeLink: {
            sourcePath: captured.managedWorktreeSourcePath!, confirmed: false, params, payloadIdentity: JSON.stringify(params),
          } } }));
        }
        if (!pending.linked!.worktreeLink!.confirmed) {
          await fresh();
          const registryClient = await taskClientConnector(input.profile, input.server, pending.linked!.worktreeLink!.sourcePath);
          try {
            const sent = await startWorkspaceTaskHandoffRpc(handoff, value => value, () => { sourceSession.assertCurrent(); return registryClient.request<{ accepted?: boolean; path?: string }>("runtime.worktrees.conversations.link", pending.linked!.worktreeLink!.params); });
            const reply = await sent.response;
            if (reply.accepted !== true || reply.path !== captured.cwd) throw new Error("原任务 worktree 关联尚未确认；原任务已保留");
            await fresh();
            pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, worktreeLink: { ...value.linked!.worktreeLink!, confirmed: true } } }));
          } finally { registryClient.close(); }
        }
      }
      client.close();
      runtime = await resume(createRuntime, { ...input, threadId: thread.id, cwd: captured.cwd });
      if (runtime.reconnectContext) runtime.reconnectContext.managedWorktreeSourcePath = captured.managedWorktreeSourcePath;
      await fresh(runtime.client!);
      pending = await readWorkspaceTaskHandoff(handoff);
      if (pending.linked!.turn.phase !== "accepted") {
        if (!pending.linked!.turn.params) {
          const params = { threadId: thread.id, clientMessageId: pending.linked!.turn.clientMessageId, input: [{ type: "text", text: captured.prompt }], ...(captured.turnMode ? { turnMode: captured.turnMode } : {}), ...(pending.linked!.startParams!.model ? { model: pending.linked!.startParams!.model } : {}), ...(captured.reasoningEffort ? { reasoningEffort: captured.reasoningEffort } : {}) };
          pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, turn: { ...value.linked!.turn, params } } }));
        }
        if (pending.linked!.turn.phase === "prepared" || pending.linked!.turn.phase === "not-sent") {
          await fresh(runtime.client!);
          const optimisticId = `local-user-${handoff.clientRequestId}`;
          if (!runtime.getSnapshot().messages.some(message => message.id === optimisticId)) runtime.patch({ messages: [...runtime.getSnapshot().messages, { id: optimisticId, role: "user", content: captured.prompt, clientMessageId: pending.linked!.turn.clientMessageId, timestampMs: Date.now() }], title: captured.prompt.split(/\r?\n/, 1)[0].slice(0, 80) || "新任务" });
          const sent = await startWorkspaceTaskHandoffRpc(handoff, value => {
            if (!["prepared","not-sent"].includes(value.linked!.turn.phase)) throw new Error("原首次发送已派发，请核对原发送 ID");
            return { ...value, turnDispatched: true, linked: { ...value.linked!, turn: { ...value.linked!.turn, phase: "sent" } } };
          }, () => { sourceSession.assertCurrent(); return runtime!.startOrdinaryTurn(pending.linked!.turn.params!, optimisticId); });
          try {
            const result = await sent.response;
            await fresh(runtime.client!);
            pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, turn: { ...value.linked!.turn, phase: "accepted", turnId: result.turn!.id! } } }));
          } catch (error) {
            const notSent = error instanceof MobileRpcError && error.delivery === "not-sent";
            pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, turn: { ...value.linked!.turn, phase: notSent ? "not-sent" : "unknown" } } }));
            runtime.uncertainSend = pending.linked!.turn.params!;
            runtime.patch({ sendAcceptanceUnknown: true, running: false, error: notSent ? "原首次发送尚未派发，请恢复原任务后继续。" : "原首次发送结果待核对，不会重复派发。" });
          }
        } else {
          runtime.uncertainSend = pending.linked!.turn.params!;
          runtime.patch({ sendAcceptanceUnknown: true, error: "原首次发送结果待核对，不会重复派发。" });
          try {
            const result = await readTurnReceipt(runtime.client!, pending.linked!.turn.params!);
            await fresh(runtime.client!);
            await runtime.acceptOrdinaryResult(result, runtime.client!, true);
            pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, turn: { ...value.linked!.turn, phase: "accepted", turnId: result.turn!.id! } } }));
          } catch { runtime.patch({ sendAcceptanceUnknown: true, error: "原首次发送结果待核对，不会重复派发。" }); }
        }
      }
      return runtime;
    } catch (error) {
      try { runtime?.close(); } catch { console.warn("task_creation_cleanup_pending"); }
      throw error;
    } finally { try { client.close(); } catch { console.warn("task_creation_cleanup_pending"); } }
  });
}

type CreateInput = Parameters<typeof createConnected>[1];
const creating = new Map<string, { intent: string; promise: Promise<TaskRuntime> }>();
/** Claim synchronously before any storage or handshake await; duplicate taps share one operation. */
function sharedCreation(createRuntime: TaskRuntimeConstructor, input: CreateInput): Promise<TaskRuntime> {
  const key = pendingThreadCreationKey(input.profile, input.server, input.cwd);
  const intent = JSON.stringify([input.prompt, input.model, input.reasoningEffort, input.sessionMode, input.turnMode, input.managedWorktreeSourcePath, input.workspaceHandoff ? [input.workspaceHandoff.clientRequestId, input.workspaceHandoff.receiptId, input.workspaceHandoff.key] : null]);
  const previous = creating.get(key);
  if (previous) return previous.intent === intent ? previous.promise : Promise.reject(new Error("当前工作区的任务创建仍在处理中"));
  if (creationCleanupSlots >= maxCreationCleanupSlots) return Promise.reject(new Error("本机任务资源清理尚未完成，请稍后重试"));
  const consumers: CreationConsumers = { claims: 0, legacyHandoff: false, adopted: false, closed: false, slotHeld: true, settled: false, failed: false };
  creationCleanupSlots += 1;
  const promise = createConnected((client, initial, context) => {
    const runtime = createRuntime(client, initial, context);
    consumers.runtime = runtime;
    return runtime;
  }, input).finally(() => {
    if (creating.get(key)?.promise === promise) creating.delete(key);
  });
  creating.set(key, { intent, promise });
  creationConsumers.set(promise, consumers);
  observeCreation(promise, consumers);
  return promise;
}

interface CreationConsumers {
  claims: number;
  legacyHandoff: boolean;
  adopted: boolean;
  closed: boolean;
  runtime?: TaskRuntime;
  slotHeld: boolean;
  settled: boolean;
  failed: boolean;
}
const creationConsumers = new WeakMap<Promise<TaskRuntime>, CreationConsumers>();
const pendingCreationCleanup = new Set<CreationConsumers>();
const maxCreationCleanupSlots = 32;
let creationCleanupSlots = 0;

function releaseCleanupSlot(consumers: CreationConsumers): void {
  if (!consumers.slotHeld) return;
  consumers.slotHeld = false;
  creationCleanupSlots -= 1;
}

export function creationCleanupStatus(): { reserved: number; pending: number } {
  return { reserved: creationCleanupSlots, pending: pendingCreationCleanup.size };
}

export function retryCreationCleanup(limit = 1): void {
  for (const consumers of [...pendingCreationCleanup].slice(0, Math.min(32, Math.max(0, limit)))) closeUnclaimed(consumers);
}

function observeCreation(result: Promise<TaskRuntime>, consumers: CreationConsumers): void {
  result.then((runtime) => {
    consumers.runtime = runtime;
    consumers.settled = true;
    if (consumers.legacyHandoff || consumers.adopted) releaseCleanupSlot(consumers);
    closeUnclaimed(consumers);
  }, () => {
    consumers.settled = true;
    consumers.failed = true;
    if (consumers.runtime) closeUnclaimed(consumers);
    else releaseCleanupSlot(consumers);
  });
}

function consumersFor(result: Promise<TaskRuntime>): CreationConsumers {
  let consumers = creationConsumers.get(result);
  if (!consumers) {
    consumers = { claims: 0, legacyHandoff: false, adopted: false, closed: false, slotHeld: false, settled: false, failed: false };
    creationConsumers.set(result, consumers);
    observeCreation(result, consumers);
  }
  return consumers;
}

function closeUnclaimed(consumers: CreationConsumers): void {
  if (!consumers.settled || !consumers.runtime || consumers.closed) return;
  if (!consumers.failed && (consumers.claims || consumers.adopted || consumers.legacyHandoff)) return;
  try {
    consumers.runtime.close();
    consumers.closed = true;
    pendingCreationCleanup.delete(consumers);
    releaseCleanupSlot(consumers);
  } catch {
    pendingCreationCleanup.delete(consumers);
    pendingCreationCleanup.add(consumers);
    console.warn("task_creation_cleanup_pending");
  }
}

/** Local ownership only: no new creation ID, wire request, or receipt mutation. */
export function claimCreationResult(result: Promise<TaskRuntime>, registration: TaskCreationRegistration): TaskCreationClaim {
  const existing = creationConsumers.get(result);
  if (!existing?.slotHeld && !existing?.legacyHandoff && !existing?.adopted && creationCleanupSlots >= maxCreationCleanupSlots) throw new Error("本机任务资源清理尚未完成，请稍后重试");
  const consumers = consumersFor(result);
  if (!consumers.slotHeld && !consumers.legacyHandoff && !consumers.adopted && !consumers.closed) { consumers.slotHeld = true; creationCleanupSlots += 1; }
  consumers.claims += 1;
  let released = false;
  let adopted = false;
  return {
    result,
    adopt(registry, profileId, serverId) {
      if (released) return false;
      if (adopted) return true;
      const runtime = consumers.runtime;
      if (!runtime || !consumers.settled || consumers.failed) throw new Error("任务创建尚未完成");
      if (consumers.closed || runtime.isDisposed()) return false;
      if (registration.registry !== registry) throw new Error("任务登记目标与预留不匹配");
      const committed = () => {
        // The registry has committed before previous-runtime or eviction cleanup can throw.
        consumers.adopted = true;
        releaseCleanupSlot(consumers);
        adopted = true;
      };
      registration.put(profileId, serverId, runtime, committed);
      return true;
    },
    release() {
      if (released) return;
      released = true;
      registration.release();
      consumers.claims -= 1;
      closeUnclaimed(consumers);
    },
  };
}

/** Legacy callers own the resolved runtime directly; preserve shared Promise identity. */
export function create(createRuntime: TaskRuntimeConstructor, input: CreateInput): Promise<TaskRuntime> {
  const result = sharedCreation(createRuntime, input);
  const consumers = consumersFor(result);
  consumers.legacyHandoff = true;
  if (consumers.settled && !consumers.failed) releaseCleanupSlot(consumers);
  return result;
}

export function claimCreation(createRuntime: TaskRuntimeConstructor, input: CreateInput, registry: TaskRuntimeRegistry): TaskCreationClaim {
  retryCreationCleanup();
  const pending = creating.get(pendingThreadCreationKey(input.profile, input.server, input.cwd));
  const existing = pending && creationConsumers.get(pending.promise);
  if (!existing?.slotHeld && !existing?.legacyHandoff && !existing?.adopted && creationCleanupSlots >= maxCreationCleanupSlots) throw new Error("本机任务资源清理尚未完成，请稍后重试");
  const registration = registry.reserveCreation();
  try { return claimCreationResult(sharedCreation(createRuntime, input), registration); }
  catch (error) { registration.release(); throw error; }
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
    const inlineHistory = client.supportsExperimental?.("threadResumeHistoryPageV1") === true;
    const resumed = await client.request<{ thread?: ThreadSummary }>(
      "thread/resume",
      {
        threadId: input.threadId,
        ...(inlineHistory ? { history: {
          limit: 50,
          indexed: client.supportsExperimental?.("threadIndexedPagesV1") === true,
        } } : {}),
      },
    );
    const inlinePage = inlineHistory ? inlineResumeHistoryPage(resumed, input.threadId) : null;
    const history = inlinePage
      ? normalizeHistoryPage(inlinePage)
      : await readHistoryPage(client, input.threadId);
    const historyThread = history.thread;
    const resumedThread = resumed.thread;
    const model =
      threadModelSelector(resumedThread) ?? threadModelSelector(historyThread);
    const threadCwd =
      [historyThread?.cwd, resumedThread?.cwd, input.cwd].find(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
    const reasoningEffort = input.reasoningEffort;
    const configurationPending = Boolean(model && reasoningEffort);
    const runtime = createRuntime(
      null,
      {
        threadId: input.threadId,
        title:
          historyThread?.title ??
          resumedThread?.title ??
          input.title ??
          "KCoder 任务",
        cwd: threadCwd ?? "/",
        model,
        archivedAt: historyThread?.archivedAt ?? resumedThread?.archivedAt,
        reasoningEffort,
        configurationReady: !configurationPending,
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
        threadCwd,
        onSessionExpired: input.onSessionExpired,
      },
    );
    runtime.attachBufferedClient(client, buffered);
    runtime.flushPendingDeltas();
    const generation = runtime.clientGeneration;
    const current = () => !runtime.disposed && runtime.clientGeneration === generation;
    if (client.supportsExperimental?.("agentSteering") === true) {
      let changed = false;
      const unsubscribe = runtime.subscribeProtocol((message) => {
        if (message.method?.startsWith("agent/") || message.method?.startsWith("backgroundAgent/")) changed = true;
      });
      void client.request<AgentListResult>("agent/list", { threadId: input.threadId })
        .then((result) => { if (current() && !changed) runtime.applySubagentSnapshot(Array.isArray(result.agents) ? result.agents : []); })
        .catch(() => {})
        .finally(unsubscribe);
    }
    if (configurationPending) {
      void restoreReasoningEffortForThread(client, input.threadId, model, reasoningEffort)
        .then((restored) => {
          if (current() && !runtime.snapshot.pendingTurnPreferences && runtime.snapshot.model === model && runtime.snapshot.reasoningEffort === reasoningEffort)
            runtime.patch({ reasoningEffort: restored, configurationReady: true });
        });
    }
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
