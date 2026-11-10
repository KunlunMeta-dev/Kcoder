import { gatewaySessionExpired, ensureGatewayAuthorization } from "@/gateway/http";
import { GatewayRpcClient } from "@/gateway/rpc";
import type { ThreadSummary } from "@/gateway/types";
import { captureSessionTranscriptScope, sessionTranscriptScopeKey } from "@/storage/session-transcript-scope";
import { gatewayReconnectDelay } from "../../../../shared/gatewayConnectionBudget";
import {
  parseThreadRunSummary,
  threadRunActivity,
  threadRunSummaryIsActive,
} from "../../../../shared/threadRunSummary";
import { taskClientConnector } from "./connectionFactory";
import { TaskRuntime } from "./core";
import {
  completedLivePairsAtReadStart,
  historiesOverlap,
  historyResetTail,
  transcriptReadIdentityKey,
  transcriptReadIdentityMatches,
  inlineResumeHistoryPage,
  mergeReconciledMessages,
  normalizeHistoryPage,
  publishConfirmedHistoryPage,
  readHistoryPage,
} from "./history";
import {
  restoreReasoningEffortForThread,
  threadModelSelector,
} from "./modelCatalog";
import { bufferNotifications } from "./notificationBuffer";
import { type BufferedSubscription } from "./types";

function reconnectOwnerScope(runtime: TaskRuntime, cwd = runtime.snapshot.cwd): string | null {
  const context = runtime.reconnectContext;
  if (!context) return null;
  try {
    return JSON.stringify([
      sessionTranscriptScopeKey(captureSessionTranscriptScope(
        context.profile, context.server, cwd, runtime.snapshot.threadId,
      )),
      context.server.observationTargetIdentity ?? null,
    ]);
  } catch { return null; }
}

function allowsCompletedAbsencePrune(runtime: TaskRuntime): boolean {
  const snapshot = runtime.snapshot;
  return !snapshot.running && snapshot.activeTurnId === null && !snapshot.interaction &&
    runtime.pendingInteractions.length === 0 && !runtime.uncertainSend &&
    !snapshot.sendAcceptanceUnknown && !snapshot.acceptanceChecking &&
    !snapshot.stopAcceptanceUnknown && !snapshot.continuationUnknown &&
    !snapshot.continuationPending;
}

function explicitlyIdleThread(thread: ThreadSummary | undefined): boolean {
  if (!thread || thread.status !== "idle") return false;
  const summary = parseThreadRunSummary(thread.runSummary);
  return (thread.runSummary === undefined || summary !== undefined) &&
    threadRunActivity(thread.status, summary) === "idle";
}

export function close(this: TaskRuntime): void {
  if (this.closeComplete) return;
  if (!this.disposed) this.clientGeneration += 1;
  this.disposed = true; // Fence new work even when releasing one resource must be retried.
  if (this.pendingInteractions.length) this.markInteractionsDisconnected();
  const errors: unknown[] = [];
  for (const [key, session] of this.terminalSessions) {
    try { session.dispose(false); this.terminalSessions.delete(key); }
    catch (error) { errors.push(error); }
  }
  this.uncertainSend = null;
  if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  this.reconnectTimer = null;
  try { this.unsubscribeRpc?.(); this.unsubscribeRpc = null; }
  catch (error) { errors.push(error); }
  try { this.client?.close(); this.client = null; }
  catch (error) { errors.push(error); }
  this.pendingInteractions = [];
  if (this.deltaFlushTimer) clearTimeout(this.deltaFlushTimer);
  this.deltaFlushTimer = null;
  this.pendingAssistantDeltas.clear();
  this.pendingOrderedAssistantDeltas.clear();
  this.pendingThinkingDeltas.clear();
  try {
    this.patch({ connected: false, connectionPhase: undefined, running: false, activeTurnId: null, interaction: null, interactionCount: 0 });
  } catch (error) { errors.push(error); }
  this.closeComplete = errors.length === 0;
  if (errors.length) throw errors[0];
}

export function attachClient(
  this: TaskRuntime,
  client: GatewayRpcClient,
): void {
  this.unsubscribeRpc?.();
  this.client = client;
  this.clientGeneration += 1;
  const generation = this.clientGeneration;
  this.unsubscribeRpc = client.subscribe((message) => {
    if (!this.disposed && this.client === client && this.clientGeneration === generation) this.handleRpc(message);
  });
}

