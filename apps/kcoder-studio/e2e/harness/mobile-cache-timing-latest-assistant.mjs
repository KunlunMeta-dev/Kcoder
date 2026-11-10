import assert from "node:assert/strict";

const MAX_INLINE_RESUME_PAGE_MESSAGES = 100;

export function projectResumeAssistantPageEvidence(frame, {
  expectedThreadId,
  expectedAssistantMessageId,
  tailMarker,
}) {
  assert.ok(typeof expectedThreadId === "string" && expectedThreadId.length > 0,
    "resume-page evidence requires the exact fixture thread");
  assert.ok(typeof expectedAssistantMessageId === "string" && expectedAssistantMessageId.length > 0,
    "resume-page evidence requires the expected canonical assistant message ID");
  assert.ok(typeof tailMarker === "string" && tailMarker.length > 0,
    "resume-page evidence requires the exact assistant tail marker");

  const responseSucceeded = Boolean(frame?.result) && !frame?.error;
  const threadMatched = frame?.result?.thread?.id === expectedThreadId;
  const history = frame?.result?.history;
  const page = history?.status === "ready" ? history.page : null;
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  const pageMessageCount = Array.isArray(page?.messages) ? messages.length : null;
  const rangeStart = page?.rangeStart;
  const rangeEnd = page?.rangeEnd;
  const boundedInlinePage = Boolean(page && Array.isArray(page.messages) &&
    messages.length <= MAX_INLINE_RESUME_PAGE_MESSAGES && Number.isSafeInteger(rangeStart) && rangeStart >= 0 &&
    Number.isSafeInteger(rangeEnd) && rangeEnd >= rangeStart && rangeEnd - rangeStart === messages.length &&
    typeof page.hasMoreBefore === "boolean");
  const expectedAssistants = messages.filter(message =>
    message?.role === "assistant" && message.id === expectedAssistantMessageId);
  const tailAssistants = messages.filter(message =>
    message?.role === "assistant" && typeof message.content === "string" && message.content.includes(tailMarker));
  const expectedAssistantContainsTailMarker = expectedAssistants.length === 1 &&
    typeof expectedAssistants[0].content === "string" && expectedAssistants[0].content.includes(tailMarker);
  const expectedAssistantMatchCount = expectedAssistants.length;
  const assistantTailMarkerMatchCount = tailAssistants.length;
  const matched = responseSucceeded && threadMatched && boundedInlinePage && expectedAssistantMatchCount === 1 &&
    assistantTailMarkerMatchCount === 1 && expectedAssistantContainsTailMarker;

  return {
    responseSucceeded,
    threadMatched,
    boundedInlinePage,
    pageMessageCount,
    expectedAssistantMatchCount,
    assistantTailMarkerMatchCount,
    expectedAssistantContainsTailMarker,
    matched,
  };
}

export function resolveLatestCompletedAssistantIdentity({
  threadId,
  activeSocketOrdinal,
  turnCompletions,
  indexedHistoryRead,
  liveRows,
  tailGeometry,
}) {
  assert.ok(typeof threadId === "string" && threadId.length > 0,
    "latest assistant identity requires the exact fixture thread");
  assert.ok(Number.isSafeInteger(activeSocketOrdinal) && activeSocketOrdinal > 0,
    "latest assistant identity requires the active Mobile RPC socket ordinal");

  const completedTurns = (Array.isArray(turnCompletions) ? turnCompletions : []).filter(event =>
    event?.threadId === threadId && event.socketOrdinal === activeSocketOrdinal && event.status === "completed" &&
    typeof event.turnId === "string" && event.turnId.length > 0 && Number.isFinite(event.at));
  assert.equal(completedTurns.length, 1,
    "the active task socket must report exactly one completed turn for this thread");
  const completedTurn = completedTurns[0];

  assert.equal(indexedHistoryRead?.success, true,
    "latest assistant identity must come from a successful indexed-history read");
  assert.equal(indexedHistoryRead.threadId, threadId, "indexed history must target the exact fixture thread");
  assert.equal(indexedHistoryRead.responseThreadId, threadId,
    "indexed history must return the exact fixture thread");
  assert.equal(indexedHistoryRead.requestSocketOrdinal, activeSocketOrdinal,
    "indexed history must be requested on the active task socket");
  assert.equal(indexedHistoryRead.responseSocketOrdinal, activeSocketOrdinal,
    "indexed history must return on the active task socket");
  assert.ok(Number.isFinite(indexedHistoryRead.requestedAtMs) && Number.isFinite(indexedHistoryRead.receivedAtMs),
    "indexed history must carry host-monotonic request and response times");
  assert.ok(indexedHistoryRead.requestedAtMs >= completedTurn.at,
    "the authoritative history request must start after the real turn/completed event");
  assert.ok(indexedHistoryRead.receivedAtMs >= indexedHistoryRead.requestedAtMs,
    "the authoritative history response must follow its request");

  const messages = Array.isArray(indexedHistoryRead.messageIdentities) ? indexedHistoryRead.messageIdentities : [];
  assert.ok(messages.length > 0, "the completed thread history must contain canonical messages");
  const latestMessage = messages.at(-1);
  assert.equal(latestMessage?.role, "assistant",
    "the canonical completed history must end with an assistant message");
  assert.equal(latestMessage?.turnId, completedTurn.turnId,
    "the latest canonical assistant must belong to the exact completed turn");
  assert.ok(typeof latestMessage?.id === "string" && latestMessage.id.length > 0,
    "the latest canonical assistant must have a persisted message ID");
  assert.ok(typeof latestMessage?.attemptId === "string" && latestMessage.attemptId.length > 0,
    "the latest canonical assistant must have an explicit attempt identity");
  assert.equal(messages.filter(message => message?.id === latestMessage.id).length, 1,
    "the latest canonical assistant message ID must be unique in the authority page");

  const displayRowId = latestMessage.id;
  const matchingRows = (Array.isArray(liveRows) ? liveRows : []).filter(row =>
    row?.role === "assistant" && row.id === displayRowId);
  assert.equal(matchingRows.length, 1,
    "the canonical completed assistant message must map to exactly one live assistant row");
  assert.equal(tailGeometry?.rowDomId, `message-${encodeURIComponent(displayRowId)}`,
    "the unique visible assistant tail Range must belong to that canonical completed message");

  return {
    threadId,
    socketOrdinal: activeSocketOrdinal,
    turnId: completedTurn.turnId,
    attemptId: latestMessage.attemptId,
    canonicalMessageId: latestMessage.id,
    displayRowId,
    completionAtMs: completedTurn.at,
    historyRequestedAtMs: indexedHistoryRead.requestedAtMs,
    historyReceivedAtMs: indexedHistoryRead.receivedAtMs,
    identityMode: "completed turn plus same-socket canonical history ID and unique inverted-DOM row/Range match",
  };
}
