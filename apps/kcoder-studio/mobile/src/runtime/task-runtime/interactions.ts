import type {
  InteractionStatusReadParamsV1,
  InteractionStatusReadResultV1,
} from "../../../../shared/generated/contracts";
import { type JsonRecord } from "@/gateway/rpc";
import { t } from "@/i18n";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { interactionServerIdentity } from "./threadDirectory";
import { TaskRuntime } from "./core";
import { text } from "./normalizers";
import {
  type ApprovalInteraction,
  type InteractionReceiptStatus,
  type InteractionSelector,
  type PendingInteraction,
  type QuestionInteraction,
  type SourceAgent,
} from "./types";

const interactionId = (interaction: PendingInteraction): string =>
  interaction.kind === "approval"
    ? interaction.approvalId
    : interaction.questionId;

export function selectorForInteraction(
  interaction: PendingInteraction,
): InteractionSelector {
  return {
    kind: interaction.kind,
    requestId: interaction.requestId,
    interactionId: interactionId(interaction),
    serverId: interaction.owner.serverId,
    appServerId: interaction.owner.appServerId,
    serverConfigIdentity: interaction.owner.serverConfigIdentity,
    profileId: interaction.owner.profileId,
    profileAuthorizationScopeKey: interaction.owner.profileAuthorizationScopeKey,
    threadId: interaction.owner.threadId,
    turnId: interaction.owner.turnId,
    appServerEpoch: interaction.owner.appServerEpoch,
    runtimeInstanceNonce: interaction.owner.runtimeInstanceNonce,
    profileActivationEpoch: interaction.owner.profileActivationEpoch,
    originClientGeneration: interaction.owner.originClientGeneration,
  };
}

export function matchesInteractionSelector(
  interaction: PendingInteraction,
  selector: InteractionSelector,
): boolean {
  return interaction.kind === selector.kind &&
    interaction.requestId === selector.requestId &&
    interactionId(interaction) === selector.interactionId &&
    interaction.owner.serverId === selector.serverId &&
    interaction.owner.appServerId === selector.appServerId &&
    interaction.owner.serverConfigIdentity === selector.serverConfigIdentity &&
    interaction.owner.profileId === selector.profileId &&
    interaction.owner.profileAuthorizationScopeKey === selector.profileAuthorizationScopeKey &&
    interaction.owner.threadId === selector.threadId &&
    interaction.owner.turnId === selector.turnId &&
    interaction.owner.appServerEpoch === selector.appServerEpoch &&
    interaction.owner.runtimeInstanceNonce === selector.runtimeInstanceNonce &&
    interaction.owner.profileActivationEpoch === selector.profileActivationEpoch &&
    interaction.owner.originClientGeneration === selector.originClientGeneration;
}

function sameReceiptTuple(
  left: PendingInteraction,
  right: PendingInteraction,
): boolean {
  return left.kind === right.kind &&
    left.requestId === right.requestId &&
    interactionId(left) === interactionId(right) &&
    left.owner.profileAuthorizationScopeKey === right.owner.profileAuthorizationScopeKey &&
    left.owner.serverId === right.owner.serverId &&
    left.owner.appServerId === right.owner.appServerId &&
    left.owner.serverConfigIdentity === right.owner.serverConfigIdentity &&
    left.owner.threadId === right.owner.threadId &&
    left.owner.turnId === right.owner.turnId &&
    left.owner.appServerEpoch === right.owner.appServerEpoch;
}

function sameStatusTuple(
  interaction: PendingInteraction,
  result: InteractionStatusReadResultV1,
): boolean {
  const owner = interaction.owner;
  return owner.appServerEpoch === result.appServerEpoch &&
    owner.appServerId === result.serverId &&
    owner.threadId === result.threadId &&
    owner.turnId === result.turnId &&
    interaction.requestId === result.requestId &&
    interaction.kind === result.kind &&
    (interaction.kind === "approval"
      ? result.approvalId === interaction.approvalId && result.questionId == null
      : result.questionId === interaction.questionId && result.approvalId == null);
}

