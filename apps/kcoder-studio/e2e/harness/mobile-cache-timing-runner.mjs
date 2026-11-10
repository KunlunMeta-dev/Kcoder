import assert from "node:assert/strict";
import { waitFor } from "./run-context.mjs";
import {
  assessCacheTimingSamplePerformanceValidity,
  installCacheTimingTelemetry,
  snapshotCacheTimingTraffic,
} from "./mobile-cache-timing-telemetry.mjs";
import { setupCacheTimingSamplePage } from "./mobile-cache-timing-sample-setup.mjs";

export const MOBILE_CACHE_TIMING_RUNNER_VERSION = 1;

const TIMING_METRICS = Object.freeze([
  "navigationToCacheReadableMs",
  "navigationToAuthorityHistoryVisibleMs",
  "cacheReadableToAuthorityHistoryVisibleMs",
  "navigationToComposerReadyMs",
  "authorityHistoryToComposerReadyMs",
]);
const MOBILE_WORKER_FILENAME = "__kcoder_offline_sw.js";

/** Preserve the original direct pilot and interleaved matrix schedule. */
export function buildMobileCacheTimingPlanV1({ delays, paired = false } = {}) {
  if (!Array.isArray(delays) || delays.length < 1 ||
      delays.some(delay => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new TypeError("Cache timing plan requires a non-empty list of non-negative integer delays");
  }
  const matrixMode = delays.length > 1;
  if (paired) {
    const groups = [{
      phase: "pilot",
      index: 0,
      delayMs: 300,
      pairId: "pilot-300ms",
      laneOrder: ["direct", "relay"],
    }];
    if (matrixMode) {
      delays.forEach((delayMs, index) => groups.push({
        phase: "formal",
        index: index + 1,
        delayMs,
        pairId: `formal-${String(index + 1).padStart(2, "0")}`,
        laneOrder: index % 2 === 0 ? ["direct", "relay"] : ["relay", "direct"],
      }));
    }
    return Object.freeze({ version: MOBILE_CACHE_TIMING_RUNNER_VERSION, paired: true, matrixMode, groups });
  }

  const groups = matrixMode
    ? [{ phase: "pilot", index: 0, delayMs: 300, laneOrder: ["direct"] },
      ...delays.map((delayMs, index) => ({ phase: "formal", index: index + 1, delayMs, laneOrder: ["direct"] }))]
    : [{ phase: "pilot", index: 0, delayMs: delays[0], laneOrder: ["direct"] }];
  return Object.freeze({ version: MOBILE_CACHE_TIMING_RUNNER_VERSION, paired: false, matrixMode, groups });
}

/** Build the strict direct Gateway lane descriptor used by the shared runner. */
export function createDirectMobileTimingLaneDescriptor({ gatewayUrl, mobileUrl } = {}) {
  let gateway;
  let mobile;
  try {
    gateway = new URL(gatewayUrl);
    mobile = new URL(mobileUrl);
  } catch {
    throw new TypeError("Direct cache timing lane requires valid Gateway and Mobile URLs");
  }
  if (!isHttpProtocol(gateway.protocol) || !isHttpProtocol(mobile.protocol) ||
      gateway.origin !== mobile.origin || gateway.username || gateway.password || gateway.search || gateway.hash ||
      mobile.username || mobile.password || mobile.search || mobile.hash || !mobile.pathname.endsWith("/")) {
    throw new Error("Direct cache timing lane must use one owned origin and a mounted Mobile URL");
  }
  const gatewayPrefix = gateway.pathname === "/" ? "" : stripTrailingSlash(gateway.pathname);
  const mobileMountPath = stripTrailingSlash(mobile.pathname);
  const rootMobileMount = mobile.pathname === "/" && gatewayPrefix === "";
  if ((!rootMobileMount && !mobileMountPath) ||
      (!rootMobileMount && !isPathBelow(mobileMountPath, gatewayPrefix))) {
    throw new Error("Direct cache timing lane has an invalid Mobile mount");
  }
  const rpcPath = `${gatewayPrefix}/rpc` || "/rpc";
  const mobileEntryPath = `${gatewayPrefix}/mobile-entry` || "/mobile-entry";
  const workerPath = `${mobileMountPath}/${MOBILE_WORKER_FILENAME}`;
  const workerScopePath = `${mobileMountPath}/`;
  const lane = {
    id: "direct",
    origin: mobile.origin,
    gatewayUrl: gateway.href.replace(/\/$/, ""),
    gatewayPath: gatewayPrefix || "/",
    mobileUrl: mobile.href,
    mobileEntryUrl: `${mobile.origin}${mobileEntryPath}`,
    mobilePath: mobile.pathname,
    mobileMountPath,
    rpcPath,
    rpcUrl: `${gateway.protocol === "https:" ? "wss:" : "ws:"}//${gateway.host}${rpcPath}`,
    workerPath,
    workerUrl: `${mobile.origin}${workerPath}`,
    workerScopePath,
    workerScope: `${mobile.origin}${workerScopePath}`,
    assertRouteUrl(rawUrl, kind) {
      return assertDirectMobileTimingRoute(lane, rawUrl, kind);
    },
    safeSummary() {
      return Object.freeze({
        lane: "direct",
        gatewayPath: lane.gatewayPath,
        mobilePath: lane.mobilePath,
        apiPathPrefix: `${gatewayPrefix}/api/` || "/api/",
        rpcPath: lane.rpcPath,
        workerPath: lane.workerPath,
        workerScope: lane.workerScopePath,
      });
    },
  };
  return Object.freeze(lane);
}

/** Normalize the validated Relay adapter descriptor into the runner lane contract. */
export function normalizeRelayMobileTimingLaneV1(relayLane) {
  const mobile = new URL(relayLane.mobileUrl);
  return {
    ...relayLane,
    id: "relay",
    gatewayPath: relayLane.gatewayPrefix,
    mobilePath: mobile.pathname,
    mobileMountPath: mobile.pathname.replace(/\/$/, ""),
    rpcPath: new URL(relayLane.rpcUrl).pathname,
    workerPath: new URL(relayLane.workerUrl).pathname,
  };
}

/** Exact origin/path check for the direct Gateway lane. */
export function assertDirectMobileTimingRoute(lane, rawUrl, kind) {
  if (!lane || !new Set(["entry", "gateway", "mobile", "asset", "api", "rpc", "worker", "worker-scope"]).has(kind)) {
    throw new Error("Unsupported direct Mobile timing route assertion");
  }
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error("Direct Mobile timing route violates its owned mount"); }
  if (url.username || url.password || url.hash || hasUnsafePathEncoding(url.pathname)) {
    throw new Error("Direct Mobile timing route violates its owned mount");
  }
  const origin = new URL(lane.origin);
  const websocket = kind === "rpc";
  const expectedProtocol = websocket ? (origin.protocol === "https:" ? "wss:" : "ws:") : origin.protocol;
  if (url.protocol !== expectedProtocol || url.host !== origin.host) {
    throw new Error("Direct Mobile timing route violates its owned origin");
  }
  const gatewayPrefix = lane.gatewayPrefix ?? (lane.gatewayPath === "/" ? "" : stripTrailingSlash(lane.gatewayPath));
  const apiPrefix = `${gatewayPrefix}/api/` || "/api/";
  const expectedPath = {
    entry: `${gatewayPrefix}/mobile-entry` || "/mobile-entry",
    gateway: lane.gatewayPath,
    mobile: lane.mobilePath,
    rpc: lane.rpcPath,
    worker: lane.workerPath,
    "worker-scope": lane.workerScopePath,
  }[kind];
  let valid = expectedPath !== undefined && url.pathname === expectedPath;
  if (kind === "api") valid = url.pathname.startsWith(apiPrefix) && url.pathname.length > apiPrefix.length;
  if (kind === "asset") valid = url.pathname.startsWith(`${lane.mobileMountPath}/`) && url.pathname !== lane.mobilePath;
  if (kind !== "rpc" && kind !== "api" && kind !== "asset" && url.search) valid = false;
  if (!valid) throw new Error("Direct Mobile timing route violates its owned mount");
  return true;
}

