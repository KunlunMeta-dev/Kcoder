import assert from "node:assert/strict";

const EXPECTED_MOBILE_PROTOCOL_VERSION = "2026-07-27";

/** Observe only non-secret route facts and initialize receipts on the real runtime socket. */
export function observeMobileRuntimeInitialize(page, {
  gatewayBaseUrl,
  workspacePath,
  serverId = "local",
  getPhase = () => null,
  redactText = value => String(value),
} = {}) {
  assert.equal(typeof gatewayBaseUrl, "string");
  assert.equal(typeof workspacePath, "string");
  assert.equal(typeof redactText, "function");
  const expectedGateway = new URL(gatewayBaseUrl);
  const expectedProtocol = expectedGateway.protocol === "https:" ? "wss:" : "ws:";
  const expectedRpcPath = `${expectedGateway.pathname.replace(/\/+$/, "")}/rpc`;
  const sockets = [];

  page.on("websocket", socket => {
    let url;
    try { url = new URL(socket.url()); } catch { return; }
    const query = url.searchParams;
    if (url.pathname !== expectedRpcPath || query.get("channel") !== "runtime") return;
    const queryKeys = [...query.keys()];
    const routeMatches = url.protocol === expectedProtocol
      && url.host === expectedGateway.host
      && !url.username
      && !url.password
      && queryKeys.length === 4
      && new Set(queryKeys).size === 4
      && queryKeys.every(key => ["token", "server", "channel", "workspace"].includes(key))
      && Boolean(query.get("token"))
      && query.get("server") === serverId
      && query.get("workspace") === workspacePath;
    const record = {
      testPhaseAtSocket: getPhase(),
      routeMatches,
      lifecycle: [{ event: "websocket-created", testPhase: getPhase() }],
      initializeRequests: [],
      initializeResponses: [],
    };
    const requestsById = new Map();
    sockets.push(record);

    socket.on("socketerror", error => {
      const message = redactText(String(error))
        .replace(/\b(?:ws|wss|http|https):\/\/[^\s'"<>]+/gi, "[REDACTED_URL]")
        .slice(0, 500);
      record.lifecycle.push({ event: "socketerror", testPhase: getPhase(), message });
    });
    socket.on("close", () => record.lifecycle.push({ event: "close", testPhase: getPhase() }));
    socket.on("framesent", event => {
      const frame = parseJsonFrame(event.payload);
      if (frame?.method !== "initialize" || frame.id === undefined) return;
      const request = { id: frame.id, testPhase: getPhase() };
      requestsById.set(frame.id, request);
      record.initializeRequests.push(request);
      record.lifecycle.push({ event: "initialize-request", testPhase: request.testPhase });
    });
    socket.on("framereceived", event => {
      const frame = parseJsonFrame(event.payload);
      if (frame?.id === undefined || !requestsById.has(frame.id)) return;
      const request = requestsById.get(frame.id);
      requestsById.delete(frame.id);
      record.initializeResponses.push({
        testPhase: getPhase(),
        requestTestPhase: request.testPhase,
        success: !frame.error && frame.result?.protocolVersion === EXPECTED_MOBILE_PROTOCOL_VERSION,
        protocolVersion: typeof frame.result?.protocolVersion === "string" ? frame.result.protocolVersion : null,
      });
      record.lifecycle.push({ event: "initialize-response", testPhase: getPhase(), success: !frame.error && frame.result?.protocolVersion === EXPECTED_MOBILE_PROTOCOL_VERSION });
    });
  });

  const successfulInitializations = () => sockets.flatMap((socket, socketIndex) =>
    socket.initializeResponses
      .filter(response => socket.routeMatches && response.success)
      .map(response => ({ ...response, socketIndex, testPhaseAtSocket: socket.testPhaseAtSocket })),
  );

  return {
    sockets,
    successfulInitializations,
    async waitForSuccessfulInitializeAfter(previousCount, timeoutMs = 30_000) {
      assert.ok(Number.isInteger(previousCount) && previousCount >= 0);
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const current = successfulInitializations();
        if (current.length > previousCount) return current[previousCount];
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Mobile runtime initialize did not succeed after reload within ${timeoutMs}ms`);
    },
  };
}

/** Capture bounded, redacted page state when a Mobile route locator fails. */
export async function captureMobileRouteFailure(page, {
  context,
  artifactName,
  screenshotName,
  testPhase,
  testIds,
  diagnosticEvents = [],
  runtimeSocketObservations = [],
  error,
} = {}) {
  assert.equal(typeof context?.redactText, "function");
  assert.equal(typeof context?.pathInArtifacts, "function");
  assert.equal(typeof context?.writeArtifactJson, "function");
  assert.equal(typeof artifactName, "string");
  assert.equal(typeof screenshotName, "string");
  assert.equal(typeof testPhase, "string");
  assert.ok(Array.isArray(testIds) && testIds.length <= 40);
  assert.ok(Array.isArray(diagnosticEvents));
  assert.ok(Array.isArray(runtimeSocketObservations));

  const controls = await Promise.all(testIds.map(async testId => {
    const locator = page.getByTestId(testId);
    const count = await locator.count().catch(() => null);
    const visibleCount = await locator.evaluateAll(elements => elements.filter(element => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }).length).catch(() => null);
    return { testId, count, visibleCount };
  }));
  const headingsAndAlerts = await page.locator('h1, h2, [role="heading"], [role="alert"], [aria-live="assertive"]')
    .evaluateAll(elements => elements.slice(0, 40).map(element => (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500)))
    .catch(() => []);
  let screenshotSaved = false;
  let screenshotError = null;
  try {
    await page.screenshot({ path: context.pathInArtifacts(screenshotName), fullPage: false, timeout: 5_000 });
    screenshotSaved = true;
  } catch (captureError) {
    screenshotError = safeDiagnosticText(context, captureError instanceof Error ? captureError.message : String(captureError));
  }
  const consolePageErrors = diagnosticEvents.slice(-100).map(event => ({
    testPhase: event.phase ?? null,
    type: event.type,
    message: safeDiagnosticText(context, event.message).slice(0, 1_000),
    locationPathname: event.location?.url ? safePathname(event.location.url) : null,
  }));
  const evidence = {
    testPhase,
    pathname: safePathname(page.url()),
    waitError: safeDiagnosticText(context, error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    controls,
    headingsAndAlerts: headingsAndAlerts.map(text => safeDiagnosticText(context, text).slice(0, 500)),
    consolePageErrors,
    runtimeSocketObservations,
    screenshot: { file: screenshotName, saved: screenshotSaved, error: screenshotError },
  };
  await context.writeArtifactJson(artifactName, evidence);
  return evidence;
}

/** Strictly recognize the one known Chromium warning only during an observed reload recovery phase. */
export function isExpectedMobileReloadSocketClose(diagnostic, {
  gatewayBaseUrl,
  workspacePath,
  serverId = "local",
} = {}) {
  if (diagnostic?.kind !== "warning" || diagnostic.phase !== "page-reload-restore") return false;
  const match = /^WebSocket connection to '([^']+)' failed: WebSocket is closed before the connection is established\.$/.exec(diagnostic.message ?? "");
  if (!match) return false;

  let actual;
  let expectedGateway;
  try {
    actual = new URL(match[1]);
    expectedGateway = new URL(gatewayBaseUrl);
  } catch {
    return false;
  }
  const expectedProtocol = expectedGateway.protocol === "https:" ? "wss:" : "ws:";
  const expectedRpcPath = `${expectedGateway.pathname.replace(/\/+$/, "")}/rpc`;
  const queryKeys = [...actual.searchParams.keys()];
  return actual.protocol === expectedProtocol
    && actual.host === expectedGateway.host
    && actual.pathname === expectedRpcPath
    && !actual.username
    && !actual.password
    && queryKeys.length === 4
    && new Set(queryKeys).size === 4
    && queryKeys.every(key => ["token", "server", "channel", "workspace"].includes(key))
    && Boolean(actual.searchParams.get("token"))
    && actual.searchParams.get("server") === serverId
    && actual.searchParams.get("channel") === "runtime"
    && actual.searchParams.get("workspace") === workspacePath;
}

function parseJsonFrame(payload) {
  try { return JSON.parse(String(payload)); } catch { return null; }
}

function safeDiagnosticText(context, value) {
  return context.redactText(String(value)).replace(/\b(?:ws|wss|http|https):\/\/[^\s'"<>]+/gi, url => safePathname(url) ?? "[REDACTED_URL]");
}

function safePathname(value) {
  try { return new URL(value).pathname; }
  catch { return null; }
}