function queryForInteraction(
  interaction: PendingInteraction,
): InteractionStatusReadParamsV1 | null {
  const owner = interaction.owner;
  if (!owner.appServerEpoch || !owner.turnId || !owner.appServerId || !owner.threadId)
    return null;
  return {
    appServerEpoch: owner.appServerEpoch,
    serverId: owner.appServerId,
    threadId: owner.threadId,
    turnId: owner.turnId,
    requestId: interaction.requestId,
    kind: interaction.kind,
    ...(interaction.kind === "approval"
      ? { approvalId: interaction.approvalId }
      : { questionId: interaction.questionId }),
  };
}

function currentOwnerMatches(
  runtime: TaskRuntime,
  interaction: PendingInteraction,
): boolean {
  const context = runtime.reconnectContext;
  const owner = interaction.owner;
  return Boolean(context && owner.runtimeInstanceNonce === runtime.runtimeInstanceNonce &&
    owner.profileId === context.profile.id &&
    owner.profileAuthorizationScopeKey === profileAuthorizationScopeKey(context.profile) &&
    owner.serverId === context.server.id &&
    runtime.client?.getAppServerId() === owner.appServerId &&
    owner.serverConfigIdentity === interactionServerIdentity(context.server) &&
    owner.threadId === runtime.snapshot.threadId &&
    owner.profileActivationEpoch === (context.profileActivationEpoch ?? -1) &&
    context.isCurrentInteractionOwner?.(owner) === true);
}

function isActionable(
  runtime: TaskRuntime,
  interaction: PendingInteraction,
): boolean {
  return Boolean(runtime.client && runtime.client.isTransportOpen() &&
    !runtime.disposed && !runtime.reconnecting && runtime.snapshot.connected &&
    !interaction.turnEnded &&
    !(interaction.kind === "question" && interaction.sourceBindingConflict) &&
    interaction.owner.appServerEpoch && interaction.owner.turnId &&
    interaction.owner.status === "pending" &&
    runtime.client.getAppServerId() === interaction.owner.appServerId &&
    interaction.owner.originClientGeneration === runtime.clientGeneration &&
    currentOwnerMatches(runtime, interaction) &&
    runtime.pendingInteractions.filter((item) => item.requestId === interaction.requestId).length === 1);
}

function projectedInteraction(
  runtime: TaskRuntime,
): PendingInteraction | null {
  if (runtime.focusedInteractionSelector) {
    const focused = runtime.pendingInteractions.find((item) =>
      matchesInteractionSelector(item, runtime.focusedInteractionSelector!),
    );
    return focused && isActionable(runtime, focused) ? focused : null;
  }
  return runtime.pendingInteractions.find((item) => isActionable(runtime, item)) ?? null;
}

export function publishInteractionProjection(runtime: TaskRuntime): void {
  const actionableCount = runtime.pendingInteractions.filter((item) =>
    isActionable(runtime, item),
  ).length;
  runtime.patch({
    interaction: projectedInteraction(runtime),
    interactionCount: actionableCount,
  });
}

function findSelectedInteraction(
  runtime: TaskRuntime,
  selector?: InteractionSelector,
): PendingInteraction | null {
  if (selector)
    return runtime.pendingInteractions.find((item) =>
      matchesInteractionSelector(item, selector),
    ) ?? null;
  return runtime.snapshot.interaction;
}

function requireActionable(
  runtime: TaskRuntime,
  interaction: PendingInteraction | null,
  selector?: InteractionSelector,
): asserts interaction is PendingInteraction {
  if (!interaction || interaction.responding || !isActionable(runtime, interaction))
    throw new Error(selector
      ? "此请求已失效或当前连接只支持核对，请返回收件箱刷新。"
      : "当前连接不可处理此请求，请返回收件箱核对状态。");
}

function captureActionOwner(runtime: TaskRuntime, interaction: PendingInteraction): {
  client: NonNullable<TaskRuntime["client"]>;
  generation: number;
  runtimeInstanceNonce: number;
  selector: InteractionSelector;
} {
  const client = runtime.client;
  if (!client) throw new Error("当前连接不可处理此请求，请返回收件箱核对状态。");
  return {
    client,
    generation: runtime.clientGeneration,
    runtimeInstanceNonce: runtime.runtimeInstanceNonce,
    selector: selectorForInteraction(interaction),
  };
}

