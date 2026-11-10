import assert from "node:assert/strict";
import test from "node:test";
import { createMobileLocalRelayTimingLaneDescriptor } from "./mobile-local-relay-timing-adapter.mjs";
import {
  assertDirectMobileTimingRoute,
  assertMobileTimingLaneServiceWorker,
  assertPairedTimingSetupEvidenceV1,
  buildMobileCacheTimingPlanV1,
  createDirectMobileTimingLaneDescriptor,
  createMobileTimingLaneRouteAudit,
  installMobileTimingLaneHttpGuard,
  normalizeRelayMobileTimingLaneV1,
  prepareRelayTimingLatestAnchorV1,
  runTrustedUserAnchorWheelSequenceV1,
  selectTrustedTranscriptWheelV1,
  runMobileCacheTimingSamplesV1,
  transcriptWheelPointV1,
  shouldContinueAfterTimingGroupV1,
  summarizePairedTimingSamplesV1,
  summarizeTimingByteEvidenceV1,
} from "./mobile-cache-timing-runner.mjs";

const directOrigin = "http://127.0.0.1:43001";
const relayOrigin = "http://127.0.0.1:43002";

function makeServiceWorkerLane() {
  const origin = "http://127.0.0.1:43003";
  const scopePath = "/g/relay-owned/mobile/";
  const workerPath = `${scopePath}__kcoder_offline_sw.js`;
  return {
    origin,
    scopePath,
    workerPath,
    assertRouteUrl(raw, kind) {
      const url = new URL(raw);
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, kind === "worker-scope" ? scopePath : workerPath);
    },
    safeSummary() {
      return { workerScope: scopePath, workerPath };
    },
  };
}

function serviceWorkerPage(lane, controllerScriptUrl) {
  return {
    evaluate: async () => ({
      supported: true,
      controllerScriptUrl,
      registrations: [{
        scope: `${lane.origin}${lane.scopePath}`,
        activeScriptUrl: `${lane.origin}${lane.workerPath}`,
        activeState: "activated",
      }],
    }),
  };
}

test("legacy direct timing descriptors retain root and mounted Mobile Web deployments", () => {
  const root = createDirectMobileTimingLaneDescriptor({
    gatewayUrl: `${directOrigin}/`,
    mobileUrl: `${directOrigin}/`,
  });
  assert.equal(root.mobilePath, "/");
  assert.equal(root.workerPath, "/__kcoder_offline_sw.js");
  assert.equal(root.workerScopePath, "/");
  assert.equal(assertDirectMobileTimingRoute(root, `${directOrigin}/`, "mobile"), true);
  assert.equal(assertDirectMobileTimingRoute(root, `${directOrigin}/api/mobile/session`, "api"), true);
  assert.equal(assertDirectMobileTimingRoute(root, `ws://127.0.0.1:43001/rpc?token=private`, "rpc"), true);

  const mounted = createDirectMobileTimingLaneDescriptor({
    gatewayUrl: `${directOrigin}/`,
    mobileUrl: `${directOrigin}/mobile/`,
  });
  assert.equal(mounted.workerPath, "/mobile/__kcoder_offline_sw.js");
  assert.equal(mounted.workerScopePath, "/mobile/");
  assert.equal(assertDirectMobileTimingRoute(mounted, `${directOrigin}/mobile/assets/entry.js`, "asset"), true);
  assert.throws(() => assertDirectMobileTimingRoute(mounted,
    "http://127.0.0.1:43002/mobile/assets/entry.js", "asset"), /owned origin/);
  assert.throws(() => assertDirectMobileTimingRoute(mounted,
    `${directOrigin}/mobile-other/assets/entry.js`, "asset"), /owned mount/);
  assert.throws(() => assertDirectMobileTimingRoute(mounted,
    `${directOrigin}/api/`, "api"), /owned mount/);
});