export function attachBufferedClient(
  this: TaskRuntime,
  client: GatewayRpcClient,
  buffered: BufferedSubscription,
): void {
  this.unsubscribeRpc?.();
  this.client = client;
  this.clientGeneration += 1;
  const generation = this.clientGeneration;
  // Replay may synchronously close or replace this connection. Install cleanup
  // first so it cannot leak the old subscription or overwrite its replacement.
  this.unsubscribeRpc = () => buffered.cancel();
  buffered.activate((message) => {
    if (!this.disposed && this.client === client && this.clientGeneration === generation) this.handleRpc(message);
  });
}

export function scheduleReconnect(this: TaskRuntime, reason: string): void {
  if (this.disposed || !this.reconnectContext) return;
  this.markInteractionsDisconnected();
  if (this.reconnectTimer) return;
  if (this.reconnecting) {
    this.reconnectRequested = true;
    this.patch({
      connected: false,
      running: false,
      error: `${reason}，正在重新连接…`,
      connectionPhase: "reconnecting",
    });
    return;
  }
  if (
    this.reconnectAttempt >= 8 &&
    Date.now() < this.reconnectContext.profile.expiresAt
  ) {
    this.patch({
      connected: false,
      running: false,
      interaction: null,
      error: "目标连接失败，已停止自动重连。可重试连接；其他目标仍保持登录。",
      connectionPhase: "failed",
    });
    return;
  }
  if (Date.now() >= this.reconnectContext.profile.expiresAt && !this.reconnectContext.profile.refreshToken) {
    this.reconnectContext.onSessionExpired?.();
    this.patch({
      connected: false,
      running: false,
      interaction: null,
      error: "Gateway 会话已失效，请前往设置重新连接",
      connectionPhase: "reauthorization-required",
    });
    return;
  }
  const delayMs = gatewayReconnectDelay(
    Math.min(500 * 2 ** this.reconnectAttempt, 8_000),
  );
  this.patch({
    connected: false,
    running: false,
    interaction: null,
    error: `${reason}，正在重新连接…`,
    connectionPhase: "reconnecting",
  });
  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    void this.reconnect();
  }, delayMs);
}

export async function reconnectNow(this: TaskRuntime): Promise<void> {
  if (this.disposed) throw new Error("会话已关闭");
  if (
    !this.reconnectContext ||
    (Date.now() >= this.reconnectContext.profile.expiresAt && !this.reconnectContext.profile.refreshToken)
  ) {
    this.patch({ connected: false, connectionPhase: "reauthorization-required",
      error: "Gateway 会话已失效，请前往设置重新连接" });
    throw new Error("Gateway 会话已失效，请前往设置重新连接");
  }
  if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  this.reconnectTimer = null;
  this.reconnectAttempt = 0;
  await this.reconnect();
}

export function reconnect(this: TaskRuntime): Promise<void> {
  if (this.reconnectPromise) return this.reconnectPromise;
  this.reconnectPromise = this.performReconnect().finally(() => {
    this.reconnectPromise = null;
  });
  return this.reconnectPromise;
}

