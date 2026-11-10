import assert from "node:assert/strict";

/** Correlate the real page RPC events with their owning route bridge records. */
export function correlateMobilePageRpcRoutes(pageWebSockets, routeDiagnostics) {
  assert.ok(Array.isArray(pageWebSockets), "page WebSocket records must be an array");
  assert.ok(Array.isArray(routeDiagnostics), "route WebSocket diagnostics must be an array");

  const pageRpcSockets = pageWebSockets.filter(socket => socket?.path === "/rpc");
  assert.ok(pageRpcSockets.length > 0, "the Mobile page must have observed at least one Gateway RPC WebSocket");

  const pageOrdinals = new Set();
  const routeOrdinals = new Set();
  for (const socket of pageRpcSockets) {
    assert.ok(Number.isSafeInteger(socket.rpcOrdinal) && socket.rpcOrdinal > 0,
      "every Gateway page RPC WebSocket must carry its positive RPC ordinal");
    assert.equal(pageOrdinals.has(socket.rpcOrdinal), false,
      `page Gateway RPC ordinal ${socket.rpcOrdinal} must be unique`);
    pageOrdinals.add(socket.rpcOrdinal);
  }
  for (const route of routeDiagnostics) {
    assert.ok(Number.isSafeInteger(route?.socketOrdinal) && route.socketOrdinal > 0,
      "every observed Gateway RPC route must carry its positive route ordinal");
    assert.equal(routeOrdinals.has(route.socketOrdinal), false,
      `route socket ordinal ${route.socketOrdinal} must be unique`);
    routeOrdinals.add(route.socketOrdinal);
  }
  assert.equal(routeOrdinals.size, pageOrdinals.size,
    "every page RPC WebSocket must have exactly one observed route ordinal and vice versa");

  const routeByOrdinal = new Map(routeDiagnostics.map(route => [route.socketOrdinal, route]));
  const usedRouteOrdinals = new Set();
  return pageRpcSockets.map(pageSocket => {
    const routeDiagnostic = routeByOrdinal.get(pageSocket.rpcOrdinal);
    assert.ok(routeDiagnostic,
      `page Gateway RPC ordinal ${pageSocket.rpcOrdinal} must map to one observed route socket ordinal`);
    assert.equal(usedRouteOrdinals.has(routeDiagnostic.socketOrdinal), false,
      `route socket ordinal ${routeDiagnostic.socketOrdinal} cannot own multiple page RPC sockets`);
    usedRouteOrdinals.add(routeDiagnostic.socketOrdinal);
    return { pageSocket, routeDiagnostic };
  });
}

function isDomSendableWebSocketCloseCode(code) {
  // Wire close codes such as 1001 cannot be passed to the DOM WebSocket.close API.
  return Number.isSafeInteger(code) &&
    (code === 1000 || (code >= 3000 && code <= 4999));
}

function projectForwardedCloseOptions(code, reason, state) {
  if (!isDomSendableWebSocketCloseCode(code)) {
    state.closeCodeNormalized = true;
    state.closeReasonNormalized = typeof reason === "string" && reason.length > 0;
    return { code: 1000, reason: "" };
  }
  const safeReason = typeof reason === "string" ? reason : "";
  if (safeReason !== reason) state.closeReasonNormalized = true;
  if (Buffer.byteLength(safeReason, "utf8") > 123) {
    throw new RangeError("WebSocket close reason exceeds the protocol byte limit");
  }
  return { code, reason: safeReason };
}

