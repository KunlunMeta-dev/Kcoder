import assert from "node:assert/strict";
import test from "node:test";
import { waitForAnchorGeometry } from "../suites/mobile/mobile-session-cache-cold-process.mjs";
import {
  assessAnchorScrollReachability,
  assessCounterWheelPreparation,
  assessFinalWheelMovement,
  assessPersistedAnchorReadiness,
  anchorOffsetWithinTolerance,
  assertColdOfflineBridgeStayedOffline,
  assertAnchorScrollReachability,
  observeAnchorScrollResponse,
  projectColdFailureCacheEvidence,
  projectColdOfflineBridgeEvidence,
  projectColdFailureUiState,
  projectColdFailureViewportGeometry,
} from "./mobile-session-cache-cold-diagnostics.mjs";

test("cold offline bridge evidence scopes to the second Chromium and omits RPC payloads", () => {
  const evidence = projectColdOfflineBridgeEvidence({
    firstSocketOrdinal: 4,
    routeDiagnostics: [
      { socketOrdinal: 3, clientToServerForwardCount: 6, upstreamMessageCount: 49, serverToClientForwardCount: 49 },
      { socketOrdinal: 4, clientToServerForwardCount: 0, upstreamMessageCount: 0, serverToClientForwardCount: 0 },
    ],
    requests: [
      { socketOrdinal: 3, method: "turn/start", params: { content: "PRIVATE_TRANSCRIPT" } },
    ],
  });

  assert.deepEqual(evidence, {
    observationBoundary: "Playwright routeWebSocket frame-forward counters on the cold Page; no Gateway-side request counter or handshake claim.",
    firstSocketOrdinal: 4,
    routeCallbackCount: 1,
    routeSocketOrdinals: [4],
    clientFrameCount: 0,
    upstreamFrameCount: 0,
    forwardedServerFrameCount: 0,
    rpcRequestCount: 0,
    rpcRequestMethods: [],
    evidenceComplete: true,
  });
  assert.strictEqual(assertColdOfflineBridgeStayedOffline(evidence), evidence);
  assert.equal(JSON.stringify(evidence).includes("PRIVATE_TRANSCRIPT"), false);
});

test("cold offline bridge audit fails closed for RPC requests, forwarded frames, and incomplete evidence", async t => {
  const base = {
    firstSocketOrdinal: 4,
    routeDiagnostics: [{ socketOrdinal: 4, clientToServerForwardCount: 0, upstreamMessageCount: 0,
      serverToClientForwardCount: 0 }],
    requests: [],
  };

  await t.test("client frames", () => {
    const evidence = projectColdOfflineBridgeEvidence({
      ...base,
      routeDiagnostics: [{ ...base.routeDiagnostics[0], clientToServerForwardCount: 1 }],
    });
    assert.equal(evidence.clientFrameCount, 1);
    assert.throws(() => assertColdOfflineBridgeStayedOffline(evidence), error =>
      error.offlineBridgeEvidence?.clientFrameCount === 1);
  });

  await t.test("server frames", () => {
    const evidence = projectColdOfflineBridgeEvidence({
      ...base,
      routeDiagnostics: [{ ...base.routeDiagnostics[0], upstreamMessageCount: 1, serverToClientForwardCount: 1 }],
    });
    assert.throws(() => assertColdOfflineBridgeStayedOffline(evidence), error =>
      error.offlineBridgeEvidence?.upstreamFrameCount === 1);
  });

  await t.test("RPC request records", () => {
    const evidence = projectColdOfflineBridgeEvidence({
      ...base,
      requests: [{ socketOrdinal: 4, method: "turn/start", clientMessageId: "PRIVATE_CLIENT_ID" }],
    });
    assert.deepEqual(evidence.rpcRequestMethods, ["turn/start"]);
    assert.equal(JSON.stringify(evidence).includes("PRIVATE_CLIENT_ID"), false);
    assert.throws(() => assertColdOfflineBridgeStayedOffline(evidence), error =>
      error.offlineBridgeEvidence?.rpcRequestCount === 1);
  });

  await t.test("audit overflow or missing route counters", () => {
    const overflowed = projectColdOfflineBridgeEvidence({ ...base, overflowed: true });
    assert.equal(overflowed.evidenceComplete, false);
    assert.throws(() => assertColdOfflineBridgeStayedOffline(overflowed));
    const incomplete = projectColdOfflineBridgeEvidence({
      ...base,
      routeDiagnostics: [{ socketOrdinal: 4, clientToServerForwardCount: null,
        upstreamMessageCount: 0, serverToClientForwardCount: 0 }],
    });
    assert.equal(incomplete.evidenceComplete, false);
    assert.throws(() => assertColdOfflineBridgeStayedOffline(incomplete));
  });
});

