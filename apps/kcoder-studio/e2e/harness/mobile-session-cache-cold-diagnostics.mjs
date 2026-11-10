function finite(value) {
  return Number.isFinite(value) ? value : null;
}

export function observeAnchorScrollResponse({ startScrollTop, startOffset, endScrollTop, endOffset }) {
  if (![startScrollTop, startOffset, endScrollTop, endOffset].every(Number.isFinite)) return null;
  const scrollTopDeltaPx = endScrollTop - startScrollTop;
  const rowOffsetDeltaPx = endOffset - startOffset;
  if (Math.abs(scrollTopDeltaPx) < 0.5 || Math.abs(rowOffsetDeltaPx) < 0.5) return null;
  return {
    scrollTopDeltaPx: round(scrollTopDeltaPx),
    rowOffsetDeltaPx: round(rowOffsetDeltaPx),
    rowOffsetPerScrollTop: round(rowOffsetDeltaPx / scrollTopDeltaPx),
  };
}

export function assessCounterWheelPreparation(start, prepared, { preparationDeltaY, finalDeltaY, expectedRowDomId }) {
  const startHost = start?.host;
  const preparedHost = prepared?.host;
  const startTop = startHost?.scrollTop;
  const preparedTop = preparedHost?.scrollTop;
  const startRange = Number.isFinite(startHost?.scrollHeight) && Number.isFinite(startHost?.clientHeight)
    ? Math.max(0, startHost.scrollHeight - startHost.clientHeight) : null;
  const preparedRange = Number.isFinite(preparedHost?.scrollHeight) && Number.isFinite(preparedHost?.clientHeight)
    ? Math.max(0, preparedHost.scrollHeight - preparedHost.clientHeight) : null;
  const scrollTopDeltaPx = Number.isFinite(startTop) && Number.isFinite(preparedTop)
    ? preparedTop - startTop : null;
  const scrollTopPerWheelDelta = Number.isFinite(scrollTopDeltaPx) && Number.isFinite(preparationDeltaY) &&
    Math.abs(preparationDeltaY) >= 0.5 ? scrollTopDeltaPx / preparationDeltaY : null;
  const expectedFinalScrollTopDirection = Number.isFinite(scrollTopPerWheelDelta) &&
    Number.isFinite(finalDeltaY) ? Math.sign(scrollTopPerWheelDelta * finalDeltaY) : 0;
  const finalDirectionalRoomAtStartPx = directionalScrollRoom(startTop, startRange, expectedFinalScrollTopDirection);
  const finalDirectionalRoomPx = directionalScrollRoom(preparedTop, preparedRange, expectedFinalScrollTopDirection);
  const rangeStable = Number.isFinite(startRange) && Number.isFinite(preparedRange) &&
    Math.abs(startRange - preparedRange) <= 0.5;
  const rowMatches = typeof expectedRowDomId === "string" && expectedRowDomId.length > 0 &&
    start?.rowDomId === expectedRowDomId && prepared?.rowDomId === expectedRowDomId &&
    start?.rowMatchCount === 1 && prepared?.rowMatchCount === 1;
  const markerVisibleAtStart = hasVisibleUniqueMarker(start);
  const markerVisibleAfterPreparation = hasVisibleUniqueMarker(prepared);
  const realMessageListHost = startHost?.testId === "message-list" && preparedHost?.testId === "message-list";
  const oppositeWheelDirections = Number.isFinite(preparationDeltaY) && Number.isFinite(finalDeltaY) &&
    preparationDeltaY * finalDeltaY < 0;
  const preparationMoved = Number.isFinite(scrollTopDeltaPx) && Math.abs(scrollTopDeltaPx) >= 0.5;
  const scrollable = Number.isFinite(startRange) && startRange > 0 && rangeStable;
  const finalWheelHasRoom = Number.isFinite(finalDirectionalRoomPx) && finalDirectionalRoomPx >= 0.5;
  return {
    preparationDeltaY: finite(preparationDeltaY),
    finalDeltaY: finite(finalDeltaY),
    initialScrollTopPx: finite(startTop),
    preparedScrollTopPx: finite(preparedTop),
    preparationScrollTopDeltaPx: finite(scrollTopDeltaPx),
    observedScrollTopPerWheelDelta: finite(scrollTopPerWheelDelta),
    expectedFinalScrollTopDirection,
    availableScrollRangePx: finite(startRange),
    preparedScrollRangePx: finite(preparedRange),
    rangeStable,
    initialFinalDirectionRoomPx: finite(finalDirectionalRoomAtStartPx),
    finalDirectionalRoomPx: finite(finalDirectionalRoomPx),
    startedAtFinalDirectionBoundary: Number.isFinite(finalDirectionalRoomAtStartPx) &&
      finalDirectionalRoomAtStartPx < 0.5,
    openedFinalDirectionRoom: Number.isFinite(finalDirectionalRoomAtStartPx) &&
      finalDirectionalRoomAtStartPx < 0.5 && finalWheelHasRoom,
    preparationMoved,
    oppositeWheelDirections,
    rowMatches,
    markerVisibleAtStart,
    markerVisibleAfterPreparation,
    realMessageListHost,
    scrollable,
    finalWheelHasRoom,
    ready: scrollable && preparationMoved && oppositeWheelDirections && expectedFinalScrollTopDirection !== 0 &&
      rowMatches && markerVisibleAtStart && markerVisibleAfterPreparation && realMessageListHost && finalWheelHasRoom,
  };
}