/** Observe real endpoint closes and explicitly forward only the first close request. */
export function observeAndForwardMobileRpcRouteCloses(client, upstream, {
  onClientClose = () => {},
  onUpstreamClose = () => {},
} = {}) {
  for (const [name, endpoint] of [["client", client], ["upstream", upstream]]) {
    assert.ok(endpoint && typeof endpoint.onClose === "function" && typeof endpoint.close === "function",
      `Mobile RPC ${name} route endpoint must expose onClose() and close()`);
  }
  assert.equal(typeof onClientClose, "function", "Mobile RPC client close observer must be a function");
  assert.equal(typeof onUpstreamClose, "function", "Mobile RPC upstream close observer must be a function");

  const state = {
    firstCloseEndpoint: null,
    requestedDirection: null,
    requestStatus: "not-requested",
    closeForwardErrorCount: 0,
    closeForwardErrorName: null,
    closeCodeNormalized: false,
    closeReasonNormalized: false,
    ownerReleaseCloseRequested: false,
    ownerReleaseCloseRequestCount: 0,
    clientCloseRequestCount: 0,
    upstreamCloseRequestCount: 0,
    closeRequestPendingCount: 0,
    closeRequestSettledCount: 0,
    clientCloseRequestFailed: false,
    upstreamCloseRequestFailed: false,
    clientActuallyClosed: false,
    upstreamActuallyClosed: false,
  };
  const recordForwardError = (error, endpointName) => {
    state.requestStatus = "failed";
    state.closeForwardErrorCount += 1;
    state.closeForwardErrorName = typeof error?.name === "string" ? error.name : "Error";
    if (endpointName === "client") state.clientCloseRequestFailed = true;
    if (endpointName === "upstream") state.upstreamCloseRequestFailed = true;
  };
  const requestEndpointClose = (endpointName, endpoint, options) => {
    const actualClosedKey = endpointName === "client" ? "clientActuallyClosed" : "upstreamActuallyClosed";
    const requestCountKey = endpointName === "client" ? "clientCloseRequestCount" : "upstreamCloseRequestCount";
    const requestFailedKey = endpointName === "client" ? "clientCloseRequestFailed" : "upstreamCloseRequestFailed";
    if (state[actualClosedKey]) return false;
    if (state[requestCountKey] > 0 && !state[requestFailedKey]) return false;
    state[requestCountKey] += 1;
    state[requestFailedKey] = false;
    state.closeRequestPendingCount += 1;
    state.requestStatus = "requested";
    const settleCloseRequest = (error, rejected) => {
      state.closeRequestPendingCount -= 1;
      state.closeRequestSettledCount += 1;
      if (rejected) recordForwardError(error, endpointName);
    };
    try {
      Promise.resolve(endpoint.close(options)).then(
        () => settleCloseRequest(null, false),
        error => settleCloseRequest(error, true),
      );
    } catch (error) {
      settleCloseRequest(error, true);
    }
    return true;
  };
  const forwardFirstClose = (source, target, code, reason) => {
    if (state.firstCloseEndpoint !== null || state.ownerReleaseCloseRequested) return;
    state.firstCloseEndpoint = source;
    state.requestedDirection = source === "client" ? "client-to-upstream" : "upstream-to-client";
    let options;
    try {
      options = projectForwardedCloseOptions(code, reason, state);
    } catch (error) {
      recordForwardError(error, source === "client" ? "upstream" : "client");
      return;
    }
    requestEndpointClose(source === "client" ? "upstream" : "client", target, options);
  };

  client.onClose((code, reason) => {
    state.clientActuallyClosed = true;
    try { onClientClose(code, reason); }
    finally { forwardFirstClose("client", upstream, code, reason); }
  });
  upstream.onClose((code, reason) => {
    state.upstreamActuallyClosed = true;
    try { onUpstreamClose(code, reason); }
    finally { forwardFirstClose("upstream", client, code, reason); }
  });
  Object.defineProperty(state, "requestCloseFromOwnerRelease", {
    enumerable: false,
    value() {
      if (state.ownerReleaseCloseRequested) return false;
      state.ownerReleaseCloseRequested = true;
      state.requestedDirection ??= "owner-release-both";
      const options = { code: 1000, reason: "" };
      if (requestEndpointClose("client", client, options)) state.ownerReleaseCloseRequestCount += 1;
      if (requestEndpointClose("upstream", upstream, options)) state.ownerReleaseCloseRequestCount += 1;
      return state.ownerReleaseCloseRequestCount > 0;
    },
  });
  return state;
}

/** Browser wrapper close events are advisory; both owned bridge endpoints must report close. */
export function mobilePageRpcRoutesClosed(pairs) {
  return Array.isArray(pairs) && pairs.length > 0 && pairs.every(({ routeDiagnostic }) => {
    const closeForwarding = routeDiagnostic?.closeForwarding;
    const closeRequestCount = closeForwarding === undefined ? 0 :
      (closeForwarding.clientCloseRequestCount ?? 0) + (closeForwarding.upstreamCloseRequestCount ?? 0);
    const allCloseRequestsSettled = closeForwarding === undefined ||
      (closeForwarding.closeRequestPendingCount === 0 &&
        closeForwarding.closeRequestSettledCount === closeRequestCount);
    return Number.isFinite(routeDiagnostic?.clientClosedAtMs) &&
      Number.isFinite(routeDiagnostic?.upstreamClosedAtMs) &&
      allCloseRequestsSettled &&
      (closeForwarding?.closeForwardErrorCount ?? 0) === 0;
  });
}