test("trusted counter-wheel opens measured room for the final gesture without losing the unique marker", () => {
  const start = {
    listFound: true,
    rowDomId: "message-user-1",
    rowMatchCount: 1,
    rowIntersectsWindow: true,
    rowIntersectsList: true,
    markerTextMatchCount: 1,
    markerVisible: true,
    markerIntersectsWindow: true,
    markerIntersectsList: true,
    host: { testId: "message-list", scrollTop: 413, scrollHeight: 1020, clientHeight: 607 },
    row: { offsetFromHost: 16 },
    marker: { top: 134, bottom: 173 },
  };
  const prepared = {
    ...start,
    host: { ...start.host, scrollTop: 389 },
    row: { offsetFromHost: -8 },
    marker: { top: 110, bottom: 149 },
  };
  const preparation = assessCounterWheelPreparation(start, prepared, {
    preparationDeltaY: 24,
    finalDeltaY: -48,
    expectedRowDomId: "message-user-1",
  });

  assert.equal(preparation.availableScrollRangePx, 413);
  assert.equal(preparation.expectedFinalScrollTopDirection, 1);
  assert.equal(preparation.initialFinalDirectionRoomPx, 0);
  assert.equal(preparation.startedAtFinalDirectionBoundary, true);
  assert.equal(preparation.finalDirectionalRoomPx, 24);
  assert.equal(preparation.openedFinalDirectionRoom, true);
  assert.equal(preparation.markerVisibleAfterPreparation, true);
  assert.equal(preparation.ready, true);

  const completed = {
    ...prepared,
    host: { ...prepared.host, scrollTop: 413 },
    row: { offsetFromHost: 16 },
    marker: { top: 134, bottom: 173 },
  };
  const finalMovement = assessFinalWheelMovement(preparation, prepared, completed);
  assert.equal(finalMovement.scrollTopDeltaPx, 24);
  assert.equal(finalMovement.actualScrollTopDirection, preparation.expectedFinalScrollTopDirection);
  assert.equal(finalMovement.markerVisible, true);
  assert.equal(finalMovement.ready, true);
});

test("counter-wheel preflight rejects no movement, clipped marker, row drift, or no final direction room", async t => {
  const start = {
    listFound: true,
    rowDomId: "message-user-1",
    rowMatchCount: 1,
    rowIntersectsWindow: true,
    rowIntersectsList: true,
    markerTextMatchCount: 1,
    markerVisible: true,
    markerIntersectsWindow: true,
    markerIntersectsList: true,
    host: { testId: "message-list", scrollTop: 413, scrollHeight: 1020, clientHeight: 607 },
  };
  const prepared = {
    ...start,
    host: { ...start.host, scrollTop: 389 },
  };
  const options = { preparationDeltaY: 24, finalDeltaY: -48, expectedRowDomId: start.rowDomId };

  await t.test("no preparatory movement", () => {
    assert.equal(assessCounterWheelPreparation(start, start, options).ready, false);
  });
  await t.test("the marker has left the usable viewport", () => {
    assert.equal(assessCounterWheelPreparation(start, {
      ...prepared,
      markerVisible: false,
      markerIntersectsWindow: false,
    }, options).ready, false);
  });
  await t.test("the measured target row changed", () => {
    assert.equal(assessCounterWheelPreparation(start, {
      ...prepared,
      rowDomId: "message-user-2",
    }, options).ready, false);
  });
  await t.test("the scroll range collapses before the final gesture", () => {
    const fromOffset = { ...start, host: { ...start.host, scrollTop: 24 } };
    const collapsedRange = {
      ...start,
      host: { ...start.host, scrollTop: 0, scrollHeight: 607, clientHeight: 607 },
    };
    const evidence = assessCounterWheelPreparation(fromOffset, collapsedRange, {
      preparationDeltaY: -24,
      finalDeltaY: 48,
      expectedRowDomId: start.rowDomId,
    });
    assert.equal(evidence.expectedFinalScrollTopDirection, 1);
    assert.equal(evidence.finalDirectionalRoomPx, 0);
    assert.equal(evidence.ready, false);
  });
});