/** Add a fail-closed HTTP guard and bounded route audit for one timing lane. */
export async function installMobileTimingLaneHttpGuard(page, lane, audit) {
  if (!page || typeof page.route !== "function" || typeof page.on !== "function" || !lane || !audit) {
    throw new TypeError("Mobile timing lane guard requires an owned Page, lane, and audit record");
  }
  const seenRequests = new WeakSet();
  const rejectedRequests = new WeakSet();
  const validate = (request, abort) => {
    const url = request.url();
    const kind = classifyLaneRequest(lane, url, request.resourceType?.());
    if (kind === null) return true;
    if (!seenRequests.has(request)) {
      seenRequests.add(request);
      audit.requestCount += 1;
      audit.requestCountsByKind[kind] = (audit.requestCountsByKind[kind] ?? 0) + 1;
    }
    try {
      lane.assertRouteUrl(url, kind);
      return true;
    } catch {
      if (!rejectedRequests.has(request)) {
        rejectedRequests.add(request);
        recordLaneViolation(audit, kind);
      }
      if (abort) return false;
      return false;
    }
  };
  page.on("request", request => { validate(request, false); });
  page.on("websocket", socket => {
    audit.websocketObservationCount += 1;
    try { lane.assertRouteUrl(socket.url(), "rpc"); }
    catch { recordLaneViolation(audit, "rpc"); }
  });
  await page.route("**/*", async route => {
    const request = route.request();
    if (!validate(request, true)) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
  return audit;
}

/** Verify the actual Service Worker script and scope for a lane. */
export async function assertMobileTimingLaneServiceWorker(page, lane, {
  allowUncontrolledBootstrap = false,
} = {}) {
  const observed = await page.evaluate(async () => {
    if (!navigator.serviceWorker || typeof navigator.serviceWorker.getRegistrations !== "function") {
      return { supported: false, controllerScriptUrl: null, registrations: [] };
    }
    const registrations = await navigator.serviceWorker.getRegistrations();
    return {
      supported: true,
      controllerScriptUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
      registrations: registrations.map(registration => ({
        scope: registration.scope,
        activeScriptUrl: registration.active?.scriptURL ?? null,
        activeState: registration.active?.state ?? null,
      })),
    };
  });
  assert.equal(observed.supported, true, "timing lane must expose Service Worker registration APIs");
  assert.equal(observed.registrations.length, 1, "timing lane origin must own exactly one Mobile Service Worker registration");
  const registration = observed.registrations[0];
  lane.assertRouteUrl(registration.scope, "worker-scope");
  lane.assertRouteUrl(registration.activeScriptUrl, "worker");
  assert.equal(registration.activeState, "activated", "lane Mobile Service Worker must be activated");
  const controllerPresent = observed.controllerScriptUrl !== null;
  if (controllerPresent) {
    assert.equal(observed.controllerScriptUrl, registration.activeScriptUrl,
      "controller must match the lane's exact active Service Worker");
  } else {
    assert.equal(allowUncontrolledBootstrap, true,
      "timing sample must be controlled by the lane's exact active Service Worker");
  }
  return {
    supported: observed.supported,
    registrationCount: observed.registrations.length,
    activeState: registration.activeState,
    scopeMatchesLane: true,
    workerScriptMatchesLane: true,
    controllerPresent,
    controllerMatchesWorker: controllerPresent ? true : null,
    controllerState: controllerPresent ? "controlled-by-active-worker" : "active-uncontrolled-bootstrap",
    safeScope: lane.safeSummary().workerScope,
    safeWorkerPath: lane.safeSummary().workerPath,
  };
}

/**
 * Execute the legacy direct plan or the matched direct/Relay plan. Suite-owned
 * cache inspection, bridge behavior, and screenshots are injected explicitly.
 */
export async function runMobileCacheTimingSamplesV1({
  context,
  lanes,
  createSamplePage,
  openCacheObserverPage,
  releaseTimingPage,
  initialBrowserOwner,
  clientMessageIdHashKey,
  threadId,
  promptMarker,
  replacementMarker,
  tailMarker,
  expectedAssistantMessageId,
  delays,
  paired = false,
  pairedSetupEvidence = null,
  browserErrors,
  readCacheReadiness,
  installResumeBridge,
  releaseTimingResponse,
  savePrivateScreenshot,
}) {
  const plan = buildMobileCacheTimingPlanV1({ delays, paired });
  assert.ok(Array.isArray(lanes) && lanes.length === (paired ? 2 : 1), "timing runner requires exactly the selected lane set");
  const laneById = new Map(lanes.map(lane => [lane.id, lane]));
  assert.deepEqual([...laneById.keys()].sort(), paired ? ["direct", "relay"] : ["direct"],
    "timing runner lane IDs must match the selected direct or paired mode");
  assert.equal(typeof createSamplePage, "function");
  assert.equal(typeof openCacheObserverPage, "function");
  assert.equal(typeof releaseTimingPage, "function");
  assert.ok(Number.isSafeInteger(initialBrowserOwner?.pid) && initialBrowserOwner.pid > 0 &&
    Number.isSafeInteger(initialBrowserOwner?.pgid) && initialBrowserOwner.pgid > 0 &&
    typeof initialBrowserOwner.profileDir === "string" && initialBrowserOwner.profileDir.length > 0,
  "timing runner requires the active setup Chromium PID/PGID and same-profile identity");
  assert.equal(typeof readCacheReadiness, "function");
  assert.equal(typeof installResumeBridge, "function");
  assert.equal(typeof releaseTimingResponse, "function");
  assert.equal(typeof savePrivateScreenshot, "function");
  const laneState = new Map();
  for (const lane of lanes) {
    const mobile = new URL(lane.mobileUrl);
    const gateway = new URL(lane.gatewayUrl);
    assert.equal(mobile.origin, lane.origin, `${lane.id} Mobile origin descriptor must match its origin`);
    assert.equal(gateway.origin, lane.origin, `${lane.id} Gateway and Mobile must share the same origin`);
    assert.equal(typeof lane.assertRouteUrl, "function");
    assert.ok(lane.protocol && lane.taskPath, "timing lane requires its exact task protocol and route");
    if (paired) assert.ok(lane.expectedScope, `${lane.id} paired lane requires observed profile and target scope`);
    if (paired) assert.equal(lane.threadId, threadId, `${lane.id} lane must open the common seed thread`);
    laneState.set(lane.id, { observerPage: lane.initialPage ?? null });
  }
  let pairedSetupSummary = null;
  if (paired) {
    assert.notEqual(laneById.get("direct").origin, laneById.get("relay").origin,
      "paired timing lanes must use distinct browser origins for origin-scoped IndexedDB, localStorage, and Service Workers");
    assert.notEqual(laneById.get("direct").expectedScope.routeProfileId, laneById.get("relay").expectedScope.routeProfileId,
      "paired timing lanes must be backed by distinct Mobile Gateway profiles");
    pairedSetupSummary = assertPairedTimingSetupEvidenceV1(lanes, pairedSetupEvidence);
  }

  const allSamples = [];
  const attemptedGroups = [];
  let expectedBrowserOwner = { ...initialBrowserOwner };
  let stoppedAfterGroup = false;
  for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex += 1) {
    const group = plan.groups[groupIndex];
    const groupSamples = [];
    for (let laneOrder = 0; laneOrder < group.laneOrder.length; laneOrder += 1) {
      const lane = laneById.get(group.laneOrder[laneOrder]);
      const sample = await runOneSample({
        context,
        lane,
        laneState: laneState.get(lane.id),
        laneStates: laneState,
        expectedBrowserOwner,
        createSamplePage,
        openCacheObserverPage,
        releaseTimingPage,
        clientMessageIdHashKey,
        threadId,
        promptMarker,
        replacementMarker,
        tailMarker,
        expectedAssistantMessageId,
        delayMs: group.delayMs,
        phase: group.phase,
        index: group.index,
        pairId: paired ? group.pairId : null,
        laneOrder,
        browserErrors,
        readCacheReadiness,
        installResumeBridge,
        releaseTimingResponse,
        savePrivateScreenshot,
        hasNextLaneSample: laneOrder + 1 < group.laneOrder.length,
        hasLaterGroup: groupIndex + 1 < plan.groups.length,
        priorGroupSamplesValid: groupSamples.every(sample =>
          sample?.status === "PASS" && sample?.functionalStatus === "PASS" && sample?.validForPerformance === true),
      });
      groupSamples.push(sample);
      allSamples.push(sample);
      if (!sample.ownershipReleaseError && sample.ownershipRelease?.restartRequested === true) {
        expectedBrowserOwner = {
          pid: sample.ownershipRelease.newPid,
          pgid: sample.ownershipRelease.newPgid,
          profileDir: sample.ownershipRelease.profileDir,
        };
      }
      if (sample.ownershipReleaseError && laneOrder + 1 < group.laneOrder.length) {
        for (let remaining = laneOrder + 1; remaining < group.laneOrder.length; remaining += 1) {
          const unrun = createNotRunSample(group, group.laneOrder[remaining], remaining,
            "NOT_RUN_AFTER_BROWSER_OWNER_RELEASE_FAILURE");
          groupSamples.push(unrun);
          allSamples.push(unrun);
        }
        break;
      }
    }
    attemptedGroups.push({ ...group, samples: groupSamples });
    if (!shouldContinueAfterTimingGroupV1(groupSamples)) {
      stoppedAfterGroup = true;
      for (const future of plan.groups.slice(groupIndex + 1)) {
        for (let laneOrder = 0; laneOrder < future.laneOrder.length; laneOrder += 1) {
          allSamples.push(createNotRunSample(future, future.laneOrder[laneOrder], laneOrder,
            group.phase === "pilot" && groupSamples.some(sample => sample.functionalStatus === "PASS")
              ? "NOT_RUN_AFTER_INVALID_300MS_PILOT"
              : group.phase === "pilot" ? "NOT_RUN_AFTER_FAILED_300MS_PILOT" : "NOT_RUN_AFTER_FAILURE"));
        }
      }
      break;
    }
  }

  for (const state of laneState.values()) await state.observerPage?.close().catch(() => {});
  const attemptedSamples = allSamples.filter(sample => !sample.status.startsWith("NOT_RUN"));
  const formalSamples = allSamples.filter(sample => sample.phase === "formal");
  const failedSamples = attemptedSamples.filter(sample => sample.status === "FAIL" || sample.validForPerformance !== true).length;
  const notRunSamples = allSamples.filter(sample => sample.status.startsWith("NOT_RUN")).length;
  const passedSampleCount = attemptedSamples.filter(sample => sample.status === "PASS").length;
  const validPerformanceSampleCount = attemptedSamples.filter(sample => sample.validForPerformance === true).length;
  const invalidPerformanceSampleCount = attemptedSamples.length - validPerformanceSampleCount;
  const timingBoundary = "Node request time is the RPC frame arriving at the owned Playwright bridge; response time is the upstream response frame arriving at that same bridge (through the owned Relay in the Relay lane). These durations are not public-network RTT. The test hold begins after upstream arrival and is reported separately as appliedHoldRawMs/appliedHoldMs.";
  const httpCache = "HTTP cache disabled by per-page Playwright routing; each lane retains its origin-scoped IndexedDB transcript cache in the same RunContext-owned Chromium profile.";
  const browserLifecycle = {
    mode: "new-owned-Chromium-process-per-measured-sample",
    profileStorage: "same RunContext-owned profile directory; direct and Relay storage remains separated by origin and Mobile scope",
    ownerRelease: "RunContext confirms the exact old process group stopped and child exited before a next sample owner starts",
    startup: "recorded separately in ownershipRelease.startupMs and excluded from page Navigation Timing",
    backend: "warm; Gateway and app-server processes are reused",
    gatewayClientEofProven: false,
    historicalWarmBaselineComparable: false,
  };
  const byteBoundary = "HTTP request bytes are request-body payload bytes; HTTP response bytes are the sum of known Content-Length headers only, with unknown response lengths counted separately and byte total left unknown; WebSocket/RPC bytes are observed payload bytes, not wire bytes.";

  if (!paired) {
    const pilot = allSamples.find(sample => sample.phase === "pilot") ?? null;
    const samples = formalSamples;
    const mode = plan.matrixMode
      ? "real-ui-latest-anchor-plus-pilot-and-matrix-diagnostic"
      : "real-ui-latest-anchor-plus-300ms-pilot-n1";
    return {
      runnerVersion: MOBILE_CACHE_TIMING_RUNNER_VERSION,
      mode,
      pilot: pilot ? projectPilot(pilot) : null,
      timingBoundary,
      httpCache,
      browserLifecycle,
      byteBoundary,
      plannedSampleCount: plan.groups.reduce((count, group) => count + group.laneOrder.length, 0),
      formalPlannedSampleCount: plan.groups.filter(group => group.phase === "formal")
        .reduce((count, group) => count + group.laneOrder.length, 0),
      attemptedSampleCount: attemptedSamples.length,
      passedSampleCount,
      validPerformanceSampleCount,
      invalidPerformanceSampleCount,
      failedSamples,
      notRunSamples,
      samples,
      ...(plan.matrixMode ? { summaries: summarizeTimingSamples(samples) } : {}),
      stoppedAfterGroup,
    };
  }

  const pilotGroup = attemptedGroups.find(group => group.phase === "pilot") ?? null;
  const formalPairs = attemptedGroups.filter(group => group.phase === "formal");
  const plannedFormalPairs = plan.groups.filter(group => group.phase === "formal");
  return {
    runnerVersion: MOBILE_CACHE_TIMING_RUNNER_VERSION,
    mode: plan.matrixMode ? "real-ui-direct-relay-paired-pilot-and-matrix" : "real-ui-direct-relay-paired-300ms-pilot-n1",
    paired: true,
    storageIsolation: {
      browserProfile: "same RunContext-owned persistent Chromium profile, relaunched under a new owned process for each sample",
      boundary: "direct Gateway and local Relay have distinct origins; IndexedDB, localStorage, and Service Worker registrations are origin-scoped; process relaunch preserves each lane's origin store",
      laneOriginsDistinct: true,
      mobileProfileIdsDistinct: true,
      sharedThreadId: true,
      ...pairedSetupSummary,
    },
    lanes: lanes.map(lane => ({ id: lane.id, ...lane.safeSummary() })),
    timingBoundary,
    httpCache,
    browserLifecycle,
    byteBoundary,
    plannedSampleCount: plan.groups.reduce((count, group) => count + group.laneOrder.length, 0),
    formalPlannedSampleCount: plannedFormalPairs.reduce((count, group) => count + group.laneOrder.length, 0),
    plannedPairCount: plan.groups.length,
    formalPlannedPairCount: plannedFormalPairs.length,
    attemptedSampleCount: attemptedSamples.length,
    attemptedPairCount: attemptedGroups.length,
    passedSampleCount,
    validPerformanceSampleCount,
    invalidPerformanceSampleCount,
    failedSamples,
    notRunSamples,
    pilotPair: pilotGroup ? projectPair(pilotGroup) : null,
    formalPairs: formalPairs.map(projectPair),
    samples: allSamples,
    pairedSummaries: plan.matrixMode
      ? summarizePairedTimingSamplesV1(formalSamples, plannedFormalPairs)
      : null,
    stoppedAfterGroup,
  };
}

/** Verify that real lane setup shared one seed thread without creating a Relay turn. */
export function assertPairedTimingSetupEvidenceV1(lanes, evidence) {
  assert.ok(Array.isArray(lanes) && lanes.length === 2, "paired setup requires direct and Relay lanes");
  const byId = new Map(lanes.map(lane => [lane.id, lane]));
  const direct = byId.get("direct");
  const relay = byId.get("relay");
  assert.ok(direct && relay, "paired setup requires both lane identities");
  assert.equal(direct.threadId, relay.threadId, "direct and Relay lanes must open the same seeded thread");
  assert.equal(direct.expectedScope?.threadId, direct.threadId, "direct scope must identify the seeded thread");
  assert.equal(relay.expectedScope?.threadId, relay.threadId, "Relay scope must identify the seeded thread");
  assert.notEqual(direct.origin, relay.origin, "paired lanes must use distinct origins");
  assert.notEqual(direct.expectedScope?.routeProfileId, relay.expectedScope?.routeProfileId,
    "paired lanes must use origin-owned Mobile profile identities");
  assert.ok(evidence && typeof evidence === "object", "paired setup requires observed protocol evidence");
  assert.equal(evidence.directSeedTurnStartCount, 1, "direct lane must own exactly the one real seed turn");
  assert.equal(evidence.relayTurnStartCount, 0, "Relay lane must not create a second turn");
  assert.equal(evidence.relayBootstrapResumeCount, 1, "Relay lane must resume the seeded thread once before sampling");
  assert.equal(evidence.relayBootstrapResumeSucceeded, true, "Relay bootstrap resume must succeed before sampling");
  assert.equal(evidence.relayBootstrapCacheReady, true, "Relay origin must commit the same canonical seed transcript before sampling");
  assert.equal(evidence.relayBootstrapRouteViolationCount, 0, "Relay bootstrap HTTP and RPC routes must stay on its exact mount");
  assert.equal(evidence.relayBootstrapWorkerScopeMatched, true,
    "Relay bootstrap must install the active Service Worker at its exact mounted scope");
  assert.equal(typeof evidence.relayBootstrapControllerPresent, "boolean",
    "Relay bootstrap must record whether its first document is controlled");
  assert.equal(evidence.relayBootstrapControllerState,
    evidence.relayBootstrapControllerPresent ? "controlled-by-active-worker" : "active-uncontrolled-bootstrap",
    "Relay bootstrap controller state must accurately distinguish first-document control");
  assertTimingOwnerRelease(evidence.directSeedOwnershipRelease, "direct seed");
  assertTimingOwnerRelease(evidence.relayBootstrapOwnershipRelease, "Relay bootstrap");
  return Object.freeze({
    directSeedTurnStartCount: 1,
    relayTurnStartCount: 0,
    relayBootstrapResumeCount: 1,
    relayBootstrapResumeSucceeded: true,
    relayBootstrapCacheReady: true,
    relayBootstrapRouteViolationCount: 0,
    relayBootstrapWorkerScopeMatched: true,
    relayBootstrapControllerPresent: evidence.relayBootstrapControllerPresent,
    relayBootstrapControllerState: evidence.relayBootstrapControllerState,
    directSeedOwnershipReleased: true,
    relayBootstrapOwnershipReleased: true,
    sharedThreadId: true,
    distinctMobileProfileIds: true,
    distinctOriginScopedStores: true,
  });
}

/** A pilot/formal group proceeds only when every lane sample is functional and complete. */
export function shouldContinueAfterTimingGroupV1(samples) {
  return Array.isArray(samples) && samples.length > 0 && samples.every(sample =>
    sample?.status === "PASS" && sample?.functionalStatus === "PASS" && sample?.validForPerformance === true);
}

/** Pick a real point shared by the marker Range and the Mobile message-list viewport. */
export function transcriptWheelPointV1(geometry) {
  assert.equal(geometry?.host?.testId, "message-list", "trusted transcript wheel requires the measured Mobile message-list host");
  assert.equal(geometry?.rowMatchCount, 1, "trusted transcript wheel requires one exact message row");
  assert.equal(geometry?.markerTextMatchCount, 1, "trusted transcript wheel requires one exact marker Range");
  const host = geometry.host.rect;
  const marker = geometry.marker;
  assert.ok(host && marker && [host.left, host.right, host.top, host.bottom,
    marker.left, marker.right, marker.top, marker.bottom].every(Number.isFinite),
  "trusted transcript wheel requires measured marker and scroll-host rectangles");
  const intersection = {
    left: Math.max(host.left, marker.left),
    right: Math.min(host.right, marker.right),
    top: Math.max(host.top, marker.top),
    bottom: Math.min(host.bottom, marker.bottom),
  };
  assert.ok(intersection.right - intersection.left > 1 && intersection.bottom - intersection.top > 1,
    "the exact marker Range must have a visible intersection with the message-list viewport");
  return {
    x: (intersection.left + intersection.right) / 2,
    y: (intersection.top + intersection.bottom) / 2,
    intersection,
    markerCenterInsideList: marker.centerX >= host.left && marker.centerX <= host.right &&
      marker.centerY >= host.top && marker.centerY <= host.bottom,
  };
}

/** Select the RNW inverted-list wheel direction from the hit target and measured viewport. */
export function selectTrustedTranscriptWheelV1(geometry, targetAtPoint, maxDelta = 16) {
  assert.ok(Number.isSafeInteger(maxDelta) && maxDelta > 0 && maxDelta <= 16,
    "trusted transcript wheel delta must be a positive integer no larger than 16px");
  assert.equal(geometry?.host?.testId, "message-list",
    "trusted transcript wheel requires the measured Mobile message-list host");
  assert.equal(geometry?.rowMatchCount, 1, "trusted transcript wheel requires one exact message row");
  assert.equal(geometry?.markerTextMatchCount, 1, "trusted transcript wheel requires one exact marker Range");
  assert.equal(geometry?.markerIntersectsList, true, "trusted transcript wheel requires the exact marker to intersect the list");
  assert.equal(targetAtPoint?.targetInsideList, true, "trusted transcript wheel hit target must be inside the list");
  assert.equal(targetAtPoint?.pathReachesHost, true, "trusted transcript wheel target ancestry must reach the measured host");
  assert.ok(Array.isArray(targetAtPoint.targetPath) && targetAtPoint.targetPath.length > 0,
    "trusted transcript wheel requires the measured event-target ancestry");
  const hostTargetIndex = targetAtPoint.targetPath.findIndex(entry => entry?.isHost === true);
  assert.equal(hostTargetIndex, targetAtPoint.targetPath.length - 1,
    "trusted transcript wheel target ancestry must end at the measured host");
  assert.equal(targetAtPoint.targetIsHost, hostTargetIndex === 0,
    "trusted transcript wheel host-target flag must match its measured ancestry");
  assert.equal(targetAtPoint.targetIsHost, false,
    "RNW host-target wheel uses a different targetDelta algorithm and is unsupported by this child-target prediction");
  assert.ok(targetAtPoint.targetPath.slice(0, hostTargetIndex).every(entry => entry?.rnwScrollable === false),
    "nested scrollable hit targets are ambiguous for the outer transcript wheel and must fail closed");

  const host = geometry.host;
  const measuredHostTarget = targetAtPoint.targetPath[hostTargetIndex];
  assert.ok(Number.isFinite(measuredHostTarget?.scrollTop) && Number.isFinite(measuredHostTarget?.scrollHeight) &&
    Number.isFinite(measuredHostTarget?.clientHeight) &&
    Math.abs(measuredHostTarget.scrollTop - host.scrollTop) <= 0.5 &&
    measuredHostTarget.scrollHeight === host.scrollHeight && measuredHostTarget.clientHeight === host.clientHeight,
  "trusted transcript hit-test host measurements must match the same measured list snapshot");
  const marker = geometry.marker;
  const required = [host.scrollTop, host.scrollHeight, host.clientHeight,
    host.rect?.top, host.rect?.bottom, marker?.top, marker?.bottom];
  assert.ok(required.every(Number.isFinite),
    "trusted transcript wheel direction requires finite host and marker measurements");
  const range = Math.max(0, host.scrollHeight - host.clientHeight);
  assert.ok(host.scrollTop >= -0.5 && host.scrollTop <= range + 0.5,
    "trusted transcript wheel host offset must be within its physical range");
  const positiveRoom = Math.min(host.scrollTop, marker.top - host.rect.top - 1);
  const negativeRoom = Math.min(range - host.scrollTop, host.rect.bottom - marker.bottom - 1);
  const candidates = [
    { deltaY: Math.floor(Math.min(maxDelta, positiveRoom)), room: positiveRoom },
    { deltaY: -Math.floor(Math.min(maxDelta, negativeRoom)), room: negativeRoom },
  ].filter(candidate => candidate.room >= 1 && Math.abs(candidate.deltaY) >= 1);
  assert.ok(candidates.length > 0,
    "the measured marker/list intersection has no safe RNW inverted-wheel direction with host scroll room");
  candidates.sort((left, right) => right.room - left.room || right.deltaY - left.deltaY);
  const selected = candidates[0];
  return {
    deltaY: selected.deltaY,
    availableRoom: selected.room,
    expectedScrollTop: Math.max(0, Math.min(range, host.scrollTop - selected.deltaY)),
    targetIsHost: targetAtPoint.targetIsHost,
    targetPath: targetAtPoint.targetPath,
  };
}

/** Perform one real direct-lane wheel while retaining the exact target and dispatch trace. */
export async function runTrustedUserAnchorWheelSequenceV1({
  page,
  markerText,
  rowDomId,
  initialGeometry,
  wheelStart,
  readTranscriptViewport,
  readTrustedWheelTargetAtPoint,
  readTrustedWheelObservation,
  diagnostics = {},
  deadlineAtMs = null,
  movementTimeoutMs = 5_000,
}) {
  assert.ok(page?.mouse && typeof page.mouse.move === "function" && typeof page.mouse.wheel === "function",
    "trusted transcript wheel requires the owned Browser page mouse");
  assert.equal(typeof readTranscriptViewport, "function");
  assert.equal(typeof readTrustedWheelTargetAtPoint, "function");
  assert.equal(typeof readTrustedWheelObservation, "function");
  assert.ok(typeof markerText === "string" && markerText.length > 0,
    "trusted transcript wheel requires the unique user marker text");
  assert.ok(typeof rowDomId === "string" && rowDomId.length > 0,
    "trusted transcript wheel requires the selected user row identity");
  assert.ok(Number.isFinite(wheelStart?.scrollTop) && Number.isFinite(wheelStart?.scrollHeight) &&
    Number.isFinite(wheelStart?.clientHeight) &&
    Math.abs(wheelStart.scrollTop - initialGeometry.host.scrollTop) <= 0.5 &&
    wheelStart.scrollHeight === initialGeometry.host.scrollHeight &&
    wheelStart.clientHeight === initialGeometry.host.clientHeight,
  "trusted transcript wheel audit must start from the exact measured list geometry");
  assert.ok(Number.isSafeInteger(movementTimeoutMs) && movementTimeoutMs > 0,
    "trusted transcript wheel requires a bounded movement timeout");
  const deadline = Number.isFinite(deadlineAtMs) ? deadlineAtMs : Date.now() + movementTimeoutMs;
  assert.ok(deadline > Date.now(), "trusted transcript wheel deadline must still be active");
  diagnostics.wheelSequence = {
    rowDomId,
    initialScrollTop: initialGeometry.host.scrollTop,
    scrollRange: Math.max(0, initialGeometry.host.scrollHeight - initialGeometry.host.clientHeight),
    wheelStartScrollTop: Number.isFinite(wheelStart?.scrollTop) ? wheelStart.scrollTop : null,
    initialGeometry,
    initialTargetPoint: null,
    targetPreflight: null,
    selectedDeltaY: null,
  };
  try {
    diagnostics.wheelSequence.initialTargetPoint = transcriptWheelPointV1(initialGeometry);
  } catch (error) {
    diagnostics.wheelSequence.failure = `${error?.name ?? "Error"}: ${String(error?.message ?? error).slice(0, 400)}`;
    throw new Error(`trusted transcript wheel preflight failed; ${JSON.stringify(diagnostics.wheelSequence)}`, { cause: error });
  }

  const observe = async () => {
    try { return await readTranscriptViewport(page, { markerText, rowDomId, rowTestId: "message-user" }); }
    catch { return null; }
  };
  const summarizeEvents = audit => Array.isArray(audit?.events) ? audit.events.slice(-8).map(event => ({
    deltaY: Number.isFinite(event?.deltaY) ? event.deltaY : null,
    isTrusted: event?.isTrusted === true,
    targetInsideList: event?.targetInsideList === true,
    targetPath: Array.isArray(event?.targetPath) ? event.targetPath : [],
    defaultPreventedAtCapture: event?.defaultPreventedAtCapture === true,
    defaultPreventedAfterDispatch: event?.defaultPreventedAfterDispatch === true,
    hostScrollTopAtCapture: Number.isFinite(event?.hostScrollTopAtCapture) ? event.hostScrollTopAtCapture : null,
    hostScrollTopAfterDispatch: Number.isFinite(event?.hostScrollTopAfterDispatch) ? event.hostScrollTopAfterDispatch : null,
    hostScrollTopAfterFrame: Number.isFinite(event?.hostScrollTopAfterFrame) ? event.hostScrollTopAfterFrame : null,
  })) : [];
  const performWheel = async (name, startGeometry) => {
    const targetPoint = transcriptWheelPointV1(startGeometry);
    const step = diagnostics[name] = {
      phase: "target-preflight",
      deltaY: null,
      targetPoint,
      targetPreflight: null,
      directionSelection: null,
      startGeometry,
      lastGeometry: null,
      afterGeometry: null,
      wheelEvents: [],
    };
    let targetPreflight;
    let selection;
    try {
      targetPreflight = await readTrustedWheelTargetAtPoint(page, targetPoint);
      step.targetPreflight = diagnostics.wheelSequence.targetPreflight = targetPreflight;
      selection = selectTrustedTranscriptWheelV1(startGeometry, targetPreflight);
      step.deltaY = diagnostics.wheelSequence.selectedDeltaY = selection.deltaY;
      step.directionSelection = selection;
      step.phase = "wheel-dispatch";
      await page.mouse.move(targetPoint.x, targetPoint.y);
      await page.mouse.wheel(0, selection.deltaY);
      step.phase = "wheel-movement-observation";
      const moved = await waitFor(async () => {
        const geometry = await observe();
        step.lastGeometry = geometry;
        return geometry?.host?.testId === "message-list" && geometry.rowDomId === rowDomId &&
          geometry.rowMatchCount === 1 && geometry.markerTextMatchCount === 1 &&
          geometry.markerIntersectsWindow === true && geometry.markerIntersectsList === true &&
          Number.isFinite(geometry.host.scrollTop) &&
          Math.abs(geometry.host.scrollTop - startGeometry.host.scrollTop) > 0.5 ? geometry : null;
      }, Math.max(1, deadline - Date.now()), `trusted ${name} to move the same user row on its real message list`);
      step.afterGeometry = moved;
      step.phase = "post-dispatch-audit";
      const audit = await waitFor(async () => {
        const current = await readTrustedWheelObservation(page);
        const event = current?.events?.find(candidate => candidate?.isTrusted === true &&
          candidate?.targetInsideList === true && candidate?.deltaY === selection.deltaY);
        return event?.defaultPreventedAfterDispatch !== null &&
          Number.isFinite(event?.hostScrollTopAfterFrame) ? current : null;
      }, Math.max(1, deadline - Date.now()), `trusted ${name} dispatch and frame audit`);
      step.wheelEvents = summarizeEvents(audit);
      const dispatched = step.wheelEvents.find(event => event.isTrusted && event.targetInsideList &&
        event.deltaY === selection.deltaY);
      assert.ok(dispatched, `trusted ${name} must be observed inside the message list with the selected delta`);
      assert.deepEqual(dispatched.targetPath, targetPreflight.targetPath,
        `trusted ${name} event target ancestry must match its pre-dispatch hit test`);
      assert.equal(dispatched.defaultPreventedAfterDispatch, true,
        `trusted ${name} must reach the RNW inverted-list wheel handler`);
      assert.ok(Math.abs(dispatched.hostScrollTopAtCapture - startGeometry.host.scrollTop) <= 0.5,
        `trusted ${name} event target and start geometry must share the same host offset`);
      assert.ok(Math.abs(dispatched.hostScrollTopAfterFrame - selection.expectedScrollTop) <= 0.5,
        `trusted ${name} frame must show the source-predicted RNW host movement`);
      step.phase = "complete";
      return { geometry: moved, audit, targetPoint, selection, targetPreflight, wheelEvents: step.wheelEvents };
    } catch (error) {
      step.lastGeometry = await observe();
      try { step.wheelEvents = summarizeEvents(await readTrustedWheelObservation(page)); }
      catch { step.wheelEvents = []; }
      step.failure = `${error?.name ?? "Error"}: ${String(error?.message ?? error).slice(0, 400)}`;
      const diagnostic = JSON.stringify(step);
      throw new Error(`trusted ${name} failed during ${step.phase}; ${diagnostic}`, { cause: error });
    }
  };

  const finalWheel = await performWheel("finalWheel", initialGeometry);
  diagnostics.completed = true;
  return {
    afterWheelGeometry: finalWheel.geometry,
    wheelAudit: finalWheel.audit,
    counterWheelPreparation: null,
    finalWheel: {
      deltaY: finalWheel.selection.deltaY,
      targetPreflight: finalWheel.targetPreflight,
      startGeometry: initialGeometry,
      afterGeometry: finalWheel.geometry,
      targetPoint: finalWheel.targetPoint,
      dispatch: finalWheel.wheelEvents.find(event => event.isTrusted &&
        event.deltaY === finalWheel.selection.deltaY) ?? null,
      scrollSamples: finalWheel.audit?.scrollSamples ?? [],
    },
  };
}

/** Seed the Relay origin's real reading anchor before validating its latest position. */
export async function prepareRelayTimingLatestAnchorV1({
  page,
  threadId,
  gatewayOrigin,
  marker,
  expectedScope,
  expectedUserAnchorMessageId,
  expectedAssistantMessageId,
  tailMarker,
  readCacheReadiness,
  prepareUserAnchorViewport,
  readTranscriptViewport,
  armTrustedWheelObservationWithViewport,
  readTrustedWheelTargetAtPoint,
  readTrustedWheelObservation,
}) {
  for (const [name, callback] of Object.entries({
    readCacheReadiness,
    prepareUserAnchorViewport,
    readTranscriptViewport,
    armTrustedWheelObservationWithViewport,
    readTrustedWheelTargetAtPoint,
    readTrustedWheelObservation,
  })) assert.equal(typeof callback, "function", `Relay latest-anchor setup requires ${name}`);
  assert.ok(page && typeof page.getByTestId === "function" && page.mouse,
    "Relay latest-anchor setup requires the real owned Browser page");
  assert.ok(typeof threadId === "string" && threadId.length > 0 &&
    typeof gatewayOrigin === "string" && typeof marker === "string" && marker.length > 0 &&
    typeof tailMarker === "string" && tailMarker.length > 0,
  "Relay latest-anchor setup requires exact thread, origin, and fixture markers");
  assert.ok(typeof expectedUserAnchorMessageId === "string" && expectedUserAnchorMessageId.length > 0 &&
    typeof expectedAssistantMessageId === "string" && expectedAssistantMessageId.length > 0,
  "Relay latest-anchor setup requires canonical user and assistant message identities");
  assert.ok(expectedScope && expectedScope.threadId === threadId &&
    typeof expectedScope.routeProfileId === "string" && expectedScope.routeProfileId.length > 0,
  "Relay latest-anchor setup requires the exact observed Mobile Gateway scope");

  const cacheInputs = { threadId, gatewayOrigin, marker, expectedScope, expectedMessageId: expectedAssistantMessageId };
  const initialCache = await readCacheReadiness(cacheInputs, 30_000);
  assert.ok(initialCache?.ready,
    "Relay resume must first persist the exact transcript record and scope without requiring a reading anchor");

  const userAnchor = await prepareUserAnchorViewport(page);
  const initialGeometry = await armTrustedWheelObservationWithViewport(page, {
    markerText: marker,
    rowDomId: userAnchor.rowDomId,
    rowTestId: "message-user",
  });
  const wheelStart = initialGeometry?.wheelStart;
  assert.equal(initialGeometry?.rowDomId, userAnchor.rowDomId,
    "the armed Relay viewport must retain the prepared exact user row");
  assert.equal(initialGeometry?.host?.testId, "message-list",
    "Relay anchor gestures must target the actual Mobile message-list scroll host");
  assert.equal(initialGeometry?.rowMatchCount, 1, "the Relay prompt marker must identify exactly one visible user row");
  assert.equal(initialGeometry?.markerTextMatchCount, 1, "the Relay user marker Range must be unique");
  assert.equal(initialGeometry?.markerIntersectsWindow, true, "the Relay marker Range must be visible before the wheel");
  assert.equal(initialGeometry?.markerIntersectsList, true, "the Relay marker Range must intersect the message list");
  assert.ok(Number.isFinite(initialGeometry.host.scrollTop) &&
    Number.isFinite(initialGeometry.host.scrollHeight) && Number.isFinite(initialGeometry.host.clientHeight) &&
    Number.isFinite(initialGeometry.host.rect?.top) && Number.isFinite(initialGeometry.host.rect?.bottom) &&
    Number.isFinite(initialGeometry.marker?.top) && Number.isFinite(initialGeometry.marker?.bottom),
  "Relay anchor wheel direction must use measured scroll-host and marker geometry");
  const scrollRange = Math.max(0, initialGeometry.host.scrollHeight - initialGeometry.host.clientHeight);
  assert.ok(scrollRange > 0, "the real Relay message list must have scroll range before a detached anchor gesture");

  const scrollTop = initialGeometry.host.scrollTop;
  assert.ok(Number.isFinite(wheelStart?.scrollTop) && Number.isFinite(wheelStart?.scrollHeight) &&
    Number.isFinite(wheelStart?.clientHeight), "Relay wheel audit must begin from the measured message-list state");
  assert.ok(Math.abs(wheelStart.scrollTop - scrollTop) <= 0.5,
    "Relay wheel audit start must match the measured user-marker geometry");
  assert.equal(wheelStart.scrollHeight, initialGeometry.host.scrollHeight,
    "Relay wheel audit scroll height must match the measured list");
  assert.equal(wheelStart.clientHeight, initialGeometry.host.clientHeight,
    "Relay wheel audit viewport height must match the measured list");

  const wheelPoint = transcriptWheelPointV1(initialGeometry);
  let targetPreflight = null;
  let selectedWheel;
  try {
    targetPreflight = await readTrustedWheelTargetAtPoint(page, wheelPoint);
    selectedWheel = selectTrustedTranscriptWheelV1(initialGeometry, targetPreflight);
  } catch (error) {
    throw new Error(`Relay trusted wheel preflight failed; ${JSON.stringify({
      wheelPoint,
      host: initialGeometry.host,
      marker: initialGeometry.marker,
      targetPreflight,
      failure: `${error?.name ?? "Error"}: ${String(error?.message ?? error).slice(0, 300)}`,
    })}`, { cause: error });
  }
  const wheelDeadlineAtMs = Date.now() + 5_000;
  await page.mouse.move(wheelPoint.x, wheelPoint.y);
  await page.mouse.wheel(0, selectedWheel.deltaY);
  const afterWheel = await waitFor(async () => {
    const geometry = await readTranscriptViewport(page, {
      markerText: marker,
      rowDomId: userAnchor.rowDomId,
      rowTestId: "message-user",
    });
    return geometry.host?.testId === "message-list" && geometry.rowMatchCount === 1 &&
      geometry.markerTextMatchCount === 1 && geometry.markerIntersectsWindow && geometry.markerIntersectsList &&
      Number.isFinite(geometry.host.scrollTop) && Math.abs(geometry.host.scrollTop - scrollTop) > 0.5
      ? geometry : null;
  }, Math.max(1, wheelDeadlineAtMs - Date.now()), "a trusted Relay wheel to move the exact visible user marker on its real message list");
  assert.equal(afterWheel.rowDomId, userAnchor.rowDomId,
    "the Relay wheel must retain the exact user row selected by its unique marker");
  const wheelAudit = await waitFor(async () => {
    const current = await readTrustedWheelObservation(page);
    const event = current?.events?.find(candidate => candidate?.isTrusted === true &&
      candidate?.targetInsideList === true && candidate?.deltaY === selectedWheel.deltaY);
    return event?.defaultPreventedAfterDispatch !== null &&
      Number.isFinite(event?.hostScrollTopAfterFrame) ? current : null;
  }, Math.max(1, wheelDeadlineAtMs - Date.now()), "Relay RNW wheel dispatch and frame audit");
  const trustedWheel = wheelAudit?.events?.find(event => event?.isTrusted === true &&
    event.targetInsideList === true && event.deltaY === selectedWheel.deltaY);
  assert.ok(trustedWheel,
    "the Relay detached anchor must be caused by the selected trusted wheel event inside the real message list");
  assert.deepEqual(trustedWheel.targetPath, targetPreflight.targetPath,
    "the Relay trusted wheel target must match its pre-dispatch hit test");
  assert.equal(trustedWheel.defaultPreventedAfterDispatch, true,
    "the Relay trusted wheel must reach the RNW inverted-list handler");
  assert.ok(Math.abs(trustedWheel.hostScrollTopAtCapture - scrollTop) <= 0.5,
    "Relay wheel target and starting geometry must share the same host offset");
  assert.ok(Math.abs(trustedWheel.hostScrollTopAfterFrame - selectedWheel.expectedScrollTop) <= 0.5,
    "Relay frame must show the source-predicted RNW host movement");

  const detachedAnchor = await readCacheReadiness({
    ...cacheInputs,
    expectedAnchorMessageId: expectedUserAnchorMessageId,
    expectedAnchorOffset: afterWheel.row.offsetFromHost,
    expectedAnchorFollowsLatest: false,
    requireReadingAnchor: true,
  }, 30_000);
  assert.ok(detachedAnchor?.ready,
    "the Relay trusted wheel must persist the canonical user anchor as detached reading intent before latest navigation");
  assert.equal(detachedAnchor.anchor?.messageId, expectedUserAnchorMessageId,
    "the Relay detached anchor must identify the shared canonical user message");
  assert.equal(detachedAnchor.anchor?.followsLatest, false,
    "the actual Relay wheel must persist followsLatest=false before the jump-to-latest action");

  const jumpToLatest = page.getByTestId("jump-to-latest");
  assert.equal(await jumpToLatest.count(), 1, "Relay task must expose exactly one real jump-to-latest control");
  await jumpToLatest.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await jumpToLatest.isEnabled(), true, "Relay jump-to-latest must be enabled before its real click");
  await jumpToLatest.click();
  const tailGeometry = await waitFor(async () => {
    const geometry = await readTranscriptViewport(page, { markerText: tailMarker, rowTestId: "message-assistant" });
    return geometry.rowMatchCount === 1 && geometry.markerTextMatchCount === 1 &&
      geometry.markerIntersectsWindow && geometry.markerIntersectsList ? geometry : null;
  }, 10_000, "the Relay canonical assistant tail Range to become visible after its real jump-to-latest click");
  assert.equal(tailGeometry.rowDomId, `message-${encodeURIComponent(expectedAssistantMessageId)}`,
    "the visible Relay tail marker must belong to the exact canonical latest assistant row");

  const latestAnchor = await readCacheReadiness({
    ...cacheInputs,
    expectedAnchorMessageId: expectedAssistantMessageId,
    expectedAnchorOffset: 0,
    expectedAnchorOffsetTolerance: 0,
    expectedAnchorFollowsLatest: true,
    minimumManifestRevision: detachedAnchor.manifestRevision + 1,
  }, 30_000);
  assert.ok(latestAnchor?.ready,
    "Relay jump-to-latest must persist the exact canonical assistant anchor at followsLatest/offset zero");
  assert.ok(latestAnchor.manifestRevision > detachedAnchor.manifestRevision,
    "Relay latest-anchor persistence must advance the origin's IndexedDB manifest revision");
  assert.equal(latestAnchor.anchor?.messageId, expectedAssistantMessageId);
  assert.equal(latestAnchor.anchor?.followsLatest, true);
  assert.equal(latestAnchor.anchor?.offset, 0);

  return {
    initialRecord: {
      ready: true,
      initialAnchorPresent: initialCache.anchorPresent,
      manifestRevision: initialCache.manifestRevision,
    },
    wheel: {
      trusted: true,
      targetInsideMessageList: true,
      deltaY: selectedWheel.deltaY,
      targetPoint: wheelPoint,
      targetPreflight,
      dispatch: trustedWheel,
      scrollSamples: wheelAudit.scrollSamples ?? [],
      scrollTopBefore: scrollTop,
      scrollTopAfter: afterWheel.host.scrollTop,
      markerVisibleAfter: afterWheel.markerIntersectsList === true && afterWheel.markerIntersectsWindow === true,
    },
    detachedAnchor: {
      persisted: true,
      canonicalUserMessageMatched: detachedAnchor.anchor.messageId === expectedUserAnchorMessageId,
      followsLatest: detachedAnchor.anchor.followsLatest,
      offset: detachedAnchor.anchor.offset,
      manifestRevision: detachedAnchor.manifestRevision,
    },
    latestAnchor: {
      persisted: true,
      jumpControlCount: 1,
      jumpControlEnabled: true,
      clicked: true,
      tailRowMatchesCanonicalAssistant: true,
      canonicalAssistantMessageMatched: latestAnchor.anchor.messageId === expectedAssistantMessageId,
      followsLatest: latestAnchor.anchor.followsLatest,
      offset: latestAnchor.anchor.offset,
      manifestRevision: latestAnchor.manifestRevision,
    },
  };
}

