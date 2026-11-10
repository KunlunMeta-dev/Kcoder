import type { InteractionInboxRow, InteractionReceiptStatus, PendingInteraction } from "@/runtime/task-runtime/types";

export interface InteractionRouteLocator {
  kind: PendingInteraction["kind"];
  requestId: number;
  interactionId: string;
  turnId: string | null;
  appServerEpoch: string | null;
}

export interface SourceAgentQuestionRouteFocus extends InteractionRouteLocator {
  kind: "question";
  agentId: string;
  parentSessionId: string;
  status: InteractionReceiptStatus;
  liveActionable: boolean;
}

export interface InteractionRouteParams {
  kind?: unknown;
  requestId?: unknown;
  interactionId?: unknown;
  turnId?: unknown;
  appServerEpoch?: unknown;
}

export interface InteractionTaskHref {
  pathname: "/h/[profileId]/task/[serverId]/[threadId]";
  params: {
    profileId: string;
    serverId: string;
    threadId: string;
    kind: PendingInteraction["kind"];
    requestId: string;
    interactionId: string;
    turnId: string;
    appServerEpoch: string;
  };
}

const queryText = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export function hasInteractionRouteParams(params: InteractionRouteParams): boolean {
  return [params.kind, params.requestId, params.interactionId, params.turnId, params.appServerEpoch]
    .some((value) => value !== undefined);
}

export function parseInteractionRouteLocator(
  params: InteractionRouteParams,
): InteractionRouteLocator | null {
  const kind = queryText(params.kind);
  const requestId = queryText(params.requestId);
  const interactionId = queryText(params.interactionId);
  const turnId = queryText(params.turnId);
  const appServerEpoch = queryText(params.appServerEpoch);
  if ((kind !== "approval" && kind !== "question") || requestId === null ||
      interactionId === null || turnId === null || appServerEpoch === null ||
      !/^\d+$/.test(requestId) || !interactionId) return null;
  const numericRequestId = Number(requestId);
  if (!Number.isSafeInteger(numericRequestId)) return null;
  return {
    kind,
    requestId: numericRequestId,
    interactionId,
    turnId: turnId || null,
    appServerEpoch: appServerEpoch || null,
  };
}

export function interactionRouteLocatorFromRow(row: InteractionInboxRow): InteractionRouteLocator {
  return {
    kind: row.kind,
    requestId: row.requestId,
    interactionId: row.interactionId,
    turnId: row.turnId,
    appServerEpoch: row.appServerEpoch,
  };
}

export function interactionTaskHref(row: InteractionInboxRow): InteractionTaskHref {
  return {
    pathname: "/h/[profileId]/task/[serverId]/[threadId]",
    params: {
      profileId: row.profileId,
      serverId: row.serverId,
      threadId: row.threadId,
      kind: row.kind,
      requestId: String(row.requestId),
      interactionId: row.interactionId,
      turnId: row.turnId ?? "",
      appServerEpoch: row.appServerEpoch ?? "",
    },
  };
}

export function matchesInteractionRouteLocator(
  interaction: PendingInteraction,
  locator: InteractionRouteLocator,
  threadId: string,
): boolean {
  const interactionId = interaction.kind === "approval"
    ? interaction.approvalId
    : interaction.questionId;
  return interaction.kind === locator.kind &&
    interaction.requestId === locator.requestId &&
    interactionId === locator.interactionId &&
    interaction.owner.threadId === threadId &&
    interaction.owner.turnId === locator.turnId &&
    interaction.owner.appServerEpoch === locator.appServerEpoch;
}

export function interactionMatchesInboxRow(
  interaction: PendingInteraction,
  row: InteractionInboxRow,
): boolean {
  const interactionId = interaction.kind === "approval"
    ? interaction.approvalId
    : interaction.questionId;
  const sourceAgentMatches = interaction.kind === "question"
    ? interaction.sourceAgent?.parentSessionId === row.sourceAgent?.parentSessionId &&
      interaction.sourceAgent?.agentId === row.sourceAgent?.agentId
    : row.sourceAgent === undefined;
  return interaction.kind === row.kind && interaction.requestId === row.requestId &&
    interactionId === row.interactionId && sourceAgentMatches &&
    interaction.owner.profileId === row.profileId &&
    interaction.owner.profileAuthorizationScopeKey === row.profileAuthorizationScopeKey &&
    interaction.owner.serverId === row.serverId &&
    interaction.owner.appServerId === row.appServerId &&
    interaction.owner.serverConfigIdentity === row.serverConfigIdentity &&
    interaction.owner.threadId === row.threadId && interaction.owner.turnId === row.turnId &&
    interaction.owner.appServerEpoch === row.appServerEpoch &&
    interaction.owner.runtimeInstanceNonce === row.runtimeInstanceNonce &&
    interaction.owner.profileActivationEpoch === row.profileActivationEpoch &&
    interaction.owner.originClientGeneration === row.originClientGeneration;
}

export function sourceAgentQuestionSelection(
  question: Extract<PendingInteraction, { kind: "question" }>,
  parentThreadId: string,
  pendingInteractions: PendingInteraction[],
): string | null {
  const source = question.sourceAgent;
  if (!source || source.parentSessionId !== parentThreadId) return null;
  const exact = pendingInteractions.find((candidate) =>
    candidate.kind === "question" && candidate.requestId === question.requestId &&
    candidate.questionId === question.questionId &&
    candidate.owner.profileId === question.owner.profileId &&
    candidate.owner.profileAuthorizationScopeKey === question.owner.profileAuthorizationScopeKey &&
    candidate.owner.serverId === question.owner.serverId &&
    candidate.owner.appServerId === question.owner.appServerId &&
    candidate.owner.serverConfigIdentity === question.owner.serverConfigIdentity &&
    candidate.owner.threadId === question.owner.threadId &&
    candidate.owner.turnId === question.owner.turnId &&
    candidate.owner.appServerEpoch === question.owner.appServerEpoch &&
    candidate.owner.runtimeInstanceNonce === question.owner.runtimeInstanceNonce &&
    candidate.owner.profileActivationEpoch === question.owner.profileActivationEpoch &&
    candidate.owner.originClientGeneration === question.owner.originClientGeneration &&
    candidate.sourceAgent?.parentSessionId === source.parentSessionId &&
    candidate.sourceAgent.agentId === source.agentId,
  );
  return exact?.kind === "question" &&
    exact.sourceAgent?.parentSessionId === parentThreadId &&
    exact.sourceAgent.agentId === source.agentId
    ? source.agentId
    : null;
}

export function sourceAgentQuestionRouteRow(
  focus: SourceAgentQuestionRouteFocus | null | undefined,
  rows: InteractionInboxRow[],
  parentThreadId: string,
): InteractionInboxRow | null {
  if (!focus || focus.kind !== "question" || focus.parentSessionId !== parentThreadId) return null;
  return rows.find((row) => row.kind === "question" &&
    row.requestId === focus.requestId && row.interactionId === focus.interactionId &&
    row.turnId === focus.turnId && row.appServerEpoch === focus.appServerEpoch &&
    row.threadId === parentThreadId && row.sourceAgent?.parentSessionId === focus.parentSessionId &&
    row.sourceAgent.agentId === focus.agentId) ?? null;
}