test("the real Relay descriptor normalizes through the paired runner lane selector", async () => {
  const gatewayPrefix = "/g/paired-contract";
  const gatewayUrl = `${relayOrigin}${gatewayPrefix}`;
  const relay = normalizeRelayMobileTimingLaneV1(createMobileLocalRelayTimingLaneDescriptor({
    origin: relayOrigin,
    gatewayBaseUrl: gatewayUrl,
    mobileEntryUrl: `${gatewayUrl}/mobile-entry`,
    mobileUrl: `${gatewayUrl}/mobile/`,
  }));
  assert.equal(relay.id, "relay");
  assert.equal(relay.gatewayPath, gatewayPrefix);
  assert.equal(relay.mobilePath, `${gatewayPrefix}/mobile/`);
  assert.equal(relay.mobileMountPath, `${gatewayPrefix}/mobile`);
  assert.equal(relay.rpcPath, `${gatewayPrefix}/rpc`);
  assert.equal(relay.workerPath, `${gatewayPrefix}/mobile/__kcoder_offline_sw.js`);
  assert.equal(relay.assertRouteUrl(`${relayOrigin}${gatewayPrefix}/mobile/assets/app.js`, "asset"), true);
  assert.equal(relay.safeSummary().mobilePath, "/g/<gateway>/mobile/");

  const threadId = "thread_seed";
  const directDescriptor = createDirectMobileTimingLaneDescriptor({
    gatewayUrl: `${directOrigin}/`,
    mobileUrl: `${directOrigin}/mobile/`,
  });
  const direct = {
    ...directDescriptor,
    taskPath: "/mobile/task/thread_seed",
    threadId,
    expectedScope: { threadId, routeProfileId: "direct-profile" },
    protocol: { requests: [] },
  };
  const relayLane = {
    ...relay,
    taskPath: `${gatewayPrefix}/mobile/task/thread_seed`,
    threadId,
    expectedScope: { threadId, routeProfileId: "relay-profile" },
    protocol: { requests: [] },
  };
  const openedLaneIds = [];
  const profileDir = "/owned/run/relay-lane-contract-profile";
  let owner = { pid: 8101, pgid: 9101 };
  const result = await runMobileCacheTimingSamplesV1({
    context: { redactText: value => String(value) },
    lanes: [direct, relayLane],
    createSamplePage: async () => { throw new Error("sample page must not be needed by this lane-contract test"); },
    openCacheObserverPage: async lane => {
      openedLaneIds.push(lane.id);
      throw new Error("stop after paired lane selection");
    },
    releaseTimingPage: async (_lane, _page, { restartAfterSample }) => {
      const old = owner;
      if (restartAfterSample) owner = { pid: old.pid + 1, pgid: old.pgid + 1 };
      return {
        status: "PASS",
        browserOwnerReleased: true,
        processGroupGone: true,
        sameProfileDir: true,
        restartRequested: restartAfterSample,
        oldPid: old.pid,
        oldPgid: old.pgid,
        newPid: restartAfterSample ? owner.pid : null,
        newPgid: restartAfterSample ? owner.pgid : null,
        profileDir,
        startupMs: restartAfterSample ? 1 : null,
      };
    },
    initialBrowserOwner: { pid: owner.pid, pgid: owner.pgid, profileDir },
    clientMessageIdHashKey: new Uint8Array(32),
    threadId,
    promptMarker: "seed-prompt",
    replacementMarker: "replacement-prompt",
    tailMarker: "seed-tail",
    expectedAssistantMessageId: "canonical-assistant",
    delays: [300],
    paired: true,
    pairedSetupEvidence: {
      directSeedTurnStartCount: 1,
      relayTurnStartCount: 0,
      relayBootstrapResumeCount: 1,
      relayBootstrapResumeSucceeded: true,
      relayBootstrapCacheReady: true,
      relayBootstrapRouteViolationCount: 0,
      relayBootstrapWorkerScopeMatched: true,
      relayBootstrapControllerPresent: false,
      relayBootstrapControllerState: "active-uncontrolled-bootstrap",
      directSeedOwnershipRelease: { allRouteEndpointsClosed: true, requiredRouteEndpointsClosed: true },
      relayBootstrapOwnershipRelease: { allRouteEndpointsClosed: true, requiredRouteEndpointsClosed: true },
    },
    browserErrors: [],
    readCacheReadiness: async () => { throw new Error("must not run before observer creation"); },
    installResumeBridge: async () => {},
    releaseTimingResponse: () => {},
    savePrivateScreenshot: async () => ({ saved: false, modeVerified: false }),
  });

  assert.deepEqual(openedLaneIds, ["direct", "relay"]);
  assert.deepEqual(result.lanes.map(lane => lane.id), ["direct", "relay"]);
  assert.deepEqual(result.samples.map(sample => sample.laneId), ["direct", "relay"]);
  assert.deepEqual(result.samples.map(sample => sample.status), ["FAIL", "FAIL"],
    "the test deliberately stops before cache observation; reaching both lane samples proves descriptor selection passed");
});

test("timing plans preserve direct-only behavior and pair every smoke or matrix sample", () => {
  const directSmoke = buildMobileCacheTimingPlanV1({ delays: [300] });
  assert.equal(directSmoke.groups.length, 1);
  assert.deepEqual(directSmoke.groups[0].laneOrder, ["direct"]);

  const pairedSmoke = buildMobileCacheTimingPlanV1({ delays: [300], paired: true });
  assert.equal(pairedSmoke.groups.length, 1);
  assert.deepEqual(pairedSmoke.groups[0].laneOrder, ["direct", "relay"]);
  assert.equal(pairedSmoke.groups[0].phase, "pilot");

  const delays = [0, 300, 600, 1000, 0, 300, 600, 1000, 0, 300,
    600, 1000, 0, 300, 600, 1000, 0, 300, 600, 1000];
  const pairedMatrix = buildMobileCacheTimingPlanV1({ delays, paired: true });
  assert.equal(pairedMatrix.groups.length, 21);
  assert.equal(pairedMatrix.groups.filter(group => group.phase === "formal").length, 20);
  assert.deepEqual(pairedMatrix.groups.slice(1).map(group => group.laneOrder[0]),
    ["direct", "relay", "direct", "relay", "direct", "relay", "direct", "relay", "direct", "relay",
      "direct", "relay", "direct", "relay", "direct", "relay", "direct", "relay", "direct", "relay"]);
  for (const delayMs of [0, 300, 600, 1000]) {
    assert.equal(pairedMatrix.groups.filter(group => group.phase === "formal" && group.delayMs === delayMs).length, 5);
  }
});