/** Pair percentiles are emitted only when all five planned same-delay pairs are complete. */
export function summarizePairedTimingSamplesV1(samples, plannedPairs) {
  const delays = [...new Set(plannedPairs.map(group => group.delayMs))].sort((a, b) => a - b);
  const byRequestedHoldMs = {};
  for (const delayMs of delays) {
    const plans = plannedPairs.filter(group => group.delayMs === delayMs);
    const rows = samples.filter(sample => sample.requestedHoldMs === delayMs);
    const pairs = plans.map(plan => {
      const members = rows.filter(sample => sample.pairId === plan.pairId);
      const direct = members.find(sample => sample.laneId === "direct") ?? null;
      const relay = members.find(sample => sample.laneId === "relay") ?? null;
      return { pairId: plan.pairId, direct, relay,
        valid: direct?.validForPerformance === true && relay?.validForPerformance === true &&
          direct?.functionalStatus === "PASS" && relay?.functionalStatus === "PASS" };
    });
    const validPairs = pairs.filter(pair => pair.valid);
    const complete = plans.length === 5 && validPairs.length === 5;
    const metrics = {};
    for (const metric of TIMING_METRICS) {
      const directValues = validPairs.map(pair => pair.direct.browser?.[metric]).filter(Number.isFinite);
      const relayValues = validPairs.map(pair => pair.relay.browser?.[metric]).filter(Number.isFinite);
      const deltaValues = validPairs.map(pair => pair.relay.browser?.[metric] - pair.direct.browser?.[metric])
        .filter(Number.isFinite);
      const quantified = complete && directValues.length === 5 && relayValues.length === 5 && deltaValues.length === 5;
      metrics[metric] = {
        validPairN: validPairs.length,
        missingPairN: plans.length - validPairs.length,
        direct: quantified ? quantiles(directValues) : null,
        relay: quantified ? quantiles(relayValues) : null,
        relayMinusDirect: quantified ? quantiles(deltaValues) : null,
        deltaClockBoundary: "difference between matching per-page duration values; no cross-page timestamp subtraction",
      };
    }
    byRequestedHoldMs[String(delayMs)] = {
      plannedPairN: plans.length,
      validPairN: validPairs.length,
      invalidOrUnrunPairN: plans.length - validPairs.length,
      quantilesEmitted: complete,
      quantileRequirement: "all five direct/Relay pairs for this hold must be functionally PASS and traffic-complete",
      metrics,
    };
  }
  return {
    primaryMetric: "navigationToAuthorityHistoryVisibleMs",
    quantiles: "conventional median for even n; nearest-rank P95",
    byRequestedHoldMs,
  };
}

