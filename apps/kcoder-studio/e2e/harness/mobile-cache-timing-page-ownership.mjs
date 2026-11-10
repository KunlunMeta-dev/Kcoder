import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import { closeChromiumProfileAndWaitForExit } from "./chromium-profile-exit.mjs";
import { closePageRpcRoutesAndWait } from "./mobile-page-rpc-lifecycle.mjs";
import {
  createMobileTimingLaneRouteAudit,
  installMobileTimingLaneHttpGuard,
} from "./mobile-cache-timing-runner.mjs";

/** Observe only bounded metadata for the page's exact Gateway RPC endpoint. */
export function observeMobilePageRpcSockets(page, protocol, context, gatewayUrl, rpcPath, credentialsByRecord = null) {
  assert.ok(page && typeof page.on === "function", "Mobile RPC socket observation requires an owned Page");
  assert.ok(protocol && Array.isArray(protocol.pageWebSockets), "Mobile RPC socket observation requires protocol state");
  assert.ok(Number.isSafeInteger(protocol.nextPageWebSocketOrdinal) &&
    Number.isSafeInteger(protocol.nextPageRpcSocketOrdinal), "Mobile RPC page ordinals must be initialized");
  const gateway = gatewayUrl instanceof URL ? gatewayUrl : new URL(gatewayUrl);
  assert.ok(["http:", "https:"].includes(gateway.protocol), "Mobile Gateway URL must use HTTP(S)");
  assert.ok(typeof rpcPath === "string" && rpcPath.startsWith("/"), "Mobile RPC path must be absolute");
  page.on("websocket", socket => {
    let url;
    try { url = new URL(socket.url()); } catch { url = null; }
    const expectedProtocol = gateway.protocol === "https:" ? "wss:" : "ws:";
    const isRpc = url !== null && url.protocol === expectedProtocol && url.host === gateway.host &&
      url.pathname === rpcPath && !url.username && !url.password;
    const record = {
      ordinal: ++protocol.nextPageWebSocketOrdinal,
      path: isRpc ? "/rpc" : "[non-rpc]",
      rpcOrdinal: isRpc ? ++protocol.nextPageRpcSocketOrdinal : null,
      openedAtMs: performance.now(),
      closedAtMs: null,
      sentFrameCount: 0,
      receivedFrameCount: 0,
    };
    protocol.pageWebSockets.push(record);
    if (protocol.pageWebSockets.length > 8) protocol.pageWebSockets.shift();
    if (isRpc && credentialsByRecord instanceof WeakMap) {
      const rpcToken = url.searchParams.get("token");
      const credentials = {
        host: url.host,
        path: url.pathname,
        serverId: url.searchParams.get("server"),
        workspace: url.searchParams.get("workspace"),
        rpcToken,
      };
      credentialsByRecord.set(record, credentials);
      if (typeof rpcToken === "string" && rpcToken.length >= 8) context?.registerSecret?.(rpcToken);
    }
    socket.on("framesent", () => { record.sentFrameCount += 1; });
    socket.on("framereceived", () => { record.receivedFrameCount += 1; });
    socket.on("close", () => { record.closedAtMs = performance.now(); });
  });
}

/** Close the exact task-page RPC routes before disposing the owned Page. */
export async function closeMobileTimingTaskPage({
  page,
  protocol,
  waitFor,
  firstRouteSocketOrdinal = 0,
  firstPageRpcOrdinal = 0,
  requiredSocketOrdinal = null,
  label = "Mobile timing task",
}) {
  assert.ok(protocol && Array.isArray(protocol.pageWebSockets) && Array.isArray(protocol.routeDiagnostics),
    "Mobile task close requires its protocol state");
  assert.ok(Number.isSafeInteger(protocol.nextPageRpcSocketOrdinal) &&
    Number.isSafeInteger(protocol.nextSocketOrdinal),
  "Mobile task close requires total page and route ordinals to detect truncated histories");
  assert.ok(Number.isSafeInteger(firstPageRpcOrdinal) && firstPageRpcOrdinal >= 0 &&
    firstPageRpcOrdinal <= protocol.nextPageRpcSocketOrdinal,
  "first page RPC ordinal must be within the observed page history");
  assert.ok(Number.isSafeInteger(firstRouteSocketOrdinal) && firstRouteSocketOrdinal >= 0 &&
    firstRouteSocketOrdinal <= protocol.nextSocketOrdinal,
  "first route ordinal must be within the observed route history");
  const pageWebSockets = protocol.pageWebSockets.filter(socket =>
    socket.path === "/rpc" && socket.rpcOrdinal > firstPageRpcOrdinal);
  const routeDiagnostics = protocol.routeDiagnostics.filter(route => route.socketOrdinal > firstRouteSocketOrdinal);
  return closePageRpcRoutesAndWait({
    page,
    pageWebSockets,
    routeDiagnostics,
    requiredSocketOrdinal,
    expectedPageRpcCount: protocol.nextPageRpcSocketOrdinal - firstPageRpcOrdinal,
    expectedRouteCount: protocol.nextSocketOrdinal - firstRouteSocketOrdinal,
    readCurrentOrdinalCounts: () => ({
      pageRpcCount: protocol.nextPageRpcSocketOrdinal - firstPageRpcOrdinal,
      routeCount: protocol.nextSocketOrdinal - firstRouteSocketOrdinal,
    }),
    waitFor,
    label,
  });
}

