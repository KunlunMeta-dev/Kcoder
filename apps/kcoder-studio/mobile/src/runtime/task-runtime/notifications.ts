import { hasConflictingTurnIdentity } from "../../../../shared/turnNotificationIdentity";
import { refreshSharedTranscript } from './shared-transcript';
import { isApprovalResponse } from "../../../../shared/generated/contracts";
import { normalizeReviewEvidence } from "../../../../shared/reviewEvidence";
import { type RpcMessage } from "@/gateway/rpc";
import { decodeProviderFailure } from "../../../../shared/providerFailure";
import { normalizeTurnFileCapture } from "../../../../shared/turnFileCapture";
import { TaskRuntime } from "./core";
import { interactionServerIdentity } from "./threadDirectory";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { publishGoal } from "./goalProjection";
import { markTurnInteractionsEnded, matchesInteractionSelector, selectorForInteraction } from "./interactions";
import type { PendingInteraction, ThreadGoal } from "./types";
import {
  fileChangesFromValue,
  numberValue,
  record,
  text,
  turnIdFrom,
} from "./normalizers";

export function handleRpc(this: TaskRuntime, message: RpcMessage): void {
  const params = record(message.params);
  if (hasConflictingTurnIdentity(message)) return;
  // Legacy transports may bypass Gateway fences. Reused task/turn IDs cannot
  // bind a foreign producer or request envelope to this connection's input.
  // Reject before observers and replay tracking; omitted legacy IDs stay valid.
  if (["asyncQuestion/changed", "question/resolved", "approval/resolved", "turn/started", "turn/completed"].includes(message.method ?? "") &&
      (message.id !== undefined || (params.serverId !== undefined &&
        params.serverId !== this.client?.getAppServerId()))) return;
  // Legacy transports can bypass the Gateway's terminal-outcome validation.
  // Invalid outcomes must not close a card or claim its recovery replay ID.
  if ((message.method === "question/resolved" || message.method === "approval/resolved") &&
      (typeof params.reason !== "string" ||
        (message.method === "approval/resolved" && params.decision !== undefined &&
          !isApprovalResponse({ decision: params.decision })))) return;
  // Turn IDs are task-local. Reject conflicting task identities before replay
  // tracking or a peer's terminal event can close this task's question input.
  if ((message.method === "turn/started" || message.method === "turn/completed") &&
      ([params.threadId, record(params.turn).threadId].some(threadId =>
        threadId !== undefined && threadId !== this.snapshot.threadId) ||
      [params.thread_id, record(params.thread).threadId, record(params.thread).id,
        record(params.widget).threadId].some(threadId =>
        threadId != null && threadId !== this.snapshot.threadId))) return;
  if (
    message.id == null &&
    !this.notificationReplayGuard.accept(message.method ?? "", params)
  )
    return;
  try {
    this.handleAcceptedRpc(message);
  } catch (error) {
    this.notificationReplayGuard.release(message.method ?? "", params);
    throw error;
  }
}

