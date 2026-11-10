import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { assertCachedSessionComposerReadOnly } from "../../harness/mobile-session-cache-readonly.mjs";
import { waitFor } from "../../harness/run-context.mjs";
import {
  assertAnchorScrollReachability,
  assessAnchorScrollReachability,
  assertColdOfflineBridgeStayedOffline,
  projectColdFailureCacheEvidence,
  projectColdOfflineBridgeEvidence,
  projectColdFailureUiState,
  projectColdFailureViewportGeometry,
} from "../../harness/mobile-session-cache-cold-diagnostics.mjs";
import {
  correlateMobilePageRpcRoutes,
  mobilePageRpcRoutesClosed,
} from "../../harness/mobile-page-rpc-lifecycle.mjs";
import {
  MOBILE_OFFLINE_BUILD_DIGEST_HEADER,
  MOBILE_OFFLINE_GENERATION_HEADER,
  MOBILE_OFFLINE_LIMITS,
} from "../../../src/mobile-web-offline.js";

const FIRST_CHROMIUM_LABEL = "session-cache-chromium";
const COLD_CHROMIUM_LABEL = "session-cache-cold-open-chromium";
const MOBILE_SCOPE_PATH = "/mobile/";

export async function runColdProcessSmoke({
  context,
  firstChromium,
  profileName,
  firstPage,
  gateway,
  mobileWeb,
  deploymentRoot,
  productionMobileMountInputs,
  mobileEntryUrl,
  taskPath,
  threadId,
  promptMarker,
  replacementMarker,
  tailMarker,
  gatewayOrigin,
  scopeExpectation,
  cacheAfterTurn,
  savedAnchor,
  anchorScrollResponse,
  anchorDisplayIdentity,
  protocol,
  installResumeBridge,
  releaseHeldAuthority,
  rustAppServer,
  firstBrowserIdentity,
  waitForReadOnlyTranscriptCache,
  readTranscriptViewport,
  assertOffsetNear,
  capturePrivateScreenshot,
}) {
  assert.ok(productionMobileMountInputs?.archiveSha256,
    "cold process smoke requires the caller-pinned production Mobile Web archive");
  assert.ok(typeof profileName === "string" && profileName.length > 0,
    "cold process smoke requires the exact RunContext profile name used by the first Chromium");
  assert.ok(scopeExpectation, "cold process smoke requires the observed production Mobile route scope");
  assert.match(threadId, /^[A-Za-z0-9._:-]+$/, "cold process smoke requires the exact UI-created thread identity");
  assert.equal(new URL(mobileEntryUrl).origin, gatewayOrigin, "the Mobile entry must use the owned Gateway origin");
  assert.equal(new URL(mobileEntryUrl).pathname, MOBILE_SCOPE_PATH, "the cold browser must open the actual /mobile/ mount entry");
  assert.ok(taskPath.startsWith(MOBILE_SCOPE_PATH), "the cached task route must remain under the actual Mobile mount");
  assert.equal(cacheAfterTurn.ready, true, "the first browser must have committed the real UI-seeded transcript cache");
  assert.equal(savedAnchor.ready, true, "the first browser must have committed the real trusted-wheel reading anchor");
  assert.equal(savedAnchor.anchor?.followsLatest, false, "the cold reopen must start from a detached reading position");
  assert.ok(anchorScrollResponse && Number.isFinite(anchorScrollResponse.rowOffsetPerScrollTop),
    "cold process recovery requires the exact live scroll-axis response measured from the user row");
  assert.equal(anchorDisplayIdentity.canonicalId, savedAnchor.anchor.messageId,
    "the display anchor must resolve from the exact UI-seeded cache identity");
  assert.equal(protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length,
    1, "the UI must complete exactly one deterministic full turn before the cold restart");

  assert.ok(typeof deploymentRoot === "string" && deploymentRoot.length > 0,
    "cold process smoke requires the actual Gateway deployment root");
  const bundleManifestPath = resolve(deploymentRoot, "kcoder-mobile-web.json");
  const bundleManifestBytes = await readFile(bundleManifestPath);
  assert.ok(bundleManifestBytes.length > 0 && bundleManifestBytes.length <= 4 * 1024 * 1024,
    "the production Mobile Web manifest must be a bounded regular build input");
  const bundleManifestSha256 = createHash("sha256").update(bundleManifestBytes).digest("hex");
  const bundleManifest = JSON.parse(bundleManifestBytes.toString("utf8"));
  assert.equal(bundleManifest.version, 1, "the production Mobile Web asset manifest must use the current version");
  assert.ok(Array.isArray(bundleManifest.files) && bundleManifest.files.length > 0 &&
    bundleManifest.files.length <= MOBILE_OFFLINE_LIMITS.assets,
  "the production Mobile Web inventory must fit the current offline worker asset limit");
  const expectedAssetPaths = bundleManifest.files.map(row => row.path);
  assert.ok(expectedAssetPaths.every((path, index) => typeof path === "string" && path.length > 0 &&
    path.length <= 1024 && !path.startsWith("/") && !/[\\\x00-\x1f\x7f%?#]/.test(path) &&
    path.split("/").every(segment => segment && segment !== "." && segment !== "..") &&
    Number.isSafeInteger(bundleManifest.files[index].size) && bundleManifest.files[index].size >= 0 &&
    /^[a-f0-9]{64}$/.test(bundleManifest.files[index].sha256) &&
    typeof bundleManifest.files[index].text === "boolean" &&
    Number.isSafeInteger(bundleManifest.files[index].replacements) && bundleManifest.files[index].replacements >= 0),
  "the actual Mobile Web manifest must provide every offline asset path");
  assert.equal(new Set(expectedAssetPaths).size, expectedAssetPaths.length,
    "the actual Mobile Web manifest must contain unique offline asset paths");
  assert.ok(expectedAssetPaths.includes("index.html"), "the actual Mobile Web inventory must contain its entry document");

  const serviceWorkerCacheBeforeExit = await waitFor(async () => {
    const snapshot = await readActualServiceWorkerCache(firstPage, {
      gatewayOrigin,
      scopePath: MOBILE_SCOPE_PATH,
      expectedManifestSha256: bundleManifestSha256,
      expectedAssetPaths,
    });
    return snapshot.ready ? snapshot : null;
  }, 15_000, "the first Chromium's naturally installed Mobile Service Worker inventory");
  assert.equal(serviceWorkerCacheBeforeExit.marker.assetCount, expectedAssetPaths.length,
    "the first Chromium's natural completion marker must attest every pinned Mobile asset before process exit");

  const firstProfileDir = firstChromium.profileDir;
  const firstContextList = firstChromium.browser.contexts();
  assert.equal(firstContextList.length, 1, "the first owned Chromium must have exactly one default persistent context");
  const firstDefaultContext = firstContextList[0];
  const firstOwnedPages = firstDefaultContext.pages();
  assert.ok(firstOwnedPages.includes(firstPage), "the setup page must belong to the first Chromium default context");
  const firstProcessRpcPairs = correlateMobilePageRpcRoutes(protocol.pageWebSockets, protocol.routeDiagnostics);
  for (const page of firstOwnedPages) {
    if (page.isClosed()) continue;
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.close();
  }
  await waitFor(() => mobilePageRpcRoutesClosed(firstProcessRpcPairs) ? true : null,
    15_000, "all correlated first-process Mobile RPC route endpoints to close after owned-page navigation completes");
  const firstProcessRpcShutdown = {
    navigationCompletedBeforeBarrier: true,
    pageRpcRouteCount: firstProcessRpcPairs.length,
    routes: firstProcessRpcPairs.map(({ pageSocket, routeDiagnostic }) => ({
      rpcOrdinal: pageSocket.rpcOrdinal,
      browserWrapperClosedAtMs: pageSocket.closedAtMs,
      browserWrapperCloseObserved: Number.isFinite(pageSocket.closedAtMs),
      clientClosedAtMs: routeDiagnostic.clientClosedAtMs,
      clientClosed: Number.isFinite(routeDiagnostic.clientClosedAtMs),
      upstreamClosedAtMs: routeDiagnostic.upstreamClosedAtMs,
      upstreamClosed: Number.isFinite(routeDiagnostic.upstreamClosedAtMs),
    })),
  };

  const firstProcess = context.processes.get(FIRST_CHROMIUM_LABEL);
  assert.ok(firstProcess, "the first Chromium must retain its exact RunContext process owner record");
  const firstPid = firstProcess.pid ?? firstProcess.child?.pid;
  await firstChromium.close();
  await assertOwnedChromiumExited(context, FIRST_CHROMIUM_LABEL, firstProcess);

  let coldChromium = null;
  let coldContext = null;
  let coldPage = null;
  let coldCdp = null;
  let coldPageErrors = [];
  let offlineNetworkResponses = [];
  let offlineObservationActive = true;
  const offlineGatewayHttpRequests = [];
  const offlineGatewayHttpByRequest = new WeakMap();
  const offlineWebSocketObservations = [];
  let offlineTurnStarts = [];
  let coldPageBridgeFirstSocketOrdinal = null;
  let offlineBridgeEvidence = null;
  let serviceWorkerCacheAfterRestart = null;
  let cacheAfterRestart = null;
  let cachedAnchorWhileOffline = null;
  let offlineAnchorReachability = null;
  let cachedAnchorWhileAuthorityHeld = null;
  let authorityAnchorAfterRelease = null;
  let syncedCacheReadiness = null;
  let authorityResponse = null;
  let recoveryTrigger = null;
  let coldPhase = "cold-chromium-open";
  let coldOffline = false;
  try {
    coldChromium = await startColdChromiumProfileEpoch({
      context,
      profileName,
      firstProfileDir,
      firstPid,
    });
    const coldContexts = coldChromium.browser.contexts();
    assert.equal(coldContexts.length, 1, "the cold Chromium must have exactly one default persistent context");
    coldContext = coldContexts[0];
    assert.equal(typeof coldContext.setOffline, "function", "the persistent BrowserContext must support whole-context offline mode");
    await coldContext.setOffline(true);
    coldOffline = true;

    coldPage = await coldChromium.newPersistentPage();
    await coldPage.setViewportSize({ width: 390, height: 844 });
    coldPage.on("pageerror", error => coldPageErrors.push(context.redactText(String(error?.message ?? error)).slice(0, 1000)));
    const gatewayUrl = new URL(gatewayOrigin);
    const gatewayRpcPath = `${gatewayUrl.pathname.replace(/\/+$/, "")}/rpc`;
    const observeOfflineRequest = request => {
      if (!offlineObservationActive) return null;
      let requestUrl;
      try { requestUrl = new URL(request.url()); } catch { return null; }
      if (requestUrl.origin !== gatewayOrigin) return null;
      let observation = offlineGatewayHttpByRequest.get(request);
      if (!observation) {
        observation = {
          method: request.method(),
          path: requestUrl.pathname,
          resourceType: request.resourceType(),
          responseStatus: null,
          fromServiceWorker: false,
          finished: false,
          failureCode: null,
        };
        offlineGatewayHttpByRequest.set(request, observation);
        offlineGatewayHttpRequests.push(observation);
      }
      return observation;
    };
    coldPage.on("request", request => { observeOfflineRequest(request); });
    coldPage.on("response", response => {
      const observation = observeOfflineRequest(response.request());
      if (!observation) return;
      observation.responseStatus = response.status();
      observation.fromServiceWorker = response.fromServiceWorker();
    });
    coldPage.on("requestfinished", request => {
      const observation = observeOfflineRequest(request);
      if (observation) observation.finished = true;
    });
    coldPage.on("requestfailed", request => {
      const observation = observeOfflineRequest(request);
      if (!observation) return;
      const failureText = request.failure()?.errorText ?? "";
      observation.failureCode = /\bERR_[A-Z0-9_]+\b/.exec(failureText)?.[0] ?? "network-failure";
    });
    coldPage.on("websocket", socket => {
      if (!offlineObservationActive) return;
      let socketUrl;
      try { socketUrl = new URL(socket.url()); } catch { return; }
      if (socketUrl.host !== gatewayUrl.host || socketUrl.pathname !== gatewayRpcPath) return;
      const observation = {
        path: socketUrl.pathname,
        sentFrameCount: 0,
        sentMethods: {},
        receivedFrameCount: 0,
        receivedResponseFrameCount: 0,
        socketError: false,
        closed: false,
      };
      offlineWebSocketObservations.push(observation);
      socket.on("framesent", event => {
        if (!offlineObservationActive) return;
        observation.sentFrameCount += 1;
        if (typeof event.payload !== "string") return;
        try {
          const frame = JSON.parse(event.payload);
          if (typeof frame?.method === "string") {
            observation.sentMethods[frame.method] = (observation.sentMethods[frame.method] ?? 0) + 1;
          }
          if (frame?.method === "turn/start") {
            offlineTurnStarts.push({ method: frame.method });
          }
        } catch {}
      });
      socket.on("framereceived", event => {
        if (!offlineObservationActive) return;
        observation.receivedFrameCount += 1;
        if (typeof event.payload !== "string") return;
        try {
          const frame = JSON.parse(event.payload);
          if (frame?.id !== undefined && (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))) {
            observation.receivedResponseFrameCount += 1;
          }
        } catch {}
      });
      socket.on("socketerror", () => {
        if (offlineObservationActive) observation.socketError = true;
      });
      socket.on("close", () => {
        if (offlineObservationActive) observation.closed = true;
      });
    });

    coldPageBridgeFirstSocketOrdinal = protocol.nextSocketOrdinal + 1;
    protocol.coldOfflineBridgeAudit = {
      active: true,
      firstSocketOrdinal: coldPageBridgeFirstSocketOrdinal,
      routes: [],
      overflowed: false,
    };

    coldCdp = await coldContext.newCDPSession(coldPage);
    await coldCdp.send("Network.enable");
    coldCdp.on("Network.responseReceived", event => {
      if (!offlineObservationActive) return;
      let url;
      try { url = new URL(event.response.url); } catch { return; }
      if (url.origin !== gatewayOrigin || !url.pathname.startsWith(MOBILE_SCOPE_PATH)) return;
      offlineNetworkResponses.push({
        path: url.pathname,
        resourceType: event.type,
        status: event.response.status,
        fromServiceWorker: event.response.fromServiceWorker === true,
      });
      if (offlineNetworkResponses.length > 128) offlineNetworkResponses.shift();
    });

    coldPhase = "offline-mobile-document-load";
    await installResumeBridge(coldPage);
    await coldPage.goto(mobileEntryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await coldPage.waitForURL(url => url.pathname === taskPath, { timeout: 30_000 });
    await coldPage.getByTestId("session-cache-view").waitFor({ state: "visible", timeout: 30_000 });
    await coldPage.getByTestId("session-cache-status").waitFor({ state: "visible", timeout: 30_000 });
    await coldPage.getByTestId("session-cache-retry").waitFor({ state: "visible", timeout: 30_000 });
    const offlineReadOnlyComposer = await assertCachedSessionComposerReadOnly(coldPage,
      "the cold offline cached task");
    const cachedPrompt = coldPage.getByTestId("message-user").filter({ hasText: promptMarker });
    await cachedPrompt.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await cachedPrompt.count(), 1, "the cold offline Mobile entry must restore the exact original cached user row once");

    const offlineDocument = await waitFor(() => offlineNetworkResponses.find(response =>
      response.path === MOBILE_SCOPE_PATH && response.resourceType === "Document" && response.fromServiceWorker) ?? null,
    15_000, "the real /mobile/ document response to come from the installed Service Worker while Chromium is offline");
    assert.equal(offlineDocument.status, 200, "the actual Mobile entry document must load successfully from Service Worker cache");
    const offlineBundleScript = await waitFor(() => offlineNetworkResponses.find(response =>
      response.resourceType === "Script" && response.fromServiceWorker &&
      expectedAssetPaths.includes(response.path.slice(MOBILE_SCOPE_PATH.length)) && response.status === 200) ?? null,
    15_000, "at least one actual pinned Mobile bundle script to execute from the Service Worker cache");
    assert.equal(offlineBundleScript.fromServiceWorker, true,
      "the Mobile JavaScript entry must be served from the actual Service Worker cache");

    serviceWorkerCacheAfterRestart = await waitFor(async () => {
      const snapshot = await readActualServiceWorkerCache(coldPage, {
        gatewayOrigin,
        scopePath: MOBILE_SCOPE_PATH,
        expectedManifestSha256: bundleManifestSha256,
        expectedAssetPaths,
      });
      return snapshot.ready && snapshot.controllerScope === `${gatewayOrigin}${MOBILE_SCOPE_PATH}` &&
        snapshot.controllerScriptPath === `${MOBILE_SCOPE_PATH}__kcoder_offline_sw.js` ? snapshot : null;
    }, 15_000, "the completed production Mobile Service Worker inventory and controller after process restart");
    assert.equal(serviceWorkerCacheAfterRestart.controllerScope, `${gatewayOrigin}${MOBILE_SCOPE_PATH}`,
      "the offline task document must be controlled by the production Mobile Service Worker scope");
    assert.equal(serviceWorkerCacheAfterRestart.controllerScriptPath, `${MOBILE_SCOPE_PATH}__kcoder_offline_sw.js`,
      "the offline task document must use the production Gateway-mounted Mobile worker endpoint");
    assert.equal(serviceWorkerCacheAfterRestart.marker.manifestSha256, bundleManifestSha256,
      "the naturally written Service Worker completion marker must bind to the actual bundle manifest digest");
    assert.equal(serviceWorkerCacheAfterRestart.marker.assetCount, expectedAssetPaths.length,
      "the Service Worker completion marker must attest every asset in the pinned Mobile manifest");
    assert.deepEqual(serviceWorkerCacheAfterRestart.assetPaths, expectedAssetPaths.slice().sort(),
      "the persisted Service Worker cache must contain exactly the files from the actual Mobile build inventory");

    coldPhase = "offline-cached-transcript-readback";
    cacheAfterRestart = await waitForReadOnlyTranscriptCache(coldPage, {
      threadId,
      gatewayOrigin,
      marker: promptMarker,
      expectedScope: scopeExpectation,
      expectedAnchorMessageId: savedAnchor.anchor.messageId,
      requireReadingAnchor: true,
    }, 30_000);
    assert.ok(cacheAfterRestart.ready, "the cold browser must read back the exact UI-seeded transcript and detached anchor from IndexedDB");
    assert.equal(cacheAfterRestart.entryKey, savedAnchor.entryKey,
      "the cold browser must use the same committed cache manifest entry seeded before process exit");
    assert.equal(cacheAfterRestart.entrySlot, savedAnchor.entrySlot,
      "the cold browser must use the same committed cache slot seeded before process exit");
    assert.equal(cacheAfterRestart.entryRevision, savedAnchor.entryRevision,
      "offline display must leave the exact seeded cache revision unchanged");
    assert.deepEqual(cacheAfterRestart.anchor, savedAnchor.anchor,
      "offline display must retain the exact detached canonical reading anchor");
    coldPhase = "offline-cached-anchor-scroll-preflight";
    const offlineAnchorCandidate = await readTranscriptViewport(coldPage, {
      markerText: promptMarker,
      rowDomId: `message-${encodeURIComponent(anchorDisplayIdentity.canonicalId)}`,
      rowTestId: "message-user",
    });
    offlineAnchorReachability = assertAnchorScrollReachability(
      offlineAnchorCandidate,
      savedAnchor.anchor.offset,
      anchorScrollResponse,
      "offline cached user anchor scroll precondition",
    );
    coldPhase = "offline-cached-anchor-geometry";
    cachedAnchorWhileOffline = await waitForAnchorGeometry({
      page: coldPage,
      rowDomId: `message-${encodeURIComponent(anchorDisplayIdentity.canonicalId)}`,
      rowTestId: "message-user",
      markerText: promptMarker,
      expectedOffset: savedAnchor.anchor.offset,
      label: "cold offline cached anchor viewport geometry",
      readTranscriptViewport,
      assertOffsetNear,
    });
    assert.equal(cachedAnchorWhileOffline.rowMatchCount, 1, "the detached cached anchor row must be mounted exactly once after process exit");
    assert.equal(cachedAnchorWhileOffline.rowIntersectsWindow, true, "the detached cached anchor row must remain in the viewport while offline");
    assert.equal(cachedAnchorWhileOffline.rowIntersectsList, true, "the detached cached anchor row must remain in the transcript list while offline");
    assertOffsetNear(cachedAnchorWhileOffline.row.offsetFromHost, savedAnchor.anchor.offset,
      "cold offline cached anchor offset from scroll host versus the persisted reading anchor");
    assert.equal(offlineTurnStarts.length, 0, "the offline cached UI must not submit a turn/start RPC");
    const offlineApiRequests = offlineGatewayHttpRequests.filter(request => request.path.startsWith("/api/"));
    const offlineApiSuccessfulResponses = offlineApiRequests.filter(request =>
      request.responseStatus >= 200 && request.responseStatus < 300);
    const offlineRpcSentFrameCount = offlineWebSocketObservations.reduce((sum, socket) => sum + socket.sentFrameCount, 0);
    const offlineRpcResponseFrameCount = offlineWebSocketObservations.reduce((sum, socket) =>
      sum + socket.receivedResponseFrameCount, 0);
    assert.equal(offlineApiSuccessfulResponses.length, 0,
      "the offline browser must observe no successful Gateway API response");
    assert.equal(offlineRpcResponseFrameCount, 0,
      "the offline browser must observe no successful Gateway RPC response frame");
    assert.equal(offlineRpcSentFrameCount, 0,
      "the offline browser must send no Gateway RPC frame");
    const offlineUiSnapshot = {
      promptVisibleOnce: await cachedPrompt.count() === 1,
      cachedViewVisible: await coldPage.getByTestId("session-cache-view").isVisible(),
      readOnlyStatusVisible: await coldPage.getByTestId("session-cache-status").isVisible(),
      composerVisible: offlineReadOnlyComposer.inputVisible,
      composerEditable: offlineReadOnlyComposer.inputEditable,
      composerDisabledControls: offlineReadOnlyComposer.disabledControls,
      retryActionVisible: await coldPage.getByTestId("session-cache-retry").isVisible(),
    };
    assert.deepEqual(offlineUiSnapshot, {
      promptVisibleOnce: true,
      cachedViewVisible: true,
      readOnlyStatusVisible: true,
      composerVisible: true,
      composerEditable: false,
      composerDisabledControls: ["send", "attachment", "model selection", "permission selection"],
      retryActionVisible: true,
    }, "the evidence snapshot must capture the visible read-only offline cache before reconnect");

    protocol.coldOfflineBridgeAudit.active = false;
    offlineBridgeEvidence = assertColdOfflineBridgeStayedOffline(projectColdOfflineBridgeEvidence({
      firstSocketOrdinal: coldPageBridgeFirstSocketOrdinal,
      routeDiagnostics: protocol.coldOfflineBridgeAudit.routes,
      requests: protocol.requests,
      overflowed: protocol.coldOfflineBridgeAudit.overflowed,
    }));

    const coldProcess = context.processes.get(COLD_CHROMIUM_LABEL);
    assert.ok(coldProcess, "the cold Chromium must retain its exact RunContext process owner record");
    const coldPid = coldProcess.pid ?? coldProcess.child?.pid;
    assert.notEqual(coldPid, firstPid, "the first and second profile epochs must have different owned Chromium PIDs");
    assert.equal(coldChromium.profileDir, firstProfileDir, "both process epochs must retain identical profile paths");
    assert.equal(protocol.errors.length, 0, `protocol bridge errors before reconnect: ${protocol.errors.join(" | ")}`);

    protocol.rootRestore = {
      minSocketOrdinal: coldPageBridgeFirstSocketOrdinal,
      threadId,
      holdMode: "full",
    };
    offlineObservationActive = false;
    await coldContext.setOffline(false);
    coldOffline = false;
    coldPhase = "authority-reconnect";
    recoveryTrigger = "user-clicked-session-cache-retry";
    await coldPage.getByTestId("session-cache-retry").click();
    authorityResponse = await waitFor(() => protocol.rootRestore?.heldResponse ?? protocol.errors[0] ?? null,
      30_000, "the exact real Rust thread/resume response to be held before replacing the cold cached transcript");
    assert.equal(protocol.errors.length, 0, `protocol bridge errors during cold reconnect: ${protocol.errors.join(" | ")}`);
    assert.equal(protocol.rootRestore.request?.method, "thread/resume", "the scoped Reconnect action must request thread/resume");
    assert.equal(protocol.rootRestore.request?.threadId, threadId, "the Reconnect action must resume the exact cached thread");
    assert.equal(authorityResponse.threadId, threadId, "the held authoritative response must identify the exact cached thread");
    assert.equal(authorityResponse.success, true, "the unchanged authoritative Rust resume response must succeed");
    assert.equal(authorityResponse.fixtureTransformed, false, "the cold recovery barrier must preserve the exact Rust authority response");
    assert.ok(authorityResponse.messageIds.length >= 2, "the unchanged inline authority page must contain the original user and assistant rows");
    assert.ok(authorityResponse.messageIds.includes(anchorDisplayIdentity.canonicalId),
      "the exact persisted reading-anchor message must remain in the authoritative resume page");
    assert.ok(authorityResponse.markerMessageId, "the authoritative resume page must identify the original UI-created prompt row");
    assert.equal(authorityResponse.replacementMessageId, null,
      "the deterministic replacement marker must not be mistaken for the unchanged real authority page");

    await coldPage.getByTestId("session-cache-view").waitFor({ state: "visible", timeout: 30_000 });
    await assertCachedSessionComposerReadOnly(coldPage,
      "the cached transcript while the actual Rust authority response is held");
    cachedAnchorWhileAuthorityHeld = await waitForAnchorGeometry({
      page: coldPage,
      rowDomId: `message-${encodeURIComponent(anchorDisplayIdentity.canonicalId)}`,
      rowTestId: "message-user",
      markerText: promptMarker,
      expectedOffset: savedAnchor.anchor.offset,
      label: "cold cached anchor while authority is held",
      readTranscriptViewport,
      assertOffsetNear,
    });
    assert.equal(cachedAnchorWhileAuthorityHeld.rowMatchCount, 1,
      "the same cached anchor row must remain mounted while authoritative recovery is held");
    assert.equal(cachedAnchorWhileAuthorityHeld.rowIntersectsWindow, true,
      "the same cached anchor row must remain visible while authoritative recovery is held");
    assertOffsetNear(cachedAnchorWhileAuthorityHeld.row.offsetFromHost, savedAnchor.anchor.offset,
      "held-authority cached anchor offset from scroll host versus the persisted reading anchor");

    assert.equal(releaseHeldAuthority(protocol), true, "the test-owned barrier must release the unchanged Rust authority response");
    await coldPage.getByTestId("session-cache-view").waitFor({ state: "detached", timeout: 30_000 });
    await coldPage.getByTestId("message-user").filter({ hasText: promptMarker }).waitFor({ state: "visible", timeout: 30_000 });
    await coldPage.getByTestId("message-assistant").filter({ hasText: tailMarker }).waitFor({ state: "visible", timeout: 30_000 });
    const composer = coldPage.getByTestId("message-input");
    await waitFor(() => composer.isEditable(), 30_000, "the editable task composer after the actual authority page is applied");
    syncedCacheReadiness = await waitForReadOnlyTranscriptCache(coldPage, {
      threadId,
      gatewayOrigin,
      marker: promptMarker,
      expectedScope: scopeExpectation,
      expectedMessageId: authorityResponse.markerMessageId,
      expectedAnchorMessageId: savedAnchor.anchor.messageId,
      requireReadingAnchor: true,
      minimumManifestRevision: cacheAfterRestart.manifestRevision + 1,
    }, 30_000);
    assert.ok(syncedCacheReadiness.ready,
      "the unchanged authority page and original reading anchor must be committed to IndexedDB after the reconnect barrier releases");
    assert.equal(syncedCacheReadiness.anchor.messageId, savedAnchor.anchor.messageId,
      "authoritative cache replacement must keep the exact canonical reading anchor identity");
    assert.equal(syncedCacheReadiness.anchor.followsLatest, false,
      "authoritative cache replacement must preserve detached reading intent");
    authorityAnchorAfterRelease = await waitForAnchorGeometry({
      page: coldPage,
      rowDomId: `message-${encodeURIComponent(anchorDisplayIdentity.canonicalId)}`,
      rowTestId: "message-user",
      markerText: promptMarker,
      expectedOffset: savedAnchor.anchor.offset,
      label: "authoritative anchor after IndexedDB replacement",
      readTranscriptViewport,
      assertOffsetNear,
    });
    assert.equal(authorityAnchorAfterRelease.rowMatchCount, 1,
      "the canonical anchor row must remain mounted after authority replaces the cached transcript");
    assert.equal(authorityAnchorAfterRelease.rowIntersectsWindow, true,
      "the reading anchor must remain in the real viewport after authority replaces the cache");
    assert.equal(authorityAnchorAfterRelease.rowIntersectsList, true,
      "the reading anchor must remain in the transcript list after authority replaces the cache");
    assert.equal(offlineTurnStarts.length, 0, "cold recovery must not submit a turn/start from the cached transcript");
    assert.equal(protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length,
      1, "the cold reconnect must not send or replay another task turn");
    assert.equal(coldPageErrors.length, 0, `cold Mobile page errors: ${coldPageErrors.join(" | ")}`);

    return {
      caseId: "mobile-session-cache-production-mobile-mount-cold-process-smoke",
      status: "PASS_COLD_PROCESS_CACHE_RECOVERY",
      boundary: "The real pinned Gateway-mounted Mobile Web build installs its naturally generated service-worker cache, seeds transcript and reading anchor through visible UI, exits the exact owned Chromium process group, reopens the same RunContext profile in a new PID, reads the cached UI offline without a send, then applies the unchanged Rust authority response after the user presses the scoped Reconnect button. No cache/IDB/tombstone injection, fixture bundle, external Provider call, or native-phone claim.",
      mobileBundle: {
        archiveSha256: productionMobileMountInputs.archiveSha256,
        sourceManifestSha256: productionMobileMountInputs.sourceManifestSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleManifestSha256,
        assetCount: expectedAssetPaths.length,
      },
      serviceWorker: {
        firstProcess: serviceWorkerCacheBeforeExit,
        afterRestart: serviceWorkerCacheAfterRestart,
        offlineDocument,
        offlineBundleScript,
      },
      profileEpochs: {
        profilePathWithinRun: relative(context.runRoot, firstProfileDir),
        first: {
          label: FIRST_CHROMIUM_LABEL,
          pid: firstPid,
          pgid: firstProcess.pgid ?? null,
          stopped: firstProcess.stopped,
          exitCode: firstProcess.child?.exitCode ?? null,
          signalCode: firstProcess.child?.signalCode ?? null,
        },
        second: {
          label: COLD_CHROMIUM_LABEL,
          pid: coldPid,
          pgid: coldProcess.pgid ?? null,
          version: await coldChromium.browser.version(),
          executablePath: coldChromium.executablePath,
          cdpPort: coldChromium.cdpPort,
          noSandbox: coldChromium.noSandbox,
          headless: coldChromium.headless,
          sameProfilePath: coldChromium.profileDir === firstProfileDir,
          oldProcessExitedBeforeNewStart: firstProcess.stopped && firstPid !== coldPid,
        },
      },
      firstProcessRpcShutdown,
      runtimeProvenance: {
        rustAppServer,
        firstBrowser: firstBrowserIdentity,
      },
      cacheBeforeProcessExit: {
        entryKey: savedAnchor.entryKey,
        entrySlot: savedAnchor.entrySlot,
        entryRevision: savedAnchor.entryRevision,
        anchor: savedAnchor.anchor,
      },
      offlineRecovery: {
        routePath: taskPath,
        ...offlineUiSnapshot,
        retryActionClickedAfterNetworkRestore: recoveryTrigger,
        cache: cacheAfterRestart,
        anchorScrollReachability: offlineAnchorReachability,
        anchorRow: cachedAnchorWhileOffline,
        turnStartCount: offlineTurnStarts.length,
      },
      authorityReplacement: {
        threadId,
        method: protocol.rootRestore.request.method,
        fixtureTransformed: authorityResponse.fixtureTransformed,
        success: authorityResponse.success,
        messageIds: authorityResponse.messageIds,
        promptMessageId: authorityResponse.markerMessageId,
        forwardedAt: protocol.rootRestore.response?.forwardedAt ?? null,
        cachedAnchorWhileHeld: cachedAnchorWhileAuthorityHeld,
        anchorAfterRelease: authorityAnchorAfterRelease,
        cacheAfterAuthority: syncedCacheReadiness,
        turnStartCount: protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length,
      },
      offlineGatewayHttp: {
        observationBoundary: "Browser-observed requests and responses on the owned Gateway origin; no Gateway-side request counter is implied.",
        requestCount: offlineGatewayHttpRequests.length,
        apiRequestCount: offlineApiRequests.length,
        apiSuccessfulResponseCount: offlineApiSuccessfulResponses.length,
        requests: offlineGatewayHttpRequests,
      },
      offlineGatewayRpc: {
        observationBoundary: "Browser-observed WebSocket frames only; no Gateway-side request counter is implied.",
        socketCount: offlineWebSocketObservations.length,
        sentFrameCount: offlineRpcSentFrameCount,
        responseFrameCount: offlineRpcResponseFrameCount,
        turnStartCount: offlineTurnStarts.length,
        sockets: offlineWebSocketObservations,
        routedBridge: offlineBridgeEvidence,
      },
      offlineNetworkResponses,
      pageErrors: coldPageErrors,
    };
  } catch (error) {
    if (protocol.coldOfflineBridgeAudit) protocol.coldOfflineBridgeAudit.active = false;
    let failureScreenshot = { saved: false, modeVerified: false };
    if (coldPage && !coldPage.isClosed() && typeof capturePrivateScreenshot === "function") {
      try {
        failureScreenshot = await capturePrivateScreenshot(coldPage, "mobile-session-cache-cold-process-failure.png");
      } catch (screenshotError) {
        failureScreenshot.error = context.redactText(screenshotError?.message || String(screenshotError)).slice(0, 800);
      }
    }
    const currentGeometry = coldPage && !coldPage.isClosed()
      ? await readTranscriptViewport(coldPage, {
        markerText: promptMarker,
        rowDomId: `message-${encodeURIComponent(anchorDisplayIdentity.canonicalId)}`,
        rowTestId: "message-user",
      }).catch(() => null)
      : null;
    const uiSnapshot = coldPage && !coldPage.isClosed()
      ? await readColdFailureUiSnapshot({ coldPage, promptMarker, coldOffline,
        offlineGatewayHttpRequests, offlineNetworkResponses, offlineWebSocketObservations,
        offlineTurnStarts, coldPageErrors }).catch(() => null)
      : null;
    const failureArtifact = "mobile-session-cache-cold-process-failure.json";
    const failureEvidence = {
      status: "FAIL",
      phase: coldPhase,
      error: context.redactText(error?.message || String(error)).slice(0, 1200),
      identity: {
        canonicalAnchorMessageId: anchorDisplayIdentity.canonicalId,
        role: anchorDisplayIdentity.role,
        threadId: anchorDisplayIdentity.threadId,
        socketOrdinal: anchorDisplayIdentity.socketOrdinal,
        turnId: anchorDisplayIdentity.turnId,
      },
      expectedAnchor: savedAnchor.anchor,
      cache: projectColdFailureCacheEvidence(cacheAfterRestart),
      serviceWorker: serviceWorkerCacheAfterRestart ? {
        controllerScope: serviceWorkerCacheAfterRestart.controllerScope,
        controllerScriptPath: serviceWorkerCacheAfterRestart.controllerScriptPath,
        manifestSha256: serviceWorkerCacheAfterRestart.marker?.manifestSha256 ?? null,
        assetCount: Array.isArray(serviceWorkerCacheAfterRestart.assetPaths)
          ? serviceWorkerCacheAfterRestart.assetPaths.length : null,
      } : null,
      anchorGeometry: {
        expectedOffset: savedAnchor.anchor.offset,
        scrollReachability: offlineAnchorReachability ?? error?.anchorGeometry?.reachability ??
          assessAnchorScrollReachability(currentGeometry, savedAnchor.anchor.offset, anchorScrollResponse),
        lastCandidate: projectColdFailureViewportGeometry(error?.anchorGeometry?.lastCandidate),
        current: projectColdFailureViewportGeometry(currentGeometry),
      },
      ui: projectColdFailureUiState(uiSnapshot),
      offlineBridge: offlineBridgeEvidence ?? projectColdOfflineBridgeEvidence({
        firstSocketOrdinal: coldPageBridgeFirstSocketOrdinal,
        routeDiagnostics: protocol.coldOfflineBridgeAudit?.routes ?? [],
        requests: protocol.requests,
        overflowed: protocol.coldOfflineBridgeAudit?.overflowed ?? false,
      }),
      failureScreenshot,
    };
    try {
      await context.writeArtifactJson(failureArtifact, failureEvidence);
      if (error && typeof error === "object") error.coldProcessFailureArtifact = failureArtifact;
    } catch (artifactError) {
      if (error && typeof error === "object") {
        error.coldProcessFailureCaptureError = context.redactText(artifactError?.message || String(artifactError)).slice(0, 800);
      }
    }
    throw error;
  } finally {
    if (protocol.coldOfflineBridgeAudit) protocol.coldOfflineBridgeAudit.active = false;
    if (coldContext) await coldContext.setOffline(false).catch(() => {});
    try { releaseHeldAuthority(protocol); } catch {}
    if (coldCdp) await coldCdp.detach().catch(() => {});
    if (coldChromium) {
      const pages = coldContext?.pages?.() ?? [];
      for (const page of pages) {
        if (page.isClosed()) continue;
        await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
        await page.close().catch(() => {});
      }
      await coldChromium.close().catch(() => {});
    }
  }
}