export function summarizeTimingByteEvidenceV1(traffic) {
  const responseCount = Number.isSafeInteger(traffic?.httpResponseCount) ? traffic.httpResponseCount : 0;
  const knownCount = Number.isSafeInteger(traffic?.httpResponseContentLengthKnownCount)
    ? traffic.httpResponseContentLengthKnownCount : 0;
  return {
    httpRequestBodyPayloadBytes: traffic?.httpRequestBodyBytes ?? 0,
    httpResponseKnownContentLengthSumBytes: traffic?.httpResponseContentLengthBytes ?? 0,
    httpResponseContentLengthKnownCount: knownCount,
    httpResponseContentLengthUnknownCount: Math.max(0, responseCount - knownCount),
    httpResponseUnknownBytes: null,
    websocketPayloadBytes: {
      sent: traffic?.websocketSentFrameBytes ?? 0,
      received: traffic?.websocketReceivedFrameBytes ?? 0,
    },
    rpcPayloadBytes: {
      request: sumRpcPayloadBytes(traffic?.rpcRequestRecords, "requestPayloadBytes"),
      response: sumRpcPayloadBytes(traffic?.rpcRequestRecords, "responsePayloadBytes"),
    },
    boundary: "known Content-Length sum only; unknown response byte total remains null; WebSocket/RPC figures are observed payload bytes, not wire bytes",
  };
}