function revalidateActionOwner(
  runtime: TaskRuntime,
  captured: ReturnType<typeof captureActionOwner>,
): PendingInteraction {
  const current = runtime.pendingInteractions.find((item) =>
    matchesInteractionSelector(item, captured.selector),
  );
  if (runtime.client !== captured.client || runtime.clientGeneration !== captured.generation ||
      runtime.runtimeInstanceNonce !== captured.runtimeInstanceNonce || runtime.disposed ||
      runtime.reconnecting || !captured.client.isTransportOpen() || !current ||
      !isActionable(runtime, current))
    throw new Error("此请求的原连接已失效，请返回收件箱核对状态。");
  return current;
}

export function respondApproval(
  this: TaskRuntime,
  decision: "accept" | "accept_for_session" | "decline" | "cancel",
  selector?: InteractionSelector,
): void {
  const interaction = findSelectedInteraction(this, selector);
  if (interaction?.kind !== "approval") {
    if (selector) requireActionable(this, null, selector);
    return;
  }
  requireActionable(this, interaction, selector);
  const captured = captureActionOwner(this, interaction);
  this.markInteractionResponding(captured.selector);
  try {
    revalidateActionOwner(this, captured);
    captured.client.respond(interaction.requestId, { decision });
  } catch (error) {
    this.markInteractionResponding(captured.selector, false);
    throw error;
  }
}

function snapshotQuestionAnswers(
  interaction: QuestionInteraction,
  answers: Record<string, string[]>,
): Record<string, { answers: string[] }> {
  const itemIds = new Set(interaction.questions.map((question) => question.id));
  // Validate before copying: spreading a string would silently turn one answer
  // into character selections, while invalid values could leave the card busy.
  if (!answers || typeof answers !== "object" || Array.isArray(answers) ||
      Object.entries(answers).some(([id, values]) => !itemIds.has(id) ||
        !Array.isArray(values) || values.some((value) => typeof value !== "string")))
    throw new Error(t("task.question_answer_items_mismatch"));
  // Busy-state observers run synchronously. Fix the validated payload before
  // publishing so draft edits cannot change its item IDs or answer arrays.
  return Object.fromEntries(
    Object.entries(answers).map(([id, values]) => [id, { answers: [...values] }]),
  );
}

export function respondQuestions(
  this: TaskRuntime,
  answers: Record<string, string[]>,
  selector?: InteractionSelector,
): void {
  const interaction = findSelectedInteraction(this, selector);
  if (interaction?.kind !== "question") {
    if (selector) requireActionable(this, null, selector);
    return;
  }
  requireActionable(this, interaction, selector);
  const responseAnswers = snapshotQuestionAnswers(interaction, answers);
  const captured = captureActionOwner(this, interaction);
  this.markInteractionResponding(captured.selector);
  try {
    revalidateActionOwner(this, captured);
    captured.client.respond(interaction.requestId, {
      answers: responseAnswers,
    });
  } catch (error) {
    this.markInteractionResponding(captured.selector, false);
    throw error;
  }
}

/** Source questions share the reply ledger; ignoring one cannot cancel its parent. */
export function respondAgentQuestions(
  this: TaskRuntime,
  agentId: string,
  requestId: number,
  answers: Record<string, string[]>,
  ignored?: boolean,
  selector?: InteractionSelector,
): void {
  if (ignored === undefined) ignored = false;
  const interaction = selector
    ? this.pendingInteractions.find((item) => matchesInteractionSelector(item, selector))
    : this.pendingInteractions.find((item) => item.kind === "question" && item.requestId === requestId);
  if (
    !this.client ||
    interaction?.kind !== "question" ||
    interaction.requestId !== requestId ||
    interaction.responding ||
    interaction.sourceAgent?.agentId !== agentId ||
    interaction.sourceAgent.parentSessionId !== this.snapshot.threadId
  ) {
    throw new Error("子代理问题已经失效，请刷新后重试");
  }
  requireActionable(this, interaction, selector);
  const responseAnswers = snapshotQuestionAnswers(interaction, answers);
  const captured = captureActionOwner(this, interaction);
  this.markInteractionResponding(captured.selector);
  try {
    revalidateActionOwner(this, captured);
    captured.client.respond(requestId, {
      answers: responseAnswers,
      ...(ignored ? { annotations: { ignored: true } } : {}),
    });
  } catch (error) {
    this.markInteractionResponding(captured.selector, false);
    throw error;
  }
}