export async function startColdChromiumProfileEpoch({
  context,
  profileName,
  firstProfileDir,
  firstPid,
  launchChromium = startChromium,
}) {
  assert.ok(typeof profileName === "string" && profileName.length > 0,
    "cold Chromium epoch requires the first process's RunContext profile name");
  const coldChromium = await launchChromium(context, {
    label: COLD_CHROMIUM_LABEL,
    profileName,
    startTimeoutMs: 60_000,
  });
  assert.equal(coldChromium.profileDir, firstProfileDir,
    "the second Chromium process must open the exact first-process private persistent profile");
  assert.notEqual(coldChromium.child.pid, firstPid,
    "the cold reopen must use a different Chromium process");
  return coldChromium;
}

async function assertOwnedChromiumExited(context, label, expectedRecord) {
  const currentRecord = context.processes.get(label);
  assert.strictEqual(currentRecord, expectedRecord, `the exact owned Chromium process record for ${label} must remain authoritative`);
  if (currentRecord.stopPromise) await currentRecord.stopPromise;
  assert.equal(currentRecord.stopped, true, `the exact owned Chromium process group for ${label} must be stopped`);
  assert.ok(currentRecord.child?.exitCode !== null || currentRecord.child?.signalCode != null,
    `the owned Chromium child for ${label} must have exited`);
}