export function assertCounterWheelPreparation(start, prepared, options) {
  const evidence = assessCounterWheelPreparation(start, prepared, options);
  if (!evidence.ready) {
    const error = new Error("trusted counter-wheel must preserve the exact visible user marker and open room for the final wheel; " +
      JSON.stringify(evidence));
    error.wheelPreparation = evidence;
    throw error;
  }
  return evidence;
}

export function assessFinalWheelMovement(preparation, start, completed) {
  const startTop = start?.host?.scrollTop;
  const completedTop = completed?.host?.scrollTop;
  const startRange = Number.isFinite(start?.host?.scrollHeight) && Number.isFinite(start?.host?.clientHeight)
    ? Math.max(0, start.host.scrollHeight - start.host.clientHeight) : null;
  const scrollTopDeltaPx = Number.isFinite(startTop) && Number.isFinite(completedTop)
    ? completedTop - startTop : null;
  const actualDirection = Number.isFinite(scrollTopDeltaPx) && Math.abs(scrollTopDeltaPx) >= 0.5
    ? Math.sign(scrollTopDeltaPx) : 0;
  const availableScrollRangePx = Number.isFinite(completed?.host?.scrollHeight) &&
    Number.isFinite(completed?.host?.clientHeight)
    ? Math.max(0, completed.host.scrollHeight - completed.host.clientHeight) : null;
  const rangeStable = Number.isFinite(startRange) && Number.isFinite(availableScrollRangePx) &&
    Math.abs(startRange - availableScrollRangePx) <= 0.5;
  const scrollTopInRange = Number.isFinite(completedTop) && Number.isFinite(availableScrollRangePx) &&
    completedTop >= -0.5 && completedTop <= availableScrollRangePx + 0.5;
  const rowMatches = typeof start?.rowDomId === "string" && start.rowDomId.length > 0 &&
    start?.rowMatchCount === 1 && completed?.rowDomId === start.rowDomId && completed?.rowMatchCount === 1;
  const markerVisible = hasVisibleUniqueMarker(completed);
  const realMessageListHost = start?.host?.testId === "message-list" && completed?.host?.testId === "message-list";
  const directionMatches = actualDirection !== 0 && actualDirection === preparation?.expectedFinalScrollTopDirection;
  return {
    scrollTopDeltaPx: finite(scrollTopDeltaPx),
    expectedScrollTopDirection: preparation?.expectedFinalScrollTopDirection ?? 0,
    actualScrollTopDirection: actualDirection,
    availableScrollRangePx: finite(availableScrollRangePx),
    rangeStable,
    completedScrollTopPx: finite(completedTop),
    scrollTopInRange,
    realMessageListHost,
    rowMatches,
    markerVisible,
    ready: directionMatches && rangeStable && scrollTopInRange && realMessageListHost && rowMatches && markerVisible,
  };
}

export function assertFinalWheelMovement(preparation, start, completed) {
  const evidence = assessFinalWheelMovement(preparation, start, completed);
  if (!evidence.ready) {
    const error = new Error("the final trusted wheel must move the same visible user anchor in the observed available direction; " +
      JSON.stringify(evidence));
    error.finalWheelMovement = evidence;
    throw error;
  }
  return evidence;
}