export function handleAcceptedRpc(
  this: TaskRuntime,
  message: RpcMessage,
): void {
  const originalClient = this.client;
  const originalGeneration = this.clientGeneration;
  const arrivalOrdinal = this.transcriptArrivalOrdinal++;
  const params = record(message.params);
  const disconnected = message.method === "connection/closed" ||
    message.method === "server/disconnected" || message.method === "server/transportError";
  // Revoke input before protocol observers or reconnect's interaction projection
  // can synchronously dispatch through the still-open Gateway transport.
  if (disconnected) this.patch({ connected: false });
  for (const listener of this.protocolListeners) listener(message);
  // Observers can synchronously close or replace this connection. An old frame
  // must not acquire the replacement's owner or consume its recovery replay.
  if (this.disposed || this.client !== originalClient || this.clientGeneration !== originalGeneration) {
    this.notificationReplayGuard.release(message.method ?? "", params);
    return;
  }
  if (message.method === 'gateway/interaction/replyRejected' && params.threadId === this.snapshot.threadId &&
      typeof params.requestId === 'number') {
    const candidates = this.pendingInteractions.filter(interaction =>
      interaction.requestId === params.requestId && interaction.owner.threadId === params.threadId);
    // New Gateways carry the complete original binding. Partial or stale
    // bindings cannot unlock a different request that reused its transport ID.
    const bound = ["turnId", "appServerEpoch", "questionId", "approvalId"]
      .some(key => Object.hasOwn(params, key));
    const matches = bound ? candidates.filter(interaction =>
      interaction.owner.turnId === params.turnId &&
      (interaction.owner.appServerEpoch ?? null) === (params.appServerEpoch ?? null) &&
      (interaction.kind === "question"
        ? interaction.questionId === params.questionId && params.approvalId === undefined
        : interaction.approvalId === params.approvalId && params.questionId === undefined)) : candidates;
    // Legacy notifications can recover only an unambiguous local request.
    const interaction = matches.length === 1 ? matches[0] : undefined;
    if (interaction && interaction.owner.originClientGeneration === this.clientGeneration) {
      // A fully bound turn-ended refusal closes this exact request even if its
      // terminal event was missed. Preserve the unknown receipt for reconciliation.
      if (bound && params.reason === "turn_ended") {
        this.pendingInteractions = this.pendingInteractions.map(item => item === interaction
          ? { ...item, turnEnded: true } : item);
        // Its unknown receipt must not keep obsolete focus over another card.
        if (this.focusedInteractionSelector &&
            matchesInteractionSelector(interaction, this.focusedInteractionSelector))
          this.focusInteraction(null);
      }
      this.markInteractionResponding(selectorForInteraction(interaction), false);
    }
    return;
  }
  // App-server loss revokes task input before the Gateway socket finishes closing.
  if (disconnected) {
    this.scheduleReconnect(text(params.reason) ?? "连接已断开");
    return;
  }
  if (message.method === "asyncQuestion/changed") {
    this.handleAsyncQuestionChanged(params);
    return;
  }
  if (typeof message.id === "number" && message.method === "approval/request") {
    const owner = interactionOwner(this, params);
    const approvalId = text(params.approvalId);
    if (!owner || !approvalId?.trim()) return;
    this.enqueueInteraction({
      kind: "approval",
      requestId: message.id,
      approvalId,
      reason: text(params.reason) ?? "KCoder 请求执行此操作",
      action: record(params.action),
      availableDecisions: Array.isArray(params.availableDecisions)
        ? params.availableDecisions.filter(
            (
              value,
            ): value is
              "accept" | "accept_for_session" | "decline" | "cancel" =>
              value === "accept" ||
              value === "accept_for_session" ||
              value === "decline" ||
              value === "cancel",
          )
        : undefined,
      owner,
    });
    return;
  }
  if (typeof message.id === "number" && message.method === "question/request") {
    const owner = interactionOwner(this, params);
    const questionId = text(params.questionId);
    if (!owner || !questionId?.trim()) return;
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const sourceAgentValue = params.sourceAgent;
    const sourceAgent = record(sourceAgentValue);
    const sourceAgentId = text(sourceAgent.agentId);
    const sourceAgentParent = text(sourceAgent.parentSessionId);
    const hasSourceAgent = sourceAgentValue !== undefined && sourceAgentValue !== null;
    const hasBackgroundRun = sourceAgent.backgroundRun !== undefined && sourceAgent.backgroundRun !== null;
    const backgroundRun = record(sourceAgent.backgroundRun);
    const sourceAgentValid = !hasSourceAgent || Boolean(
      sourceAgentId?.trim() && sourceAgentParent === this.snapshot.threadId &&
      (!hasBackgroundRun || (text(backgroundRun.runId)?.trim() &&
        backgroundRun.parentSessionId === sourceAgentParent && backgroundRun.agentId === sourceAgentId)),
    );
    this.enqueueInteraction({
      kind: "question",
      requestId: message.id,
      questionId,
      ...(hasSourceAgent && sourceAgentValid
        ? {
            sourceAgent: {
              agentId: sourceAgentId!,
              parentSessionId: this.snapshot.threadId,
              ...(hasBackgroundRun ? { backgroundRun } : {}),
            },
          }
        : {}),
      questions: questions.map((value, index) => {
        const question = record(value);
        return {
          id: text(question.id) ?? `question-${index + 1}`,
          header: text(question.header) ?? "问题",
          prompt: text(question.prompt) ?? "请选择",
          options: (Array.isArray(question.options)
            ? question.options
            : []
          ).map((option) => {
            const item = record(option);
            return {
              label: text(item.label) ?? text(item.value) ?? "选项",
              value: text(item.value) ?? text(item.label) ?? "",
              description: text(item.description),
            };
          }),
          allowsFreeform: question.allowsFreeform !== false,
          multiSelect: question.multiSelect === true,
        };
      }),
      ...(hasSourceAgent && !sourceAgentValid ? { sourceBindingConflict: true as const } : {}),
      owner: hasSourceAgent && !sourceAgentValid
        ? { ...owner, status: "unsupported" }
        : owner,
    });
    return;
  }
  if (
    message.method === "approval/resolved" ||
    message.method === "question/resolved"
  ) {
    const resolved = this.resolveInteraction(
      message.method === "approval/resolved" ? "approval" : "question",
      params,
    );
    // Only a projected receipt consumes its sequenced replay identity. A stale
    // binding must leave the authoritative recovery receipt eligible.
    if (!resolved) this.notificationReplayGuard.release(message.method, params);
    return;
  }
  if (message.method === "thread/goal/updated") {
    if (params.threadId !== this.snapshot.threadId) return;
    const goal = params.goal;
    if (goal === null) publishGoal(this, null);
    else if (goal && typeof goal === "object" && !Array.isArray(goal) &&
      typeof record(goal).objective === "string" && typeof record(goal).revision === "number")
      publishGoal(this, goal as unknown as ThreadGoal);
    return;
  }
  if (message.method === "thread/goal/continuation") {
    if (params.threadId !== this.snapshot.threadId || !text(params.status)) return;
    this.patch({ goalContinuation: { status: text(params.status)!, reason: text(params.reason) } });
    return;
  }
  if (message.method === "turn/started") {
    refreshSharedTranscript(this, "started", turnIdFrom(message));
    this.flushPendingDeltas();
    const turnId = turnIdFrom(message);
    const attemptId =
      text(params.attemptId) ?? text(record(params.turn).attemptId) ?? turnId;
    this.attemptByTurn.set(turnId, attemptId);
    if (Number.isSafeInteger(params.sequence))
      this.attemptSequence.set(turnId, Number(params.sequence));
    if (this.attemptByTurn.size > 256) {
      const first = this.attemptByTurn.keys().next().value!;
      this.attemptByTurn.delete(first);
      this.attemptSequence.delete(first);
    }
    const messages = this.snapshot.messages.map((item) =>
      item.role === "assistant" &&
      item.turnId === turnId &&
      item.status === "failed" &&
      !item.continuedByAttemptId &&
      (item.attemptId ?? turnId) !== attemptId
        ? { ...item, continuedByAttemptId: attemptId }
        : item,
    );
    this.patch({
      running: true,
      activeTurnId: turnId,
      messages,
      error: null,
      continuationUnknown: null,
    });
    return;
  }
  const eventTurn = turnIdFrom(message);
  const floor = this.attemptSequence.get(eventTurn);
  if (
    floor !== undefined &&
    Number.isSafeInteger(params.sequence) &&
    Number(params.sequence) < floor
  )
    return;
  if (message.method === "item/delta") {
    const delta = text(record(params.delta).text);
    if (!delta) return;
    this.appendAssistantDelta(
      turnIdFrom(message),
      delta,
      text(params.itemId),
      numberValue(params.sequence),
      arrivalOrdinal,
    );
    return;
  }
  if (message.method === "agent/steer/applied") {
    const agentId = text(params.agentId);
    const messageId = text(params.messageId);
    if (agentId && messageId) {
      this.updateSubagentSteer(
        agentId,
        "applied",
        messageId,
        text(params.clientMessageId),
        numberValue(params.sequence),
        arrivalOrdinal,
      );
    }
    return;
  }
  if (message.method === "item/event") {
    const event = record(params.event);
    if (event.type === "assistant_thinking_delta") {
      const delta = text(event.text);
      if (delta)
        this.appendThinkingDelta(
          turnIdFrom(message),
          delta,
          numberValue(params.sequence),
          arrivalOrdinal,
        );
      return;
    }
    this.updateActivity(
      turnIdFrom(message),
      event,
      numberValue(params.sequence),
      arrivalOrdinal,
    );
    return;
  }
  if (message.method === "item/started") {
    refreshSharedTranscript(this, "progress", turnIdFrom(message));
    this.flushPendingDeltas();
    const item = record(params.item);
    if (item.type === "agentMessage") {
      this.updateAssistantItem(
        turnIdFrom(message),
        item,
        numberValue(params.sequence),
        false,
        arrivalOrdinal,
      );
    } else if (item.type === "toolCall") {
      if (text(item.name)?.toLowerCase() === "todowrite")
        this.updateTodos(turnIdFrom(message), item);
      else
        this.updateTool(
          turnIdFrom(message),
          item,
          false,
          numberValue(params.sequence),
          arrivalOrdinal,
        );
    }
    return;
  }
  if (message.method === "item/completed") {
    this.flushPendingDeltas();
    const item = record(params.item);
    if (item.type === "agentMessage")
      this.updateAssistantItem(
        turnIdFrom(message),
        item,
        numberValue(params.sequence),
        true,
        arrivalOrdinal,
      );
    else if (
      item.type === "toolCall" &&
      text(item.name)?.toLowerCase() !== "todowrite"
    )
      this.updateTool(
        turnIdFrom(message),
        item,
        true,
        numberValue(params.sequence),
        arrivalOrdinal,
      );
    return;
  }
  if (message.method === "turn/completed") {
    refreshSharedTranscript(this, "completed", turnIdFrom(message));
    const turnId = turnIdFrom(message);
    const turn = record(params.turn);
    const attemptId =
      text(turn.attemptId) ?? this.attemptByTurn.get(turnId) ?? turnId;
    if (
      this.attemptByTurn.has(turnId) &&
      this.attemptByTurn.get(turnId) !== attemptId
    )
      return;
    this.flushPendingDeltas();
    this.attemptByTurn.set(turnId, attemptId);
    if (!this.finishedAttempts.has(attemptId)) this.completedTranscriptRevision++;
    this.finishedAttempts.add(attemptId);
    if (this.finishedAttempts.size > 256)
      this.finishedAttempts.delete(
        this.finishedAttempts.values().next().value!,
      );
    markTurnInteractionsEnded(this, turnId);
    const error = text(record(params.error).message);
    const providerFailure = decodeProviderFailure(record(params.error).details);
    const messages = [...this.snapshot.messages];
    const index = this.ensureAssistantMessage(messages, turnId);
    const cancelled = ["interrupted", "cancelled"].includes(
      String(turn.status),
    );
    const status =
      cancelled
        ? "cancelled"
        : turn.status === "failed" || error
          ? "failed"
          : "completed";
    const fileChanges = fileChangesFromValue(
      params.fileChanges ?? params.file_changes,
    );
    const assistant = { ...messages[index] };
    if (cancelled) {
      delete assistant.error;
      delete assistant.providerFailure;
    }
    messages[index] = {
      ...assistant,
      tools: assistant.tools?.map(tool => tool.status === "running" ? { ...tool, status: "unknown" as const } : tool),
      orderedBlocks: assistant.orderedBlocks?.map(block => block.kind === "tool" && block.status === "running" ? { ...block, status: "unknown" as const } : block),
      status,
      attemptId,
      ...(!cancelled && providerFailure ? { providerFailure } : {}),
      ...(!cancelled && error ? { error } : {}),
      ...(fileChanges ? { fileChanges } : {}),
      fileChangesCapture: normalizeTurnFileCapture(params.fileChangesCapture, { threadId: this.snapshot.threadId, turnId, attemptId }),
      reviewEvidence: normalizeReviewEvidence(params.reviewEvidence, { threadId: this.snapshot.threadId, turnId, attemptId }) ?? assistant.reviewEvidence,
    };
    if (this.snapshot.activeTurnId && this.snapshot.activeTurnId !== turnId) {
      this.patch({ messages });
      return;
    }
    this.patch({
      messages,
      running: false,
      activeTurnId: null,
      interaction: null,
      interactionCount: 0,
      error: cancelled ? null : (error ?? null),
    });
    void this.reconcilePendingInteractions(true);
  }
}

function interactionOwner(
  runtime: TaskRuntime,
  params: Record<string, unknown>,
): PendingInteraction["owner"] | null {
  const context = runtime.reconnectContext;
  if (!context) return null;
  const appServerId = runtime.client?.getAppServerId() ?? null;
  const threadId = text(params.threadId);
  const turnId = text(params.turnId);
  if (!appServerId || params.serverId !== appServerId ||
      !threadId || threadId !== runtime.snapshot.threadId || !turnId) return null;
  const appServerEpoch = text(params.appServerEpoch) ?? null;
  return {
    profileId: context.profile.id,
    profileAuthorizationScopeKey: profileAuthorizationScopeKey(context.profile),
    serverId: context.server.id,
    appServerId,
    serverConfigIdentity: interactionServerIdentity(context.server),
    threadId,
    turnId,
    appServerEpoch,
    runtimeInstanceNonce: runtime.runtimeInstanceNonce,
    profileActivationEpoch: context.profileActivationEpoch ?? -1,
    originClientGeneration: runtime.clientGeneration,
    status: appServerEpoch && turnId ? "pending" : "unsupported",
  };
}