test("paired setup requires one direct seed turn, one successful Relay resume, and separate origin profiles", () => {
  const lanes = makePairedLanes();
  const evidence = {
    directSeedTurnStartCount: 1,
    relayTurnStartCount: 0,
    relayBootstrapResumeCount: 1,
    relayBootstrapResumeSucceeded: true,
    relayBootstrapCacheReady: true,
    relayBootstrapRouteViolationCount: 0,
    relayBootstrapWorkerScopeMatched: true,
    relayBootstrapControllerPresent: false,
    relayBootstrapControllerState: "active-uncontrolled-bootstrap",
    directSeedOwnershipRelease: { allRouteEndpointsClosed: true, requiredRouteEndpointsClosed: true },
    relayBootstrapOwnershipRelease: { allRouteEndpointsClosed: true, requiredRouteEndpointsClosed: true },
  };
  assert.deepEqual(assertPairedTimingSetupEvidenceV1(lanes, evidence), {
    directSeedTurnStartCount: 1,
    relayTurnStartCount: 0,
    relayBootstrapResumeCount: 1,
    relayBootstrapResumeSucceeded: true,
    relayBootstrapCacheReady: true,
    relayBootstrapRouteViolationCount: 0,
    relayBootstrapWorkerScopeMatched: true,
    relayBootstrapControllerPresent: false,
    relayBootstrapControllerState: "active-uncontrolled-bootstrap",
    directSeedOwnershipReleased: true,
    relayBootstrapOwnershipReleased: true,
    sharedThreadId: true,
    distinctMobileProfileIds: true,
    distinctOriginScopedStores: true,
  });
  assert.throws(() => assertPairedTimingSetupEvidenceV1(lanes, { ...evidence, relayTurnStartCount: 1 }), /must not create/);
  assert.throws(() => assertPairedTimingSetupEvidenceV1(lanes, { ...evidence, relayBootstrapResumeSucceeded: false }), /must succeed/);
  assert.throws(() => assertPairedTimingSetupEvidenceV1(lanes, { ...evidence, relayBootstrapWorkerScopeMatched: false }), /Service Worker/);
  assert.throws(() => assertPairedTimingSetupEvidenceV1(lanes, {
    ...evidence, relayBootstrapControllerPresent: true,
  }), /controller state must accurately distinguish/);
  assert.throws(() => assertPairedTimingSetupEvidenceV1(lanes, {
    ...evidence,
    directSeedOwnershipRelease: { allRouteEndpointsClosed: false, requiredRouteEndpointsClosed: true },
  }), /direct seed task Gateway client/);
  assert.throws(() => assertPairedTimingSetupEvidenceV1(lanes, {
    ...evidence,
    relayBootstrapOwnershipRelease: { allRouteEndpointsClosed: true, requiredRouteEndpointsClosed: false },
  }), /Relay bootstrap resume socket/);
  assert.throws(() => assertPairedTimingSetupEvidenceV1([
    lanes[0], { ...lanes[1], threadId: "another-thread" },
  ], evidence), /same seeded thread/);
});

test("a paired pilot or formal group continues only when both lane traffic records are complete", () => {
  const complete = ["direct", "relay"].map(laneId => ({
    laneId, status: "PASS", functionalStatus: "PASS", validForPerformance: true,
  }));
  assert.equal(shouldContinueAfterTimingGroupV1(complete), true);
  assert.equal(shouldContinueAfterTimingGroupV1([
    complete[0], { ...complete[1], validForPerformance: false },
  ]), false);
  assert.equal(shouldContinueAfterTimingGroupV1([
    complete[0], { ...complete[1], functionalStatus: "FAIL" },
  ]), false);
});

test("paired quantiles require all five valid same-delay pairs and use per-page durations", () => {
  const plan = buildMobileCacheTimingPlanV1({ delays: [300, 300, 300, 300, 300], paired: true });
  const formalPlans = plan.groups.filter(group => group.phase === "formal");
  const samples = formalPlans.flatMap((group, index) => [
    timingSample(group, "direct", 100 + index),
    timingSample(group, "relay", 120 + index),
  ]);
  const complete = summarizePairedTimingSamplesV1(samples, formalPlans).byRequestedHoldMs["300"];
  assert.equal(complete.quantilesEmitted, true);
  assert.equal(complete.metrics.navigationToAuthorityHistoryVisibleMs.direct.p50Ms, 102);
  assert.equal(complete.metrics.navigationToAuthorityHistoryVisibleMs.relay.p50Ms, 122);
  assert.equal(complete.metrics.navigationToAuthorityHistoryVisibleMs.relayMinusDirect.p50Ms, 20);

  const incomplete = summarizePairedTimingSamplesV1(
    samples.map((sample, index) => index === 0 ? { ...sample, validForPerformance: false } : sample), formalPlans,
  ).byRequestedHoldMs["300"];
  assert.equal(incomplete.validPairN, 4);
  assert.equal(incomplete.quantilesEmitted, false);
  assert.equal(incomplete.metrics.navigationToAuthorityHistoryVisibleMs.direct, null);
  assert.equal(incomplete.metrics.navigationToAuthorityHistoryVisibleMs.relayMinusDirect, null);
});

test("byte summary keeps unknown Content-Length bytes unknown", () => {
  const summary = summarizeTimingByteEvidenceV1({
    httpRequestBodyBytes: 37,
    httpResponseCount: 3,
    httpResponseContentLengthKnownCount: 2,
    httpResponseContentLengthBytes: 950,
    websocketSentFrameBytes: 40,
    websocketReceivedFrameBytes: 51,
    rpcRequestRecords: [
      { requestPayloadBytes: 5, responsePayloadBytes: 7 },
      { requestPayloadBytes: 3, responsePayloadBytes: null },
    ],
  });
  assert.equal(summary.httpRequestBodyPayloadBytes, 37);
  assert.equal(summary.httpResponseKnownContentLengthSumBytes, 950);
  assert.equal(summary.httpResponseContentLengthKnownCount, 2);
  assert.equal(summary.httpResponseContentLengthUnknownCount, 1);
  assert.equal(summary.httpResponseUnknownBytes, null);
  assert.deepEqual(summary.websocketPayloadBytes, { sent: 40, received: 51 });
  assert.deepEqual(summary.rpcPayloadBytes, { request: 8, response: 7 });
});