export function projectColdOfflineBridgeEvidence({ firstSocketOrdinal, routeDiagnostics, requests, overflowed = false }) {
  const validFirstOrdinal = Number.isSafeInteger(firstSocketOrdinal) && firstSocketOrdinal > 0;
  const validRoutes = Array.isArray(routeDiagnostics);
  const validRequests = Array.isArray(requests);
  const coldRoutes = validRoutes
    ? routeDiagnostics.filter(route => Number.isSafeInteger(route?.socketOrdinal) && route.socketOrdinal >= firstSocketOrdinal)
    : [];
  const coldRequests = validRequests
    ? requests.filter(request => Number.isSafeInteger(request?.socketOrdinal) && request.socketOrdinal >= firstSocketOrdinal)
    : [];
  const totalCount = (rows, key) => rows.every(row => Number.isSafeInteger(row?.[key]) && row[key] >= 0)
    ? rows.reduce((sum, row) => sum + row[key], 0)
    : null;
  const clientFrameCount = totalCount(coldRoutes, "clientToServerForwardCount");
  const upstreamFrameCount = totalCount(coldRoutes, "upstreamMessageCount");
  const forwardedServerFrameCount = totalCount(coldRoutes, "serverToClientForwardCount");
  return {
    observationBoundary: "Playwright routeWebSocket frame-forward counters on the cold Page; no Gateway-side request counter or handshake claim.",
    firstSocketOrdinal: validFirstOrdinal ? firstSocketOrdinal : null,
    routeCallbackCount: coldRoutes.length,
    routeSocketOrdinals: coldRoutes.map(route => route.socketOrdinal),
    clientFrameCount,
    upstreamFrameCount,
    forwardedServerFrameCount,
    rpcRequestCount: coldRequests.length,
    rpcRequestMethods: coldRequests.slice(0, 32).map(request =>
      typeof request?.method === "string" ? request.method.slice(0, 80) : "unclassified"),
    evidenceComplete: validFirstOrdinal && validRoutes && validRequests && overflowed === false &&
      clientFrameCount !== null && upstreamFrameCount !== null && forwardedServerFrameCount !== null,
  };
}

export function assertColdOfflineBridgeStayedOffline(evidence) {
  const noRouteTraffic = evidence?.clientFrameCount === 0 && evidence?.upstreamFrameCount === 0 &&
    evidence?.forwardedServerFrameCount === 0 && evidence?.rpcRequestCount === 0;
  if (evidence?.evidenceComplete !== true || !noRouteTraffic) {
    const error = new Error("the routed cold-page WebSocket bridge must carry no RPC frames while Chromium is offline; " +
      JSON.stringify(evidence));
    error.offlineBridgeEvidence = evidence;
    throw error;
  }
  return evidence;
}

export function anchorOffsetWithinTolerance(actual, expected, tolerance = 4) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Number.isFinite(tolerance) && tolerance >= 0 &&
    Math.abs(actual - expected) <= tolerance;
}

export function assessPersistedAnchorReadiness(snapshot, expectedAnchorOffset, tolerance = 4, expectedFollowsLatest = null) {
  const anchorOffsetMatches = expectedAnchorOffset === null ? null
    : anchorOffsetWithinTolerance(snapshot?.anchor?.offset, expectedAnchorOffset, tolerance);
  const anchorFollowsLatestMatches = expectedFollowsLatest === null ? null
    : snapshot?.anchor?.followsLatest === expectedFollowsLatest;
  return {
    ...snapshot,
    ready: snapshot?.ready === true && (anchorOffsetMatches === null || anchorOffsetMatches) &&
      (anchorFollowsLatestMatches === null || anchorFollowsLatestMatches),
    reason: anchorOffsetMatches === false ? "expected-reading-anchor-offset-mismatch" :
      anchorFollowsLatestMatches === false ? "expected-reading-anchor-follow-latest-mismatch" : snapshot?.reason ?? null,
    expectedAnchorOffset: finite(expectedAnchorOffset),
    anchorOffsetMatches,
    expectedAnchorFollowsLatest: expectedFollowsLatest,
    anchorFollowsLatestMatches,
  };
}