async function readColdFailureUiSnapshot({ coldPage, promptMarker, coldOffline, offlineGatewayHttpRequests,
  offlineNetworkResponses, offlineWebSocketObservations, offlineTurnStarts, coldPageErrors }) {
  let urlPath = null;
  try { urlPath = new URL(coldPage.url()).pathname; } catch {}
  const count = locator => locator.count().catch(() => null);
  return {
    urlPath,
    cacheViewCount: await count(coldPage.getByTestId("session-cache-view")),
    cacheStatusCount: await count(coldPage.getByTestId("session-cache-status")),
    retryButtonCount: await count(coldPage.getByTestId("session-cache-retry")),
    composerCount: await count(coldPage.getByTestId("message-input")),
    composerEditable: await coldPage.getByTestId("message-input").isEditable().catch(() => null),
    sendDisabled: await coldPage.getByTestId("send-message").isDisabled().catch(() => null),
    attachmentDisabled: await coldPage.getByTestId("composer-attachment").isDisabled().catch(() => null),
    promptUserRowCount: await count(coldPage.getByTestId("message-user").filter({ hasText: promptMarker })),
    offline: coldOffline,
    offlineHttpRequestCount: offlineGatewayHttpRequests.length,
    offlineNetworkResponseCount: offlineNetworkResponses.length,
    offlineSocketCount: offlineWebSocketObservations.length,
    offlineTurnStartCount: offlineTurnStarts.length,
    pageErrorCount: coldPageErrors.length,
  };
}