/** Close one owned Page and wait for its selected RPC route endpoints to close. */
export async function closePageRpcRoutesAndWait({
  page,
  pageWebSockets,
  routeDiagnostics,
  requiredSocketOrdinal = null,
  expectedPageRpcCount = null,
  expectedRouteCount = null,
  readCurrentOrdinalCounts = null,
  waitFor,
  timeoutMs = 15_000,
  label = "Mobile page RPC route",
}) {
  assert.ok(page && typeof page.close === "function", "owned Mobile Page must expose close()");
  assert.ok(Array.isArray(pageWebSockets), "selected Mobile page WebSockets must be an array");
  assert.ok(Array.isArray(routeDiagnostics), "selected Mobile route diagnostics must be an array");
  assert.equal(typeof waitFor, "function", "Mobile route close barrier requires the RunContext waitFor helper");
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "Mobile route close timeout must be positive");
  if (requiredSocketOrdinal !== null) {
    assert.ok(Number.isSafeInteger(requiredSocketOrdinal) && requiredSocketOrdinal > 0,
      "required Mobile RPC socket ordinal must be positive");
  }
  if (expectedPageRpcCount !== null) {
    assert.ok(Number.isSafeInteger(expectedPageRpcCount) && expectedPageRpcCount >= 0,
      "expected Mobile RPC WebSocket count must be non-negative");
  }
  if (expectedRouteCount !== null) {
    assert.ok(Number.isSafeInteger(expectedRouteCount) && expectedRouteCount >= 0,
      "expected Mobile route socket count must be non-negative");
  }
  if (readCurrentOrdinalCounts !== null) {
    assert.equal(typeof readCurrentOrdinalCounts, "function",
      "current Mobile RPC ordinal counts must be readable during owner release");
  }

  let pairs = [];
  let correlationError = null;
  const expectedOrdinalCounts = expectedPageRpcCount === null || expectedRouteCount === null ? null : {
    pageRpcCount: expectedPageRpcCount,
    routeCount: expectedRouteCount,
  };
  const assertOrdinalCountsStable = phase => {
    if (!readCurrentOrdinalCounts || !expectedOrdinalCounts) return;
    const current = readCurrentOrdinalCounts();
    assert.ok(current && Number.isSafeInteger(current.pageRpcCount) && Number.isSafeInteger(current.routeCount),
      "current Mobile RPC ordinal counts must be safe integers");
    assert.equal(current.pageRpcCount, expectedOrdinalCounts.pageRpcCount,
      `new page RPC ordinal observed while ${phase}`);
    assert.equal(current.routeCount, expectedOrdinalCounts.routeCount,
      `new RPC route ordinal observed while ${phase}`);
  };
  try {
    if (expectedPageRpcCount !== null) {
      assert.equal(pageWebSockets.filter(socket => socket?.path === "/rpc").length, expectedPageRpcCount,
        "selected page RPC WebSocket history was truncated before the close barrier");
    }
    if (expectedRouteCount !== null) {
      assert.equal(routeDiagnostics.length, expectedRouteCount,
        "selected RPC route diagnostic history was truncated before the close barrier");
    }
    if (pageWebSockets.length > 0 || routeDiagnostics.length > 0) {
      pairs = correlateMobilePageRpcRoutes(pageWebSockets, routeDiagnostics);
    }
    if (requiredSocketOrdinal !== null) {
      assert.equal(pairs.filter(pair => pair.routeDiagnostic.socketOrdinal === requiredSocketOrdinal).length, 1,
        `required Mobile RPC socket ordinal ${requiredSocketOrdinal} must map to one page socket and route`);
    }
    if (pairs.length === 0 && requiredSocketOrdinal !== null) {
      throw new Error("required Mobile RPC socket was not observed before page close");
    }
    assertOrdinalCountsStable("starting owner release");
  } catch (error) {
    correlationError = error;
  }

  let routeCloseError = correlationError;
  if (!routeCloseError && pairs.length > 0) {
    try {
      for (const { routeDiagnostic } of pairs) {
        const closeRequest = routeDiagnostic?.closeForwarding?.requestCloseFromOwnerRelease;
        if (typeof closeRequest === "function") closeRequest.call(routeDiagnostic.closeForwarding);
        else if (!mobilePageRpcRoutesClosed([{ routeDiagnostic }])) {
          throw new Error("selected RPC route has no owned endpoint close request mechanism");
        }
      }
      await waitFor(() => {
        assertOrdinalCountsStable("waiting for route endpoints to close");
        return mobilePageRpcRoutesClosed(pairs) ? true : null;
      }, timeoutMs, `${label}: every selected page RPC route client and upstream endpoint to close`);
    } catch (error) {
      routeCloseError = error;
    }
  }

  let pageCloseError = null;
  try { await page.close(); }
  catch (error) { pageCloseError = error; }
  if (!routeCloseError) {
    try {
      assertOrdinalCountsStable("disposing the owned page");
      if (pairs.length > 0 && !mobilePageRpcRoutesClosed(pairs)) {
        throw new Error("RPC route close callbacks or close request settlement changed before Page disposal completed");
      }
    }
    catch (error) { routeCloseError = error; }
  }
  if (routeCloseError) throw routeCloseError;
  if (pageCloseError) throw pageCloseError;
  const requiredPair = requiredSocketOrdinal === null ? null :
    pairs.find(pair => pair.routeDiagnostic.socketOrdinal === requiredSocketOrdinal) ?? null;
  return Object.freeze({
    pageClosed: true,
    rpcSocketCount: pairs.length,
    allRouteEndpointsClosed: pairs.length === 0 || mobilePageRpcRoutesClosed(pairs),
    requiredSocketOrdinal,
    requiredRouteEndpointsClosed: requiredPair === null ? null : mobilePageRpcRoutesClosed([requiredPair]),
  });
}