test("HTTP route guard continues exact lane routes and aborts foreign origins", async () => {
  const lane = createDirectMobileTimingLaneDescriptor({
    gatewayUrl: `${directOrigin}/`,
    mobileUrl: `${directOrigin}/mobile/`,
  });
  const listeners = new Map();
  let routeHandler;
  const page = {
    on(event, handler) { listeners.set(event, handler); },
    async route(_pattern, handler) { routeHandler = handler; },
  };
  const audit = createMobileTimingLaneRouteAudit("direct");
  await installMobileTimingLaneHttpGuard(page, lane, audit);
  const decisions = [];
  const validRequest = { url: () => `${directOrigin}/mobile/`, resourceType: () => "document" };
  await routeHandler({
    request: () => validRequest,
    continue: async () => decisions.push("continue"),
    abort: async () => decisions.push("abort"),
  });
  const foreignRequest = { url: () => "http://127.0.0.1:43002/mobile/assets/app.js", resourceType: () => "script" };
  listeners.get("request")(foreignRequest);
  await routeHandler({
    request: () => foreignRequest,
    continue: async () => decisions.push("continue"),
    abort: async () => decisions.push("abort"),
  });
  assert.deepEqual(decisions, ["continue", "abort"]);
  assert.equal(audit.requestCount, 2);
  assert.equal(audit.requestCountsByKind.mobile, 1);
  assert.equal(audit.requestCountsByKind["foreign-origin"], 1);
  assert.equal(audit.violations.length, 1);
  assert.equal(typeof listeners.get("websocket"), "function");
});