test("final-wheel and persisted-anchor checks reject a stale preparatory offset", () => {
  assert.equal(anchorOffsetWithinTolerance(-8, 16), false);
  assert.equal(anchorOffsetWithinTolerance(16, 16), true);
  assert.equal(anchorOffsetWithinTolerance(20, 16), true);
  assert.equal(anchorOffsetWithinTolerance(21, 16), false);
  const stalePreparedAnchor = assessPersistedAnchorReadiness({
    ready: true,
    anchor: { messageId: "canonical-user-id", offset: -8, followsLatest: false },
  }, 16);
  assert.equal(stalePreparedAnchor.ready, false);
  assert.equal(stalePreparedAnchor.reason, "expected-reading-anchor-offset-mismatch");
  assert.equal(stalePreparedAnchor.anchorOffsetMatches, false);
  const finalGestureAnchor = assessPersistedAnchorReadiness({
    ready: true,
    anchor: { messageId: "canonical-user-id", offset: 16, followsLatest: false },
  }, 16);
  assert.equal(finalGestureAnchor.ready, true);
  assert.equal(finalGestureAnchor.anchorOffsetMatches, true);

  const latestAnchor = assessPersistedAnchorReadiness({
    ready: true,
    anchor: { messageId: "canonical-assistant-id", offset: 0, followsLatest: true },
  }, 0, 0, true);
  assert.equal(latestAnchor.ready, true);
  assert.equal(latestAnchor.anchorOffsetMatches, true);
  assert.equal(latestAnchor.anchorFollowsLatestMatches, true);
  const detachedAnchor = assessPersistedAnchorReadiness({
    ready: true,
    anchor: { messageId: "canonical-assistant-id", offset: 0, followsLatest: false },
  }, 0, 0, true);
  assert.equal(detachedAnchor.ready, false);
  assert.equal(detachedAnchor.reason, "expected-reading-anchor-follow-latest-mismatch");
  const displacedLatestAnchor = assessPersistedAnchorReadiness({
    ready: true,
    anchor: { messageId: "canonical-assistant-id", offset: 1, followsLatest: true },
  }, 0, 0, true);
  assert.equal(displacedLatestAnchor.ready, false);
  assert.equal(displacedLatestAnchor.reason, "expected-reading-anchor-offset-mismatch");

  const preparation = { expectedFinalScrollTopDirection: 1 };
  const start = { host: { testId: "message-list", scrollTop: 389, scrollHeight: 1020, clientHeight: 607 },
    rowDomId: "message-user-1", rowMatchCount: 1 };
  const rightDirection = { host: { testId: "message-list", scrollTop: 413, scrollHeight: 1020, clientHeight: 607 },
    rowDomId: "message-user-1", rowMatchCount: 1, listFound: true, markerTextMatchCount: 1,
    markerVisible: true, markerIntersectsWindow: true, markerIntersectsList: true,
    rowIntersectsWindow: true, rowIntersectsList: true };
  assert.equal(assessFinalWheelMovement(preparation, start, rightDirection).ready, true);
  assert.equal(assessFinalWheelMovement(preparation, start, {
    ...rightDirection,
    host: { ...rightDirection.host, scrollTop: 360 },
  }).ready, false);
});

