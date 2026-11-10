const transcriptMarkers = (value) =>
  String(value ?? "").match(/TRANSCRIPT_[A-Z0-9_]+/g) ?? [];
const observedCursorPattern = /^tp1:ob1-([a-f0-9]{64}):([1-9]\d{0,19})$/;

export function transcriptRpcResponseMatchesRequest(response, request) {
  const responseRequest = response?.request;
  return typeof request?.id === "string" &&
    Number.isSafeInteger(request.requestOrdinal) &&
    Number.isSafeInteger(request.socketOrdinal) &&
    response?.requestId === request.id &&
    responseRequest?.id === request.id &&
    responseRequest?.method === request.method &&
    responseRequest?.threadId === request.threadId &&
    responseRequest?.beforeCursor === request.beforeCursor &&
    responseRequest?.requestOrdinal === request.requestOrdinal &&
    responseRequest?.socketOrdinal === request.socketOrdinal;
}

/**
 * Project only real transcript pages observed on the Mobile RPC connection.
 * Resume-inline and indexed-read pages retain their actual source method, and
 * the cursor sent by the client stays distinct from the next cursor returned
 * by the server.
 */
export function observeTranscriptPageResponse(request, rpcResponse) {
  if (
    request?.method !== "thread/resume" &&
    request?.method !== "thread/read/indexed"
  ) {
    return null;
  }

  const result = rpcResponse?.result;
  const history = request.method === "thread/resume" ? result?.history : null;
  const page = request.method === "thread/resume"
    ? history?.status === "ready" ? history.page : null
    : rpcResponse?.success ? result : null;
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  const transcriptSnapshot = page?.transcriptSnapshotV1;
  const transcriptObservation = page?.transcriptObservationV1;
  const observedCursor = typeof page?.beforeCursor === "string"
    ? page.beforeCursor.match(observedCursorPattern)
    : null;
  const requestedCursor = typeof request.beforeCursor === "string"
    ? request.beforeCursor.match(observedCursorPattern)
    : null;
  const observationCursorOrdinal = observedCursor ? Number(observedCursor[2]) : null;
  const observationCursorMatchesObservationId = Boolean(
    observedCursor && observedCursor[1] === transcriptObservation?.observationId,
  );
  const historyRequest = request.method === "thread/resume"
    ? request.params?.history
    : null;
  const threadMatches = request.method === "thread/resume"
    ? result?.thread?.id === request.threadId
    : !page?.thread || page.thread.id === request.threadId;
  const pageAvailable = rpcResponse?.success === true &&
    page !== null && typeof page === "object" && threadMatches;

  return {
    ...rpcResponse,
    sourceMethod: request.method,
    historyStatus: request.method === "thread/resume"
      ? history?.status ?? (rpcResponse?.success ? "omitted" : "rpc-error")
      : rpcResponse?.success ? "ready" : "rpc-error",
    threadId: request.threadId ?? result?.thread?.id ?? null,
    requestOrdinal: Number.isSafeInteger(request.requestOrdinal)
      ? request.requestOrdinal
      : null,
    requestBeforeCursor:
      typeof request.beforeCursor === "string" ? request.beforeCursor : null,
    beforeCursor:
      typeof page?.beforeCursor === "string" ? page.beforeCursor : null,
    transcriptSnapshotStatus: transcriptSnapshot?.status ?? null,
    transcriptSnapshotCode: transcriptSnapshot?.code ?? null,
    transcriptObservationPresent: transcriptObservation !== null && typeof transcriptObservation === "object",
    transcriptObservationIdPresent: typeof transcriptObservation?.observationId === "string",
    transcriptObservationViewKeyPresent: typeof transcriptObservation?.viewKey === "string",
    requestedObservationCursorMatchesObservationId: Boolean(
      requestedCursor && requestedCursor[1] === transcriptObservation?.observationId,
    ),
    returnedObservationCursorMatchesObservationId: observationCursorMatchesObservationId,
    observationCursorOrdinal: Number.isSafeInteger(observationCursorOrdinal)
      ? observationCursorOrdinal
      : null,
    historyRequestLimit: Number.isSafeInteger(historyRequest?.limit)
      ? historyRequest.limit
      : null,
    historyRequestIndexed: typeof historyRequest?.indexed === "boolean"
      ? historyRequest.indexed
      : null,
    hasMoreBefore: page?.hasMoreBefore === true,
    rangeStart: Number.isSafeInteger(page?.rangeStart) ? page.rangeStart : null,
    rangeEnd: Number.isSafeInteger(page?.rangeEnd) ? page.rangeEnd : null,
    success: pageAvailable,
    messageCount: messages.length,
    userMarkers: messages.flatMap((message) =>
      message?.role === "user" ? transcriptMarkers(message.content) : []),
  };
}

export function projectTranscriptPageObservation(page) {
  return {
    requestId: page.requestId,
    sourceMethod: page.sourceMethod,
    historyStatus: page.historyStatus,
    threadId: page.threadId,
    requestBeforeCursor: page.requestBeforeCursor,
    beforeCursor: page.beforeCursor,
    transcriptSnapshotStatus: page.transcriptSnapshotStatus ?? null,
    transcriptSnapshotCode: page.transcriptSnapshotCode ?? null,
    transcriptObservationPresent: page.transcriptObservationPresent ?? false,
    transcriptObservationIdPresent: page.transcriptObservationIdPresent ?? false,
    transcriptObservationViewKeyPresent: page.transcriptObservationViewKeyPresent ?? false,
    requestedObservationCursorMatchesObservationId: page.requestedObservationCursorMatchesObservationId ?? false,
    returnedObservationCursorMatchesObservationId: page.returnedObservationCursorMatchesObservationId ?? false,
    observationCursorOrdinal: page.observationCursorOrdinal ?? null,
    historyRequestLimit: page.historyRequestLimit ?? null,
    historyRequestIndexed: page.historyRequestIndexed ?? null,
    hasMoreBefore: page.hasMoreBefore,
    rangeStart: page.rangeStart,
    rangeEnd: page.rangeEnd,
    requestOrdinal: page.requestOrdinal ?? page.request?.requestOrdinal ?? null,
    requestOrdinalAtResponse: page.requestOrdinalAtResponse ?? null,
    success: page.success,
    errorCode: page.errorCode,
    errorMessage: page.errorMessage,
    messageCount: page.messageCount,
    userMarkers: page.userMarkers,
    responseOrdinal: page.responseOrdinal,
    rawRequest: page.request?.rawRequest ?? null,
    rawResponse: page.rawResponse ?? null,
  };
}