export async function waitForAnchorGeometry({
  page,
  rowDomId,
  rowTestId = null,
  markerText = null,
  expectedOffset,
  label,
  readTranscriptViewport,
  assertOffsetNear,
  timeoutMs = 10_000,
  pollIntervalMs = 50,
}) {
  let previousValid = null;
  let lastCandidate = null;
  let lastObservedAtMs = null;
  const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(10_000, timeoutMs)) : 10_000;
  const boundedPollIntervalMs = Number.isFinite(pollIntervalMs) ? Math.max(1, Math.min(250, pollIntervalMs)) : 50;
  let convergence;
  try {
    convergence = await waitFor(async () => {
      const viewportOptions = { rowDomId, rowTestId };
      if (markerText !== null) viewportOptions.markerText = markerText;
      const candidate = await readTranscriptViewport(page, viewportOptions);
      lastCandidate = candidate;
      lastObservedAtMs = Date.now();
      if (candidate.listFound !== true || candidate.rowDomId !== rowDomId || candidate.rowMatchCount !== 1 ||
          candidate.rowIntersectsWindow !== true || candidate.rowIntersectsList !== true ||
          (markerText !== null && (candidate.markerTextMatchCount !== 1 || candidate.markerVisible !== true ||
            candidate.markerIntersectsWindow !== true || candidate.markerIntersectsList !== true)) ||
          !Number.isFinite(candidate.row?.offsetFromHost) || !candidate.viewport ||
          !Number.isFinite(candidate.viewport.width) || !Number.isFinite(candidate.viewport.height) ||
          !candidate.list || !candidate.host?.rect) {
        previousValid = null;
        return null;
      }
      try {
        assertOffsetNear(candidate.row.offsetFromHost, expectedOffset, label);
      } catch {
        previousValid = null;
        return null;
      }
      const viewportIdentity = JSON.stringify({
        rowDomId: candidate.rowDomId,
        viewport: candidate.viewport,
        list: candidate.list,
        host: {
          testId: candidate.host.testId,
          markedScrollHost: candidate.host.markedScrollHost,
          rect: candidate.host.rect,
        },
      });
      const current = { observedAtMs: Date.now(), viewportIdentity, geometry: candidate };
      if (!previousValid || previousValid.viewportIdentity !== viewportIdentity) {
        previousValid = current;
        return null;
      }
      if (current.observedAtMs - previousValid.observedAtMs < 50) return null;
      return { first: previousValid, second: current };
    }, boundedTimeoutMs, `${label} to produce two consecutive same-anchor viewport readings`, boundedPollIntervalMs);
  } catch (error) {
    if (error && typeof error === "object") {
      error.anchorGeometry = {
        label,
        expectedOffset,
        observedAtMs: lastObservedAtMs,
        lastCandidate: projectColdFailureViewportGeometry(lastCandidate),
      };
    }
    throw error;
  }
  assertOffsetNear(convergence.first.geometry.row.offsetFromHost, expectedOffset, label);
  assertOffsetNear(convergence.second.geometry.row.offsetFromHost, expectedOffset, label);
  return {
    ...convergence.second.geometry,
    convergence: {
      requiredConsecutiveObservations: 2,
      minimumIntervalMs: 50,
      firstObservedAtMs: convergence.first.observedAtMs,
      secondObservedAtMs: convergence.second.observedAtMs,
      observations: [convergence.first.geometry, convergence.second.geometry],
    },
  };
}

