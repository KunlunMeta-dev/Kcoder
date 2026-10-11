import { gatewaySessionExpired, ensureGatewayAuthorization } from "@/gateway/http";
import { GatewayRpcClient } from "@/gateway/rpc";
import type { ThreadSummary } from "@/gateway/types";
import { gatewayReconnectDelay } from "../../../../shared/gatewayConnectionBudget";
import {
  parseThreadRunSummary,
  threadRunActivity,
  threadRunSummaryIsActive,
} from "../../../../shared/threadRunSummary";
import { taskClientConnector } from "./connectionFactory";
import { TaskRuntime } from "./core";
import {
  historiesOverlap,
  inlineResumeHistoryPage,
  mergeReconciledMessages,
  normalizeHistoryPage,
  readHistoryPage,
} from "./history";
import {
  restoreReasoningEffortForThread,
  threadModelSelector,
} from "./modelCatalog";
import { bufferNotifications } from "./notificationBuffer";
import { type BufferedSubscription } from "./types";

export function close(this: TaskRuntime): void {
  if (this.closeComplete) return;
  if (!this.disposed) this.clientGeneration += 1;
  this.disposed = true; // Fence new work even when releasing one resource must be retried.
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
    this.patch({ connected: false, running: false, activeTurnId: null, interaction: null, interactionCount: 0 });
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
  this.unsubscribeRpc = client.subscribe((message) => this.handleRpc(message));
}

export function attachBufferedClient(
  this: TaskRuntime,
  client: GatewayRpcClient,
  buffered: BufferedSubscription,
): void {
  this.unsubscribeRpc?.();
  this.client = client;
  this.clientGeneration += 1;
  this.unsubscribeRpc = buffered.activate((message) => this.handleRpc(message));
}

export function scheduleReconnect(this: TaskRuntime, reason: string): void {
  if (this.disposed || !this.reconnectContext || this.reconnectTimer) return;
  if (this.reconnecting) {
    this.reconnectRequested = true;
    this.patch({
      connected: false,
      running: false,
      error: `${reason}，正在重新连接…`,
    });
    return;
  }
  if (
    this.reconnectAttempt >= 8 &&
    Date.now() < this.reconnectContext.profile.expiresAt
  ) {
    this.pendingInteractions = [];
    this.patch({
      connected: false,
      running: false,
      interaction: null,
      error: "目标连接失败，已停止自动重连。可重试连接；其他目标仍保持登录。",
    });
    return;
  }
  if (Date.now() >= this.reconnectContext.profile.expiresAt && !this.reconnectContext.profile.refreshToken) {
    this.reconnectContext.onSessionExpired?.();
    this.pendingInteractions = [];
    this.patch({
      connected: false,
      running: false,
      interaction: null,
      error: "Gateway 会话已失效，请前往设置重新连接",
    });
    return;
  }
  const delayMs = gatewayReconnectDelay(
    Math.min(500 * 2 ** this.reconnectAttempt, 8_000),
  );
  this.pendingInteractions = [];
  this.patch({
    connected: false,
    running: false,
    interaction: null,
    error: `${reason}，正在重新连接…`,
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
  )
    throw new Error("Gateway 会话已失效，请前往设置重新连接");
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
      ? normalizeHistoryPage(inlinePage)
      : await readHistoryPage(nextClient, this.snapshot.threadId);
    if (this.disposed) {
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
    const configurationPending = Boolean(model && reasoningEffort);
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
      historiesOverlap(history.messages, this.snapshot.messages) &&
      ((!nextClient.supportsExperimental?.("threadIndexedPagesV1") &&
        !this.snapshot.beforeCursor?.startsWith("tp1:") &&
        !history.beforeCursor?.startsWith("tp1:")) ||
        (nextClient.supportsExperimental?.("threadIndexedPagesV1") &&
          this.snapshot.beforeCursor?.startsWith("tp1:") === true &&
          history.beforeCursor?.startsWith("tp1:") === true &&
          this.snapshot.beforeCursor.split(":")[1] ===
            history.beforeCursor.split(":")[1]));
    const newestTimestamp = history.messages.at(-1)?.timestampMs ?? 0;
    const optimisticTail = this.snapshot.messages.filter(
      (message) =>
        message.id.startsWith("local-") &&
        message.timestampMs >= newestTimestamp,
    );
    const messages = mergeReconciledMessages(
      history.messages,
      continuousHistory ? this.snapshot.messages : optimisticTail,
    );
    const retainedExpandedHistory =
      continuousHistory &&
      this.snapshot.messages.length > history.messages.length;
    this.unsubscribeRpc?.();
    this.unsubscribeRpc = null;
    this.client?.close();
    this.client = null;
    this.reconnectAttempt = 0;
    this.pendingInteractions = [];
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
      hasMoreBefore: retainedExpandedHistory
        ? this.snapshot.hasMoreBefore
        : history.hasMoreBefore,
      beforeCursor: retainedExpandedHistory
        ? this.snapshot.beforeCursor
        : history.beforeCursor,
      loadingOlder: false,
      running,
      connected: true,
      activeTurnId,
      interaction: null,
      error: null,
    });
    this.attachBufferedClient(nextClient, buffered);
    const client = nextClient;
    const generation = this.clientGeneration;
    if (configurationPending) {
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
      this.pendingInteractions = [];
      context.onSessionExpired?.();
      this.patch({
        connected: false,
        running: false,
        interaction: null,
        error: "Gateway 会话已失效，请前往设置重新连接",
      });
      return;
    }
    if (this.disposed) return;
    this.reconnectAttempt += 1;
    this.patch({
      connected: false,
      running: false,
      error: `重新连接失败：${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    this.reconnecting = false;
  }
  if (this.reconnectRequested || !this.snapshot.connected)
    this.scheduleReconnect("连接仍不可用");
}
