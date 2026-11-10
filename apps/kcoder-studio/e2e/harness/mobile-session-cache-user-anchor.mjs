import assert from "node:assert/strict";

const CLIENT_ID_HMAC_PATTERN = /^[a-f0-9]{64}$/;

export function buildColdProcessAnchorPrompt(promptMarker) {
  assert.ok(typeof promptMarker === "string" && promptMarker.length > 0,
    "the cold-process user prompt requires its unique fixture marker");
  const visibleParagraphs = [
    "Please keep this ordinary transcript readable while the local fixture completes. Save the reading position on this exact user message, and show the same prompt after the read-only offline restart.",
    "Keep the opening marker above and leave assistant output collapsed. These visible paragraphs give the real message list enough natural content to preserve the wheel anchor while the completed fixture response and its ownership stay unchanged.",
  ];
  return `${promptMarker}\n\n${visibleParagraphs.join("\n\n")}`;
}

export function turnStartIncludesPromptMarker(params, promptMarker) {
  if (typeof promptMarker !== "string" || promptMarker.length === 0 || !Array.isArray(params?.input)) return false;
  return params.input.some(item => item?.type === "text" && typeof item.text === "string" &&
    item.text.includes(promptMarker));
}

export async function prepareUserReadingAnchorViewport({ page, promptMarker, readTranscriptViewport }) {
  assert.ok(typeof promptMarker === "string" && promptMarker.length > 0,
    "the initial user reading anchor requires its exact fixture marker");
  const promptRow = page.getByTestId("message-user").filter({ hasText: promptMarker });
  assert.equal(await promptRow.count(), 1, "the initial prompt marker must identify exactly one rendered user row");
  const markerText = promptRow.getByText(promptMarker, { exact: false });
  assert.equal(await markerText.count(), 1,
    "the initial prompt marker must identify one user text element containing that substring");
  await markerText.scrollIntoViewIfNeeded();

  const geometry = await readTranscriptViewport(page, { markerText: promptMarker, rowTestId: "message-user" });
  assert.equal(geometry.listFound, true, "the user anchor must belong to the real Mobile message list");
  assert.equal(geometry.rowMatchCount, 1, "the prompt marker must identify one measured user row");
  assert.equal(geometry.markerTextMatchCount, 1, "the prompt marker must remain unique in rendered transcript text");
  assert.equal(geometry.markerVisible, true, "the exact user marker text must have visible browser geometry");
  assert.equal(geometry.markerIntersectsWindow, true, "the user marker must be inside the browser viewport");
  assert.equal(geometry.markerIntersectsList, true, "the user marker must intersect the message-list viewport");
  assert.equal(geometry.rowIntersectsList, true, "the user row must intersect the actual message-list viewport");
  assert.ok(typeof geometry.rowDomId === "string" && geometry.rowDomId.startsWith("message-"),
    "the visible user row must expose its rendered row identity");
  assert.ok(Number.isFinite(geometry.row?.offsetFromHost), "the user row must have a measured scroll-host offset");
  return { rowDomId: geometry.rowDomId, geometry };
}

export function resolveUniqueTurnUserAnchorIdentity({
  anchor,
  threadId,
  activeSocketOrdinal,
  requests,
  indexedHistoryRead,
  turnCompletions,
}) {
  assert.ok(typeof threadId === "string" && threadId.length > 0, "user anchor identity requires the exact fixture thread");
  assert.ok(Number.isSafeInteger(activeSocketOrdinal) && activeSocketOrdinal > 0,
    "user anchor identity requires the active Mobile RPC socket ordinal");

  const starts = (Array.isArray(requests) ? requests : []).filter(request =>
    request?.method === "turn/start" && request.threadId === threadId);
  assert.equal(starts.length, 1, "the initial fixture thread must have exactly one observed turn/start request");
  const start = starts[0];
  assert.equal(start.socketOrdinal, activeSocketOrdinal, "the unique turn/start must use the active Mobile RPC socket");
  assert.equal(start.clientPromptMarkerPresent, true,
    "the unique turn/start input must contain the exact initial user prompt marker");
  assert.equal(start.clientMessageIdExplicit, true, "the unique turn/start must carry an explicit clientMessageId");
  assert.match(start.clientMessageIdHmacSha256 ?? "", CLIENT_ID_HMAC_PATTERN,
    "the unique turn/start must carry a per-run clientMessageId HMAC");

  assert.equal(indexedHistoryRead?.success, true, "the canonical user identity must come from a successful indexed-history read");
  assert.equal(indexedHistoryRead.threadId, threadId, "the indexed-history request must target the fixture thread");
  assert.equal(indexedHistoryRead.responseThreadId, threadId,
    "the indexed-history response must identify the exact fixture thread");
  assert.equal(indexedHistoryRead.requestSocketOrdinal, activeSocketOrdinal,
    "the indexed-history request must use the active task socket");
  assert.equal(indexedHistoryRead.responseSocketOrdinal, activeSocketOrdinal,
    "the indexed-history response must return on the active task socket");

  const completedTurns = (Array.isArray(turnCompletions) ? turnCompletions : []).filter(event =>
    event?.threadId === threadId && event.socketOrdinal === activeSocketOrdinal &&
    event.status === "completed" && typeof event.turnId === "string" && event.turnId.length > 0);
  assert.equal(completedTurns.length, 1, "the active fixture socket must report exactly one completed turn for this thread");
  const completedTurn = completedTurns[0];

  const canonicalUserMessages = (Array.isArray(indexedHistoryRead.messageIdentities)
    ? indexedHistoryRead.messageIdentities : []).filter(message =>
    message?.role === "user" && message.clientMessageIdExplicit === true &&
    message.clientMessageIdHmacSha256 === start.clientMessageIdHmacSha256);
  assert.equal(canonicalUserMessages.length, 1,
    "the start clientMessageId HMAC must identify exactly one canonical user row in the indexed-history page");
  const canonicalUser = canonicalUserMessages[0];
  assert.ok(typeof canonicalUser.id === "string" && canonicalUser.id.length > 0,
    "the uniquely correlated canonical user row must have a persisted message ID");
  assert.equal(canonicalUser.turnId, completedTurn.turnId,
    "the canonical user row must belong to the exact completed turn on the active socket");
  assert.ok(anchor && anchor.followsLatest === false && Number.isFinite(anchor.offset),
    "the saved user reading anchor must contain a finite detached offset");
  assert.equal(anchor.messageId, canonicalUser.id,
    "the persisted reading anchor must point to the uniquely correlated canonical user message");

  return {
    canonicalId: canonicalUser.id,
    role: "user",
    threadId,
    socketOrdinal: activeSocketOrdinal,
    turnId: completedTurn.turnId,
    clientMessageIdHmacSha256: start.clientMessageIdHmacSha256,
    identityMode: "unique initial turn/start CID HMAC mapped to one canonical user row; visible row selected by unique prompt marker",
  };
}