async function readActualServiceWorkerCache(page, { gatewayOrigin, scopePath, expectedManifestSha256, expectedAssetPaths }) {
  try {
    return await page.evaluate(async ({
      gatewayOrigin,
      scopePath,
      expectedManifestSha256,
      expectedAssetPaths,
      buildDigestHeader,
      generationHeader,
      maximumTotalBytes,
    }) => {
      const scopeUrl = `${location.origin}${scopePath}`;
      const invalid = reason => ({ ready: false, reason });
      if (location.origin !== gatewayOrigin) return invalid("gateway-origin-mismatch");
      if (!navigator.serviceWorker || !globalThis.caches) return invalid("service-worker-or-cache-storage-unavailable");
      const registration = await navigator.serviceWorker.getRegistration(scopePath);
      if (!registration?.active || registration.active.state !== "activated") return invalid("active-worker-unavailable");
      const cachePrefix = `kcoder-mobile-offline-shell:${encodeURIComponent(scopePath)}:${expectedManifestSha256}:`;
      const cacheNames = (await caches.keys()).filter(name => name.startsWith(cachePrefix));
      if (cacheNames.length !== 1) return invalid("expected-build-cache-not-unique");
      const cache = await caches.open(cacheNames[0]);
      const keys = await cache.keys();
      const completion = keys.filter(request => {
        const url = new URL(request.url);
        return url.origin === location.origin && url.pathname.startsWith(`${scopePath}__kcoder_offline_complete__/`);
      });
      if (completion.length !== 1) return invalid("complete-marker-not-unique");
      const response = await cache.match(completion[0]);
      if (!response) return invalid("complete-marker-missing");
      const marker = await response.json();
      const assetRequests = keys.filter(request => request !== completion[0]);
      const assetPathnames = assetRequests.map(request => {
        const url = new URL(request.url);
        if (url.origin !== location.origin || !url.pathname.startsWith(scopePath) || url.search || url.hash) return null;
        return url.pathname;
      }).sort();
      let cachedTotalBytes = 0;
      let generation = null;
      let assetHeadersMatch = true;
      for (const request of assetRequests) {
        const assetResponse = await cache.match(request);
        if (!assetResponse) {
          assetHeadersMatch = false;
          continue;
        }
        const assetBytes = await assetResponse.clone().arrayBuffer();
        cachedTotalBytes += assetBytes.byteLength;
        const buildDigest = assetResponse.headers.get(buildDigestHeader);
        const assetGeneration = assetResponse.headers.get(generationHeader);
        const generationParts = typeof assetGeneration === "string" ? assetGeneration.split(":") : [];
        const validGeneration = generationParts.length === 3 && generationParts[0] === expectedManifestSha256 &&
          /^[a-f0-9]{64}$/.test(generationParts[1]) && /^[a-f0-9]{64}$/.test(generationParts[2]);
        if (generation === null) generation = assetGeneration;
        if (buildDigest !== expectedManifestSha256 || !validGeneration || generation !== assetGeneration) {
          assetHeadersMatch = false;
        }
      }
      const generationParts = typeof generation === "string" ? generation.split(":") : [];
      const markerMatches = marker?.manifestSha256 === expectedManifestSha256 &&
        /^[a-f0-9]{64}$/.test(marker?.mechanismCodeSha256 ?? "") &&
        marker.mechanismCodeSha256 === generationParts[1] &&
        Number.isSafeInteger(marker?.assetCount) && marker.assetCount === expectedAssetPaths.length &&
        Number.isSafeInteger(marker?.totalBytes) && marker.totalBytes === cachedTotalBytes &&
        marker.totalBytes > 0 && marker.totalBytes <= maximumTotalBytes;
      const activeScriptPath = new URL(registration.active.scriptURL).pathname;
      const controllerScriptPath = navigator.serviceWorker.controller
        ? new URL(navigator.serviceWorker.controller.scriptURL).pathname : null;
      const scopeMatches = registration.scope === scopeUrl && activeScriptPath === `${scopePath}__kcoder_offline_sw.js`;
      const cacheNameMatches = cacheNames[0].endsWith(`:${generation}`);
      return {
        scopeMatches,
        markerMatches,
        assetHeadersMatch,
        cacheNameMatches,
        scope: registration.scope,
        controllerScope: navigator.serviceWorker.controller ? registration.scope : null,
        controllerScriptUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
        controllerScriptPath,
        activeScriptPath,
        cacheName: cacheNames[0],
        marker,
        assetPathnames,
        completionMarkerCount: completion.length,
        generation,
        configurationSha256: generationParts[2] ?? null,
        buildDigestHeader: { name: buildDigestHeader, matched: assetHeadersMatch },
        generationHeader: { name: generationHeader, matched: assetHeadersMatch },
        cachedTotalBytes,
      };
    }, {
      gatewayOrigin,
      scopePath,
      expectedManifestSha256,
      expectedAssetPaths,
      buildDigestHeader: MOBILE_OFFLINE_BUILD_DIGEST_HEADER,
      generationHeader: MOBILE_OFFLINE_GENERATION_HEADER,
      maximumTotalBytes: MOBILE_OFFLINE_LIMITS.totalBytes,
    }).then(snapshot => {
      if (!Array.isArray(snapshot.assetPathnames)) {
        return { ...snapshot, expectedAssetCount: expectedAssetPaths.length };
      }
      const assetPaths = snapshot.assetPathnames.map(pathname =>
        typeof pathname === "string" ? decodeServiceWorkerCacheAssetPathname(pathname, scopePath) : null)
        .sort();
      const expected = [...expectedAssetPaths].sort();
      const inventoryMatches = assetPaths.length === expected.length &&
        assetPaths.every((path, index) => path !== null && path === expected[index]);
      const ready = snapshot.scopeMatches && inventoryMatches && snapshot.markerMatches &&
        snapshot.assetHeadersMatch && snapshot.cacheNameMatches;
      const reason = assetPaths.some(path => path === null) ? "invalid-encoded-asset-path" :
        !inventoryMatches ? "asset-inventory-mismatch" : !snapshot.markerMatches ? "completion-marker-mismatch" :
          !snapshot.assetHeadersMatch ? "asset-generation-header-mismatch" : !snapshot.scopeMatches ? "worker-scope-or-script-mismatch" :
            !snapshot.cacheNameMatches ? "generation-cache-name-mismatch" : null;
      return {
        ...snapshot,
        ready,
        reason,
        encodedAssetPathnames: snapshot.assetPathnames,
        assetPaths,
        expectedAssetCount: expectedAssetPaths.length,
      };
    });
  } catch {
    return { ready: false, reason: "service-worker-inspection-failed" };
  }
}

export function decodeServiceWorkerCacheAssetPathname(pathname, scopePath) {
  if (typeof pathname !== "string" || typeof scopePath !== "string" || !scopePath.startsWith("/") ||
      !scopePath.endsWith("/") || !pathname.startsWith(scopePath) || /[?#\0-\x1f\x7f\\]/.test(pathname)) return null;
  const encodedPath = pathname.slice(scopePath.length);
  if (!encodedPath || encodedPath.endsWith("/")) return null;
  const encodedSegments = encodedPath.split("/");
  const decodedSegments = [];
  for (const segment of encodedSegments) {
    if (!segment || /%(?:2e|2f|5c|00)/i.test(segment)) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!decoded || decoded === "." || decoded === ".." || /[%?#\0-\x1f\x7f/\\]/.test(decoded)) return null;
    decodedSegments.push(decoded);
  }
  return decodedSegments.join("/");
}