export function assessAnchorScrollReachability(candidate, expectedOffset, scrollResponse) {
  const host = candidate?.host;
  const rowOffset = candidate?.row?.offsetFromHost;
  const scrollTop = host?.scrollTop;
  const availableScrollRangePx = Number.isFinite(host?.scrollHeight) && Number.isFinite(host?.clientHeight)
    ? Math.max(0, host.scrollHeight - host.clientHeight) : null;
  const targetOffsetDeltaPx = Number.isFinite(expectedOffset) && Number.isFinite(rowOffset)
    ? expectedOffset - rowOffset : null;
  const slope = scrollResponse?.rowOffsetPerScrollTop;
  const targetScrollTopPx = Number.isFinite(scrollTop) && Number.isFinite(targetOffsetDeltaPx) &&
    Number.isFinite(slope) && Math.abs(slope) >= 0.01
    ? scrollTop + targetOffsetDeltaPx / slope : null;
  const markerWitnessed = candidate?.markerTextMatchCount === 1 && candidate?.markerVisible === true &&
    candidate?.markerIntersectsWindow === true && candidate?.markerIntersectsList === true;
  const rowWitnessed = candidate?.listFound === true && candidate?.rowMatchCount === 1 &&
    candidate?.rowIntersectsWindow === true && candidate?.rowIntersectsList === true;
  const scrollable = Number.isFinite(availableScrollRangePx) && availableScrollRangePx > 0;
  const targetInRange = scrollable && Number.isFinite(targetScrollTopPx) &&
    targetScrollTopPx >= -0.5 && targetScrollTopPx <= availableScrollRangePx + 0.5;
  return {
    markerWitnessed,
    rowWitnessed,
    scrollable,
    availableScrollRangePx: finite(availableScrollRangePx),
    expectedOffset: finite(expectedOffset),
    currentOffset: finite(rowOffset),
    targetOffsetDeltaPx: finite(targetOffsetDeltaPx),
    currentScrollTopPx: finite(scrollTop),
    targetScrollTopPx: finite(targetScrollTopPx),
    observedRowOffsetPerScrollTop: finite(slope),
    targetInRange,
    reachable: markerWitnessed && rowWitnessed && scrollable && targetInRange,
  };
}

export function assertAnchorScrollReachability(candidate, expectedOffset, scrollResponse, label) {
  const evidence = assessAnchorScrollReachability(candidate, expectedOffset, scrollResponse);
  if (!evidence.reachable) {
    const error = new Error(`${label}: marker visibility, real scroll range, and target offset must be reachable; ` +
      JSON.stringify(evidence));
    error.anchorReachability = evidence;
    error.anchorGeometry = {
      label,
      expectedOffset,
      lastCandidate: projectColdFailureViewportGeometry(candidate),
      reachability: evidence,
    };
    throw error;
  }
  return evidence;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function projectRect(value, extraFields = []) {
  if (!value || typeof value !== "object") return null;
  return {
    top: finite(value.top),
    bottom: finite(value.bottom),
    left: finite(value.left),
    right: finite(value.right),
    width: finite(value.width),
    height: finite(value.height),
    ...Object.fromEntries(extraFields.map(field => [field, finite(value[field])])),
  };
}

export function projectColdFailureCacheEvidence(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const anchor = snapshot.anchor;
  return {
    ready: snapshot.ready === true,
    reason: typeof snapshot.reason === "string" && snapshot.reason.length <= 128 ? snapshot.reason : null,
    manifestRevision: Number.isSafeInteger(snapshot.manifestRevision) ? snapshot.manifestRevision : null,
    entryRevision: Number.isSafeInteger(snapshot.entryRevision) ? snapshot.entryRevision : null,
    entrySlot: Number.isSafeInteger(snapshot.entrySlot) ? snapshot.entrySlot : null,
    entryKey: typeof snapshot.entryKey === "string" && /^[a-f0-9]{64}$/.test(snapshot.entryKey) ? snapshot.entryKey : null,
    entryBytes: Number.isSafeInteger(snapshot.entryBytes) ? snapshot.entryBytes : null,
    cachedProjectedMessageCount: Number.isSafeInteger(snapshot.cachedProjectedMessageCount)
      ? snapshot.cachedProjectedMessageCount : null,
    markerPresent: typeof snapshot.markerPresent === "boolean" ? snapshot.markerPresent : null,
    expectedAnchorPresent: typeof snapshot.expectedAnchorPresent === "boolean" ? snapshot.expectedAnchorPresent : null,
    expectedAnchorOffset: finite(snapshot.expectedAnchorOffset),
    anchorOffsetMatches: typeof snapshot.anchorOffsetMatches === "boolean" ? snapshot.anchorOffsetMatches : null,
    anchor: anchor && typeof anchor.messageId === "string" && Number.isFinite(anchor.offset) &&
      typeof anchor.followsLatest === "boolean"
      ? { messageId: anchor.messageId, offset: anchor.offset, followsLatest: anchor.followsLatest }
      : null,
  };
}

function hasVisibleUniqueMarker(candidate) {
  return candidate?.listFound === true && candidate?.markerTextMatchCount === 1 &&
    candidate?.markerVisible === true && candidate?.markerIntersectsWindow === true &&
    candidate?.markerIntersectsList === true && candidate?.rowIntersectsWindow === true &&
    candidate?.rowIntersectsList === true;
}

function directionalScrollRoom(scrollTop, range, direction) {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(range) || direction === 0) return null;
  return direction > 0 ? range - scrollTop : scrollTop;
}