function assertTimingOwnerRelease(release, owner) {
  const processRelease = release?.browserOwnerReleased === true && release.processGroupGone === true &&
    release.sameProfileDir === true && release.restartRequested === true &&
    Number.isSafeInteger(release.oldPid) && Number.isSafeInteger(release.oldPgid) &&
    Number.isSafeInteger(release.newPid) && release.newPid !== release.oldPid && Number.isSafeInteger(release.newPgid) &&
    Number.isFinite(release.startupMs) && typeof release.profileDir === "string";
  if (processRelease) return;
  if (release && ("allRouteEndpointsClosed" in release || "requiredRouteEndpointsClosed" in release)) {
    assert.equal(release.allRouteEndpointsClosed, true,
      `${owner} task Gateway client must release both owned RPC route endpoints before the next lane`);
    assert.equal(release.requiredRouteEndpointsClosed, true,
      `${owner} resume socket must close before the next lane`);
    return;
  }
  assert.fail(`${owner} setup must prove exact Chromium owner release and same-profile relaunch before the next lane`);
}

async function runOneSample({
  context, lane, laneState, createSamplePage, openCacheObserverPage, releaseTimingPage,
  laneStates, expectedBrowserOwner, hasNextLaneSample, hasLaterGroup, priorGroupSamplesValid,
  clientMessageIdHashKey, threadId, promptMarker,
  replacementMarker, tailMarker, expectedAssistantMessageId, delayMs, phase, index, pairId,
  laneOrder, browserErrors, readCacheReadiness, installResumeBridge, releaseTimingResponse,
  savePrivateScreenshot,
}) {
  const sample = {
    laneId: lane.id,
    phase,
    index,
    pairId,
    laneOrder,
    requestedHoldMs: delayMs,
    browserOwner: { ...expectedBrowserOwner },
    status: "FAIL",
    functionalStatus: "FAIL",
    validForPerformance: false,
    performanceValidityReasons: [],
    cacheReadiness: null,
    browser: null,
    nodeRpc: null,
    traffic: null,
    routeAudit: createMobileTimingLaneRouteAudit(lane.id),
    serviceWorker: null,
    ownershipRelease: null,
    ownershipReleaseError: null,
    error: null,
  };
  let samplePage = null;
  let timing = null;
  let traffic = null;
  const firstRouteSocketOrdinal = lane.protocol.nextSocketOrdinal;
  const firstPageRpcOrdinal = lane.protocol.nextPageRpcSocketOrdinal;
  const turnStartCountBefore = lane.protocol.requests.filter(request => request.method === "turn/start").length;
  try {
    if (!laneState.observerPage) laneState.observerPage = await openCacheObserverPage(lane);
    sample.cacheReadiness = await readCacheReadiness(lane, laneState.observerPage, {
      expectedMessageId: expectedAssistantMessageId,
      expectedAnchorMessageId: expectedAssistantMessageId,
      expectedAnchorFollowsLatest: true,
      expectedAnchorOffset: 0,
      expectedAnchorOffsetTolerance: 0,
      expectedScope: lane.expectedScope ?? null,
    });
    assert.ok(sample.cacheReadiness?.ready, "sample lane must start with the same exact-scope cached seed transcript");
    await laneState.observerPage.close();
    laneState.observerPage = null;
    await setupCacheTimingSamplePage({
      createSamplePage,
      onPage: value => { samplePage = value; },
      onTraffic: value => { traffic = value; },
      context,
      browserErrors,
      protocol: lane.protocol,
      promptMarker,
      replacementMarker,
      clientMessageIdHashKey,
      tailMarker,
      installTelemetry: async (targetPage, options) => {
        await installMobileTimingLaneHttpGuard(targetPage, lane, sample.routeAudit);
        return installCacheTimingTelemetry(targetPage, { ...options, expectedAssistantMessageId });
      },
      installResumeBridge: (...args) => installResumeBridge(lane, ...args),
    });

    timing = createTimingSample(lane.protocol, threadId, delayMs);
    lane.protocol.timingSample = timing;
    const browserErrorCountBefore = browserErrors.length;
    await samplePage.goto(lane.mobileUrl, { waitUntil: "domcontentloaded" });
    await samplePage.waitForURL(url => url.origin === lane.origin && url.pathname === lane.taskPath, { timeout: 30_000 });
    if (delayMs > 0) {
      await waitFor(() => samplePage.evaluate(() => Number.isFinite(window.__sessionCacheTiming?.cacheReadableAtMs)),
        30_000, `${lane.id} sample ${index} readable cached transcript before delayed authority`);
      assert.equal(await samplePage.evaluate(() => window.__sessionCacheTiming?.cacheReadOnlyObserved), true,
        "cached transcript must be read-only at the moment it is measured before delayed authority");
    }
    await waitFor(() => samplePage.evaluate(() => Number.isFinite(window.__sessionCacheTiming?.authorityHistoryVisibleAtMs)),
      30_000, `${lane.id} sample ${index} authoritative history visible`);
    await waitFor(() => samplePage.evaluate(() => Number.isFinite(window.__sessionCacheTiming?.composerReadyAtMs)),
      30_000, `${lane.id} sample ${index} editable composer after authoritative history`);
    await waitFor(() => timing.response?.forwardedAtNodeMs !== null && timing.response?.forwardedAtNodeMs !== undefined,
      30_000, `${lane.id} sample ${index} held thread/resume response forwarded`);
    await samplePage.getByTestId("message-user").filter({ hasText: promptMarker }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(timing.matchingResumeRequestCount, 1, "one exact-thread thread/resume request must drive each lane sample");
    assert.equal(lane.protocol.requests.filter(request => request.method === "turn/start").length,
      turnStartCountBefore, "a cache timing sample must not create or resend a turn");
    assert.equal(timing.response?.success, true, "the held authoritative thread/resume response must succeed");
    assert.equal(timing.response?.resumePageEvidence?.matched, true,
      "the actual held thread/resume response must contain the exact bounded authority page and unique canonical assistant tail");
    assert.ok(timing.response.appliedHoldRawMs >= delayMs,
      "the actual app-server response hold must meet its configured minimum duration");
    assert.equal(await samplePage.getByTestId("message-input").isEditable(), true,
      "the measured authority endpoint must leave the composer editable");
    assert.equal(browserErrors.length, browserErrorCountBefore, "sample must not add Browser page or console errors");
    sample.serviceWorker = await assertMobileTimingLaneServiceWorker(samplePage, lane);
    assert.equal(sample.routeAudit.violations.length, 0, "all observed Mobile HTTP and WebSocket routes must stay on their exact lane mount");

    const browserTiming = await samplePage.evaluate(() => ({ ...window.__sessionCacheTiming }));
    const cacheReadableAt = browserTiming.cacheReadableAtMs;
    const authorityHistoryAt = browserTiming.authorityHistoryVisibleAtMs;
    const composerReadyAt = browserTiming.composerReadyAtMs;
    assert.ok(Number.isFinite(browserTiming.navigationStartAtMs) && Number.isFinite(authorityHistoryAt) && Number.isFinite(composerReadyAt),
      "sample must record browser-owned navigation, authoritative-history, and composer-ready timestamps");
    if (delayMs > 0) assert.ok(Number.isFinite(cacheReadableAt), "delayed authority sample must observe readable cache first");
    sample.browser = {
      clock: "page performance.now; navigation start is the Navigation Timing startTime",
      cacheObserved: Number.isFinite(cacheReadableAt),
      cacheReadOnlyObserved: browserTiming.cacheReadOnlyObserved,
      cacheReadOnlyAtMs: browserTiming.cacheReadOnlyAtMs,
      navigationToCacheReadableMs: Number.isFinite(cacheReadableAt)
        ? roundTiming(cacheReadableAt - browserTiming.navigationStartAtMs) : null,
      navigationToAuthorityHistoryVisibleMs: roundTiming(authorityHistoryAt - browserTiming.navigationStartAtMs),
      cacheReadableToAuthorityHistoryVisibleMs: Number.isFinite(cacheReadableAt)
        ? roundTiming(authorityHistoryAt - cacheReadableAt) : null,
      navigationToComposerReadyMs: roundTiming(composerReadyAt - browserTiming.navigationStartAtMs),
      authorityHistoryToComposerReadyMs: roundTiming(composerReadyAt - authorityHistoryAt),
      cacheStatusVisibleAtMs: browserTiming.cacheStatusVisibleAtMs,
      tailMarkerVisibleAtMs: browserTiming.tailMarkerVisibleAtMs,
      observationFrames: browserTiming.observationFrames,
      observationStopReason: browserTiming.observationStopReason,
      rafGapSampleCount: browserTiming.rafGapSampleCount,
      rafMaxGapMs: browserTiming.rafMaxGapMs,
      longTaskSupported: browserTiming.longTaskSupported,
      longTaskCount: browserTiming.longTaskCount,
      longTaskMaxMs: browserTiming.longTaskMaxMs,
      longTaskSumMs: browserTiming.longTaskSumMs,
      eventTimingSupported: browserTiming.eventTimingSupported,
      inputSampleCount: browserTiming.inputSampleCount,
      inputMaxProcessingDelayMs: browserTiming.inputMaxProcessingDelayMs,
      inputSampleStatus: browserTiming.inputSampleStatus,
      authorityHistoryVisibleAtMs: authorityHistoryAt,
      composerReadyAtMs: composerReadyAt,
      mountedTailMarkerObserved: browserTiming.tailMarkerVisibleAtMs !== null,
    };
    sample.nodeRpc = snapshotTimingSample(timing);
    sample.metricsCapturedAtNodeMs = performance.now();
    sample.traffic = snapshotCacheTimingTraffic(traffic);
    sample.traffic.byteEvidence = summarizeTimingByteEvidenceV1(sample.traffic);
    sample.status = "PASS";
    sample.functionalStatus = "PASS";
  } catch (error) {
    if (timing) releaseTimingResponse(timing);
    sample.cacheReadiness ??= error?.cacheReadiness ?? null;
    sample.error = context.redactText(error?.stack || error?.message || String(error));
    if (timing) sample.nodeRpc = snapshotTimingSample(timing);
    if (samplePage) {
      if (traffic) {
        sample.traffic = snapshotCacheTimingTraffic(traffic);
        sample.traffic.byteEvidence = summarizeTimingByteEvidenceV1(sample.traffic);
      }
      try {
        sample.failureScreenshot = await savePrivateScreenshot(samplePage,
          context, `mobile-session-cache-timing-${lane.id}-${pairId ?? index}-failure.png`);
      } catch (screenshotError) {
        sample.failureScreenshot = { saved: false, modeVerified: false,
          error: context.redactText(screenshotError?.message || String(screenshotError)) };
      }
    }
  } finally {
    if (timing) {
      releaseTimingResponse(timing);
      if (lane.protocol.timingSample === timing) lane.protocol.timingSample = null;
    }
    try {
      await traffic?.dispose();
    } catch (disposeError) {
      sample.telemetryCleanupError = context.redactText(disposeError?.stack || disposeError?.message || String(disposeError));
      if (sample.status === "PASS") {
        sample.status = "FAIL";
        sample.functionalStatus = "FAIL";
        sample.error = "Cache timing telemetry cleanup failed";
      }
    }
  }
  if (sample.traffic === null && traffic) {
    sample.traffic = snapshotCacheTimingTraffic(traffic);
    sample.traffic.byteEvidence = summarizeTimingByteEvidenceV1(sample.traffic);
  }
  const performanceValidity = assessCacheTimingSamplePerformanceValidity({
    functionalStatus: sample.functionalStatus,
    traffic: sample.traffic,
  });
  sample.validForPerformance = performanceValidity.validForPerformance;
  sample.performanceValidityReasons = performanceValidity.invalidReasons;
  const restartAfterSample = hasNextLaneSample || (hasLaterGroup && priorGroupSamplesValid &&
    sample.status === "PASS" && sample.functionalStatus === "PASS" && sample.validForPerformance === true);
  try {
    sample.ownershipRelease = await releaseTimingPage(lane, samplePage, {
      restartAfterSample,
      firstRouteSocketOrdinal,
      firstPageRpcOrdinal,
      requiredSocketOrdinal: timing?.request?.socketOrdinal ?? null,
      observerPages: [...new Set([...laneStates.values()].map(state => state.observerPage).filter(Boolean))],
    });
    assertTimingSampleOwnerRelease(sample.ownershipRelease, restartAfterSample, expectedBrowserOwner);
    for (const state of laneStates.values()) state.observerPage = null;
  } catch (releaseError) {
    sample.ownershipReleaseError = context.redactText(releaseError?.stack || releaseError?.message || String(releaseError));
    if (sample.status === "PASS") {
      sample.status = "FAIL";
      sample.functionalStatus = "FAIL";
      sample.validForPerformance = false;
      sample.performanceValidityReasons = [...sample.performanceValidityReasons, "chromium-owner-release-unproven"];
      sample.error = "Cache timing sample Chromium owner process group was not released as required";
    }
  }
  sample.routeAudit = projectRouteAudit(sample.routeAudit);
  return sample;
}

function assertTimingSampleOwnerRelease(release, restartRequested, expectedOwner) {
  assert.equal(release?.status, "PASS", "sample must record a proven RunContext Chromium owner release");
  assert.equal(release.browserOwnerReleased, true, "sample Browser owner must close before another sample starts");
  assert.equal(release.processGroupGone, true, "RunContext must confirm the exact old Chromium process group is gone");
  assert.equal(release.sameProfileDir, true, "sample owner release must preserve the same persistent profile directory");
  assert.equal(release.restartRequested, restartRequested, "sample release must match the next-sample plan");
  assert.ok(Number.isSafeInteger(release.oldPid) && release.oldPid > 0 &&
    Number.isSafeInteger(release.oldPgid) && release.oldPgid > 0, "sample release requires exact old PID/PGID evidence");
  assert.equal(release.oldPid, expectedOwner.pid, "sample must run under the exact Chromium PID scheduled for its lane");
  assert.equal(release.oldPgid, expectedOwner.pgid, "sample must run under the exact Chromium PGID scheduled for its lane");
  assert.equal(release.profileDir, expectedOwner.profileDir, "sample owner must retain the scheduled RunContext profile");
  if (restartRequested) {
    assert.ok(Number.isSafeInteger(release.newPid) && release.newPid > 0 && release.newPid !== release.oldPid &&
      Number.isSafeInteger(release.newPgid) && release.newPgid > 0 &&
      Number.isFinite(release.startupMs) && release.startupMs >= 0,
    "the next sample requires a newly started same-profile Chromium owner");
  } else {
    assert.equal(release.newPid, null, "the final sample must close its owner without an unused relaunch");
    assert.equal(release.newPgid, null, "the final sample must not retain an unused process group");
  }
}

function createTimingSample(protocol, threadId, requestedHoldMs) {
  return {
    threadId,
    minSocketOrdinal: protocol.nextSocketOrdinal + 1,
    requestedHoldMs,
    matchingResumeRequestCount: 0,
    request: null,
    response: null,
    held: null,
    websocketClientFrameCount: 0,
    websocketClientFrameBytes: 0,
    websocketServerFrameCount: 0,
    websocketServerFrameBytes: 0,
    rpcRequestFrameCount: 0,
    rpcRequestFrameBytes: 0,
    rpcResponseFrameCount: 0,
    rpcResponseFrameBytes: 0,
    rpcRequestCountsByMethod: {},
    rpcResponseCountsByMethodOutcome: {},
  };
}

function snapshotTimingSample(sample) {
  return {
    clock: "Node performance.now; values are not subtracted from browser timestamps",
    requestedHoldMs: sample.requestedHoldMs,
    matchingResumeRequestCount: sample.matchingResumeRequestCount,
    requestThreadMatched: sample.request?.threadId === sample.threadId,
    methodMatched: sample.request?.method === "thread/resume",
    requestAtNodeMs: sample.request?.at ?? null,
    responseSuccess: sample.response?.success ?? null,
    resumePageEvidence: sample.response?.resumePageEvidence ?? null,
    responseReceivedAtNodeMs: sample.response?.receivedAtNodeMs ?? null,
    responseForwardedAtNodeMs: sample.response?.forwardedAtNodeMs ?? null,
    appliedHoldRawMs: sample.response?.appliedHoldRawMs ?? null,
    appliedHoldMs: sample.response?.appliedHoldMs ?? null,
    forwardError: sample.response?.forwardError === true,
    websocketClientFrameCount: sample.websocketClientFrameCount,
    websocketClientFrameBytes: sample.websocketClientFrameBytes,
    websocketServerFrameCount: sample.websocketServerFrameCount,
    websocketServerFrameBytes: sample.websocketServerFrameBytes,
    rpcRequestFrameCount: sample.rpcRequestFrameCount,
    rpcRequestFrameBytes: sample.rpcRequestFrameBytes,
    rpcResponseFrameCount: sample.rpcResponseFrameCount,
    rpcResponseFrameBytes: sample.rpcResponseFrameBytes,
    rpcRequestCountsByMethod: sortCountRecord(sample.rpcRequestCountsByMethod),
    rpcResponseCountsByMethodOutcome: sortNestedCountRecord(sample.rpcResponseCountsByMethodOutcome),
  };
}

function summarizeTimingSamples(samples) {
  const summaries = {};
  for (const delayMs of [0, 300, 600, 1000]) {
    const group = samples.filter(sample => sample.requestedHoldMs === delayMs);
    const metrics = {};
    for (const metric of TIMING_METRICS) {
      const values = group.filter(sample => sample.validForPerformance === true)
        .map(sample => sample.browser?.[metric]).filter(Number.isFinite).sort((a, b) => a - b);
      const complete = values.length === group.length && group.length === 5;
      metrics[metric] = {
        plannedN: group.length,
        validN: values.length,
        missingN: group.length - values.length,
        p50Ms: complete ? conventionalMedian(values) : null,
        p95Ms: complete ? values[Math.ceil(0.95 * values.length) - 1] : null,
      };
    }
    summaries[String(delayMs)] = {
      validForPerformanceSampleCount: group.filter(sample => sample.validForPerformance === true).length,
      invalidOrUnrunPerformanceSampleCount: group.filter(sample => sample.validForPerformance !== true).length,
      cacheObservedSampleCount: group.filter(sample => sample.validForPerformance === true && sample.browser?.cacheObserved === true).length,
      cacheUnobservedValidSampleCount: group.filter(sample => sample.validForPerformance === true && sample.browser?.cacheObserved !== true).length,
      metrics,
    };
  }
  return {
    primaryRecoveryMetric: "navigationToAuthorityHistoryVisibleMs; cacheView disappeared and the confirmed marker was visible in live history",
    composerReadyMetrics: "recorded separately; they include deferred-configuration readiness after authoritative history is visible",
    quantiles: "conventional median for even n; nearest-rank P95",
    byRequestedHoldMs: summaries,
  };
}

function summarizePairedGroup(group) {
  return {
    phase: group.phase,
    index: group.index,
    pairId: group.pairId,
    requestedHoldMs: group.delayMs,
    laneOrder: group.laneOrder,
    direct: projectPairMember(group.samples.find(sample => sample.laneId === "direct")),
    relay: projectPairMember(group.samples.find(sample => sample.laneId === "relay")),
    pairValidForPerformance: shouldContinueAfterTimingGroupV1(group.samples),
  };
}

function projectPair(group) {
  return summarizePairedGroup(group);
}

function projectPairMember(sample) {
  if (!sample) return null;
  return {
    status: sample.status,
    functionalStatus: sample.functionalStatus,
    validForPerformance: sample.validForPerformance,
    performanceValidityReasons: sample.performanceValidityReasons,
    browser: sample.browser,
    nodeRpc: sample.nodeRpc,
    traffic: sample.traffic,
    routeAudit: sample.routeAudit,
    serviceWorker: sample.serviceWorker,
    failureScreenshot: sample.failureScreenshot ?? null,
    error: sample.error,
  };
}

function projectPilot(sample) {
  return {
    status: sample.status,
    functionalStatus: sample.functionalStatus,
    validForPerformance: sample.validForPerformance,
    performanceValidityReasons: sample.performanceValidityReasons,
    requestedHoldMs: sample.requestedHoldMs,
    browser: sample.browser,
    nodeRpc: sample.nodeRpc,
    traffic: sample.traffic,
    failureScreenshot: sample.failureScreenshot ?? null,
    error: sample.error,
  };
}

function createNotRunSample(group, laneId, laneOrder, status) {
  return {
    laneId,
    phase: group.phase,
    index: group.index,
    pairId: group.pairId ?? null,
    laneOrder,
    requestedHoldMs: group.delayMs,
    status,
    functionalStatus: "NOT_RUN",
    validForPerformance: false,
    performanceValidityReasons: ["functionalStatus", "httpRequestRecordsComplete", "rpcRequestRecordsComplete"],
    cacheReadiness: null,
    browser: null,
    nodeRpc: null,
    traffic: null,
    routeAudit: null,
    serviceWorker: null,
    error: null,
  };
}

function classifyLaneRequest(lane, rawUrl, resourceType) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return "unexpected"; }
  if (!isHttpProtocol(url.protocol)) return null;
  if (url.origin !== lane.origin) return "foreign-origin";
  const path = url.pathname;
  const gatewayPrefix = lane.gatewayPrefix ?? (lane.gatewayPath === "/" ? "" : stripTrailingSlash(lane.gatewayPath));
  const gatewayPath = gatewayPrefix || "/";
  const mobilePath = lane.mobilePath;
  const mobileMountPath = lane.mobileMountPath;
  const entryPath = `${gatewayPrefix}/mobile-entry` || "/mobile-entry";
  const apiPrefix = `${gatewayPrefix}/api/` || "/api/";
  const rpcPath = lane.rpcPath;
  if (path === entryPath) return "entry";
  if (path === mobilePath) return "mobile";
  if (path === gatewayPath) return "gateway";
  if (path === lane.workerPath) return "worker";
  if (path.startsWith(apiPrefix)) return "api";
  if (path.startsWith(`${mobileMountPath}/`)) return "asset";
  if (path === rpcPath && (url.protocol === "ws:" || url.protocol === "wss:")) return "rpc";
  if (resourceType === "document" || resourceType === "script" || resourceType === "stylesheet" ||
      resourceType === "font" || resourceType === "image" || resourceType === "worker" || resourceType === "serviceworker") {
    return "unexpected";
  }
  return "unexpected";
}