export function cancelQuestions(
  this: TaskRuntime,
  selector?: InteractionSelector,
): void {
  const interaction = findSelectedInteraction(this, selector);
  if (interaction?.kind !== "question") {
    if (selector) requireActionable(this, null, selector);
    return;
  }
  requireActionable(this, interaction, selector);
  const captured = captureActionOwner(this, interaction);
  this.markInteractionResponding(captured.selector);
  try {
    revalidateActionOwner(this, captured);
    captured.client.respondError(
      interaction.requestId,
      -32800,
      "the user cancelled the question request",
    );
  } catch (error) {
    this.markInteractionResponding(captured.selector, false);
    throw error;
  }
}

function sameQuestionSource(left: SourceAgent | undefined, right: SourceAgent | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.parentSessionId !== right.parentSessionId || left.agentId !== right.agentId) return false;
  const leftRun = left.backgroundRun;
  const rightRun = right.backgroundRun;
  if (!leftRun || !rightRun) return leftRun === rightRun;
  return leftRun.parentSessionId === rightRun.parentSessionId &&
    leftRun.agentId === rightRun.agentId && leftRun.runId === rightRun.runId;
}

export function enqueueInteraction(
  this: TaskRuntime,
  interaction: PendingInteraction,
): void {
  if (this.interactionLedgerObserver?.wasResolved(interaction)) return;
  const turnId = interaction.owner.turnId;
  if (turnId && this.finishedAttempts.has(this.attemptByTurn.get(turnId) ?? turnId))
    interaction = { ...interaction, turnEnded: true };
  const retainedOwner = this.interactionLedgerObserver?.ownerFor(interaction);
  if (retainedOwner) interaction = { ...interaction, owner: retainedOwner } as PendingInteraction;
  const existing = this.pendingInteractions.findIndex((item) =>
    sameReceiptTuple(item, interaction),
  );
  if (existing >= 0) {
    const previous = this.pendingInteractions[existing]!;
    const sourceBindingConflict = previous.kind === "question" && interaction.kind === "question" &&
      (previous.sourceBindingConflict || interaction.sourceBindingConflict ||
        !sameQuestionSource(previous.sourceAgent, interaction.sourceAgent));
    const firstOwner = previous.owner;
    // A replay cannot redefine the prompt/options or approved action behind an
    // existing answer. Keep its original content and in-flight reply state.
    this.pendingInteractions[existing] = {
      ...previous,
      owner: sourceBindingConflict ? { ...firstOwner, status: "unsupported" } : firstOwner,
      ...(sourceBindingConflict ? { sourceBindingConflict: true } : {}),
      ...(interaction.turnEnded ? { turnEnded: true } : {}),
    } as PendingInteraction;
  } else this.pendingInteractions.push(interaction);
  publishInteractionProjection(this);
  this.notifyInteractionChanged(this.pendingInteractions[existing >= 0 ? existing : this.pendingInteractions.length - 1]!);
}

export function markTurnInteractionsEnded(runtime: TaskRuntime, turnId: string): void {
  let releaseFocus = false;
  runtime.pendingInteractions = runtime.pendingInteractions.map((interaction) => {
    if (interaction.owner.turnId !== turnId || !currentOwnerMatches(runtime, interaction))
      return interaction;
    // Retaining an unknown receipt must not retain its obsolete composer focus.
    if (runtime.focusedInteractionSelector &&
        matchesInteractionSelector(interaction, runtime.focusedInteractionSelector))
      releaseFocus = true;
    return { ...interaction, turnEnded: true };
  });
  // Keep missing interaction receipts available for reconciliation. A turn
  // ending proves input has closed, not whether an answer was accepted.
  if (releaseFocus) runtime.focusInteraction(null);
  else publishInteractionProjection(runtime);
  for (const interaction of runtime.pendingInteractions) {
    if (interaction.turnEnded && interaction.owner.turnId === turnId)
      runtime.notifyInteractionChanged(interaction);
  }
}