export function projectColdFailureViewportGeometry(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const host = candidate.host && typeof candidate.host === "object" ? candidate.host : null;
  const row = candidate.row && typeof candidate.row === "object" ? candidate.row : null;
  return {
    listFound: candidate.listFound === true,
    viewport: candidate.viewport && typeof candidate.viewport === "object"
      ? { width: finite(candidate.viewport.width), height: finite(candidate.viewport.height) } : null,
    list: projectRect(candidate.list),
    host: host ? {
      testId: typeof host.testId === "string" && host.testId.length <= 128 ? host.testId : null,
      rect: projectRect(host.rect),
      scrollTop: finite(host.scrollTop),
      scrollHeight: finite(host.scrollHeight),
      clientHeight: finite(host.clientHeight),
    } : null,
    rowMatchCount: Number.isSafeInteger(candidate.rowMatchCount) ? candidate.rowMatchCount : null,
    markerTextMatchCount: Number.isSafeInteger(candidate.markerTextMatchCount) ? candidate.markerTextMatchCount : null,
    rowDomId: typeof candidate.rowDomId === "string" && candidate.rowDomId.length <= 4096 ? candidate.rowDomId : null,
    row: row ? projectRect(row, ["offsetFromList", "offsetFromHost"]) : null,
    rowIntersectsWindow: typeof candidate.rowIntersectsWindow === "boolean" ? candidate.rowIntersectsWindow : null,
    rowIntersectsList: typeof candidate.rowIntersectsList === "boolean" ? candidate.rowIntersectsList : null,
    markerVisible: typeof candidate.markerVisible === "boolean" ? candidate.markerVisible : null,
    markerIntersectsWindow: typeof candidate.markerIntersectsWindow === "boolean" ? candidate.markerIntersectsWindow : null,
    markerIntersectsList: typeof candidate.markerIntersectsList === "boolean" ? candidate.markerIntersectsList : null,
    marker: candidate.marker && typeof candidate.marker === "object"
      ? projectRect(candidate.marker, ["centerX", "centerY", "rangeClientRectCount"]) : null,
  };
}

export function projectColdFailureUiState(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const path = typeof snapshot.urlPath === "string" && snapshot.urlPath.startsWith("/") &&
    snapshot.urlPath.length <= 2048 ? snapshot.urlPath : null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    urlPath: path,
    cacheViewCount: count(snapshot.cacheViewCount),
    cacheStatusCount: count(snapshot.cacheStatusCount),
    retryButtonCount: count(snapshot.retryButtonCount),
    composerCount: count(snapshot.composerCount),
    promptUserRowCount: count(snapshot.promptUserRowCount),
    offline: typeof snapshot.offline === "boolean" ? snapshot.offline : null,
    offlineHttpRequestCount: count(snapshot.offlineHttpRequestCount),
    offlineNetworkResponseCount: count(snapshot.offlineNetworkResponseCount),
    offlineSocketCount: count(snapshot.offlineSocketCount),
    offlineTurnStartCount: count(snapshot.offlineTurnStartCount),
    pageErrorCount: count(snapshot.pageErrorCount),
  };
}
