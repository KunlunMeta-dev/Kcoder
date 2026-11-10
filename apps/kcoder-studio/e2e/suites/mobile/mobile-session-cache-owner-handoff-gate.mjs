import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const sha256 = raw => createHash("sha256").update(raw).digest("hex");

/** Only an already completed same-socket indexed read can confirm both live IDs. */
export function confirmedCompletedTurnRows(reads, { threadId, socketOrdinal, turnId, completedAtMs }) {
  for (const read of reads ?? []) {
    if (read.threadId !== threadId || read.responseThreadId !== threadId ||
      read.requestSocketOrdinal !== socketOrdinal || read.responseSocketOrdinal !== socketOrdinal ||
      read.success !== true || !(read.requestedAtMs > completedAtMs) ||
      !(read.receivedAtMs > read.requestedAtMs)) continue;
    const rows = read.messageIdentities?.filter(row => row.turnId === turnId) ?? [];
    const users = rows.filter(row => row.role === "user" && typeof row.id === "string" && row.id.length > 0);
    const assistants = rows.filter(row => row.role === "assistant" && typeof row.id === "string" && row.id.length > 0);
    if (rows.length !== 2 || users.length !== 1 || assistants.length !== 1 || users[0].id === assistants[0].id) continue;
    return { userId: users[0].id, assistantId: assistants[0].id,
      requestId: read.requestId, requestedAtMs: read.requestedAtMs };
  }
  return null;
}

/** Keep private assertion operands out of both structured artifacts and error text. */
export function projectSafeOwnerHandoffFailure(error, phase, actorStep, gateSnapshot) {
  const sourceRef = String(error?.stack ?? "").match(/mobile-session-cache-owner-handoff-rollback\.mjs:\d+:\d+/)?.[0] ?? null;
  const errorName = ["AssertionError", "Error", "TypeError", "TimeoutError"].includes(error?.name)
    ? error.name : "Error";
  return { phase, errorName, actorStep: phase === "legal-actor-rollback" ? actorStep : null,
    sourceRef, safeActual: typeof error?.actual === "boolean" || Number.isSafeInteger(error?.actual)
      ? error.actual : null, gate: gateSnapshot };
}

/** One exact Page reconnect request is withheld before Gateway ownership dispatch. */
export function createOwnerHandoffResumeGate({ threadId }) {
  let minSocketOrdinal = null;
  let held = null;
  let response = null;
  let forwardedAtMs = null;
  let discarded = false;
  let duplicateCount = 0;
  return {
    arm(nextSocketOrdinal) {
      assert.equal(minSocketOrdinal, null);
      assert.ok(Number.isSafeInteger(nextSocketOrdinal) && nextSocketOrdinal > 0);
      minSocketOrdinal = nextSocketOrdinal;
    },
    capture({ raw, frame, request, socketOrdinal, forward }) {
      if (minSocketOrdinal === null || request?.method !== "thread/resume" ||
        request.threadId !== threadId || frame?.params?.threadId !== threadId ||
        socketOrdinal < minSocketOrdinal || request.socketOrdinal !== socketOrdinal) return false;
      if (held) { duplicateCount += 1; return true; }
      assert.equal(typeof forward, "function");
      assert.ok(Number.isSafeInteger(frame.id) && frame.id >= 0 && String(frame.id) === request.id);
      held = { request, frameId: frame.id, socketOrdinal, rawSha256: sha256(raw), forward };
      return true;
    },
    release() {
      if (!held || forwardedAtMs !== null || discarded) return false;
      held.forward();
      forwardedAtMs = performance.now();
      held.forward = null;
      return true;
    },
    observeResponse({ raw, frame, request, socketOrdinal }) {
      if (!held || forwardedAtMs === null || response || socketOrdinal !== held.socketOrdinal ||
        frame?.jsonrpc !== "2.0" || !Object.is(frame.id, held.frameId) ||
        typeof frame.method === "string" || request !== held.request) return false;
      response = { frame, rawSha256: sha256(raw), receivedAtMs: performance.now() };
      return true;
    },
    responseFrame() { return response?.frame ?? null; },
    discard() {
      if (!held || forwardedAtMs !== null || discarded) return false;
      held.forward = null;
      discarded = true;
      return true;
    },
    snapshot() {
      return { armed: minSocketOrdinal !== null, minSocketOrdinal,
        held: Boolean(held && forwardedAtMs === null && !discarded),
        requestId: held?.frameId ?? null, socketOrdinal: held?.socketOrdinal ?? null,
        requestSha256: held?.rawSha256 ?? null, forwardedAtMs,
        responseSha256: response?.rawSha256 ?? null, responseReceivedAtMs: response?.receivedAtMs ?? null,
        duplicateCount, discarded };
    },
  };
}

/** Reject partial, non-idle, or wrong-thread authority before inspecting UI deletion. */
export function projectFullIdleRollbackAuthority(frame, {
  threadId, turn1Marker, turn2Marker, turn1UserId, turn2UserId, turn2AssistantId, knownCount,
}) {
  const result = frame?.result;
  const page = result?.history?.page;
  const messages = page?.messages;
  const thread = result?.thread;
  const observation = page?.transcriptObservationV1;
  const snapshot = page?.transcriptSnapshotV1;
  const summary = thread?.runSummary;
  const idleFacts = thread?.status === "idle" && (summary === undefined ||
    (summary?.mainTurn === "idle" && ["pendingApprovals", "pendingQuestions", "activeJobs",
      "tasksPending", "tasksRunning", "pendingFollowups", "pendingGoals"]
      .every(key => summary[key] === 0)));
  const identityBound = (typeof observation?.observationId === "string" && /^[a-f0-9]{64}$/.test(observation.observationId) &&
    typeof observation.viewKey === "string" && /^[a-f0-9]{64}$/.test(observation.viewKey)) ||
    (snapshot?.status === "available" && typeof snapshot.snapshotId === "string" &&
      /^[a-f0-9]{64}$/.test(snapshot.snapshotId) && typeof snapshot.viewKey === "string" &&
      /^[a-f0-9]{64}$/.test(snapshot.viewKey));
  const turn2IdsAbsent = Array.isArray(messages) && !messages.some(message =>
    message?.id === turn2UserId || message?.id === turn2AssistantId);
  const complete = frame?.jsonrpc === "2.0" && !frame.error && thread?.id === threadId &&
    idleFacts && result.history?.status === "ready" && Array.isArray(messages) &&
    page.rangeStart === 0 && page.rangeEnd === knownCount && messages.length === knownCount &&
    page.hasMoreBefore === false && page.beforeCursor == null && identityBound && turn2IdsAbsent &&
    messages.every(message => message && typeof message.id === "string" &&
      typeof message.content === "string") &&
    new Set(messages.map(message => message.id)).size === messages.length;
  return { complete: Boolean(complete), threadIdle: idleFacts, identityBound,
    turn2IdsAbsent, rangeStart: page?.rangeStart ?? null,
    rangeEnd: page?.rangeEnd ?? null, hasMoreBefore: page?.hasMoreBefore ?? null,
    beforeCursorAbsent: page?.beforeCursor == null,
    turn1UserCount: Array.isArray(messages) ? messages.filter(message =>
      message.role === "user" && message.content?.includes(turn1Marker)).length : null,
    turn1UserIdCount: Array.isArray(messages) ? messages.filter(message => message.id === turn1UserId).length : null,
    turn2UserCount: Array.isArray(messages) ? messages.filter(message =>
      message.role === "user" && message.content?.includes(turn2Marker)).length : null,
    messageCount: Array.isArray(messages) ? messages.length : null };
}