export function resolveInteraction(
  this: TaskRuntime,
  kind: PendingInteraction["kind"],
  params: JsonRecord,
): boolean {
  const requestId = typeof params.requestId === "number" ? params.requestId : undefined;
  const identity = kind === "approval" ? text(params.approvalId) : text(params.questionId);
  if (requestId === undefined || !identity) return false;
  const context = this.reconnectContext;
  const appServerId = this.client?.getAppServerId() ?? null;
  if (!context || !appServerId) return false;
  // Older receipts may omit serverId or carry a null optional counterpart.
  // Explicit foreign server/kind identities cannot settle this connection's card.
  if ((params.serverId !== undefined && params.serverId !== appServerId) ||
      (kind === "question" ? params.approvalId != null : params.questionId != null)) return false;
  const index = this.pendingInteractions.findIndex((item) => {
    if (item.kind !== kind || item.requestId !== requestId || interactionId(item) !== identity)
      return false;
    const owner = item.owner;
    if (owner.profileId !== context.profile.id ||
        owner.profileAuthorizationScopeKey !== profileAuthorizationScopeKey(context.profile) ||
        owner.serverId !== context.server.id ||
        owner.appServerId !== appServerId ||
        owner.serverConfigIdentity !== interactionServerIdentity(context.server) ||
        owner.threadId !== this.snapshot.threadId || params.threadId !== owner.threadId ||
        (text(params.turnId) ?? null) !== owner.turnId ||
        (params.appServerEpoch ?? null) !== owner.appServerEpoch) return false;
    if (owner.appServerEpoch === null && owner.originClientGeneration !== this.clientGeneration)
      return false;
    return true;
  });
  if (index < 0) return false;
  const [resolved] = this.pendingInteractions.splice(index, 1);
  if (resolved) this.notifyInteractionResolved(resolved);
  if (resolved && this.focusedInteractionSelector &&
      matchesInteractionSelector(resolved, this.focusedInteractionSelector))
    this.focusInteraction(null);
  else publishInteractionProjection(this);
  return true;
}

// Keep defaults in the body: Expo's native transform can shift arguments on `this`-typed methods.
export function markInteractionResponding(
  this: TaskRuntime,
  selectorOrRequestId: InteractionSelector | number,
  responding?: boolean,
): void {
  const nextResponding = responding === undefined ? true : responding;
  const index = this.pendingInteractions.findIndex((item) =>
    typeof selectorOrRequestId === "number"
      ? item.requestId === selectorOrRequestId
      : matchesInteractionSelector(item, selectorOrRequestId),
  );
  if (index < 0) return;
  this.pendingInteractions[index] = { ...this.pendingInteractions[index]!, responding: nextResponding };
  this.notifyInteractionChanged(this.pendingInteractions[index]!);
  publishInteractionProjection(this);
}

export function focusInteraction(
  this: TaskRuntime,
  selector: InteractionSelector | null,
): "actionable" | "readOnly" | "stale" | null {
  this.focusedInteractionSelector = selector;
  if (!selector) {
    this.patch({ interactionFocusStatus: undefined });
    publishInteractionProjection(this);
    return null;
  }
  const interaction = this.pendingInteractions.find((item) =>
    matchesInteractionSelector(item, selector),
  );
  if (!interaction) {
    this.patch({ interactionFocusStatus: "stale", interaction: null });
    publishInteractionProjection(this);
    return "stale";
  }
  if (isActionable(this, interaction)) {
    this.patch({ interactionFocusStatus: undefined });
    publishInteractionProjection(this);
    return "actionable";
  }
  this.patch({ interactionFocusStatus: "readOnly", interaction: null });
  publishInteractionProjection(this);
  return "readOnly";
}

