import { observeInitialLegacyAcceptance } from "./initialLegacyCleanup";
import { completeInitialLegacyAttachments } from "./initialLegacyAttachments";
import { checkInitialTurnCapabilities, prepareInitialTurn } from "./initialTurn";
import { canCoordinateLegacyCreation } from "@/storage/context-lock";
import { t } from "@/i18n";
import { readTurnReceipt } from "../../../../shared/turnReceipt";
import { withWorkspaceScopeSession, verifyWorkspaceTaskHandoffInSession } from "@/storage/pending-workspace-operation-v2";
import { WORKSPACE_SCOPE_V2, workspaceScopeV2, sameWorkspaceScopeV2 } from "@/protocol/workspace-operation-receipts-v2";
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc } from "@/storage/workspace-profile-fence";
import { loadPendingThreadCreation, savePendingThreadCreation, clearPendingThreadCreation, pendingThreadCreationKey, readWorkspaceTaskHandoff, updateWorkspaceTaskHandoff, startWorkspaceTaskHandoffRpc, linkedCreationIntent, creationTurnOptions, originalCreationInput, type PendingThreadCreation } from "@/storage/pending-thread-creation";
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
import { startRuntimeTranscriptPublication } from "./cache-publication";
import { captureSessionTranscriptScope } from "@/storage/session-transcript-scope";
import { workspaceThreadScopeIdentity } from "./workspaces";
import { TaskRuntime } from "./core";
import { inlineResumeHistoryPage, normalizeHistoryPage, readHistoryPage } from "./history";
import {
  restoreReasoningEffortForThread,
  threadModelSelector,
} from "./modelCatalog";
import { bufferNotifications } from "./notificationBuffer";
import { probeThreadPresence, THREAD_PRESENCE_READ_CAPABILITY, type ThreadPresenceObservation } from "./thread-presence";
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
  const assertCurrent = () => { if (input.isCurrentOwner?.() === false) throw new MobileRpcError("Task creation owner changed; original submission is preserved", -1, "transport", "not-sent"); };
  assertCurrent();
  if (!input.workspaceHandoff && !canCoordinateLegacyCreation()) throw new Error(t("new.original_open_identity_unverified"));
  const publication = startRuntimeTranscriptPublication(input);
  if (input.workspaceHandoff) return createLinkedConnected(createRuntime, input, publication);
  const priorPending = await loadPendingThreadCreation(pendingThreadCreationKey(input.profile, input.server, input.cwd));
  if (priorPending?.linked) throw new Error("原任务交接尚未确认；请恢复原任务，不会创建另一个任务");
  const workspaceProfileIdentity = captureWorkspaceProfileIdentity(input.profile);
  const client = await taskClientConnector(
    input.profile,
    input.server,
    input.cwd,
  );
  try { assertCurrent(); } catch (error) { client.close(); throw error; }
  if (input.agentDefinition && (input.sessionMode !== undefined && input.sessionMode !== "default" ||
    !priorPending?.dispatched && (client.supportsExperimental("agentDefinitionsV1") !== true || client.supportsExperimental("threadCreationReceiptsV1") !== true))) {
    client.close();
    throw new Error(t(input.sessionMode !== undefined && input.sessionMode !== "default" ? "expert.default_session_required" : "expert.creation_unavailable"));
  }
  if (
    (input.sessionMode === "orchestrate" ||
      (input.turnMode && input.turnMode !== "standard")) &&
    !priorPending?.dispatched && !client.supportsExperimental?.("sessionModes")
  ) {
    client.close();
    throw new Error("目标 KCoder 不支持特殊执行模式，请升级后重试");
  }
  try { if (!priorPending?.dispatched) checkInitialTurnCapabilities(client, input); } catch (error) { client.close(); throw error; }
  let wireModel: string | undefined;
  try {
    wireModel = priorPending?.dispatched ? priorPending.input ? priorPending.wireModel : originalCreationInput(priorPending).model : await negotiateModelSelector(client, input.model);
  } catch (error) {
    client.close();
    throw error;
  }
  const receiptSupported = client.supportsExperimental?.("threadCreationReceiptsV1") === true;
  if (priorPending && !receiptSupported) { client.close(); throw new Error("目标暂不支持原创建回执核对；原 ID 已保留，不会重新创建"); }
  const creationKey = pendingThreadCreationKey(input.profile, input.server, input.cwd);
  const intent = JSON.stringify([input.cwd, input.prompt, wireModel, input.sessionMode, input.turnMode, input.reasoningEffort, input.managedWorktreeSourcePath, ...creationTurnOptions(input), ...(input.agentDefinition ? [{ agentDefinition: input.agentDefinition }] : [])]);
  let pending: PendingThreadCreation | null = null;
  let started: { thread?: ThreadSummary };
  const readCreation = async () => {
    const result = await client.request<{ receipt?: { threadId?: string; status?: string; thread?: ThreadSummary } }>("thread/creation/read", { clientRequestId: pending!.clientRequestId });
    if (result.receipt?.status !== "ready" || !result.receipt.thread?.id || result.receipt.threadId !== result.receipt.thread.id)
      throw new Error("任务创建结果仍未知，请核对同一创建请求；不会重复创建任务。");
    return { thread: result.receipt.thread };
  };
  try {
    assertCurrent();
    if (receiptSupported) {
      pending = await loadPendingThreadCreation(creationKey);
      if (pending && pending.intent !== intent) throw new Error("还有未确认的创建请求，请恢复原始任务内容后核对；不会创建第二个任务。");
      if (pending?.dispatched) {
        started = await readCreation();
        if (input.attachmentTransport !== "legacy") client.close();
        const recovered = await resume(createRuntime, { ...input, threadId: started.thread!.id }, publication, input.attachmentTransport === "legacy" ? client : undefined);
        recovered.patch({ permissionMode: input.permissionMode ?? "default" });
        if (pending.turnDispatched) {
          recovered.uncertainSend = pending.initialTurnParams ?? { threadId: started.thread!.id, clientMessageId: `${pending.clientRequestId}-initial-turn` };
          recovered.patch({ sendAcceptanceUnknown: true, error: "首次发送结果待核对，不会重复派发。" });
          await recovered.reconcileSendAcceptance().catch(() => {});
          if (!recovered.snapshot.sendAcceptanceUnknown) { await completeInitialLegacyAttachments(input, started.thread!.id); await clearPendingThreadCreation(creationKey, pending.clientRequestId); }
        } else if (pending.input) {
          pending = { ...pending, threadId: started.thread!.id };
          await savePendingThreadCreation(creationKey, input.profile.id, pending);
          const params = pending.initialTurnParams ?? await prepareInitialTurn(recovered.client!, { ...input, ...pending.input }, started.thread!.id,
            `${pending.clientRequestId}-initial-turn`, recovered.getSnapshot().model, () => !recovered.isDisposed() && input.isCurrentOwner?.() !== false, async attachments => {
              pending = { ...pending!, legacyAttachments: attachments };
              await savePendingThreadCreation(creationKey, input.profile.id, pending);
              recovered.patch({ messages: [...recovered.getSnapshot().messages, { id: `local-user-${pending.clientRequestId}`, role: "user", content: input.prompt, timestampMs: Date.now(), attachments }] });
            });
          assertCurrent();
          checkInitialTurnCapabilities(recovered.client!, { ...input, ...pending.input });
          pending = { ...pending, threadId: started.thread!.id, initialTurnModel: params.model as string | undefined, initialTurnParams: params, turnDispatched: true };
          await savePendingThreadCreation(creationKey, input.profile.id, pending);
          try {
            assertCurrent();
            await recovered.startOrdinaryTurn(params);
          } catch (error) {
            if (error instanceof MobileRpcError && (error.reason === "remote" || error.delivery === "not-sent")) await savePendingThreadCreation(creationKey, input.profile.id, { ...pending, turnDispatched: false });
            recovered.close(); throw error;
          }
          if (!recovered.snapshot.sendAcceptanceUnknown) { await completeInitialLegacyAttachments(input, started.thread!.id); await clearPendingThreadCreation(creationKey, pending.clientRequestId); }
        } else {
          await saveWorkspaceState(input.profile.id, input.server.id, started.thread!.id, { composerDraft: input.prompt }, workspaceStateAuthorizationScope(input.profile, input.server), workspaceProfileIdentity);
          await clearPendingThreadCreation(creationKey, pending.clientRequestId);
        }
        if (pending && recovered.getSnapshot().sendAcceptanceUnknown) observeInitialLegacyAcceptance(recovered, input, creationKey, pending.clientRequestId);
        return recovered;
      }
      pending = pending ?? { clientRequestId: `mobile-create-${Date.now()}-${Math.random().toString(36).slice(2)}`, intent, dispatched: false, wireModel, input: { cwd: input.cwd, prompt: input.prompt, model: input.model, reasoningEffort: input.reasoningEffort, permissionMode: input.permissionMode, localAttachmentIds: input.localAttachmentIds, attachmentDraftId: input.attachmentDraftId, attachmentTransport: input.attachmentTransport, sessionMode: input.sessionMode, turnMode: input.turnMode, managedWorktreeSourcePath: input.managedWorktreeSourcePath, ...(input.agentDefinition ? { agentDefinition: input.agentDefinition } : {}) } };
      await savePendingThreadCreation(creationKey, input.profile.id, pending);
      pending = { ...pending, dispatched: true };
      await savePendingThreadCreation(creationKey, input.profile.id, pending);
    }
    try {
      assertCurrent();
      publication.freeze();
      started = await client.request<{ thread?: ThreadSummary }>("thread/start", {
        cwd: input.cwd,
        ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
        ...(wireModel ? { model: wireModel } : {}),
        ...(input.agentDefinition ? { agentDefinition: input.agentDefinition } : {}),
        ...(pending ? { clientRequestId: pending.clientRequestId } : {}),
      });
    } catch (error) {
      if (pending && error instanceof MobileRpcError && error.reason !== "remote" && error.delivery !== "not-sent") started = await readCreation();
      else {
        if (pending) await clearPendingThreadCreation(creationKey, pending.clientRequestId);
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
  try { assertCurrent(); } catch (error) { client.close(); throw error; }
  const effectiveModel =
    input.model?.includes("::") && wireModel !== input.model
      ? wireModel
      : (threadModelSelector(thread) ?? input.model);
  const threadCwd =
    typeof thread.cwd === "string" && thread.cwd.length > 0
      ? thread.cwd
      : input.cwd;
  const title = input.prompt.split(/\r?\n/, 1)[0].slice(0, 80) || "新任务";
  const initialUserMessageId = `local-user-${Date.now()}`;
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
      permissionMode: input.permissionMode ?? "default",
      messages: [
        {
          id: initialUserMessageId,
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
      profileActivationEpoch: input.profileActivationEpoch,
      isCurrentInteractionOwner: input.isCurrentInteractionOwner,
    },
  );
  try { publication.bind(runtime, typeof thread.cwd === "string" && thread.cwd.length > 0
    ? captureSessionTranscriptScope(input.profile, input.server, thread.cwd, thread.id) : null); }
  catch { publication.bind(runtime, null); }
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
    const initialParams = pending?.initialTurnParams ?? await prepareInitialTurn(client, input, thread.id,
      pending ? `${pending.clientRequestId}-initial-turn` : `mobile-initial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      effectiveModel, () => !runtime.isDisposed() && input.isCurrentOwner?.() !== false, async attachments => {
        if (!pending) throw new Error("Initial attachment creation receipt is unavailable");
        pending = { ...pending, legacyAttachments: attachments };
        await savePendingThreadCreation(creationKey, input.profile.id, pending);
        runtime.patch({ messages: runtime.getSnapshot().messages.map(message => message.id === initialUserMessageId ? { ...message, attachments } : message) });
      });
    assertCurrent();
    checkInitialTurnCapabilities(runtime.client!, input);
    if (pending) {
      pending = { ...pending, initialTurnModel: initialParams.model as string | undefined, initialTurnParams: initialParams, turnDispatched: true };
      await savePendingThreadCreation(creationKey, input.profile.id, pending);
    }
    assertCurrent();
    if (runtime.client !== client) throw new MobileRpcError("Initial task connection changed", -1, "transport", "not-sent");
    await runtime.startOrdinaryTurn(initialParams, initialUserMessageId);
    await completeInitialLegacyAttachments(input, thread.id);
    if (pending) await clearPendingThreadCreation(creationKey, pending.clientRequestId).catch(() => {});
    return runtime;
  } catch (error) {
    if (runtime.snapshot.sendAcceptanceUnknown) {
      if (pending) observeInitialLegacyAcceptance(runtime, input, creationKey, pending.clientRequestId);
      return runtime;
    }
    if (pending && error instanceof MobileRpcError && (error.reason === "remote" || error.delivery === "not-sent")) {
      pending = { ...pending, turnDispatched: false };
      await savePendingThreadCreation(creationKey, input.profile.id, pending).catch(() => {});
    }
    // A transport failure says nothing about acceptance. Never delete a task
    // merely because its turn/start response was lost.
    if (
      error instanceof MobileRpcError &&
      error.reason === "remote" &&
      !pending && !input.localAttachmentIds?.length &&
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
async function createLinkedConnected(createRuntime: TaskRuntimeConstructor, input: TaskCreationInput,
  publication: ReturnType<typeof startRuntimeTranscriptPublication>): Promise<TaskRuntime> {
  return withWorkspaceScopeSession(input.profile, input.server, async sourceSession => {
    const handoff = input.workspaceHandoff!;
    let pending = await verifyWorkspaceTaskHandoffInSession(sourceSession, handoff);
    if (handoff.key !== pendingThreadCreationKey(input.profile, input.server, input.cwd) || pending.linked!.creationIntent !== linkedCreationIntent(input)) throw new Error("原任务内容与交接记录不匹配；不会创建另一个任务");
    sourceSession.assertCurrent();
    const client = await taskClientConnector(input.profile, input.server, pending.linked!.input.cwd);
    let runtime: TaskRuntime | undefined;
    const fresh = async (connected = client) => {
      if (input.isCurrentOwner?.() === false) throw new MobileRpcError("Task creation owner changed; original submission is preserved", -1, "transport", "not-sent");
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
      if (input.agentDefinition && (input.sessionMode !== undefined && input.sessionMode !== "default" ||
        (!pending.dispatched || pending.linked!.threadPhase === "not-sent") && client.supportsExperimental("agentDefinitionsV1") !== true)) throw new Error(t(input.sessionMode !== undefined && input.sessionMode !== "default" ? "expert.default_session_required" : "expert.creation_unavailable"));
      if ((input.sessionMode === "orchestrate" || input.turnMode && input.turnMode !== "standard") && (!pending.dispatched || pending.linked!.threadPhase === "not-sent") && !client.supportsExperimental("sessionModes")) throw new Error("目标不支持原任务执行模式；原 ID 已保留");
      if (!pending.dispatched || pending.linked!.threadPhase === "not-sent") checkInitialTurnCapabilities(client, input);
      const taskScope = await fresh();
      if (!pending.linked!.startParams) {
        const model = await negotiateModelSelector(client, pending.linked!.input.model);
        pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, taskScope,
          startParams: { cwd: value.linked!.input.cwd, clientRequestId: value.clientRequestId, ...(value.linked!.input.sessionMode ? { sessionMode: value.linked!.input.sessionMode } : {}), ...(model ? { model } : {}), ...(value.linked!.input.agentDefinition ? { agentDefinition: value.linked!.input.agentDefinition } : {}) } } }));
      }
      let thread: ThreadSummary;
      if (pending.dispatched && pending.linked!.threadPhase !== "not-sent") thread = await readCreation();
      else {
        await fresh();
        const sent = await startWorkspaceTaskHandoffRpc(handoff, value => {
          if (value.dispatched && value.linked!.threadPhase !== "not-sent") throw new Error("原创建已派发，请核对原 ID");
          return { ...value, dispatched: true, linked: { ...value.linked!, threadPhase: "sent" } };
        }, () => { sourceSession.assertCurrent(); publication.freeze(); return client.request<{ thread?: ThreadSummary }>("thread/start", pending.linked!.startParams!); });
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
      if (input.attachmentTransport !== "legacy") client.close();
      runtime = await resume(createRuntime, { ...input, threadId: thread.id, cwd: captured.cwd }, publication, input.attachmentTransport === "legacy" ? client : undefined);
      runtime.patch({ permissionMode: captured.permissionMode ?? "default" });
      if (runtime.reconnectContext) runtime.reconnectContext.managedWorktreeSourcePath = captured.managedWorktreeSourcePath;
      await fresh(runtime.client!);
      pending = await readWorkspaceTaskHandoff(handoff);
      if (pending.linked!.turn.phase !== "accepted") {
        if (!pending.linked!.turn.params) {
          const params = await prepareInitialTurn(runtime.client!, { ...input, ...captured }, thread.id, pending.linked!.turn.clientMessageId,
            pending.linked!.startParams!.model as string | undefined, () => !runtime!.isDisposed() && input.isCurrentOwner?.() !== false, async attachments => {
              pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, legacyAttachments: attachments }));
            });
          pending = await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, turn: { ...value.linked!.turn, params } } }));
        }
        if (pending.linked!.turn.phase === "prepared" || pending.linked!.turn.phase === "not-sent") {
          await fresh(runtime.client!);
          checkInitialTurnCapabilities(runtime.client!, { ...input, ...captured });
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
      if (pending.linked!.turn.phase === "accepted") await completeInitialLegacyAttachments(input, thread.id);
      return runtime;
    } catch (error) {
      try { runtime?.close(); } catch { console.warn("task_creation_cleanup_pending"); }
      throw error;
    } finally { try { if (runtime?.client !== client) client.close(); } catch { console.warn("task_creation_cleanup_pending"); } }
  });
}

type CreateInput = Parameters<typeof createConnected>[1];
const creating = new Map<string, { intent: string; promise: Promise<TaskRuntime> }>();
/** Claim synchronously before any storage or handshake await; duplicate taps share one operation. */
function sharedCreation(createRuntime: TaskRuntimeConstructor, input: CreateInput): Promise<TaskRuntime> {
  const key = pendingThreadCreationKey(input.profile, input.server, input.cwd);
  const intent = JSON.stringify([input.prompt, input.model, input.reasoningEffort, input.sessionMode, input.turnMode, input.managedWorktreeSourcePath, input.workspaceHandoff ? [input.workspaceHandoff.clientRequestId, input.workspaceHandoff.receiptId, input.workspaceHandoff.key] : null, ...creationTurnOptions(input), ...(input.agentDefinition ? [{ agentDefinition: input.agentDefinition }] : [])]);
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
    deferConfiguration?: boolean;
    onSessionExpired?: () => void;
    profileActivationEpoch?: number;
    isCurrentInteractionOwner?: ReconnectContext["isCurrentInteractionOwner"];
    presenceOwnerToken?: object;
    isCurrentOwner?: () => boolean;
    signal?: AbortSignal;
    onThreadPresence?: (observation: ThreadPresenceObservation) => void;
  },
  publication = startRuntimeTranscriptPublication(input),
  connectedClient?: GatewayRpcClient,
): Promise<TaskRuntime> {
  let client: GatewayRpcClient | undefined = connectedClient;
  let buffered: ReturnType<typeof bufferNotifications> | undefined;
  const isCurrentResumeOwner = () => !input.signal?.aborted && input.isCurrentOwner?.() !== false;
  const assertCurrentResumeOwner = () => {
    if (isCurrentResumeOwner()) return;
    const error = new Error("Task resume cancelled because its owner changed");
    error.name = "AbortError";
    throw error;
  };
  const closeOnAbort = () => client?.close();
  input.signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    assertCurrentResumeOwner();
    client = connectedClient ?? await (input.signal
      ? taskClientConnector(input.profile, input.server, input.cwd, "runtime", { signal: input.signal })
      : taskClientConnector(input.profile, input.server, input.cwd));
    assertCurrentResumeOwner();
    const resumeClient = client;
    const notificationBuffer = bufferNotifications(resumeClient);
    buffered = notificationBuffer;
    const readPresenceAfter = async (error: unknown, code: number) => {
      if (!(error instanceof MobileRpcError) || error.reason !== "remote" || error.code !== code ||
          !isCurrentResumeOwner() || resumeClient.supportsExperimental?.(THREAD_PRESENCE_READ_CAPABILITY) !== true) return;
      const isCurrentOwner = isCurrentResumeOwner;
      const ownerToken = input.presenceOwnerToken ?? input.isCurrentOwner ?? input;
      try {
        const observation = await probeThreadPresence({ client: resumeClient, profile: input.profile, server: input.server,
          cwd: input.cwd, threadId: input.threadId, ownerToken, isCurrentOwner });
        if (observation && isCurrentOwner() && resumeClient.matchesRetainedAttachmentOwner(input.profile, input.server, input.cwd)) {
          try { input.onThreadPresence?.(observation); } catch { /* Preserve the original recovery error. */ }
        }
      } catch { /* Presence is advisory and never replaces the original RPC error. */ }
    };
    const inlineHistory = resumeClient.supportsExperimental?.("threadResumeHistoryPageV1") === true;
    let resumed: { thread?: ThreadSummary };
    try {
      assertCurrentResumeOwner();
      publication.freeze();
      resumed = await resumeClient.request<{ thread?: ThreadSummary }>(
        "thread/resume",
        {
          threadId: input.threadId,
          ...(inlineHistory ? { history: {
            limit: 50,
            indexed: resumeClient.supportsExperimental?.("threadIndexedPagesV1") === true,
          } } : {}),
        },
      );
      assertCurrentResumeOwner();
    } catch (error) {
      await readPresenceAfter(error, -32022);
      throw error;
    }
    const inlinePage = inlineHistory ? inlineResumeHistoryPage(resumed, input.threadId) : null;
    let history: Awaited<ReturnType<typeof readHistoryPage>>;
    if (inlinePage) history = { ...normalizeHistoryPage(inlinePage), sourcePage: inlinePage };
    else {
      try {
        assertCurrentResumeOwner();
        history = await readHistoryPage(resumeClient, input.threadId);
        assertCurrentResumeOwner();
      }
      catch (error) { await readPresenceAfter(error, -32021); throw error; }
    }
    assertCurrentResumeOwner();
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
    const configurationPending = input.deferConfiguration === true || Boolean(model && reasoningEffort);
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
        transcriptSnapshotV1: history.transcriptSnapshotV1,
        transcriptObservationV1: history.transcriptObservationV1,
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
        profileActivationEpoch: input.profileActivationEpoch,
        isCurrentInteractionOwner: input.isCurrentInteractionOwner,
      },
    );
    runtime.confirmedTranscriptPage = { page: history.sourcePage, confirmedAt: Date.now() };
    try {
      const mismatchedThread = [historyThread?.id, resumedThread?.id].some(id => id !== undefined && id !== input.threadId);
      const confirmedCwds = [historyThread?.cwd, resumedThread?.cwd].filter(
        (value): value is string => typeof value === "string" && value.length > 0);
      const confirmedCwd = [historyThread, resumedThread].find(thread => thread?.id === input.threadId &&
        typeof thread.cwd === "string" && thread.cwd.length > 0)?.cwd;
      const conflictingCwd = confirmedCwd && confirmedCwds.some(cwd => workspaceThreadScopeIdentity(cwd) !== workspaceThreadScopeIdentity(confirmedCwd));
      publication.bind(runtime, confirmedCwd && !mismatchedThread && !conflictingCwd
        ? captureSessionTranscriptScope(input.profile, input.server, confirmedCwd, input.threadId) : null);
    } catch { publication.bind(runtime, null); }
    if (input.deferConfiguration) runtime.workspaceConfiguration = null;
    runtime.attachBufferedClient(resumeClient, notificationBuffer);
    void runtime.refreshAsyncQuestions();
    runtime.flushPendingDeltas();
    const generation = runtime.clientGeneration;
    const current = () => !runtime.disposed && runtime.clientGeneration === generation;
    if (resumeClient.supportsExperimental?.("agentSteering") === true) {
      assertCurrentResumeOwner();
      let changed = false;
      const unsubscribe = runtime.subscribeProtocol((message) => {
        if (message.method?.startsWith("agent/") || message.method?.startsWith("backgroundAgent/")) changed = true;
      });
      void resumeClient.request<AgentListResult>("agent/list", { threadId: input.threadId })
        .then((result) => { if (current() && !changed) runtime.applySubagentSnapshot(Array.isArray(result.agents) ? result.agents : []); })
        .catch(() => {})
        .finally(unsubscribe);
    }
    if (configurationPending && !input.deferConfiguration) {
      void restoreReasoningEffortForThread(resumeClient, input.threadId, model, reasoningEffort)
        .then((restored) => {
          if (current() && !runtime.snapshot.pendingTurnPreferences && runtime.snapshot.model === model && runtime.snapshot.reasoningEffort === reasoningEffort)
            runtime.patch({ reasoningEffort: restored, configurationReady: true });
        });
    }
    return runtime;
  } catch (error) {
    buffered?.cancel();
    client?.close();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", closeOnAbort);
  }
}

/** Apply locally restored preferences through the existing read-only configuration projection. */
export async function restoreWorkspaceConfiguration(
  this: TaskRuntime,
  reasoningEffort: string | undefined,
  isCurrentOwner?: () => boolean,
): Promise<void> {
  const isCurrent = isCurrentOwner === undefined ? () => true : isCurrentOwner;
  if (this.disposed || this.workspaceConfiguration === undefined || !isCurrent()) return;
  const configuration = { reasoningEffort, isCurrent };
  this.workspaceConfiguration = configuration;
  this.patch({ configurationReady: false });
  const client = this.client;
  if (!client || !this.snapshot.connected) return; // A reconnect applies this same deferred preference.
  const generation = this.clientGeneration;
  const model = this.snapshot.model;
  const restored = await restoreReasoningEffortForThread(client, this.snapshot.threadId, model, reasoningEffort);
  if (!this.disposed && isCurrent() && this.workspaceConfiguration === configuration &&
      this.clientGeneration === generation && this.snapshot.model === model && !this.snapshot.pendingTurnPreferences) {
    this.patch({ reasoningEffort: restored, configurationReady: true });
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