test("Relay bootstrap accepts its active worker before first-document control, while samples require control", async t => {
  const lane = makeServiceWorkerLane();
  const workerUrl = `${lane.origin}${lane.workerPath}`;
  const activeUncontrolled = serviceWorkerPage(lane, null);
  const bootstrap = await assertMobileTimingLaneServiceWorker(activeUncontrolled, lane, {
    allowUncontrolledBootstrap: true,
  });
  assert.equal(bootstrap.activeState, "activated");
  assert.equal(bootstrap.scopeMatchesLane, true);
  assert.equal(bootstrap.workerScriptMatchesLane, true);
  assert.equal(bootstrap.controllerPresent, false);
  assert.equal(bootstrap.controllerMatchesWorker, null);
  assert.equal(bootstrap.controllerState, "active-uncontrolled-bootstrap");

  await t.test("a timing sample rejects the same uncontrolled document", async () => {
    await assert.rejects(assertMobileTimingLaneServiceWorker(activeUncontrolled, lane),
      /timing sample must be controlled by the lane's exact active Service Worker/);
  });
  await t.test("an exact active controller passes the strict sample gate", async () => {
    const sample = await assertMobileTimingLaneServiceWorker(serviceWorkerPage(lane, workerUrl), lane);
    assert.equal(sample.controllerPresent, true);
    assert.equal(sample.controllerMatchesWorker, true);
    assert.equal(sample.controllerState, "controlled-by-active-worker");
  });
  await t.test("bootstrap still rejects a controller that does not match its active worker", async () => {
    await assert.rejects(assertMobileTimingLaneServiceWorker(
      serviceWorkerPage(lane, `${lane.origin}/g/another/mobile/__kcoder_offline_sw.js`),
      lane,
      { allowUncontrolledBootstrap: true },
    ), /controller must match the lane's exact active Service Worker/);
  });
});

for (const [preparedScrollTop, armedRowDomId] of [
  [0, "message-live-user-row"], [30, "message-live-user-row"], [30, "message-wrong-user-row"],
]) {
test(`Relay bootstrap uses the armed viewport after prepared scrollTop ${preparedScrollTop} for ${armedRowDomId}`, async () => {
  const marker = "SESSION_CACHE_PROMPT_RELAY";
  const tailMarker = "latest-tail-sentinel";
  const expectedUserAnchorMessageId = "canonical-user-1";
  const expectedAssistantMessageId = "canonical-assistant-1";
  let jumpClicked = false;
  let wheelDeltaY = null;
  let scrollTop = preparedScrollTop;
  let legacyArmCalls = 0;
  let atomicArmCalls = 0;
  let wheelCalls = 0;
  let wheelPoint = null;
  let initialUserGeometry = null;
  let wheelTargetInsideList = false;
  const userGeometry = () => {
    const markerTop = 110 + scrollTop;
    const markerBottom = 130 + scrollTop;
    return {
    listFound: true,
    rowMatchCount: 1,
    markerTextMatchCount: 1,
    markerVisible: true,
    markerIntersectsWindow: true,
    markerIntersectsList: markerBottom > 100 && markerTop < 700,
    rowIntersectsWindow: true,
    rowIntersectsList: true,
    rowDomId: "message-live-user-row",
    host: {
      testId: "message-list",
      rect: { top: 100, bottom: 700, left: 0, right: 390 },
      scrollTop,
      scrollHeight: 900,
      clientHeight: 600,
    },
    row: { offsetFromHost: 5 + scrollTop },
    marker: {
      top: markerTop,
      bottom: markerBottom,
      left: 56,
      right: 350,
      centerX: 203,
      centerY: 120 - scrollTop,
    },
    };
  };
  const tailGeometry = {
    rowMatchCount: 1,
    markerTextMatchCount: 1,
    markerVisible: true,
    markerIntersectsWindow: true,
    markerIntersectsList: true,
    rowDomId: `message-${encodeURIComponent(expectedAssistantMessageId)}`,
  };
  const page = {
    mouse: {
      async move(x, y) { wheelPoint = { x, y }; },
      async wheel(_x, deltaY) {
        wheelCalls += 1;
        wheelDeltaY = deltaY;
        const geometry = userGeometry();
        wheelTargetInsideList = wheelPoint && wheelPoint.x >= geometry.host.rect.left &&
          wheelPoint.x <= geometry.host.rect.right && wheelPoint.y >= geometry.host.rect.top &&
          wheelPoint.y <= geometry.host.rect.bottom && wheelPoint.x >= geometry.marker.left &&
          wheelPoint.x <= geometry.marker.right && wheelPoint.y >= geometry.marker.top &&
          wheelPoint.y <= geometry.marker.bottom;
        scrollTop = Math.min(300, Math.max(0, scrollTop - deltaY));
      },
    },
    getByTestId(testId) {
      assert.equal(testId, "jump-to-latest");
      return {
        count: async () => 1,
        waitFor: async ({ state, timeout }) => {
          assert.equal(state, "visible");
          assert.equal(timeout, 10_000);
        },
        isEnabled: async () => true,
        click: async () => {
          assert.equal(cacheCalls.length, 2, "the real latest click must follow a persisted detached wheel anchor");
          jumpClicked = true;
        },
      };
    },
  };
  const cacheCalls = [];
  const readinessRows = [
    { ready: true, anchorPresent: true, manifestRevision: 1,
      anchor: { messageId: "prior-canonical-message", offset: 0, followsLatest: true } },
    { ready: true, anchorPresent: true, manifestRevision: 2,
      anchor: { messageId: expectedUserAnchorMessageId, offset: 21, followsLatest: false } },
    { ready: true, anchorPresent: true, manifestRevision: 3,
      anchor: { messageId: expectedAssistantMessageId, offset: 0, followsLatest: true } },
  ];
  const preparation = prepareRelayTimingLatestAnchorV1({
    page,
    threadId: "thread-seed",
    gatewayOrigin: relayOrigin,
    marker,
    expectedScope: { threadId: "thread-seed", routeProfileId: "relay-profile" },
    expectedUserAnchorMessageId,
    expectedAssistantMessageId,
    tailMarker,
    readCacheReadiness: async options => {
      cacheCalls.push(options);
      return readinessRows[cacheCalls.length - 1];
    },
    prepareUserAnchorViewport: async () => {
      initialUserGeometry = userGeometry();
      return { rowDomId: "message-live-user-row", geometry: initialUserGeometry };
    },
    readTranscriptViewport: async (_page, options) => {
      if (options.markerText === tailMarker) return jumpClicked ? tailGeometry : null;
      return userGeometry();
    },
    armTrustedWheelObservation: async (_page, options) => {
      legacyArmCalls += 1;
      assert.deepEqual(options, {
        markerText: marker,
        rowDomId: "message-live-user-row",
        rowTestId: "message-user",
      });
      scrollTop = 0;
      return { scrollTop, scrollHeight: 900, clientHeight: 600 };
    },
    armTrustedWheelObservationWithViewport: async (_page, options) => {
      atomicArmCalls += 1;
      assert.deepEqual(options, {
        markerText: marker,
        rowDomId: "message-live-user-row",
        rowTestId: "message-user",
      });
      scrollTop = 0;
      return { ...userGeometry(), rowDomId: armedRowDomId,
        wheelStart: { scrollTop, scrollHeight: 900, clientHeight: 600 } };
    },
    readTrustedWheelTargetAtPoint: async () => ({
      targetInsideList: true,
      targetIsHost: false,
      pathReachesHost: true,
      targetPath: [
        { tagName: "DIV", testId: "message-user", isHost: false, scrollTop: 0, scrollHeight: 20, clientHeight: 20, rnwScrollable: false },
        { tagName: "DIV", testId: "message-list", isHost: true, scrollTop, scrollHeight: 900, clientHeight: 600, rnwScrollable: true },
      ],
    }),
    readTrustedWheelObservation: async () => ({
      events: [{ isTrusted: true, targetInsideList: wheelTargetInsideList, deltaY: wheelDeltaY,
        targetPath: [
          { tagName: "DIV", testId: "message-user", isHost: false, scrollTop: 0, scrollHeight: 20, clientHeight: 20, rnwScrollable: false },
          { tagName: "DIV", testId: "message-list", isHost: true, scrollTop: 0, scrollHeight: 900, clientHeight: 600, rnwScrollable: true },
        ], defaultPreventedAfterDispatch: true, hostScrollTopAtCapture: 0,
        hostScrollTopAfterDispatch: scrollTop, hostScrollTopAfterFrame: scrollTop }],
      scrollSamples: [{ source: "wheel-frame", targetIsHost: true, hostScrollTop: scrollTop }],
    }),
  });

  if (armedRowDomId !== "message-live-user-row") {
    await assert.rejects(preparation, /armed Relay viewport must retain the prepared exact user row/);
    assert.equal(wheelCalls, 0, "a changed row identity must fail before trusted input");
    return;
  }
  const result = await preparation;

  assert.equal(wheelDeltaY, -16);
  assert.equal(wheelCalls, 1, "a changed prepare-to-arm offset must not retry the trusted wheel");
  assert.equal(legacyArmCalls, 0, "the Relay entry must explicitly request the atomic arm API");
  assert.equal(atomicArmCalls, 1);
  assert.equal(result.wheel.scrollTopBefore, 0, "movement evidence must use the armed snapshot");
  assert.equal(initialUserGeometry.host.scrollTop, preparedScrollTop,
    "the separate preparation snapshot remains preparation evidence");
  assert.ok(wheelTargetInsideList);
  assert.ok(wheelPoint.x >= initialUserGeometry.marker.left && wheelPoint.x <= initialUserGeometry.marker.right);
  assert.ok(wheelPoint.y >= initialUserGeometry.host.rect.top && wheelPoint.y <= initialUserGeometry.host.rect.bottom);
  assert.ok(wheelPoint.y >= 110 && wheelPoint.y <= 130,
    "Relay wheel target must lie inside the exact marker/list intersection");
  assert.equal(jumpClicked, true);
  assert.equal(cacheCalls.length, 3);
  assert.equal("requireReadingAnchor" in cacheCalls[0], false,
    "bootstrap must first prove the real transcript record without requiring an anchor");
  assert.equal("expectedAnchorMessageId" in cacheCalls[0], false);
  assert.equal(cacheCalls[1].expectedAnchorMessageId, expectedUserAnchorMessageId);
  assert.equal(cacheCalls[1].expectedAnchorOffset, 21);
  assert.equal(cacheCalls[1].expectedAnchorFollowsLatest, false);
  assert.equal(cacheCalls[2].expectedAnchorMessageId, expectedAssistantMessageId);
  assert.equal(cacheCalls[2].expectedAnchorOffset, 0);
  assert.equal(cacheCalls[2].expectedAnchorFollowsLatest, true);
  assert.equal(cacheCalls[2].minimumManifestRevision, 3);
  assert.equal(result.detachedAnchor.persisted, true);
  assert.equal(result.initialRecord.initialAnchorPresent, true,
    "the bootstrap summary records an existing anchor without depending on its identity or requiring its absence");
  assert.equal(result.latestAnchor.persisted, true);
  assert.equal(result.latestAnchor.tailRowMatchesCanonicalAssistant, true);
  assert.equal(result.wheel.targetPoint.x, wheelPoint.x);
  assert.equal(result.wheel.targetPoint.y, wheelPoint.y);
  assert.equal(result.wheel.dispatch.defaultPreventedAfterDispatch, true);
});
}

test("trusted transcript wheel point stays inside the visible marker/list intersection", () => {
  const geometry = userAnchorWheelGeometry();
  assert.ok(geometry.marker.centerY < geometry.host.rect.top,
    "the captured marker center reproduces the boundary point outside the message list");
  const point = transcriptWheelPointV1(geometry);
  assert.equal(point.y, 114.5);
  assert.equal(point.x, geometry.marker.centerX);
  assert.ok(point.x > geometry.host.rect.left && point.x < geometry.host.rect.right);
  assert.ok(point.y > geometry.host.rect.top && point.y < geometry.host.rect.bottom);
  const overscrolled = userAnchorWheelGeometry({ scrollTop: 24 });
  assert.equal(overscrolled.marker.bottom, 101,
    "a fixed +24 wheel would move this partial marker above the host top at 104px");
  assert.equal(overscrolled.markerIntersectsList, false);
  assert.throws(() => transcriptWheelPointV1(userAnchorWheelGeometry({ markerTop: 50, markerBottom: 80 })),
    /visible intersection/);
});

const inertTranscriptTarget = (scrollTop = 543, scrollHeight = 1_164, clientHeight = 621) => ({
  targetInsideList: true,
  targetIsHost: false,
  pathReachesHost: true,
  targetPath: [
    { tagName: "DIV", testId: "message-user", isHost: false, scrollTop: 0, scrollHeight: 47, clientHeight: 47, rnwScrollable: false },
    { tagName: "DIV", testId: "message-list", isHost: true, scrollTop, scrollHeight, clientHeight, rnwScrollable: true },
  ],
});

test("RNW inverted transcript wheel selection uses the measured target and boundaries", async t => {
  await t.test("at the old edge it chooses a small inward delta and preserves the visible marker", async () => {
    const start = invertedUserAnchorGeometry({ scrollTop: 543, markerTop: 133, markerBottom: 180 });
    const target = inertTranscriptTarget(543);
    const selected = selectTrustedTranscriptWheelV1(start, target);
    assert.equal(selected.deltaY, 16);
    assert.equal(selected.expectedScrollTop, 527);
    assert.equal(selected.availableRoom, 28);
    const hostTarget = {
      targetInsideList: true,
      targetIsHost: true,
      pathReachesHost: true,
      targetPath: [target.targetPath.at(-1)],
    };
    assert.throws(() => selectTrustedTranscriptWheelV1(start, hostTarget),
      /host-target wheel uses a different targetDelta algorithm/,
    "the host event target follows RNW targetDelta handling and must fail closed");
    assert.throws(() => selectTrustedTranscriptWheelV1(start, inertTranscriptTarget(542)),
      /same measured list snapshot/);

    let scrollTop = 543;
    let pointer = null;
    const events = [];
    const page = { mouse: {
      async move(x, y) { pointer = { x, y }; },
      async wheel(_x, deltaY) {
        const before = scrollTop;
        scrollTop = Math.max(0, Math.min(543, scrollTop - deltaY));
        const moved = Math.abs(scrollTop - before) > 0.5;
        events.push({ deltaY, isTrusted: true, targetInsideList: Boolean(pointer),
          targetPath: target.targetPath, defaultPreventedAfterDispatch: true,
          hostScrollTopAtCapture: before, hostScrollTopAfterDispatch: scrollTop,
          hostScrollTopAfterFrame: scrollTop });
        if (!moved) throw new Error("source-shaped RNW wheel did not move the measured host");
      },
    } };
    const result = await runTrustedUserAnchorWheelSequenceV1({
      page,
      markerText: "SESSION_CACHE_PROMPT",
      rowDomId: "message-canonical-user",
      initialGeometry: start,
      wheelStart: { scrollTop, scrollHeight: 1_164, clientHeight: 621 },
      readTranscriptViewport: async () => invertedUserAnchorGeometry({ scrollTop, markerTop: 133, markerBottom: 180 }),
      readTrustedWheelTargetAtPoint: async () => target,
      readTrustedWheelObservation: async () => ({ events: [...events], scrollSamples: [
        { source: "wheel-frame", targetIsHost: true, hostScrollTop: scrollTop },
      ] }),
    });
    assert.deepEqual(events.map(event => event.deltaY), [16]);
    assert.equal(events[0].hostScrollTopAfterDispatch, 527);
    assert.equal(result.afterWheelGeometry.host.scrollTop, 527);
    assert.equal(result.afterWheelGeometry.rowDomId, "message-canonical-user");
    assert.equal(result.afterWheelGeometry.markerIntersectsList, true);
    assert.equal(result.finalWheel.dispatch.defaultPreventedAfterDispatch, true);
  });

  await t.test("at the opposite boundary it uses negative input only when both host and marker have room", () => {
    const geometry = invertedUserAnchorGeometry({
      scrollTop: 0, anchorScrollTop: 0, scrollHeight: 676, clientHeight: 621,
      markerTop: 120, markerBottom: 167,
    });
    const selected = selectTrustedTranscriptWheelV1(geometry, inertTranscriptTarget(0, 676, 621));
    assert.equal(selected.deltaY, -16);
    assert.equal(selected.expectedScrollTop, 16);
  });

  await t.test("partial-marker geometry caps the delta and nested scroll targets fail closed", () => {
    const partial = invertedUserAnchorGeometry({
      scrollTop: 16, anchorScrollTop: 16, scrollHeight: 676, clientHeight: 621,
      markerTop: 105, markerBottom: 125,
    });
    const partialTarget = inertTranscriptTarget(16, 676, 621);
    const selected = selectTrustedTranscriptWheelV1(partial, partialTarget);
    assert.equal(selected.deltaY, -16);
    assert.throws(() => selectTrustedTranscriptWheelV1(partial, {
      ...partialTarget,
      targetPath: [
        { ...partialTarget.targetPath[0], rnwScrollable: true },
        ...partialTarget.targetPath.slice(1),
      ],
    }), /nested scrollable hit targets/);
    assert.throws(() => selectTrustedTranscriptWheelV1(partial, {
      ...partialTarget, targetInsideList: false,
    }), /hit target must be inside the list/);
  });
});

function invertedUserAnchorGeometry({
  scrollTop = 543, anchorScrollTop = 543, scrollHeight = 1_164, clientHeight = 621,
  markerTop = 133, markerBottom = 180,
} = {}) {
  const host = {
    testId: "message-list",
    rect: { top: 104, bottom: 725, left: 0, right: 390 },
    scrollTop,
    scrollHeight,
    clientHeight,
  };
  const shift = scrollTop - anchorScrollTop;
  const marker = {
    top: markerTop + shift,
    bottom: markerBottom + shift,
    left: 56,
    right: 342,
    width: 286,
    height: markerBottom - markerTop,
    centerX: 199,
    centerY: (markerTop + markerBottom) / 2 + shift,
  };
  return {
    listFound: true,
    rowMatchCount: 1,
    markerTextMatchCount: 1,
    markerVisible: true,
    markerIntersectsWindow: true,
    markerIntersectsList: marker.bottom > host.rect.top && marker.top < host.rect.bottom,
    rowIntersectsWindow: true,
    rowIntersectsList: true,
    rowDomId: "message-canonical-user",
    host,
    row: { offsetFromHost: 16 + shift },
    marker,
  };
}

function userAnchorWheelGeometry({ scrollTop = 0, markerTop = 78, markerBottom = 125 } = {}) {
  const host = {
    testId: "message-list",
    rect: { top: 104, bottom: 725, left: 0, right: 390 },
    scrollTop,
    scrollHeight: 676,
    clientHeight: 621,
  };
  const top = markerTop - scrollTop;
  const bottom = markerBottom - scrollTop;
  const markerIntersectsList = bottom > host.rect.top && top < host.rect.bottom;
  return {
    listFound: true,
    rowMatchCount: 1,
    markerTextMatchCount: 1,
    markerVisible: true,
    markerIntersectsWindow: true,
    markerIntersectsList,
    rowIntersectsWindow: true,
    rowIntersectsList: true,
    rowDomId: "message-canonical-user",
    host,
    row: { offsetFromHost: -39 - scrollTop },
    marker: {
      top,
      bottom,
      left: 56.84,
      right: 350.19,
      centerX: (56.84 + 350.19) / 2,
      centerY: (top + bottom) / 2,
    },
  };
}

test("paired pre-page cache-readiness failures release the owner and fail closed", async t => {
  await t.test("a successful owner release gives the next lane a new process", async () => {
    const { result, releases, samplePageCreateCount } = await runPairedPrePageCacheReadinessFailure();
    assert.equal(samplePageCreateCount, 0);
    assert.equal(releases.length, 2);
    assert.deepEqual(releases.map(release => release.page), [null, null]);
    assert.deepEqual(releases.map(release => release.oldPid), [4101, 4102],
      "the next paired lane must use a new process after the early failed lane releases its owner");
    assert.equal(releases[0].restartAfterSample, true);
    assert.equal(releases[1].restartAfterSample, false);
    assert.deepEqual(result.samples.map(sample => sample.status), ["FAIL", "FAIL"]);
    assert.deepEqual(result.samples.map(sample => sample.ownershipReleaseError), [null, null]);
  });
  await t.test("an unproven owner release prevents the next lane from reusing that process", async () => {
    const { result, releases, samplePageCreateCount } = await runPairedPrePageCacheReadinessFailure({ failOwnerRelease: true });
    assert.equal(samplePageCreateCount, 0);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].page, null);
    assert.equal(result.samples[0].ownershipReleaseError !== null, true);
    assert.equal(result.samples[1].status, "NOT_RUN_AFTER_BROWSER_OWNER_RELEASE_FAILURE");
  });
});