/** Release this Browser owner's entry pages and exact task routes before profile reuse. */
export async function releaseMobileTimingPageAndChromium({
  page = null, protocol, waitFor, firstRouteSocketOrdinal = 0, firstPageRpcOrdinal = 0,
  requiredSocketOrdinal = null, observerPages = [], restart, releaseChromium,
}) {
  assert.equal(typeof releaseChromium, "function", "timing Page release requires its exact Chromium release callback");
  assert.equal(typeof restart, "boolean", "timing Page release must state whether to restart");
  assert.ok(Array.isArray(observerPages), "timing entry observers must belong to the current Browser owner");
  const failures = [];
  let observerPageCloseCount = 0;
  let taskPageRelease = null;
  for (const observer of new Set(observerPages)) {
    if (observer === page) continue;
    try { await observer.close(); observerPageCloseCount += 1; }
    catch (error) { failures.push(error); }
  }
  if (page !== null) {
    try {
      taskPageRelease = await closeMobileTimingTaskPage({
        page, protocol, waitFor, firstRouteSocketOrdinal, firstPageRpcOrdinal, requiredSocketOrdinal,
      });
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    try { await releaseChromium(false); }
    catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "timing Page release and exact Chromium cleanup failed");
  }
  const released = await releaseChromium(restart);
  return Object.freeze({ ...released, evidence: Object.freeze({
    ...released.evidence, taskPageRelease, observerPageCloseCount,
  }) });
}

