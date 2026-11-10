import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function parseFrame(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function sha256(raw) {
  return createHash("sha256").update(String(raw)).digest("hex");
}

function safeMobilePath(page) {
  try {
    return new URL(page.url()).pathname
      .replace(/\/h\/[^/]+/g, "/h/[profile]")
      .replace(/\/task\/[^/]+/g, "/task/[thread]");
  } catch {
    return "[unavailable]";
  }
}

async function testIdState(page, testId) {
  try {
    const locator = page.getByTestId(testId);
    const count = await locator.count();
    return { count, visible: count === 1 ? await locator.isVisible() : false };
  } catch {
    return { count: null, visible: false };
  }
}

export function buildHeldRouteForwardWitness({
  held,
  routeForward,
  browserSocketOrdinal,
  browserRequestFrame,
  browserInitializeFrame,
  nativeUpstreamFrame,
  ownerBMarker,
  ownerBMarkersBeforeRelease,
  ownerBMarkersAfterRelease,
  aOnlyMarkers,
}) {
  const request = held?.response?.request;
  assert.ok(request, "held server response must retain its actual RPC request");
  assert.ok(routeForward, "held response must have a route.send forwarding record");
  assert.equal(routeForward.socketOrdinal, held.socketOrdinal,
    "client-facing route forwarding must remain on the exact held RPC socket");
  assert.equal(routeForward.request?.requestOrdinal, request.requestOrdinal);
  assert.equal(routeForward.request?.socketOrdinal, request.socketOrdinal);
  assert.equal(routeForward.request?.rawRequest, request.rawRequest);
  assert.equal(routeForward.responseOrdinal, held.response.responseOrdinal);
  assert.equal(routeForward.heldAtMs, held.heldAtMs);
  assert.equal(routeForward.rawResponse, held.rawResponse,
    "route.send must forward the unmodified held server frame");
  assert.equal(String(parseFrame(held.rawResponse)?.id), request.id);
  assert.equal(String(parseFrame(routeForward.rawResponse)?.id), request.id);
  assert.equal(browserRequestFrame.raw, request.rawRequest,
    "the Browser socket must have sent the exact held RPC request");
  assert.equal(browserRequestFrame.browserSocketOrdinal, browserSocketOrdinal);
  assert.equal(String(parseFrame(browserRequestFrame.raw)?.id), request.id);
  assert.equal(browserInitializeFrame.browserSocketOrdinal, browserSocketOrdinal);
  assert.equal(browserInitializeFrame.frame?.method, "initialize",
    "the same Browser socket must carry the matching Gateway RPC initialization");
  assert.ok(browserInitializeFrame.frameOrdinal < browserRequestFrame.frameOrdinal,
    "the exact Browser socket initialization must precede the held request");
  assert.equal(nativeUpstreamFrame.browserSocketOrdinal, browserSocketOrdinal);
  assert.equal(nativeUpstreamFrame.raw, held.rawResponse,
    "the native transport observation must match the exact upstream server response");
  assert.equal(String(parseFrame(nativeUpstreamFrame.raw)?.id), request.id);
  assert.deepEqual(ownerBMarkersBeforeRelease, [ownerBMarker],
    "B must be uniquely visible before the held response is forwarded");
  assert.deepEqual(ownerBMarkersAfterRelease, [ownerBMarker],
    "B must remain uniquely visible after forwarding the held response");
  for (const marker of aOnlyMarkers) {
    assert.equal(ownerBMarkersBeforeRelease.includes(marker), false,
      `owner B must not contain A marker ${marker} before forwarding`);
    assert.equal(ownerBMarkersAfterRelease.includes(marker), false,
      `owner B must not contain A marker ${marker} after forwarding`);
  }
  assert.ok(Number.isFinite(held.heldAtMs));
  assert.ok(Number.isFinite(routeForward.releasedAtMs));
  assert.ok(Number.isFinite(routeForward.forwardedAtMs));
  assert.ok(held.heldAtMs < routeForward.releasedAtMs,
    "the exact response must enter held state before release");
  assert.ok(routeForward.releasedAtMs <= routeForward.forwardedAtMs,
    "route.send forwarding must occur at or after release");

  return {
    evidenceBoundary: "Playwright WebSocketRoute.send client-facing forwarding record followed by visible Mobile B DOM state; no native Browser receive or app-dispatch claim",
    request: {
      id: request.id,
      method: request.method,
      threadId: request.threadId,
      beforeCursor: request.beforeCursor,
      requestOrdinal: request.requestOrdinal,
      gatewayRpcSocketOrdinal: request.socketOrdinal,
      rawRequestSha256: sha256(request.rawRequest),
    },
    browserRequest: {
      browserSocketOrdinal,
      frameOrdinal: browserRequestFrame.frameOrdinal,
      atMs: browserRequestFrame.atMs,
      exactRawMatch: true,
    },
    browserInitialize: {
      browserSocketOrdinal,
      frameOrdinal: browserInitializeFrame.frameOrdinal,
      exactRawMatch: true,
    },
    nativeUpstreamTransportObservation: {
      browserSocketOrdinal,
      frameOrdinal: nativeUpstreamFrame.frameOrdinal,
      atMs: nativeUpstreamFrame.atMs,
      responseId: String(parseFrame(nativeUpstreamFrame.raw)?.id),
      rawResponseSha256: sha256(nativeUpstreamFrame.raw),
      exactRawMatch: true,
      evidenceBoundary: "Playwright native upstream transport provenance; it does not prove route.send or Mobile receipt",
    },
    routeForward: {
      gatewayRpcSocketOrdinal: routeForward.socketOrdinal,
      responseId: String(parseFrame(routeForward.rawResponse)?.id),
      responseOrdinal: routeForward.responseOrdinal,
      rawResponseSha256: sha256(routeForward.rawResponse),
      heldAtMs: held.heldAtMs,
      releasedAtMs: routeForward.releasedAtMs,
      forwardedAtMs: routeForward.forwardedAtMs,
      exactOriginalServerResponse: true,
      sameHeldRequestIdentity: true,
      heldBeforeReleaseBeforeForward: true,
    },
    ownerBMarkersBeforeRelease,
    ownerBMarkersAfterRelease,
    noAContentPublishedIntoB: true,
  };
}

export async function runHeldOwnerSwitchReleasePhase({
  context,
  page,
  bridge,
  browserSockets,
  seededA,
  seededB,
  ownerBTitle,
  ownerBMarker,
  oldestMarker,
  aOnlyMarkers,
  expectedBeforeCursor,
  expectedOlderRangeEnd,
  waitFor,
  returnToHomeSessionsAndOpenThread,
  markerRowCount,
  readVisibleUserMarkers,
}) {
  assert.ok(seededB, "held owner-switch release requires a distinct real B thread");
  const socketBaselines = new Map(browserSockets.map((socket) => [socket.ordinal, {
    sentCount: socket.sentFrames.length,
    receivedCount: socket.receivedFrames.length,
  }]));
  await context.writeArtifactJson("mobile-transcript-pagination-owner-switch-browser-frame-baseline.json", {
    stage: "before-held-older-page-request",
    sockets: browserSockets.map((socket) => ({
      browserSocketOrdinal: socket.ordinal,
      sentCount: socket.sentFrames.length,
      receivedCount: socket.receivedFrames.length,
    })),
  });

  bridge.holdNextCursorResponse(seededA.threadId);
  await page.getByTestId("load-older-messages").click();
  const held = await waitFor(
    () => bridge.heldCursorResponse,
    30_000,
    "successful real A older-page response held before route.send",
  );
  const heldRead = held.response;
  assert.equal(heldRead.threadId, seededA.threadId);
  assert.equal(heldRead.success, true);
  assert.equal(heldRead.sourceMethod, "thread/read/indexed");
  assert.equal(heldRead.request?.beforeCursor, expectedBeforeCursor,
    "held response must match the exact current first-page cursor");
  assert.equal(heldRead.rangeStart, 0, "held older response must begin at the actual oldest source boundary");
  assert.equal(heldRead.rangeEnd, expectedOlderRangeEnd,
    "held older response must end at the current first-page boundary");
  assert.equal(heldRead.messageCount, expectedOlderRangeEnd,
    "held older response row count must match its real server range");
  assert.equal(heldRead.transcriptSnapshotStatus, "unavailable",
    "default owner-release gate must remain on ordinary observation, without activating a committed snapshot");
  assert.equal(heldRead.transcriptSnapshotCode, "legacyReader");
  assert.equal(heldRead.transcriptObservationPresent, true);
  assert.equal(heldRead.requestedObservationCursorMatchesObservationId, true);
  assert.ok(heldRead.userMarkers.includes(oldestMarker), "held A response must contain the oldest real A row");
  assert.ok(heldRead.request?.rawRequest, "held response must retain its exact real RPC request");
  assert.equal(await markerRowCount(page, oldestMarker), 0,
    "the oldest A row must remain unpublished while the real response is held");

  const heldRequest = heldRead.request;
  const requestCandidates = browserSockets.flatMap((socket) => {
    const baseline = socketBaselines.get(socket.ordinal) ?? { sentCount: 0, receivedCount: 0 };
    return socket.sentFrames.slice(baseline.sentCount).flatMap((frame, offset) =>
      frame.raw === heldRequest.rawRequest ? [{
        socket,
        frame,
        frameOrdinal: baseline.sentCount + offset + 1,
        baseline,
        socketOpenedAfterBaseline: !socketBaselines.has(socket.ordinal),
      }] : []);
  });
  assert.equal(requestCandidates.length, 1,
    "exact held request must occur once in Browser WebSocket frames after the pre-click baseline");
  const requestCandidate = requestCandidates[0];
  const socketInitializes = bridge.requests.filter((request) =>
    request.method === "initialize" && request.socketOrdinal === heldRequest.socketOrdinal);
  assert.equal(socketInitializes.length, 1,
    "the exact held RPC socket must have one real initialize request");
  const initializeMatches = requestCandidate.socket.sentFrames
    .map((frame, index) => ({ frame, frameOrdinal: index + 1 }))
    .filter(({ frame }) => frame.raw === socketInitializes[0].rawRequest);
  assert.equal(initializeMatches.length, 1,
    "the Browser socket that sent the held request must also send its exact initialize frame");
  const requestFrame = {
    ...requestCandidate.frame,
    frameOrdinal: requestCandidate.frameOrdinal,
    browserSocketOrdinal: requestCandidate.socket.ordinal,
  };
  const initializeFrame = {
    ...initializeMatches[0],
    frame: initializeMatches[0].frame.frame,
    browserSocketOrdinal: requestCandidate.socket.ordinal,
  };
  assert.equal(String(requestFrame.frame?.id), heldRequest.id);
  assert.equal(requestFrame.frame?.method, "thread/read/indexed");
  assert.equal(requestFrame.frame?.params?.threadId, seededA.threadId);
  assert.equal(requestFrame.frame?.params?.beforeCursor, heldRequest.beforeCursor);

  const baselineReceivedCount = requestCandidate.baseline.receivedCount;
  const nativeUpstreamMatches = requestCandidate.socket.receivedFrames
    .slice(baselineReceivedCount)
    .map((frame, index) => ({ frame, frameOrdinal: baselineReceivedCount + index + 1 }))
    .filter(({ frame }) => frame.raw === held.rawResponse && String(frame.frame?.id) === heldRequest.id);
  assert.equal(nativeUpstreamMatches.length, 1,
    "retain one exact native upstream transport observation for the held server response");
  const nativeUpstreamFrame = nativeUpstreamMatches[0];

  const navigationTrace = [];
  let navigationStep = "before-A-task-back";
  const navigationPathBeforeBack = safeMobilePath(page);
  await context.writeArtifactJson("mobile-transcript-pagination-owner-switch-navigation-stage.json", {
    stage: "before-A-task-back",
    path: navigationPathBeforeBack,
    expected: "reloaded A task route, then Back to profile home, then sessions and exact B row",
    heldOlderResponseStillUnforwarded: held.routeForward == null,
  });
  let navigation;
  try {
    navigation = await returnToHomeSessionsAndOpenThread(
      page,
      seededB.threadId,
      ownerBTitle,
      (event) => {
        navigationStep = event.step;
        navigationTrace.push(event);
      },
    );
  } catch (error) {
    await context.writeArtifactJson("mobile-transcript-pagination-owner-switch-navigation-failure.json", {
      phase: "navigate-from-A-to-B-before-held-response-release",
      lastNavigationStep: navigationStep,
      navigationTrace,
      pathBeforeBack: navigationPathBeforeBack,
      currentPath: safeMobilePath(page),
      currentRouteClass: (() => {
        const path = safeMobilePath(page);
        if (path.includes("/task/")) return "task";
        if (path === "/mobile/sessions") return "sessions";
        if (/^\/mobile\/h\/[^/]+$/.test(path)) return "profile-home";
        return "other-mobile-route";
      })(),
      visibleControls: {
        taskHeader: await testIdState(page, "task-header"),
        newWorkspace: await testIdState(page, "new-workspace"),
        sessions: await testIdState(page, "sessions"),
        sessionSearch: await testIdState(page, "session-search"),
      },
      heldOlderResponseStillUnforwarded: held.routeForward == null,
      error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    });
    throw error;
  }
  await page.getByTestId("message-user").filter({ hasText: ownerBMarker })
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await markerRowCount(page, ownerBMarker), 1);
  for (const marker of aOnlyMarkers) {
    assert.equal(await markerRowCount(page, marker), 0,
      `owner B must not contain A marker ${marker} before forwarding`);
  }
  const ownerBMarkersBeforeRelease = await readVisibleUserMarkers(page);
  assert.deepEqual(ownerBMarkersBeforeRelease, [ownerBMarker]);
  await context.writeArtifactJson("mobile-transcript-pagination-owner-switch-before-release.json", {
    stage: "B-visible-before-route-send-of-held-A-response",
    ownerBMarkersBeforeRelease,
    browserSocketOrdinal: requestCandidate.socket.ordinal,
    gatewayRpcSocketOrdinal: heldRequest.socketOrdinal,
    socketOpenedAfterBaseline: requestCandidate.socketOpenedAfterBaseline,
    socketBaseline: requestCandidate.baseline,
    initializeFrameOrdinal: initializeFrame.frameOrdinal,
    requestFrameOrdinal: requestFrame.frameOrdinal,
    requestFrameAtMs: requestFrame.atMs,
    requestId: heldRequest.id,
    requestOrdinal: heldRequest.requestOrdinal,
    method: heldRequest.method,
    threadId: heldRequest.threadId,
    beforeCursor: heldRequest.beforeCursor,
    heldAtMs: held.heldAtMs,
    nativeUpstreamFrameOrdinal: nativeUpstreamFrame.frameOrdinal,
    nativeUpstreamFrameAtMs: nativeUpstreamFrame.frame.atMs,
    nativeUpstreamFrameIsNotClientReceipt: true,
  });

  bridge.releaseHeldCursorResponse();
  const routeForward = await waitFor(
    () => held.routeForward,
    10_000,
    "exact held server response forwarded through Playwright WebSocketRoute.send after B became visible",
  );
  const ownerBMarkersAfterRelease = await readVisibleUserMarkers(page);
  await page.evaluate(() => new Promise((resolveFrame) =>
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  const settledOwnerBMarkersAfterRelease = await readVisibleUserMarkers(page);
  await context.writeArtifactJson("mobile-transcript-pagination-owner-switch-route-forward-observation.json", {
    stage: "route-send-call-returned-before-dom-gates",
    browserSocketOrdinal: requestCandidate.socket.ordinal,
    gatewayRpcSocketOrdinal: heldRequest.socketOrdinal,
    requestId: heldRequest.id,
    requestOrdinal: heldRequest.requestOrdinal,
    requestFrameOrdinal: requestFrame.frameOrdinal,
    nativeUpstreamFrameOrdinal: nativeUpstreamFrame.frameOrdinal,
    responseOrdinal: heldRead.responseOrdinal,
    heldAtMs: held.heldAtMs,
    releasedAtMs: routeForward.releasedAtMs,
    forwardedAtMs: routeForward.forwardedAtMs,
    exactHeldRawForwarded: routeForward.rawResponse === held.rawResponse,
    sameHeldRequestIdentity: routeForward.request === heldRead.request,
    ownerBMarkersBeforeRelease,
    ownerBMarkersAfterRouteSend: ownerBMarkersAfterRelease,
    ownerBMarkersAfterTwoAnimationFrames: settledOwnerBMarkersAfterRelease,
    evidenceBoundary: "route.send call and subsequent DOM inspection only; no native Browser receive or app-dispatch claim",
  });
  for (const marker of aOnlyMarkers) {
    assert.equal(await markerRowCount(page, marker), 0,
      `forwarded held response must not publish A marker ${marker} into B`);
  }
  assert.deepEqual(settledOwnerBMarkersAfterRelease, [ownerBMarker]);

  const routeForwardWitness = buildHeldRouteForwardWitness({
    held,
    routeForward,
    browserSocketOrdinal: requestCandidate.socket.ordinal,
    browserRequestFrame: requestFrame,
    browserInitializeFrame: initializeFrame,
    nativeUpstreamFrame: {
      ...nativeUpstreamFrame.frame,
      frameOrdinal: nativeUpstreamFrame.frameOrdinal,
      browserSocketOrdinal: requestCandidate.socket.ordinal,
    },
    ownerBMarker,
    ownerBMarkersBeforeRelease,
    ownerBMarkersAfterRelease: settledOwnerBMarkersAfterRelease,
    aOnlyMarkers,
  });
  await context.writeArtifactJson("mobile-transcript-pagination-owner-switch-route-forward-witness.json", {
    stage: "exact-held-A-response-route-forwarded-after-B-visible",
    ...routeForwardWitness,
  });
  return {
    held,
    navigation,
    ownerBMarkersBeforeRelease,
    ownerBMarkersAfterRelease: settledOwnerBMarkersAfterRelease,
    routeForwardWitness,
  };
}