test("cold anchor reachability uses the observed scroll axis and the exact visible marker", () => {
  const response = observeAnchorScrollResponse({
    startScrollTop: 20,
    startOffset: 60,
    endScrollTop: 60,
    endOffset: 100,
  });
  assert.deepEqual(response, {
    scrollTopDeltaPx: 40,
    rowOffsetDeltaPx: 40,
    rowOffsetPerScrollTop: 1,
  });
  const candidate = {
    listFound: true,
    rowMatchCount: 1,
    rowIntersectsWindow: true,
    rowIntersectsList: true,
    markerTextMatchCount: 1,
    markerVisible: true,
    markerIntersectsWindow: true,
    markerIntersectsList: true,
    host: { scrollTop: 120, scrollHeight: 900, clientHeight: 700 },
    row: { offsetFromHost: 44 },
  };

  const reachable = assessAnchorScrollReachability(candidate, 16, response);
  assert.equal(reachable.availableScrollRangePx, 200);
  assert.equal(reachable.targetScrollTopPx, 92);
  assert.equal(reachable.reachable, true);
  assert.deepEqual(assertAnchorScrollReachability(candidate, 16, response, "offline user anchor"), reachable);
});

test("cold anchor preflight fails closed for no range, unreachable direction, or hidden marker", async t => {
  const response = { rowOffsetPerScrollTop: 1 };
  const candidate = {
    listFound: true,
    rowMatchCount: 1,
    rowIntersectsWindow: true,
    rowIntersectsList: true,
    markerTextMatchCount: 1,
    markerVisible: true,
    markerIntersectsWindow: true,
    markerIntersectsList: true,
    host: { scrollTop: 0, scrollHeight: 684, clientHeight: 684 },
    row: { offsetFromHost: 44 },
  };

  await t.test("no physical scroll range", () => {
    const evidence = assessAnchorScrollReachability(candidate, 16, response);
    assert.equal(evidence.availableScrollRangePx, 0);
    assert.equal(evidence.targetOffsetDeltaPx, -28);
    assert.equal(evidence.targetInRange, false);
    assert.equal(evidence.reachable, false);
    assert.throws(() => assertAnchorScrollReachability(candidate, 16, response, "offline user anchor"),
      error => error.anchorReachability?.availableScrollRangePx === 0 &&
        error.anchorGeometry?.lastCandidate?.row?.offsetFromHost === 44);
  });

  await t.test("required raw scroll position is outside the available range", () => {
    const evidence = assessAnchorScrollReachability({
      ...candidate,
      host: { scrollTop: 0, scrollHeight: 900, clientHeight: 700 },
    }, 16, response);
    assert.equal(evidence.scrollable, true);
    assert.equal(evidence.targetScrollTopPx, -28);
    assert.equal(evidence.targetInRange, false);
  });

  await t.test("the row being visible cannot hide an offscreen marker", () => {
    const evidence = assessAnchorScrollReachability({
      ...candidate,
      host: { scrollTop: 120, scrollHeight: 900, clientHeight: 700 },
      markerVisible: false,
      markerIntersectsWindow: false,
    }, 16, response);
    assert.equal(evidence.rowWitnessed, true);
    assert.equal(evidence.markerWitnessed, false);
    assert.equal(evidence.reachable, false);
  });
});