export async function performReconnect(this: TaskRuntime): Promise<void> {
  if (this.disposed || !this.reconnectContext || this.reconnecting) return;
  this.reconnecting = true;
  this.markInteractionsDisconnected();
  this.patch({ connected: false, connectionPhase: "reconnecting", interaction: null, interactionCount: 0 });
  this.reconnectRequested = false;
  let nextClient: GatewayRpcClient | null = null;
  let buffered: BufferedSubscription | null = null;
  try {
    await ensureGatewayAuthorization(this.reconnectContext.profile);
    if (this.disposed) return;
    nextClient = await taskClientConnector(
      this.reconnectContext.profile,
      this.reconnectContext.server,
      this.snapshot.cwd,
    );
    buffered = bufferNotifications(nextClient);
    const readContext = this.reconnectContext;
    const readProfile = readContext.profile;
    const readClient = this.client;
    const readGeneration = this.clientGeneration;
    const readScope = reconnectOwnerScope(this);
    const readAccessToken = readProfile.accessToken;
    const readRpcToken = readProfile.rpcToken;
    const readArrivalOrdinal = this.transcriptArrivalOrdinal;
    const candidatePairs = allowsCompletedAbsencePrune(this)
      ? completedLivePairsAtReadStart(this.snapshot, this.finishedAttempts, this.attemptByTurn)
      : [];
    const readIdentity = transcriptReadIdentityKey(this.snapshot);
    const completedRevision = this.completedTranscriptRevision;
    const readThreadId = this.snapshot.threadId;
    const inlineHistory = nextClient.supportsExperimental?.("threadResumeHistoryPageV1") === true;
    const resumed = await nextClient.request<{ thread?: ThreadSummary }>(
      "thread/resume",
      {
        threadId: this.snapshot.threadId,
        ...(inlineHistory ? { history: {
          limit: 50,
          indexed: nextClient.supportsExperimental?.("threadIndexedPagesV1") === true,
        } } : {}),
      },
    );
    const inlinePage = inlineHistory ? inlineResumeHistoryPage(resumed, this.snapshot.threadId) : null;
    const history = inlinePage
      ? { ...normalizeHistoryPage(inlinePage), sourcePage: inlinePage }
      : await readHistoryPage(nextClient, this.snapshot.threadId);
    if (buffered.hasOverflowed())
      throw new Error("会话更新超过缓存上限，请重新连接以读取完整记录。");
    if (this.disposed || this.snapshot.threadId !== readThreadId || transcriptReadIdentityKey(this.snapshot) !== readIdentity) {
      buffered.cancel();
      nextClient.close();
      return;
    }
    const historyThread = history.thread;
    const resumedThread = resumed.thread;
    const threadCwd =
      [historyThread?.cwd, resumedThread?.cwd].find(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
    if (threadCwd && this.reconnectContext)
      this.reconnectContext.threadCwd = threadCwd;
    const model =
      threadModelSelector(resumedThread) ??
      threadModelSelector(historyThread) ??
      this.snapshot.model;
    const reasoningEffort = this.snapshot.reasoningEffort;
    const configurationPending = this.workspaceConfiguration !== undefined || Boolean(model && reasoningEffort);
    const runSummary = parseThreadRunSummary(
      historyThread?.runSummary ?? resumedThread?.runSummary,
    );
    const running = threadRunSummaryIsActive(
      threadRunActivity(historyThread?.status ?? resumedThread?.status, runSummary),
    );
    const activeTurnId =
      running && runSummary?.mainTurn === "running"
        ? this.snapshot.activeTurnId
        : null;
    const continuousHistory =
      transcriptReadIdentityMatches(this.snapshot, history) &&
      historiesOverlap(history.messages, this.snapshot.messages);
    const rawPage = history.sourcePage;
    const rawMessages = rawPage.messages;
    const fullIdleAuthority = Array.isArray(rawMessages) &&
      rawPage.rangeStart === 0 && rawPage.rangeEnd === rawMessages.length &&
      rawPage.hasMoreBefore === false && rawPage.beforeCursor == null &&
      rawMessages.length === history.messages.length &&
      new Set(rawMessages.map(message => message.id)).size === rawMessages.length &&
      rawPage.thread?.id === readThreadId &&
      explicitlyIdleThread(rawPage.thread) && explicitlyIdleThread(resumedThread) &&
      transcriptReadIdentityKey(history) !== null;
    const canPrune = !continuousHistory && fullIdleAuthority && readScope !== null &&
      readContext === this.reconnectContext && readProfile === this.reconnectContext?.profile &&
      readScope === reconnectOwnerScope(this) &&
      typeof rawPage.thread?.cwd === "string" && readScope === reconnectOwnerScope(this, rawPage.thread.cwd) &&
      typeof resumedThread?.cwd === "string" && readScope === reconnectOwnerScope(this, resumedThread.cwd) &&
      readAccessToken === readProfile.accessToken && readRpcToken === readProfile.rpcToken &&
      readClient === this.client && readGeneration === this.clientGeneration &&
      readArrivalOrdinal === this.transcriptArrivalOrdinal &&
      completedRevision === this.completedTranscriptRevision && allowsCompletedAbsencePrune(this);
    const authoritativeIds = new Set(rawMessages?.map(message => message.id));
    const authoritativeTurnIds = new Set(rawMessages?.flatMap(message => message.turnId ? [message.turnId] : []));
    const absentCompletedIds = new Set<string>();
    const currentRows = new Map(this.snapshot.messages.map(message => [message.id, message]));
    if (canPrune) for (const pair of candidatePairs) {
      if (currentRows.get(pair.user.id) !== pair.user ||
          currentRows.get(pair.assistant.id) !== pair.assistant ||
          this.attemptByTurn.get(pair.turnId) !== pair.attemptId ||
          !this.finishedAttempts.has(pair.attemptId) ||
          authoritativeIds.has(pair.user.id) || authoritativeIds.has(pair.assistant.id) ||
          authoritativeTurnIds.has(pair.turnId)) continue;
      absentCompletedIds.add(pair.user.id);
      absentCompletedIds.add(pair.assistant.id);
    }
    const unprovedHistory = transcriptReadIdentityKey(history) === null &&
      (this.snapshot.messages.length > 0 || Boolean(this.snapshot.beforeCursor));
    const messages = unprovedHistory ? this.snapshot.messages : mergeReconciledMessages(
      history.messages,
      continuousHistory ? this.snapshot.messages : historyResetTail(this.snapshot, history.messages)
        .filter(message => !absentCompletedIds.has(message.id)),
    );
    const retainedExpandedHistory =
      unprovedHistory || (continuousHistory && this.snapshot.messages.length > history.messages.length);
    if (!unprovedHistory) publishConfirmedHistoryPage(this, history.sourcePage, completedRevision,
      () => !this.disposed && this.snapshot.threadId === readThreadId && transcriptReadIdentityKey(this.snapshot) === readIdentity);
    this.unsubscribeRpc?.();
    this.unsubscribeRpc = null;
    this.client?.close();
    this.client = null;
    this.reconnectAttempt = 0;
    this.patch({
      title:
        historyThread?.title ?? resumedThread?.title ?? this.snapshot.title,
      cwd: historyThread?.cwd ?? resumedThread?.cwd ?? this.snapshot.cwd,
      model,
      reasoningEffort,
      configurationReady: !configurationPending,
      pendingTurnPreferences: undefined,
      metadataPending: [],
      metadataUnknown: [],
      archivedAt: historyThread?.archivedAt ?? resumedThread?.archivedAt,
      messages,
      transcriptSnapshotV1: unprovedHistory ? this.snapshot.transcriptSnapshotV1 : history.transcriptSnapshotV1,
      transcriptObservationV1: unprovedHistory ? this.snapshot.transcriptObservationV1 : history.transcriptObservationV1,
      hasMoreBefore: retainedExpandedHistory
        ? this.snapshot.hasMoreBefore
        : history.hasMoreBefore,
      beforeCursor: retainedExpandedHistory
        ? this.snapshot.beforeCursor
        : history.beforeCursor,
      loadingOlder: false,
      running,
      connected: true,
      connectionPhase: undefined,
      activeTurnId,
      interaction: null,
      error: unprovedHistory ? "连接已恢复，历史记录尚未确认；已保留现有记录，请重试或重新打开会话。" : null,
    });
    this.attachBufferedClient(nextClient, buffered);
    const client = nextClient;
    const generation = this.clientGeneration;
    if (this.workspaceConfiguration) {
      void this.restoreWorkspaceConfiguration(this.workspaceConfiguration.reasoningEffort, this.workspaceConfiguration.isCurrent);
    } else if (configurationPending && this.workspaceConfiguration === undefined) {
      void restoreReasoningEffortForThread(client, this.snapshot.threadId, model, reasoningEffort).then((restored) => {
        if (!this.disposed && this.clientGeneration === generation && !this.snapshot.pendingTurnPreferences && this.snapshot.model === model && this.snapshot.reasoningEffort === reasoningEffort)
          this.patch({ reasoningEffort: restored, configurationReady: true });
      });
    }
    this.metadataConfirmed.clear();
    buffered = null;
    nextClient = null;
  } catch (error) {
    buffered?.cancel();
    nextClient?.close();
    const context = this.reconnectContext;
    if (
      !nextClient &&
      context &&
      (await gatewaySessionExpired(context.profile))
    ) {
      if (this.disposed || this.reconnectContext !== context) return;
      this.reconnectContext = {
        ...context,
        profile: { ...context.profile, expiresAt: 0 },
      };
      this.reconnectRequested = false;
      this.markInteractionsDisconnected();
      context.onSessionExpired?.();
      this.patch({
        connected: false,
        running: false,
        interaction: null,
        error: "Gateway 会话已失效，请前往设置重新连接",
        connectionPhase: "reauthorization-required",
      });
      return;
    }
    if (this.disposed) return;
    this.reconnectAttempt += 1;
    this.markInteractionsDisconnected();
    this.patch({
      connected: false,
      running: false,
      error: `重新连接失败：${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    this.reconnecting = false;
  }
  if (this.snapshot.connected) {
    // Replay runs behind the reconnect gate. Publish new cards and reconcile
    // retained receipts only after that gate permits the original owner checks.
    for (const interaction of this.pendingInteractions) this.notifyInteractionChanged(interaction);
    this.publishInteractionProjection();
    void this.reconcilePendingInteractions(false);
    void this.refreshAsyncQuestions();
  }
  if (this.reconnectRequested || !this.snapshot.connected)
    this.scheduleReconnect("连接仍不可用");
}