test("pre-page failure transfers every current entry observer for close without a stale task socket", async () => {
  const { releases, closedObservers } = await runPairedPrePageCacheReadinessFailure();
  assert.deepEqual(releases.map(release => release.requiredSocketOrdinal), [null, null]);
  assert.deepEqual(releases.map(release => release.firstRouteSocketOrdinal), [7, 11]);
  assert.deepEqual(releases.map(release => release.firstPageRpcOrdinal), [7, 11]);
  assert.equal(releases[0].observerPages.length, 2, "both initial entry pages belong to the old Browser owner");
  assert.equal(releases[1].observerPages.length, 1, "the next owner must receive only its new observer");
  assert.equal(new Set(closedObservers).size, 3, "old owner observer references cannot survive a relaunch");
});

test("sample Page failure releases only that sample's post-baseline resume socket", async () => {
  const { releases, samplePageCreateCount } = await runPairedPrePageCacheReadinessFailure({ taskNavigationFailure: true });
  assert.equal(samplePageCreateCount, 2);
  assert.deepEqual(releases.map(release => release.firstRouteSocketOrdinal), [7, 11]);
  assert.deepEqual(releases.map(release => release.firstPageRpcOrdinal), [7, 11]);
  assert.deepEqual(releases.map(release => release.requiredSocketOrdinal), [8, 12]);
  assert.ok(releases.every(release => release.page?.protocol.requests.some(request =>
    request.method === "thread/resume" && request.threadId === "thread_seed" &&
    request.socketOrdinal === release.requiredSocketOrdinal)));
});