export function createMobileTimingLaneRouteAudit(laneId) {
  return {
    laneId,
    requestCount: 0,
    requestCountsByKind: {},
    websocketObservationCount: 0,
    violations: [],
    overflowed: false,
  };
}

function recordLaneViolation(audit, kind) {
  if (audit.violations.length >= 32) {
    audit.overflowed = true;
    return;
  }
  audit.violations.push({ kind, laneId: audit.laneId });
}

function projectRouteAudit(audit) {
  return {
    laneId: audit.laneId,
    requestCount: audit.requestCount,
    requestCountsByKind: sortCountRecord(audit.requestCountsByKind),
    websocketObservationCount: audit.websocketObservationCount,
    violationCount: audit.violations.length,
    violations: audit.violations,
    overflowed: audit.overflowed,
  };
}

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50Ms: conventionalMedian(sorted),
    p95Ms: sorted[Math.ceil(0.95 * sorted.length) - 1],
  };
}

function conventionalMedian(values) {
  const middle = Math.floor(values.length / 2);
  return roundTiming(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2);
}

function roundTiming(value) {
  return Math.round(value * 100) / 100;
}

function sortCountRecord(counts) {
  return Object.fromEntries(Object.entries(counts ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function sortNestedCountRecord(counts) {
  return Object.fromEntries(Object.entries(counts ?? {}).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, { success: value.success, error: value.error }]));
}

function sumRpcPayloadBytes(records, key) {
  if (!Array.isArray(records)) return 0;
  return records.reduce((total, row) => total + (Number.isSafeInteger(row?.[key]) ? row[key] : 0), 0);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function isPathBelow(mountPath, gatewayPrefix) {
  return mountPath.startsWith(`${gatewayPrefix}/`) && mountPath !== gatewayPrefix;
}

function isHttpProtocol(protocol) {
  return protocol === "http:" || protocol === "https:";
}

function hasUnsafePathEncoding(pathname) {
  return /%(?:2f|5c|00|2e)/i.test(pathname) || pathname.includes("\\");
}