/** Release one exact Chromium process tree and optionally start the next owner on its same profile. */
export async function releaseMobileTimingChromium({ context, chromium, currentLabel, nextLabel, profileName,
  startChromium, restart, reason, startTimeoutMs = 60_000, closeTimeoutMs = 10_000 }) {
  assert.ok(context?.processes instanceof Map && typeof context.pathInState === "function",
    "timing Chromium release requires the owning RunContext process registry");
  assert.ok(chromium?.child && typeof chromium.close === "function", "timing Chromium release requires its exact owner");
  assert.ok(typeof currentLabel === "string" && currentLabel.length > 0 && currentLabel !== nextLabel,
    "timing Chromium owner labels must be explicit and unique");
  assert.ok(typeof profileName === "string" && profileName.length > 0, "timing Chromium profile name is required");
  assert.ok(typeof reason === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(reason), "timing Chromium release reason must be bounded metadata");
  assert.equal(typeof restart, "boolean", "timing Chromium release must state whether another sample owner is needed");
  assert.ok(Number.isFinite(startTimeoutMs) && startTimeoutMs > 0, "timing Chromium startup deadline must be positive");
  if (restart) {
    assert.ok(typeof nextLabel === "string" && nextLabel.length > 0, "next timing Chromium owner label is required");
    assert.equal(typeof startChromium, "function", "next timing Chromium owner requires the existing harness launcher");
  }
  const expectedProfileDir = resolve(context.pathInState("chromium", `${profileName}-profile`));
  assert.equal(resolve(chromium.profileDir), expectedProfileDir,
    "timing Chromium must own the expected RunContext profile before release");
  const oldRecord = context.processes.get(currentLabel);
  assert.ok(oldRecord && oldRecord.child === chromium.child,
    "timing Chromium release must target its exact RunContext process record");
  const oldPid = oldRecord.pid;
  const oldPgid = oldRecord.pgid;
  assert.ok(Number.isSafeInteger(oldPid) && oldPid > 0 && oldPid === chromium.child.pid,
    "timing Chromium release requires the exact owned process PID");
  assert.ok(Number.isSafeInteger(oldPgid) && oldPgid > 0,
    "timing Chromium release requires the exact owned process group ID");
  assert.equal(oldRecord.identity?.pid, oldPid, "timing Chromium must retain its original process identity");
  assert.equal(oldRecord.identity?.pgid, oldPgid, "timing Chromium must retain its original process group identity");
  const startedAt = performance.now();
  const closeStartedAt = startedAt;
  let next = null;
  try {
    const browser = chromium.browser;
    assert.ok(browser && typeof browser.newBrowserCDPSession === "function",
      "timing Chromium requires its owned browser-target CDP session");
    let cdpError = null;
    const captureCdpError = async operation => {
      try { return await operation(); } catch (error) { cdpError ??= error; throw error; }
    };
    // Preserve the original CDP error while the shared helper owns all exit waits and cleanup.
    const observedBrowser = {
      once: (...args) => browser.once(...args),
      removeListener: (...args) => browser.removeListener(...args),
      isConnected: () => browser.isConnected(),
      async newBrowserCDPSession() {
        const session = await captureCdpError(() => browser.newBrowserCDPSession());
        return {
          once: (...args) => session.once(...args),
          removeListener: (...args) => session.removeListener(...args),
          detach: () => session.detach(),
          send: method => captureCdpError(() => session.send(method)),
        };
      },
    };
    const profileExit = await closeChromiumProfileAndWaitForExit(context, { ...chromium, browser: observedBrowser }, {
      exitTimeoutMs: closeTimeoutMs, treeClearTimeoutMs: closeTimeoutMs, cleanupTimeoutMs: closeTimeoutMs,
    });
    const graceful = profileExit.outcome === "graceful-exit-observed" && !profileExit.fallbackUsed;
    const targetClosed = cdpError?.name === "TargetClosedError" ||
      /(?:^|:\s)(?:Target closed\.?|Target page, context or browser has been closed)(?:\r?\n|$)/.test(cdpError?.message ?? "");
    if (cdpError && !(targetClosed && graceful)) throw cdpError;
    assert.ok(graceful,
      `timing Chromium profile shutdown must be graceful: ${profileExit.reason ?? profileExit.outcome}`);
    assert.equal(profileExit.childExitCode, 0, "timing Chromium must exit naturally before profile reuse");
    assert.equal(profileExit.childSignalCode, null, "timing Chromium profile shutdown must not require a signal");
    assert.equal(profileExit.processTreeClearBeforeRelease, true,
      "the exact Chromium process tree must exit before RunContext release");
    const closedAt = performance.now();
    assert.strictEqual(context.processes.get(currentLabel), oldRecord,
      "timing Chromium owner record must remain exact until release is proven");
    assert.equal(oldRecord.spawnError, null, "timing Chromium cannot claim process-tree exit after a spawn failure");
    assert.ok(oldRecord.stopPromise && typeof oldRecord.stopPromise.then === "function",
      "timing Chromium close must settle the RunContext process-tree stop operation");
    await oldRecord.stopPromise;
    assert.equal(oldRecord.stopped, true, "RunContext must confirm the exact old Chromium process tree stopped");
    assert.ok(oldRecord.child.exitCode !== null || oldRecord.child.signalCode !== null,
      "the old Chromium process must have exited before profile reuse");
    let startupMs = null;
    let newPid = null;
    let newPgid = null;
    if (restart) {
      const nextLabelValue = nextLabel;
      next = await startChromium(context, {
        label: nextLabelValue,
        profileName,
        portLabel: `${nextLabelValue}-cdp`,
        startTimeoutMs,
      });
      startupMs = Math.max(0, performance.now() - closedAt);
      assert.equal(resolve(next.profileDir), expectedProfileDir,
        "the next timing Chromium must reopen the same RunContext-owned profile directory");
      const nextRecord = context.processes.get(nextLabelValue);
      assert.ok(nextRecord && nextRecord.child === next.child && nextRecord.stopped === false,
        "the next timing Chromium must have a new active exact RunContext process owner");
      newPid = nextRecord.pid;
      newPgid = nextRecord.pgid;
      assert.equal(nextRecord.identity?.pid, newPid, "the next Chromium owner must retain its exact process identity");
      assert.equal(nextRecord.identity?.pgid, newPgid, "the next Chromium owner must retain its exact process group identity");
      assert.ok(Number.isSafeInteger(newPid) && newPid > 0 && newPid === next.child.pid && newPid !== oldPid,
        "the next timing sample must use a distinct newly started Chromium PID");
      assert.ok(Number.isSafeInteger(newPgid) && newPgid > 0,
        "the next timing sample must expose its exact owned Chromium process group");
    }
    const evidence = Object.freeze({
      status: "PASS",
      reason,
      browserOwnerReleased: true,
      gracefulExitObserved: true,
      profileExit: Object.freeze({ ...profileExit }),
      processGroupGone: true,
      sameProfileDir: true,
      restartRequested: restart,
      oldPid,
      oldPgid,
      newPid,
      newPgid,
      profileDir: relative(resolve(context.stateDir), expectedProfileDir).split("\\").join("/"),
      closeMs: Math.round((closedAt - closeStartedAt) * 100) / 100,
      startupMs: startupMs === null ? null : Math.round(startupMs * 100) / 100,
      restartMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    return Object.freeze({ chromium: next, evidence });
  } catch (error) {
    const cleanupErrors = [];
    if (context.processes.get(currentLabel) === oldRecord && !oldRecord.stopped) {
      try { await chromium.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (next) {
      try {
        await next.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], "timing Chromium profile release and cleanup failed");
    }
    throw error;
  }
}

/** Open a same-origin, non-client entry page for read-only cache inspection. */
export async function openMobileTimingCacheObserverPage({ chromium, lane }) {
  assert.ok(chromium && typeof chromium.newPersistentPage === "function",
    "Mobile cache observer must be owned by the persistent Chromium harness");
  assert.ok(lane && typeof lane.assertRouteUrl === "function" && typeof lane.mobileEntryUrl === "string",
    "Mobile cache observer requires an exact lane entry descriptor");
  const page = await chromium.newPersistentPage();
  try {
    const audit = createMobileTimingLaneRouteAudit(`${lane.id}-cache-observer`);
    await installMobileTimingLaneHttpGuard(page, lane, audit);
    lane.assertRouteUrl(lane.mobileEntryUrl, "entry");
    const response = await page.goto(lane.mobileEntryUrl, { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200, "same-origin Mobile cache observer entry must return HTTP 200");
    assert.equal(page.url(), lane.mobileEntryUrl, "Mobile cache observer must remain on its exact entry URL");
    assert.equal(audit.requestCount, 1, "Mobile cache observer must load only its exact entry document");
    assert.deepEqual(audit.requestCountsByKind, { entry: 1 }, "Mobile cache observer must not load other lane resources");
    assert.equal(audit.violations.length, 0, "Mobile cache observer must remain inside the exact lane mount");
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

/** Project bounded Relay setup evidence without IDs, URLs, bodies, or credentials. */
export function projectRelayBootstrapFailureEvidence({
  protocol,
  routeAudit,
  serverInventoryResponses,
  browserErrorCount,
  seedThreadId,
}) {
  assert.ok(protocol && Array.isArray(protocol.requests) && Array.isArray(protocol.rpcResponses),
    "Relay failure projection requires protocol observations");
  assert.ok(routeAudit && Array.isArray(routeAudit.violations), "Relay failure projection requires route audit");
  assert.ok(Array.isArray(serverInventoryResponses), "Relay failure projection requires bounded inventory observations");
  const sameSeedThread = threadId => typeof seedThreadId === "string" && threadId === seedThreadId;
  return Object.freeze({
    routeAudit: {
      requestCount: routeAudit.requestCount,
      requestCountsByKind: { ...routeAudit.requestCountsByKind },
      websocketObservationCount: routeAudit.websocketObservationCount,
      violationKinds: routeAudit.violations.map(item => item.kind),
      overflowed: routeAudit.overflowed,
    },
    serverInventory: serverInventoryResponses.slice(0, 16).map(item => ({
      source: item.source,
      responseStatus: item.responseStatus,
      bodyReadComplete: item.bodyReadComplete,
      descriptorCount: Array.isArray(item.descriptors) ? item.descriptors.length : null,
      hasValidGatewayDescriptor: Array.isArray(item.descriptors) && item.descriptors.length > 0,
    })),
    rpcRequests: protocol.requests.slice(-32).map(request => ({
      method: request.method,
      socketOrdinal: request.socketOrdinal,
      matchesSeedThread: sameSeedThread(request.threadId),
    })),
    rpcResponses: protocol.rpcResponses.slice(-32).map(response => ({
      method: response.method,
      socketOrdinal: response.socketOrdinal,
      success: response.success,
      matchesSeedThread: sameSeedThread(response.threadId),
    })),
    routeSockets: protocol.routeDiagnostics.slice(-8).map(route => ({
      socketOrdinal: route.socketOrdinal,
      clientClosed: Number.isFinite(route.clientClosedAtMs),
      upstreamClosed: Number.isFinite(route.upstreamClosedAtMs),
      clientToServerForwardCount: route.clientToServerForwardCount,
      serverToClientForwardCount: route.serverToClientForwardCount,
    })),
    browserSockets: protocol.pageWebSockets.slice(-8).map(socket => ({
      path: socket.path === "/rpc" ? "/rpc" : "[non-rpc]",
      rpcOrdinal: Number.isSafeInteger(socket.rpcOrdinal) ? socket.rpcOrdinal : null,
      closed: Number.isFinite(socket.closedAtMs),
      sentFrameCount: socket.sentFrameCount,
      receivedFrameCount: socket.receivedFrameCount,
    })),
    browserErrorCount: Number.isSafeInteger(browserErrorCount) ? browserErrorCount : 0,
  });
}