function updateReceiptStatus(
  runtime: TaskRuntime,
  selector: InteractionSelector,
  status: InteractionReceiptStatus,
): void {
  const index = runtime.pendingInteractions.findIndex((item) =>
    matchesInteractionSelector(item, selector),
  );
  if (index < 0) return;
  const current = runtime.pendingInteractions[index]!;
  runtime.pendingInteractions[index] = {
    ...current,
    // Status receipts identify the request tuple, not its source agent/run.
    // They can settle it, but cannot erase a locally observed source conflict.
    owner: { ...current.owner, status: current.kind === "question" && current.sourceBindingConflict
      ? "unsupported" : status },
  };
  publishInteractionProjection(runtime);
  runtime.notifyInteractionChanged(runtime.pendingInteractions[index]!);
}

function removeResolvedReceipt(
  runtime: TaskRuntime,
  selector: InteractionSelector,
): void {
  // A native receipt does not authorize settling projections in another local
  // profile, target configuration or connection owner with the same wire tuple.
  const removed = runtime.pendingInteractions.filter((item) =>
    matchesInteractionSelector(item, selector),
  );
  for (const interaction of removed) runtime.notifyInteractionResolved(interaction);
  const removedSet = new Set(removed);
  runtime.pendingInteractions = runtime.pendingInteractions.filter((item) => !removedSet.has(item));
  if (runtime.focusedInteractionSelector && removed.some((interaction) =>
    matchesInteractionSelector(interaction, runtime.focusedInteractionSelector!),
  )) runtime.focusInteraction(null);
  else publishInteractionProjection(runtime);
}

/** Read exact receipt state only; a fresh socket never gains authority to answer an old request. */
export async function reconcilePendingInteractions(
  this: TaskRuntime,
  includeCurrentGeneration?: boolean,
): Promise<void> {
  // Current-generation requests remain excluded unless a caller explicitly opts in.
  const shouldIncludeCurrentGeneration = includeCurrentGeneration === undefined
    ? false
    : includeCurrentGeneration;
  const client = this.client;
  const context = this.reconnectContext;
  const generation = this.clientGeneration;
  if (!client || !context || this.disposed || this.reconnecting || !client.isTransportOpen()) return;
  for (const interaction of [...this.pendingInteractions]) {
    if (!shouldIncludeCurrentGeneration && interaction.owner.originClientGeneration === generation)
      continue;
    const selector = selectorForInteraction(interaction);
    const request = queryForInteraction(interaction);
    if (!request) {
      updateReceiptStatus(this, selector, "unsupported");
      continue;
    }
    if (!currentOwnerMatches(this, interaction)) {
      updateReceiptStatus(this, selector, "unknown");
      continue;
    }
    if (client.supportsExperimental?.("interactionStatusReadV1") !== true) {
      updateReceiptStatus(this, selector, "unsupported");
      continue;
    }
    updateReceiptStatus(this, selector, "unknown");
    try {
      const result = await client.request<InteractionStatusReadResultV1>(
        "interaction/status/read",
        request,
      );
      if (this.disposed || this.reconnecting || this.client !== client || this.clientGeneration !== generation ||
          !client.isTransportOpen() || !currentOwnerMatches(this, interaction))
        return;
      const current = this.pendingInteractions.find((item) =>
        matchesInteractionSelector(item, selector),
      );
      if (!current) continue;
      if (!sameStatusTuple(current, result)) {
        updateReceiptStatus(this, selector, "unknown");
      } else if (result.status === "resolved") {
        removeResolvedReceipt(this, selector);
      } else if (result.status === "pending" || result.status === "unknown") {
        updateReceiptStatus(this, selector, result.status);
      } else {
        updateReceiptStatus(this, selector, "unknown");
      }
    } catch {
      if (this.disposed || this.client !== client || this.clientGeneration !== generation)
        return;
      updateReceiptStatus(this, selector, "unknown");
    }
  }
}

export function markInteractionsDisconnected(this: TaskRuntime): void {
  this.pendingInteractions = this.pendingInteractions.map((item) => ({
    ...item,
    owner: {
      ...item.owner,
      status: item.owner.status === "unsupported" ? "unsupported" : "unknown",
    },
  }));
  publishInteractionProjection(this);
  for (const interaction of this.pendingInteractions) this.notifyInteractionChanged(interaction);
}

export function isInteractionActionable(
  this: TaskRuntime,
  interaction: PendingInteraction,
): boolean {
  return isActionable(this, interaction);
}