test("cold cache failure evidence keeps anchor and revisions while omitting transcript and credentials", () => {
  const projected = projectColdFailureCacheEvidence({
    ready: true,
    reason: null,
    manifestRevision: 3,
    entryRevision: 2,
    entrySlot: 1,
    entryKey: "a".repeat(64),
    entryBytes: 412,
    cachedProjectedMessageCount: 2,
    markerPresent: true,
    expectedAnchorPresent: true,
    anchor: { messageId: "canonical-user-id", offset: 18, followsLatest: false },
    messages: [{ content: "PRIVATE_TRANSCRIPT_CONTENT", credential: "PRIVATE_TOKEN" }],
    scope: { authToken: "PRIVATE_SCOPE_CREDENTIAL" },
  });

  assert.deepEqual(projected, {
    ready: true,
    reason: null,
    manifestRevision: 3,
    entryRevision: 2,
    entrySlot: 1,
    entryKey: "a".repeat(64),
    entryBytes: 412,
    cachedProjectedMessageCount: 2,
    markerPresent: true,
    expectedAnchorPresent: true,
    expectedAnchorOffset: null,
    anchorOffsetMatches: null,
    anchor: { messageId: "canonical-user-id", offset: 18, followsLatest: false },
  });
  const serialized = JSON.stringify(projected);
  for (const secret of ["PRIVATE_TRANSCRIPT_CONTENT", "PRIVATE_TOKEN", "PRIVATE_SCOPE_CREDENTIAL"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("cold failure UI state retains bounded presence counters without user-visible text", () => {
  const projected = projectColdFailureUiState({
    urlPath: "/mobile/tasks/thread-fixture",
    cacheViewCount: 1,
    cacheStatusCount: 1,
    retryButtonCount: 1,
    composerCount: 0,
    promptUserRowCount: 1,
    offline: true,
    offlineHttpRequestCount: 6,
    offlineNetworkResponseCount: 4,
    offlineSocketCount: 0,
    offlineTurnStartCount: 0,
    pageErrorCount: 0,
    visibleText: "PRIVATE_TRANSCRIPT_CONTENT",
    token: "PRIVATE_TOKEN",
  });

  assert.deepEqual(projected, {
    urlPath: "/mobile/tasks/thread-fixture",
    cacheViewCount: 1,
    cacheStatusCount: 1,
    retryButtonCount: 1,
    composerCount: 0,
    promptUserRowCount: 1,
    offline: true,
    offlineHttpRequestCount: 6,
    offlineNetworkResponseCount: 4,
    offlineSocketCount: 0,
    offlineTurnStartCount: 0,
    pageErrorCount: 0,
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("PRIVATE_TRANSCRIPT_CONTENT"), false);
  assert.equal(serialized.includes("PRIVATE_TOKEN"), false);
});

test("cold failure viewport projection retains measured geometry but drops arbitrary DOM text", () => {
  const projected = projectColdFailureViewportGeometry({
    listFound: true,
    viewport: { width: 390, height: 844 },
    list: { top: 104, bottom: 711, left: 0, right: 390, width: 390, height: 607 },
    host: {
      testId: "message-list", rect: { top: 104, bottom: 711, left: 0, right: 390, width: 390, height: 607 },
      scrollTop: 48, scrollHeight: 656, clientHeight: 607,
    },
    rowMatchCount: 1,
    markerTextMatchCount: 1,
    rowDomId: "message-canonical-user-id",
    row: { top: 180, bottom: 230, left: 0, right: 380, width: 380, height: 50, offsetFromList: 76, offsetFromHost: 76 },
    rowIntersectsWindow: true,
    rowIntersectsList: true,
    markerVisible: true,
    markerIntersectsWindow: true,
    markerIntersectsList: true,
    marker: { top: 190, bottom: 207, left: 16, right: 200, width: 184, height: 17, centerX: 108, centerY: 198.5, rangeClientRectCount: 1 },
    visibleText: "PRIVATE_TRANSCRIPT_CONTENT",
  });

  assert.equal(projected.rowDomId, "message-canonical-user-id");
  assert.deepEqual(projected.host, {
    testId: "message-list",
    rect: { top: 104, bottom: 711, left: 0, right: 390, width: 390, height: 607 },
    scrollTop: 48,
    scrollHeight: 656,
    clientHeight: 607,
  });
  assert.equal(projected.row.offsetFromHost, 76);
  assert.equal(JSON.stringify(projected).includes("PRIVATE_TRANSCRIPT_CONTENT"), false);
});

test("anchor timeout carries its last bounded geometry candidate before page teardown", async () => {
  const candidate = {
    listFound: true,
    viewport: { width: 390, height: 844 },
    list: { top: 100, bottom: 700, left: 0, right: 390, width: 390, height: 600 },
    host: { testId: "message-list", rect: { top: 100, bottom: 700, left: 0, right: 390, width: 390, height: 600 },
      scrollTop: 0, scrollHeight: 656, clientHeight: 600 },
    rowMatchCount: 1,
    markerTextMatchCount: 0,
    rowDomId: "message-canonical-user-id",
    row: { top: 50, bottom: 100, left: 0, right: 380, width: 380, height: 50, offsetFromList: -50, offsetFromHost: -50 },
    rowIntersectsWindow: true,
    rowIntersectsList: false,
    visibleText: "PRIVATE_TRANSCRIPT_CONTENT",
  };
  const error = await waitForAnchorGeometry({
    page: {},
    rowDomId: candidate.rowDomId,
    rowTestId: "message-user",
    expectedOffset: 0,
    label: "cold user anchor",
    readTranscriptViewport: async (_page, options) => {
      assert.deepEqual(options, { rowDomId: candidate.rowDomId, rowTestId: "message-user" });
      return candidate;
    },
    assertOffsetNear: (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1),
    timeoutMs: 30,
    pollIntervalMs: 1,
  }).then(() => null, value => value);

  assert.match(error.message, /two consecutive same-anchor viewport readings/);
  assert.equal(error.anchorGeometry.label, "cold user anchor");
  assert.equal(error.anchorGeometry.expectedOffset, 0);
  assert.equal(error.anchorGeometry.lastCandidate.row.offsetFromHost, -50);
  assert.equal(error.anchorGeometry.lastCandidate.host.scrollHeight, 656);
  assert.equal(JSON.stringify(error.anchorGeometry).includes("PRIVATE_TRANSCRIPT_CONTENT"), false);
});

test("cold anchor convergence keeps the exact marker visible inside its unique user row", async () => {
  const candidate = {
    listFound: true,
    viewport: { width: 390, height: 844 },
    list: { top: 100, bottom: 700, left: 0, right: 390, width: 390, height: 600 },
    host: { testId: "message-list", rect: { top: 100, bottom: 700, left: 0, right: 390, width: 390, height: 600 },
      scrollTop: 0, scrollHeight: 656, clientHeight: 600 },
    rowMatchCount: 1,
    markerTextMatchCount: 1,
    rowDomId: "message-canonical-user-id",
    row: { top: 100, bottom: 900, left: 0, right: 380, width: 380, height: 800, offsetFromList: 0, offsetFromHost: 0 },
    rowIntersectsWindow: true,
    rowIntersectsList: true,
    markerVisible: false,
    markerIntersectsWindow: false,
    markerIntersectsList: false,
  };
  const calls = [];
  const error = await waitForAnchorGeometry({
    page: {},
    rowDomId: candidate.rowDomId,
    rowTestId: "message-user",
    markerText: "SESSION_CACHE_PROMPT_TEST",
    expectedOffset: 0,
    label: "cold user anchor",
    readTranscriptViewport: async (_page, options) => {
      calls.push(options);
      return candidate;
    },
    assertOffsetNear: (actual, expected) => assert.equal(actual, expected),
    timeoutMs: 30,
    pollIntervalMs: 1,
  }).then(() => null, value => value);

  assert.ok(calls.length > 0);
  assert.deepEqual(calls[0], {
    rowDomId: candidate.rowDomId,
    rowTestId: "message-user",
    markerText: "SESSION_CACHE_PROMPT_TEST",
  });
  assert.match(error.message, /two consecutive same-anchor viewport readings/);
  assert.equal(error.anchorGeometry.lastCandidate.markerVisible, false);
});