async function runPairedPrePageCacheReadinessFailure({ failOwnerRelease = false, taskNavigationFailure = false } = {}) {
  const closedObservers = [];
  const observerPage = () => {
    const page = { async close() { closedObservers.push(page); } };
    return page;
  };
  const lanes = makePairedLanes().map((lane, index) => ({
    ...lane,
    gatewayUrl: `${lane.origin}/g/owned/mobile-entry`,
    mobileUrl: `${lane.origin}/g/owned/mobile/`,
    taskPath: "/g/owned/mobile/task/thread_seed",
    assertRouteUrl: () => true,
    safeSummary: () => ({ lane: lane.id, origin: lane.origin }),
    initialPage: observerPage(),
    protocol: { requests: [], nextSocketOrdinal: index === 0 ? 7 : 11,
      nextPageRpcSocketOrdinal: index === 0 ? 7 : 11 },
  }));
  const pairedSetupEvidence = {
    directSeedTurnStartCount: 1,
    relayTurnStartCount: 0,
    relayBootstrapResumeCount: 1,
    relayBootstrapResumeSucceeded: true,
    relayBootstrapCacheReady: true,
    relayBootstrapRouteViolationCount: 0,
    relayBootstrapWorkerScopeMatched: true,
    relayBootstrapControllerPresent: false,
    relayBootstrapControllerState: "active-uncontrolled-bootstrap",
    directSeedOwnershipRelease: { allRouteEndpointsClosed: true, requiredRouteEndpointsClosed: true },
    relayBootstrapOwnershipRelease: { allRouteEndpointsClosed: true, requiredRouteEndpointsClosed: true },
  };
  const profileDir = "/owned/run/profile";
  let currentOwner = { pid: 4101, pgid: 5101, profileDir };
  const releases = [];
  let samplePageCreateCount = 0;
  const result = await runMobileCacheTimingSamplesV1({
    context: { redactText: value => String(value) },
    lanes,
    createSamplePage: async () => {
      samplePageCreateCount += 1;
      assert.equal(taskNavigationFailure, true, "pre-page failure must not create a task Page");
      const page = { on() {}, off() {}, async close() {}, async setViewportSize() {}, async route() {},
        async evaluate() {}, async exposeBinding() { return { async dispose() {} }; },
        async addInitScript() { return { async dispose() {} }; },
        async goto() {
          const protocol = page.protocol;
          const request = { method: "thread/resume", threadId: "thread_seed", socketOrdinal: ++protocol.nextSocketOrdinal };
          protocol.nextPageRpcSocketOrdinal += 1;
          protocol.requests.push(request); protocol.timingSample.request = request;
          throw new Error("task navigation failed after its exact resume request");
        } };
      return page;
    },
    openCacheObserverPage: async () => observerPage(),
    releaseTimingPage: async (lane, page, release) => {
      const { restartAfterSample, observerPages = [] } = release;
      const oldOwner = currentOwner;
      releases.push({ ...release, lane: lane.id, page, oldPid: oldOwner.pid });
      for (const observer of observerPages) await observer.close();
      if (failOwnerRelease) throw new Error("the exact Chromium process group did not stop");
      if (restartAfterSample) currentOwner = { ...oldOwner, pid: oldOwner.pid + 1, pgid: oldOwner.pgid + 1 };
      return {
        status: "PASS",
        browserOwnerReleased: true,
        processGroupGone: true,
        sameProfileDir: true,
        restartRequested: restartAfterSample,
        oldPid: oldOwner.pid,
        oldPgid: oldOwner.pgid,
        newPid: restartAfterSample ? currentOwner.pid : null,
        newPgid: restartAfterSample ? currentOwner.pgid : null,
        profileDir,
        startupMs: restartAfterSample ? 5 : null,
      };
    },
    initialBrowserOwner: { pid: 4101, pgid: 5101, profileDir },
    clientMessageIdHashKey: new Uint8Array(32),
    threadId: "thread_seed",
    promptMarker: "prompt",
    replacementMarker: "replacement",
    tailMarker: "tail",
    expectedAssistantMessageId: "canonical-assistant",
    delays: [300],
    paired: true,
    pairedSetupEvidence,
    browserErrors: [],
    readCacheReadiness: async () => ({ ready: taskNavigationFailure, reason: "cache-record-not-ready" }),
    installResumeBridge: async (_lane, page, protocol) => { page.protocol = protocol; },
    releaseTimingResponse: () => {},
    savePrivateScreenshot: async () => ({ saved: false }),
  });
  return { result, releases, samplePageCreateCount, closedObservers };
}

function makePairedLanes() {
  return [
    { id: "direct", threadId: "thread_seed", origin: directOrigin,
      expectedScope: { threadId: "thread_seed", routeProfileId: "direct-profile" } },
    { id: "relay", threadId: "thread_seed", origin: relayOrigin,
      expectedScope: { threadId: "thread_seed", routeProfileId: "relay-profile" } },
  ];
}

function timingSample(group, laneId, value) {
  return {
    laneId,
    pairId: group.pairId,
    requestedHoldMs: group.delayMs,
    status: "PASS",
    functionalStatus: "PASS",
    validForPerformance: true,
    browser: { navigationToAuthorityHistoryVisibleMs: value },
  };
}
