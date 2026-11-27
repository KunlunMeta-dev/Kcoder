// Review candidate only. The owning manual-live Rust suite supplies its RunContext,
// Chromium browser, isolated public route, and in-memory authenticated storageState.
// This module owns only the Mobile page probe; it starts no Gateway, Relay, SSH, or Provider.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

const PUBLIC_ORIGIN = "https://hyf2333.top";
const INITIALIZE_METHOD = "initialize";
const NEW_CATALOG_METHODS = new Set([
  "runtime.workspaces.list",
  "runtime.worktrees.list",
  "runtime.models.list",
]);
const KNOWN_MUTATING_REQUEST_METHODS = new Set([
  "thread/start", "thread/fork", "thread/compact", "thread/rollback", "thread/delete",
  "thread/dispose", "thread/metadata/update", "thread/sessionMode/set", "thread/goal/set",
  "thread/goal/clear", "turn/start", "turn/interrupt", "turn/shorten_wait",
  "runtime.providers.upsert", "runtime.providers.delete", "runtime.providers.clearUserOverride",
  "runtime.worktrees.create", "runtime.worktrees.archive", "runtime.worktrees.restore",
  "workspace/file/importAttachment", "attachment/save", "attachment/delete", "device/execute",
  "terminal/start", "terminal/write", "terminal/close", "browser/action", "browser/close",
]);
const READ_ONLY_NOTIFICATION_DIRECTIONS = new Map([
  ["initialized", "client-to-server"],
  ["thread/goal/updated", "server-to-client"],
]);
const MAX_EVENTS = 512;
const MAX_PENDING_RPCS = 512;
const MAX_STATIC_ASSETS = 37;
const MAX_RPC_FRAME_BYTES = 2 * 1024 * 1024;
const HOME_BOOTSTRAP_ENDPOINTS = new Set(["/api/servers", "/api/servers/status"]);
const MAX_HOME_HTTP_OBSERVATIONS = 16;
const SAFE_NETWORK_FAILURE_CODES = new Set([
  "ERR_ABORTED", "ERR_FAILED", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_REFUSED", "ERR_TIMED_OUT", "ERR_NETWORK_CHANGED", "ERR_NAME_NOT_RESOLVED",
  "ERR_CERT_AUTHORITY_INVALID", "ERR_SSL_PROTOCOL_ERROR", "ERR_HTTP2_PROTOCOL_ERROR",
]);
const SAFE_ERROR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "AggregateError",
  "AssertionError", "TimeoutError", "AbortError",
]);

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isRpcId = value => typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));

// Playwright forwards WebSocket data frames as text or Buffer/Uint8Array. Control
// ping/pong frames are not surfaced by its framesent/framereceived events.
export function parseObservedJsonRpcFrame(direction, payload) {
  if (direction !== "client-to-server" && direction !== "server-to-client")
    return { ok: false, reason: "invalid-direction" };
  let text;
  if (typeof payload === "string") {
    if (Buffer.byteLength(payload, "utf8") > MAX_RPC_FRAME_BYTES)
      return { ok: false, reason: "frame-too-large" };
    text = payload;
  } else if (payload instanceof Uint8Array) {
    if (payload.byteLength > MAX_RPC_FRAME_BYTES) return { ok: false, reason: "frame-too-large" };
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(payload); }
    catch { return { ok: false, reason: "invalid-utf8" }; }
  } else return { ok: false, reason: "unsupported-payload" };
  let frame;
  try { frame = JSON.parse(text); }
  catch { return { ok: false, reason: "invalid-json" }; }
  if (!isRecord(frame) || frame.jsonrpc !== "2.0")
    return { ok: false, reason: "invalid-jsonrpc-envelope" };
  const hasMethod = Object.hasOwn(frame, "method");
  const hasId = Object.hasOwn(frame, "id");
  const hasResult = Object.hasOwn(frame, "result");
  const hasError = Object.hasOwn(frame, "error");
  if (hasMethod) {
    if (typeof frame.method !== "string" || frame.method.length === 0 || hasResult || hasError)
      return { ok: false, reason: "invalid-request-envelope" };
    if (hasId && !isRpcId(frame.id)) return { ok: false, reason: "invalid-request-id" };
    if (Object.hasOwn(frame, "params") &&
        (frame.params === null || typeof frame.params !== "object"))
      return { ok: false, reason: "invalid-request-params" };
    return { ok: true, envelopeKind: hasId ? "request" : "notification", frame };
  }
  if (direction !== "server-to-client")
    return { ok: false, reason: "response-wrong-direction" };
  if (!hasId || !isRpcId(frame.id)) return { ok: false, reason: "invalid-response-id" };
  if (hasResult === hasError) return { ok: false, reason: "response-result-error-xor" };
  if (hasError && (!isRecord(frame.error) || typeof frame.error.code !== "number" ||
      !Number.isInteger(frame.error.code) || typeof frame.error.message !== "string"))
    return { ok: false, reason: "invalid-response-error" };
  return { ok: true, envelopeKind: "response", responseShape: hasResult ? "result" : "error", frame };
}

export function classifyObservedRpcRequest({ direction, routeOwned, phase, method }) {
  const target = Boolean(routeOwned && direction === "client-to-server" && NEW_CATALOG_METHODS.has(method));
  let classification = "unexpected-request";
  if (!routeOwned) classification = "foreign-request";
  else if (direction === "client-to-server" && method === INITIALIZE_METHOD)
    classification = "initialize-handshake";
  else if (target) classification = "read-only-catalog-request";
  else if (KNOWN_MUTATING_REQUEST_METHODS.has(method)) classification = "mutating-request";
  return { phase, target, classification };
}

export function matchesObservedRpcPair(request, response) {
  return Boolean(request?.kind === "rpc-request" && response?.kind === "rpc-response" &&
    request.routeOwned === true && response.routeOwned === true &&
    request.direction === "client-to-server" && response.direction === "server-to-client" &&
    response.envelopeKind === "response" &&
    (response.responseShape === "result" || response.responseShape === "error") &&
    response.error === (response.responseShape === "error") &&
    request.routeSocketId === response.routeSocketId &&
    request.idFingerprint === response.idFingerprint &&
    request.requestSequence === response.requestSequence &&
    request.phase === response.phase && request.target === response.target &&
    request.classification === response.classification && request.method === response.method &&
    response.requestDirection === request.direction);
}

export function hasCompleteRpcAttribution(evidence) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  return Boolean(evidence?.actionClickReceived === true && evidence?.observedActionRpcClosed === true &&
    count(evidence.actionNonInitializeCatalogRequestCount) && evidence.actionNonInitializeCatalogRequestCount > 0 &&
    count(evidence.actionNonInitializeCatalogMatchedResponseCount) &&
    evidence.actionNonInitializeCatalogMatchedResponseCount === evidence.actionNonInitializeCatalogRequestCount &&
    count(evidence.boundaryUnknownNonHandshakeRpcRequestCount) &&
    evidence.boundaryUnknownNonHandshakeRpcRequestCount === 0 &&
    count(evidence.unansweredActionTargetRequestCount) && evidence.unansweredActionTargetRequestCount === 0 &&
    count(evidence.actionTargetResponseErrors) && evidence.actionTargetResponseErrors === 0 &&
    evidence.unexpectedRpcTraffic === false);
}

export async function loadFrozenMobileWebBundle(bundleRoot, manifestPath) {
  const root = resolve(bundleRoot);
  assert.equal(await realpath(root), root, "frozen Web root must be canonical");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.status, "complete");
  assert.ok(Number.isSafeInteger(manifest.bundleFileCount) && manifest.bundleFileCount > 0 &&
    manifest.bundleFileCount <= MAX_STATIC_ASSETS, "static bundle exceeds " + MAX_STATIC_ASSETS + " entries");
  assert.equal(manifest.bundleFiles?.length, manifest.bundleFileCount);

  const files = new Map();
  let totalBytes = 0;
  for (const entry of manifest.bundleFiles) {
    assert.equal(typeof entry.path, "string");
    assert.ok(!isAbsolute(entry.path));
    const file = resolve(root, entry.path);
    const rel = relative(root, file);
    assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`), "bundle path escaped root");
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `bundle entry must be a regular file: ${entry.path}`);
    assert.equal(await realpath(file), file, `bundle entry must be canonical: ${entry.path}`);
    const body = await readFile(file);
    assert.equal(body.byteLength, entry.size, `bundle size mismatch: ${entry.path}`);
    const digest = createHash("sha256").update(body).digest("hex");
    assert.equal(digest, entry.sha256, `bundle hash mismatch: ${entry.path}`);
    assert.ok(!files.has(entry.path), `duplicate bundle path: ${entry.path}`);
    files.set(entry.path, { body, sha256: digest, size: body.byteLength });
    totalBytes += body.byteLength;
  }
  const index = files.get("index.html");
  assert.ok(index, "frozen Web bundle must contain index.html");
  assert.equal(index.sha256, manifest.indexHtmlSha256);
  return Object.freeze({
    root,
    sourceTreeSha256: manifest.sourceTreeSha256,
    bundleSha256: manifest.bundleSha256,
    bundleFileCount: files.size,
    totalBytes,
    indexHtmlSha256: index.sha256,
    files,
  });
}

export async function createNewCatalogProbePage({
  runContext,
  browser,
  storageState,
  bundle,
  variant,
  pageId,
  gatewayBaseUrl,
  serverId,
}) {
  assert.ok(runContext && typeof runContext.registerSecret === "function");
  assert.ok(browser && typeof browser.newContext === "function");
  assert.ok(storageState && typeof storageState === "object", "profile state is supplied in memory only");
  assert.ok(bundle?.files instanceof Map && bundle.files.has("index.html"));
  assert.ok(bundle.files.size > 0 && bundle.files.size <= MAX_STATIC_ASSETS,
    "static bundle file map exceeds " + MAX_STATIC_ASSETS + " entries");
  if (Number.isSafeInteger(bundle.bundleFileCount)) assert.equal(bundle.files.size, bundle.bundleFileCount);
  assert.match(variant, /^(A|B)$/);
  assert.match(pageId, /^new-[AB]-sample-[0-9]{2}$/);
  assert.match(serverId, /^[A-Za-z0-9._-]{1,80}$/);

  const route = new URL(gatewayBaseUrl);
  assert.equal(route.origin, PUBLIC_ORIGIN);
  assert.match(route.pathname, /^\/g\/[a-f0-9]{32}$/);
  const routePrefix = route.pathname;
  const expectedWssOriginUrl = new URL(PUBLIC_ORIGIN);
  expectedWssOriginUrl.protocol = "wss:";
  const expectedWssOrigin = expectedWssOriginUrl.origin;
  const expectedWssPath = routePrefix + "/rpc";
  const browserContext = await browser.newContext({
    storageState,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
  });
  const page = await browserContext.newPage();
  const events = [];
  const staticFulfilled = new Map();
  const nodeMarkers = [];
  let droppedEvents = 0;
  let socketOrdinal = 0;
  let httpOrdinal = 0;
  let actionWindowStartNodeAtMs = null;
  let actionDispatchStartNodeAtMs = null;
  let actionClickNodeAtMs = null;
  const rpcState = {
    pendingCount: 0,
    pendingOverflowCount: 0,
    duplicatePendingCount: 0,
    unmatchedResponseCount: 0,
    requestOrdinal: 0,
    boundaryUnknownRequestCount: 0,
    boundaryUnknownTargetRequestCount: 0,
    boundaryUnknownNotificationCount: 0,
    unexpectedRequestCount: 0,
    mutatingRequestCount: 0,
    allowedNotificationCount: 0,
    unexpectedNotificationCount: 0,
    foreignNotificationCount: 0,
    malformedRpcFrameCount: 0,
  };
  let foreignWebSocketCount = 0;
  let homeBootstrap = null;
  const homeHttpObservations = [];
  let homeHttpOverflowCount = 0;
  let homeHttpOrdinal = 0;
  let staticMissCount = 0;
  let staticAssetOverflowCount = 0;
  let foreignGatewayCount = 0;
  let externalRequestCount = 0;

  const record = row => {
    if (events.length >= MAX_EVENTS) { droppedEvents += 1; return; }
    events.push(row);
  };
  const safeErrorName = name => SAFE_ERROR_NAMES.has(name) ? name : "OtherError";
  const safeNetworkFailureCode = errorText => {
    const match = typeof errorText === "string" ? errorText.match(/(?:net::)?(ERR_[A-Z0-9_]+)/) : null;
    return match && SAFE_NETWORK_FAILURE_CODES.has(match[1]) ? match[1] : "OTHER_NETWORK_FAILURE";
  };
  const recordHomeHttp = observation => {
    if (homeHttpObservations.length >= MAX_HOME_HTTP_OBSERVATIONS) {
      homeHttpObservations.shift();
      homeHttpOverflowCount += 1;
    }
    homeHttpObservations.push(observation);
  };
  const homeHttpEvidenceSince = eventOrdinal => {
    const observations = homeHttpObservations.filter(row => row.eventOrdinal > eventOrdinal).map(row => ({ ...row }));
    const counts = Object.fromEntries([...HOME_BOOTSTRAP_ENDPOINTS].map(endpoint => {
      const matching = observations.filter(row => row.endpoint === endpoint);
      const requests = matching.filter(row => row.kind === "request").length;
      const responses = matching.filter(row => row.kind === "response").length;
      const failures = matching.filter(row => row.kind === "request-failed").length;
      return [endpoint, { requests, responses, failures,
        pendingEstimate: Math.max(0, requests - responses - failures),
        complete: homeHttpOverflowCount === 0 }];
    }));
    return { endpointAllowlist: [...HOME_BOOTSTRAP_ENDPOINTS], observations, counts,
      earlierObservationsDropped: homeHttpOverflowCount, limit: MAX_HOME_HTTP_OBSERVATIONS };
  };
  const statusErrorClassification = (visible, observedStatus) => {
    if (!visible) return "HIDDEN";
    if (observedStatus === 401) return "HTTP_401";
    if (observedStatus === 403) return "HTTP_403";
    if (observedStatus === 429) return "HTTP_429";
    if (Number.isInteger(observedStatus) && observedStatus >= 500) return "HTTP_SERVER_ERROR";
    if (Number.isInteger(observedStatus) && observedStatus !== 200) return "HTTP_NON_200";
    if (observedStatus === 200) return "VISIBLE_WITH_HTTP_200";
    return "VISIBLE_WITHOUT_OBSERVED_RESPONSE";
  };
  const recordNodeMarker = async (_source, marker) => {
    const atNodeMs = performance.now();
    if (marker?.kind === "new-action-click" && actionClickNodeAtMs === null)
      actionClickNodeAtMs = atNodeMs;
    if (nodeMarkers.length < 16) nodeMarkers.push({ kind: marker?.kind, atNodeMs });
    record({ kind: "node-marker", markerKind: marker?.kind, atNodeMs,
      atPageMs: Number.isFinite(marker?.atPageMs) ? marker.atPageMs : null });
  };
  await page.exposeBinding("__kcoderNewCatalogProbeMark", recordNodeMarker);
  await page.addInitScript(({ targetTestId }) => {
    const state = {
      actionClickAtPageMs: null,
      clickTrusted: false,
      homeCtaVisibleAtPageMs: null,
      homeCtaEnabledAtPageMs: null,
      pathVisibleAtPageMs: null,
      modelVisibleAtPageMs: null,
      firstUsableDomAtPageMs: null,
      usableAfterTwoRafAtPageMs: null,
      workspaceValuePresent: false,
    };
    window.__kcoderNewCatalogDomProbe = state;
    let rafPending = false;
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&
        rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight &&
        rect.right > 0 && rect.left < innerWidth;
    };
    const enabled = element => Boolean(element) && element.hasAttribute("disabled") !== true &&
      element.getAttribute("aria-disabled") !== "true" && element.getAttribute("disabled") !== "true";
    const readControls = () => {
      const pathRoot = document.querySelector('[data-testid="workspace-path"]');
      const pathInput = pathRoot?.matches("input,textarea,[role=textbox]")
        ? pathRoot
        : pathRoot?.querySelector("input,textarea,[role=textbox]") ?? pathRoot;
      const model = document.querySelector('[data-testid="model-selector"]');
      const pathVisible = visible(pathRoot);
      const modelVisible = visible(model);
      const pathEnabled = enabled(pathInput) && pathInput?.hasAttribute("readonly") !== true && pathInput?.readOnly !== true;
      const modelEnabled = enabled(model);
      return {
        pathVisible,
        modelVisible,
        pathEnabled,
        modelEnabled,
        usable: location.pathname.replace(/\/+$/, "").endsWith("/new") &&
          pathVisible && modelVisible && pathEnabled && modelEnabled,
        workspaceValuePresent: Boolean(String(pathInput?.value ?? "").trim()),
      };
    };
    const check = () => {
      const homeCta = document.querySelector(`[data-testid="${targetTestId}"]`);
      const homeCtaVisible = visible(homeCta);
      if (homeCtaVisible && state.homeCtaVisibleAtPageMs === null)
        state.homeCtaVisibleAtPageMs = performance.now();
      if (homeCtaVisible && enabled(homeCta) && state.homeCtaEnabledAtPageMs === null)
        state.homeCtaEnabledAtPageMs = performance.now();
      if (state.actionClickAtPageMs === null) return;
      const controls = readControls();
      const now = performance.now();
      if (controls.pathVisible && state.pathVisibleAtPageMs === null) state.pathVisibleAtPageMs = now;
      if (controls.modelVisible && state.modelVisibleAtPageMs === null) state.modelVisibleAtPageMs = now;
      if (!controls.usable) return;
      if (state.firstUsableDomAtPageMs === null) state.firstUsableDomAtPageMs = now;
      state.workspaceValuePresent = controls.workspaceValuePresent;
      if (state.usableAfterTwoRafAtPageMs !== null || rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        rafPending = false;
        if (readControls().usable && state.usableAfterTwoRafAtPageMs === null)
          state.usableAfterTwoRafAtPageMs = performance.now();
        check();
      }));
    };
    document.addEventListener("click", event => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      let target = event.target;
      while (target && target.getAttribute("data-testid") !== targetTestId) target = target.parentElement;
      if (!target) return;
      state.actionClickAtPageMs = performance.now();
      state.clickTrusted = true;
      void window.__kcoderNewCatalogProbeMark({ kind: "new-action-click", atPageMs: state.actionClickAtPageMs });
      check();
    }, true);
    new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true });
  }, { targetTestId: `new-workspace-${serverId}` });

  await browserContext.route("**/*", async intercepted => {
    const request = intercepted.request();
    let url;
    try { url = new URL(request.url()); }
    catch { externalRequestCount += 1; await intercepted.abort(); return; }
    if (url.origin !== PUBLIC_ORIGIN) { externalRequestCount += 1; await intercepted.abort(); return; }
    if (url.pathname.startsWith(`${routePrefix}/`)) {
      const endpoint = url.pathname.slice(routePrefix.length);
      const ordinal = ++httpOrdinal;
      record({ kind: "gateway-http-request", pageId, atNodeMs: performance.now(), ordinal,
        method: request.method(), endpoint });
      if (HOME_BOOTSTRAP_ENDPOINTS.has(endpoint))
        recordHomeHttp({ eventOrdinal: ++homeHttpOrdinal, kind: "request", endpoint,
          method: request.method() === "GET" ? "GET" : "OTHER", atNodeMs: performance.now() });
      await intercepted.continue();
      return;
    }
    if (url.pathname.startsWith("/g/")) {
      foreignGatewayCount += 1; await intercepted.abort(); return;
    }
    let assetPath;
    try { assetPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname); }
    catch { staticMissCount += 1; await intercepted.abort(); return; }
    const normalizedPath = assetPath.replace(/^\/+/, "");
    const asset = bundle.files.get(normalizedPath);
    if (!asset) { staticMissCount += 1; await intercepted.abort(); return; }
    if (!staticFulfilled.has(normalizedPath)) {
      if (staticFulfilled.size >= MAX_STATIC_ASSETS) {
        staticAssetOverflowCount += 1;
        staticMissCount += 1;
        await intercepted.abort();
        return;
      }
      staticFulfilled.set(normalizedPath, { path: normalizedPath, sha256: asset.sha256, bytes: asset.size });
    }
    await intercepted.fulfill({ status: 200, contentType: contentType(normalizedPath),
      headers: { "cache-control": "no-store" }, body: asset.body });
  });

  page.on("websocket", socket => {
    const routeSocketId = pageId + "-socket-" + (++socketOrdinal);
    let socketUrl;
    try { socketUrl = new URL(socket.url()); } catch {
      foreignWebSocketCount += 1;
      record({ kind: "rpc-socket-open", pageId, routeSocketId, routeOwned: false,
        protocolMatches: false, originMatches: false, pathMatches: false, atNodeMs: performance.now() });
      return;
    }
    const protocolMatches = socketUrl.protocol === "wss:";
    const originMatches = socketUrl.origin === expectedWssOrigin;
    const pathMatches = socketUrl.pathname === expectedWssPath;
    const routeOwned = protocolMatches && originMatches && pathMatches;
    if (!routeOwned) foreignWebSocketCount += 1;
    const pending = new Map();
    record({ kind: "rpc-socket-open", pageId, routeSocketId, routeOwned,
      protocolMatches, originMatches, pathMatches, atNodeMs: performance.now() });
    socket.on("framesent", frame => observeFrame("request", frame?.payload, routeSocketId, routeOwned,
      pending, rpcState, () => actionDispatchStartNodeAtMs, () => actionClickNodeAtMs, record));
    socket.on("framereceived", frame => observeFrame("response", frame?.payload, routeSocketId, routeOwned,
      pending, rpcState, () => actionDispatchStartNodeAtMs, () => actionClickNodeAtMs, record));
    socket.on("close", () => record({ kind: "rpc-socket-close", pageId, routeSocketId, routeOwned, atNodeMs: performance.now() }));
  });
  page.on("response", response => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== PUBLIC_ORIGIN || !url.pathname.startsWith(`${routePrefix}/`)) return;
    const endpoint = url.pathname.slice(routePrefix.length);
    const atNodeMs = performance.now();
    record({ kind: "gateway-http-response", pageId, atNodeMs, method: response.request().method(),
      endpoint, status: response.status() });
    if (HOME_BOOTSTRAP_ENDPOINTS.has(endpoint))
      recordHomeHttp({ eventOrdinal: ++homeHttpOrdinal, kind: "response", endpoint,
        method: response.request().method() === "GET" ? "GET" : "OTHER",
        status: Number.isInteger(response.status()) ? response.status() : null, atNodeMs });
  });
  page.on("requestfailed", request => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (url.origin !== PUBLIC_ORIGIN || !url.pathname.startsWith(`${routePrefix}/`)) return;
    const endpoint = url.pathname.slice(routePrefix.length);
    if (!HOME_BOOTSTRAP_ENDPOINTS.has(endpoint)) return;
    const atNodeMs = performance.now();
    const failureClass = safeNetworkFailureCode(request.failure()?.errorText);
    const observation = { eventOrdinal: ++homeHttpOrdinal, kind: "request-failed", endpoint,
      method: request.method() === "GET" ? "GET" : "OTHER", failureClass, atNodeMs };
    recordHomeHttp(observation);
    record({ kind: "home-bootstrap-request-failed", endpoint, method: observation.method, failureClass, atNodeMs });
  });
  page.on("pageerror", error => record({ kind: "pageerror", atNodeMs: performance.now(), errorName: safeErrorName(error?.name) }));

  const snapshot = () => {
    const rpcEvents = events.filter(row => row.kind === "rpc-request" || row.kind === "rpc-response");
    const notificationEvents = events.filter(row => row.kind === "rpc-notification");
    const requests = rpcEvents.filter(row => row.kind === "rpc-request");
    const responses = rpcEvents.filter(row => row.kind === "rpc-response");
    const responseBySequence = new Map(responses.map(row => [row.requestSequence, row]));
    const requestBySequence = new Map(requests.map(row => [row.requestSequence, row]));
    const hasMatchedResponse = request => matchesObservedRpcPair(request,
      responseBySequence.get(request.requestSequence));
    const hasMatchedRequest = response => matchesObservedRpcPair(
      requestBySequence.get(response.requestSequence), response);
    const actionRequests = requests.filter(row => row.routeOwned && row.phase === "action");
    const actionResponses = responses.filter(row => row.routeOwned && row.phase === "action" && hasMatchedRequest(row));
    const setupRequests = requests.filter(row => row.routeOwned && row.phase === "setup");
    const foreignTargetRequests = requests.filter(row => !row.routeOwned && row.target);
    const boundaryUnknownRequests = requests.filter(row => row.phase === "boundary-unknown");
    const boundaryUnknownInitializeHandshakes = boundaryUnknownRequests.filter(row =>
      row.classification === "initialize-handshake");
    const boundaryUnknownNonHandshakeRequests = boundaryUnknownRequests.filter(row =>
      row.classification !== "initialize-handshake");
    const initializeHandshakeRequests = requests.filter(row => row.classification === "initialize-handshake");
    const initializeHandshakeByPhase = Object.fromEntries(["setup", "action", "boundary-unknown"].map(phase =>
      [phase, initializeHandshakeRequests.filter(row => row.phase === phase).length]));
    const boundaryUnknownTargetRequests = boundaryUnknownRequests.filter(row => row.target);
    const actionTargetRequests = actionRequests.filter(row => row.target && row.classification === "read-only-catalog-request");
    const actionTargetResponses = actionResponses.filter(row => row.target && row.classification === "read-only-catalog-request");
    const unansweredActionTargetRequests = actionTargetRequests.filter(row => !hasMatchedResponse(row));
    const actionTargetResponseErrors = actionTargetResponses.filter(row => row.error).length;
    const mutatingRequests = requests.filter(row => row.classification === "mutating-request");
    const unexpectedRequests = requests.filter(row => row.classification === "unexpected-request");
    const allowedNotifications = notificationEvents.filter(row => row.classification === "known-read-only-notification");
    const unexpectedNotifications = notificationEvents.filter(row => row.classification === "unexpected-notification" ||
      row.classification === "foreign-notification");
    const methodCounts = Object.fromEntries([...NEW_CATALOG_METHODS].map(method => {
      const methodRequests = actionTargetRequests.filter(row => row.method === method);
      const methodResponses = actionTargetResponses.filter(row => row.method === method &&
        methodRequests.some(request => request.requestSequence === row.requestSequence &&
          request.routeSocketId === row.routeSocketId && request.idFingerprint === row.idFingerprint));
      return [method, { requests: methodRequests.length, responses: methodResponses.length,
        responseErrors: methodResponses.filter(row => row.error).length }];
    }));
    const targetMethodClassification = Object.fromEntries([...NEW_CATALOG_METHODS].map(method => {
      const actionCount = actionTargetRequests.filter(row => row.method === method).length;
      const setupCount = setupRequests.filter(row => row.target && row.method === method).length;
      const boundaryUnknownCount = boundaryUnknownTargetRequests.filter(row => row.method === method).length;
      const foreignCount = foreignTargetRequests.filter(row => row.method === method).length;
      const classification = boundaryUnknownCount > 0 ? "boundary-unknown" : actionCount > 0
        ? "action-rpc" : setupCount > 0 ? "setup-warm/cache-candidate" : "foreign-or-unknown";
      return [method, { classification, actionRequests: actionCount, setupRequests: setupCount,
        boundaryUnknownRequests: boundaryUnknownCount, foreignRequests: foreignCount }];
    }));
    const actionSocketIds = [...new Set(actionRequests.map(row => row.routeSocketId))];
    const actionRpcBySocket = Object.fromEntries(actionSocketIds.map(routeSocketId => [routeSocketId,
      rpcEvents.filter(row => row.routeSocketId === routeSocketId && row.phase === "action") ]));
    const actionEvents = rpcEvents.filter(row => row.routeOwned && row.phase === "action");
    const requestClassificationCounts = {
      setup: requests.filter(row => row.phase === "setup").length,
      action: requests.filter(row => row.phase === "action").length,
      boundaryUnknown: boundaryUnknownRequests.length,
      initializeHandshake: initializeHandshakeRequests.length,
      initializeHandshakeByPhase,
      boundaryUnknownNonHandshake: boundaryUnknownNonHandshakeRequests.length,
      foreign: requests.filter(row => row.phase === "foreign").length,
      mutating: mutatingRequests.length,
      unexpected: unexpectedRequests.length,
      actionCatalog: actionTargetRequests.length,
      actionCatalogMatchedResponses: actionTargetResponses.filter(hasMatchedRequest).length,
    };
    const notificationClassificationCounts = {
      setup: notificationEvents.filter(row => row.phase === "setup").length,
      action: notificationEvents.filter(row => row.phase === "action").length,
      boundaryUnknown: notificationEvents.filter(row => row.phase === "boundary-unknown").length,
      foreign: notificationEvents.filter(row => row.phase === "foreign").length,
      knownReadOnly: allowedNotifications.length,
      unexpected: unexpectedNotifications.length,
    };
    const actionPageErrorCount = events.filter(row => row.kind === "pageerror" &&
      actionClickNodeAtMs !== null && row.atNodeMs >= actionClickNodeAtMs).length;
    const failClosedCounts = {
      droppedEvents,
      staticMissCount,
      staticAssetOverflowCount,
      externalRequestCount,
      foreignGatewayCount,
      foreignWebSocketCount,
      pendingRpcOverflowCount: rpcState.pendingOverflowCount,
      duplicatePendingRpcCount: rpcState.duplicatePendingCount,
      unmatchedRpcResponseCount: rpcState.unmatchedResponseCount,
      mutatingRequestCount: rpcState.mutatingRequestCount,
      unexpectedRequestCount: rpcState.unexpectedRequestCount,
      unexpectedNotificationCount: rpcState.unexpectedNotificationCount,
      foreignNotificationCount: rpcState.foreignNotificationCount,
      malformedRpcFrameCount: rpcState.malformedRpcFrameCount,
    };
    const failClosed = Object.values(failClosedCounts).some(count => count > 0);
    return {
      pageId, variant, samplePath: "Home-to-New; Home setup traffic is retained; this is not a cold-runtime sample",
      instrumentation: "route.fulfill static assets; real public HTTPS/WSS API pass-through; diagnostic callbacks enabled",
      limits: { events: MAX_EVENTS, pendingRpcs: MAX_PENDING_RPCS,
        rpcFrameBytes: MAX_RPC_FRAME_BYTES, staticAssetEntries: MAX_STATIC_ASSETS },
      static: { bundleSha256: bundle.bundleSha256, sourceTreeSha256: bundle.sourceTreeSha256,
        bundleFileCount: bundle.bundleFileCount, totalBytes: bundle.totalBytes, fulfilledCount: staticFulfilled.size,
        fulfilled: [...staticFulfilled.values()], maxEntries: MAX_STATIC_ASSETS,
        staticMissCount, staticAssetOverflowCount, externalRequestCount },
      http: events.filter(row => row.kind.startsWith("gateway-http-")),
      rpcEvents,
      notifications: notificationEvents,
      sockets: events.filter(row => row.kind === "rpc-socket-open" || row.kind === "rpc-socket-close"),
      actionWindowStartNodeAtMs, actionDispatchStartNodeAtMs, actionClickNodeAtMs,
      actionDispatchToMarkerReceiptNodeMs: actionDispatchStartNodeAtMs !== null && actionClickNodeAtMs !== null
        ? actionClickNodeAtMs - actionDispatchStartNodeAtMs : null,
      actionRouteSocketOpenCount: events.filter(row =>
        row.kind === "rpc-socket-open" && row.routeOwned && actionClickNodeAtMs !== null &&
        row.atNodeMs >= actionClickNodeAtMs).length,
      actionRpcSocketCount: actionSocketIds.length,
      actionRpcMethodCounts: methodCounts, targetMethodClassification, actionRpcBySocket,
      requestClassificationCounts, notificationClassificationCounts,
      actionRpcEvents: actionEvents, setupRpcEvents: setupRequests,
      boundaryUnknownRpcEvents: boundaryUnknownRequests, foreignTargetRpcEvents: foreignTargetRequests,
      mutatingRpcEvents: mutatingRequests, unexpectedRpcEvents: unexpectedRequests,
      unexpectedNotificationEvents: unexpectedNotifications,
      actionPageErrorCount, nodeMarkers, foreignGatewayCount, foreignWebSocketCount, droppedEvents,
      rpcIntegrity: { pendingAtSnapshot: rpcState.pendingCount, maxPending: MAX_PENDING_RPCS,
        pendingOverflowCount: rpcState.pendingOverflowCount, duplicatePendingRpcCount: rpcState.duplicatePendingCount,
        unmatchedRpcResponseCount: rpcState.unmatchedResponseCount,
        boundaryUnknownRpcRequestCount: rpcState.boundaryUnknownRequestCount,
        boundaryUnknownRpcEventsSeen: boundaryUnknownRequests.length,
        boundaryUnknownInitializeHandshakeCount: boundaryUnknownInitializeHandshakes.length,
        boundaryUnknownNonHandshakeRpcRequestCount: boundaryUnknownNonHandshakeRequests.length,
        initializeHandshakeRequestCount: initializeHandshakeRequests.length,
        initializeHandshakeByPhase,
        boundaryUnknownTargetRpcRequestCount: rpcState.boundaryUnknownTargetRequestCount,
        boundaryUnknownTargetRpcEventsSeen: boundaryUnknownTargetRequests.length,
        boundaryUnknownNotificationCount: rpcState.boundaryUnknownNotificationCount,
        actionTargetRequestCount: actionTargetRequests.length,
        actionTargetResponseCount: actionTargetResponses.length,
        actionNonInitializeCatalogRequestCount: actionTargetRequests.length,
        actionNonInitializeCatalogMatchedResponseCount: actionTargetResponses.filter(hasMatchedRequest).length,
        unansweredActionTargetRequestCount: unansweredActionTargetRequests.length,
        actionTargetResponseErrors: actionTargetResponseErrors,
        unexpectedRequestCount: rpcState.unexpectedRequestCount,
        mutatingRequestCount: rpcState.mutatingRequestCount,
        allowedReadOnlyNotificationCount: rpcState.allowedNotificationCount,
        unexpectedNotificationCount: rpcState.unexpectedNotificationCount,
        foreignNotificationCount: rpcState.foreignNotificationCount,
        malformedRpcFrameCount: rpcState.malformedRpcFrameCount },
      failClosed, failClosedCounts,
    };
  };

  return {
    browserContext,
    page,
    async openHome() {
      const startedAtNodeMs = performance.now();
      const homeHttpStartOrdinal = homeHttpOrdinal;
      let stage = "NAVIGATION";
      let newCta = null;
      let newCtaVisible = null;
      let newCtaVisibleAtNodeMs = null;
      let newCtaEnabled = null;
      let newCtaPageTimes = { firstVisibleAtPageMs: null, firstEnabledAtPageMs: null };
      homeBootstrap = { outcome: "IN_PROGRESS", stage, elapsedNodeMs: 0,
        strictStatusGateDeadlineMs: 15_000, http: homeHttpEvidenceSince(homeHttpStartOrdinal) };
      const failureEvidence = async failure => {
        const http = homeHttpEvidenceSince(homeHttpStartOrdinal);
        const observations = http.observations;
        const latestStatus = [...observations].reverse().find(row => row.kind === "response" &&
          row.endpoint === "/api/servers/status" && Number.isInteger(row.status));
        const latestServers = [...observations].reverse().find(row => row.kind === "response" &&
          row.endpoint === "/api/servers" && Number.isInteger(row.status));
        let statusUi = null;
        try {
          statusUi = await page.evaluate(() => {
            const visible = element => {
              if (!element) return false;
              const style = getComputedStyle(element), rect = element.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&
                rect.width > 0 && rect.height > 0;
            };
            return {
              statusErrorVisible: visible(document.querySelector('[data-testid="server-status-error"]')),
              statusRefreshingVisible: visible(document.querySelector('[data-testid="server-status-refreshing"]')),
            };
          });
        } catch {}
        if (newCta) {
          newCtaVisible = await newCta.isVisible().catch(() => null);
          if (newCtaVisible === true) newCtaVisibleAtNodeMs ??= performance.now();
          newCtaEnabled = await newCta.isEnabled().catch(() => null);
          newCtaPageTimes = await page.evaluate(() => {
            const state = window.__kcoderNewCatalogDomProbe;
            return state ? {
              firstVisibleAtPageMs: Number.isFinite(state.homeCtaVisibleAtPageMs) ? state.homeCtaVisibleAtPageMs : null,
              firstEnabledAtPageMs: Number.isFinite(state.homeCtaEnabledAtPageMs) ? state.homeCtaEnabledAtPageMs : null,
            } : { firstVisibleAtPageMs: null, firstEnabledAtPageMs: null };
          }).catch(() => ({ firstVisibleAtPageMs: null, firstEnabledAtPageMs: null }));
        }
        const visibleError = statusUi?.statusErrorVisible ?? null;
        const observedStatus = latestStatus?.status ?? null;
        const safeFailure = {};
        try {
          safeFailure.errorName = safeErrorName(failure?.name);
          safeFailure.errorCode = SAFE_NETWORK_FAILURE_CODES.has(failure?.code) ? failure.code : null;
        } catch { safeFailure.errorName = "OtherError"; safeFailure.errorCode = null; }
        homeBootstrap = {
          outcome: "ERROR", stage, elapsedNodeMs: performance.now() - startedAtNodeMs,
          strictStatusGateDeadlineMs: 15_000, failure: safeFailure,
          serverStatusResponses: observations.filter(row => row.kind === "response" &&
            HOME_BOOTSTRAP_ENDPOINTS.has(row.endpoint)).map(row => ({ endpoint: row.endpoint, status: row.status })),
          serversStatus: { servers: latestServers?.status ?? null, statuses: observedStatus },
          statusUi: statusUi ? {
            statusErrorVisible: statusUi.statusErrorVisible,
            statusError: { visible: statusUi.statusErrorVisible,
              classification: statusErrorClassification(statusUi.statusErrorVisible, observedStatus),
              observedHttpStatus: observedStatus },
            statusRefreshingVisible: statusUi.statusRefreshingVisible,
          } : { readable: false, statusErrorVisible: null,
            statusError: { visible: null, classification: "UNKNOWN", observedHttpStatus: observedStatus },
            statusRefreshingVisible: null },
          newCta: { visible: newCtaVisible, enabled: newCtaEnabled,
            firstVisibleAtPageMs: newCtaPageTimes.firstVisibleAtPageMs,
            firstEnabledAtPageMs: newCtaPageTimes.firstEnabledAtPageMs,
            observedAtNodeMs: newCtaVisibleAtNodeMs },
          http,
          pageErrors: { count: events.filter(row => row.kind === "pageerror" && row.atNodeMs >= startedAtNodeMs).length,
            safeNames: events.filter(row => row.kind === "pageerror" && row.atNodeMs >= startedAtNodeMs)
              .slice(-8).map(row => row.errorName) },
        };
      };
      try {
        const response = await page.goto(PUBLIC_ORIGIN, { waitUntil: "domcontentloaded", timeout: 30_000 });
        assert.equal(response?.status(), 200, "static fulfilled Mobile root must load");
        stage = "NEW_CTA_WAIT";
        newCta = page.getByTestId(`new-workspace-${serverId}`);
        await newCta.waitFor({ state: "visible", timeout: 30_000 });
        newCtaVisibleAtNodeMs = performance.now();
        newCtaVisible = true;
        stage = "STRICT_STATUS_GATE";
        const deadline = performance.now() + 15_000;
        newCtaEnabled = await newCta.isEnabled().catch(() => false);
        newCtaPageTimes = await page.evaluate(() => {
          const state = window.__kcoderNewCatalogDomProbe;
          return state ? {
            firstVisibleAtPageMs: Number.isFinite(state.homeCtaVisibleAtPageMs) ? state.homeCtaVisibleAtPageMs : null,
            firstEnabledAtPageMs: Number.isFinite(state.homeCtaEnabledAtPageMs) ? state.homeCtaEnabledAtPageMs : null,
          } : { firstVisibleAtPageMs: null, firstEnabledAtPageMs: null };
        });
        let settled = false;
        while (performance.now() < deadline) {
          const httpResponses = events.filter(row => row.kind === "gateway-http-response");
          const latestFor = endpoint => httpResponses.filter(row => row.endpoint === endpoint).at(-1);
          const serversResponse = latestFor("/api/servers");
          const statusesResponse = latestFor("/api/servers/status");
          const statusUi = await page.evaluate(() => {
            const visible = element => {
              if (!element) return false;
              const style = getComputedStyle(element), rect = element.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&
                rect.width > 0 && rect.height > 0;
            };
            return {
              statusErrorVisible: visible(document.querySelector('[data-testid="server-status-error"]')),
              statusRefreshingVisible: visible(document.querySelector('[data-testid="server-status-refreshing"]')),
            };
          });
          const observedStatus = Number.isInteger(statusesResponse?.status) ? statusesResponse.status : null;
          const safeStatusUi = {
            statusErrorVisible: statusUi.statusErrorVisible,
            statusError: { visible: statusUi.statusErrorVisible,
              classification: statusErrorClassification(statusUi.statusErrorVisible, observedStatus),
              observedHttpStatus: observedStatus },
            statusRefreshingVisible: statusUi.statusRefreshingVisible,
          };
          if (serversResponse?.status === 200 && statusesResponse?.status === 200 &&
              !statusUi.statusErrorVisible && !statusUi.statusRefreshingVisible) {
            settled = true;
            homeBootstrap = {
              outcome: "COMPLETED",
              elapsedNodeMs: performance.now() - startedAtNodeMs,
              strictStatusGateDeadlineMs: 15_000,
              serversStatus: { servers: serversResponse.status, statuses: statusesResponse.status },
              statusUi: safeStatusUi,
              newCta: { visible: true, enabled: newCtaEnabled,
                firstVisibleAtPageMs: newCtaPageTimes.firstVisibleAtPageMs,
                firstEnabledAtPageMs: newCtaPageTimes.firstEnabledAtPageMs,
                observedAtNodeMs: newCtaVisibleAtNodeMs },
              http: homeHttpEvidenceSince(homeHttpStartOrdinal),
              pageErrors: { count: events.filter(row => row.kind === "pageerror" && row.atNodeMs >= startedAtNodeMs).length,
                safeNames: events.filter(row => row.kind === "pageerror" && row.atNodeMs >= startedAtNodeMs)
                  .slice(-8).map(row => row.errorName) },
            };
            break;
          }
          await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
        }
        if (!settled) {
          const failure = new Error("home bootstrap did not settle with successful servers/status UI before New action");
          await failureEvidence(failure);
          throw failure;
        }
      } catch (failure) {
        if (homeBootstrap?.outcome !== "ERROR") await failureEvidence(failure);
        throw failure;
      }
    },
    async clickNewAndWaitForUsableDom() {
      assert.equal(homeBootstrap?.outcome, "COMPLETED", "home servers/status preconditions must settle before New action");
      const outerStartAt = performance.now();
      actionDispatchStartNodeAtMs = performance.now();
      actionWindowStartNodeAtMs = actionDispatchStartNodeAtMs;
      await page.getByTestId(`new-workspace-${serverId}`).click();
      const clickReturnAt = performance.now();
      await page.waitForFunction(() => Boolean(window.__kcoderNewCatalogDomProbe?.clickTrusted) &&
        typeof window.__kcoderNewCatalogDomProbe?.usableAfterTwoRafAtPageMs === "number",
      undefined, { polling: "raf", timeout: 30_000 });
      const outerReadyAt = performance.now();
      const dom = await page.evaluate(() => {
        const state = window.__kcoderNewCatalogDomProbe;
        return state ? {
          ...state,
          clickToFirstUsableDomMs: state.firstUsableDomAtPageMs - state.actionClickAtPageMs,
          clickToTwoRafUsableMs: state.usableAfterTwoRafAtPageMs - state.actionClickAtPageMs,
        } : null;
      });
      const markerWaitStartedAt = performance.now();
      while (actionClickNodeAtMs === null && performance.now() - markerWaitStartedAt < 2_000)
        await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
      const actionMarkerNodeWaitMs = performance.now() - markerWaitStartedAt;
      const rpcWaitStartedAt = performance.now();
      let observedActionRpcClosed = false;
      while (performance.now() - rpcWaitStartedAt < 10_000) {
        const integrity = snapshot().rpcIntegrity;
        observedActionRpcClosed = integrity.actionNonInitializeCatalogRequestCount > 0 &&
          integrity.unansweredActionTargetRequestCount === 0 &&
          integrity.actionNonInitializeCatalogMatchedResponseCount === integrity.actionNonInitializeCatalogRequestCount;
        if (observedActionRpcClosed) break;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      }
      const rpcClosureWaitMs = performance.now() - rpcWaitStartedAt;
      const network = snapshot();
      const domUsable = dom?.clickTrusted && dom?.clickToTwoRafUsableMs >= 0;
      const unexpectedRpcTraffic = network.rpcIntegrity.unexpectedRequestCount > 0 ||
        network.rpcIntegrity.mutatingRequestCount > 0 || network.rpcIntegrity.unexpectedNotificationCount > 0 ||
        network.rpcIntegrity.foreignNotificationCount > 0;
      const completeRpcAttribution = hasCompleteRpcAttribution({
        actionClickReceived: actionClickNodeAtMs !== null,
        observedActionRpcClosed,
        actionNonInitializeCatalogRequestCount: network.rpcIntegrity.actionNonInitializeCatalogRequestCount,
        actionNonInitializeCatalogMatchedResponseCount: network.rpcIntegrity.actionNonInitializeCatalogMatchedResponseCount,
        boundaryUnknownNonHandshakeRpcRequestCount: network.rpcIntegrity.boundaryUnknownNonHandshakeRpcRequestCount,
        unansweredActionTargetRequestCount: network.rpcIntegrity.unansweredActionTargetRequestCount,
        actionTargetResponseErrors: network.rpcIntegrity.actionTargetResponseErrors,
        unexpectedRpcTraffic,
      });
      const rpcAttributionOutcome = network.rpcIntegrity.boundaryUnknownNonHandshakeRpcRequestCount > 0
        ? "BOUNDARY_UNKNOWN" : unexpectedRpcTraffic ? "UNEXPECTED_RPC_TRAFFIC"
          : network.rpcIntegrity.actionNonInitializeCatalogRequestCount === 0
            ? "NO_ACTION_CATALOG_RPC_UNKNOWN" : network.rpcIntegrity.unansweredActionTargetRequestCount > 0
              ? "ACTION_RPC_INCOMPLETE" : network.rpcIntegrity.actionTargetResponseErrors > 0
                ? "ACTION_RPC_ERROR" : completeRpcAttribution ? "COMPLETE" : "UNKNOWN";
      const nonProtocolIntegrityFailure = Object.entries(network.failClosedCounts).some(([name, count]) =>
        count > 0 && !["mutatingRequestCount", "unexpectedRequestCount", "unexpectedNotificationCount", "foreignNotificationCount"].includes(name));
      const outcome = !domUsable || network.actionPageErrorCount > 0 || nonProtocolIntegrityFailure
        ? "ERROR" : unexpectedRpcTraffic ? "UNKNOWN" : completeRpcAttribution ? "COMPLETED" : "UNKNOWN";
      return {
        outcome,
        domOutcome: domUsable ? "COMPLETED" : "ERROR",
        rpcAttributionOutcome,
        dom,
        network,
        homeBootstrap,
        correlation: { completeObservedActionRpcResponses: completeRpcAttribution,
          minimumMatchedNonInitializeCatalogResponses: 1,
          trackedActionCatalogMethods: [...NEW_CATALOG_METHODS],
          allowedReadOnlyNotifications: { "client-to-server": ["initialized"], "server-to-client": ["thread/goal/updated"] },
          forbiddenTraffic: "malformed or unmatched RPC frames, observed mutations, unrecognized requests, unexpected notifications, and non-handshake boundary requests block COMPLETED; counts are separated by setup/action/boundary/foreign/unexpected",
          note: "only route-owned responses matched by routeSocketId, ID fingerprint, direction and request sequence count; client-to-server initialize is a handshake in every observed phase, keeps its true phase and target=false, and never satisfies action evidence; a boundary initialize handshake is counted but does not alone block attribution; other requests between dispatch and click-marker receipt remain boundary-unknown with their responses; absent action calls are UNKNOWN" },
        timing: { clock: "browser performance.now for click/DOM; Node performance.now for locator wait and network callbacks",
          clickToDomNodeWaitMs: outerReadyAt - outerStartAt,
          clickActionAwaitMs: clickReturnAt - outerStartAt,
          actionMarkerNodeWaitMs,
          actionDispatchToMarkerReceiptNodeMs: network.actionDispatchToMarkerReceiptNodeMs,
          rpcClosureWaitMs,
          diagnosticPageObserverEnabled: true,
          staticInitialLoad: "route.fulfilled from frozen bundle; not a public static-download measurement" },
      };
    },
    homeBootstrapEvidence() {
      return homeBootstrap ? JSON.parse(JSON.stringify(homeBootstrap)) : null;
    },
    snapshot,
    async close() { await browserContext.close(); },
  };
}

function observeFrame(kind, payload, routeSocketId, routeOwned, pending, rpcState,
  getActionDispatchStartNodeAtMs, getActionClickNodeAtMs, record) {
  const direction = kind === "request" ? "client-to-server" : "server-to-client";
  const atNodeMs = performance.now();
  const phase = phaseForRpc(routeOwned, atNodeMs, getActionDispatchStartNodeAtMs(), getActionClickNodeAtMs());
  const parsed = parseObservedJsonRpcFrame(direction, payload);
  const recordMalformed = reason => {
    rpcState.malformedRpcFrameCount = Math.min(MAX_EVENTS, rpcState.malformedRpcFrameCount + 1);
    record({ kind: "rpc-malformed-frame", routeSocketId, routeOwned, direction, atNodeMs, phase, reason });
  };
  if (!parsed.ok) { recordMalformed(parsed.reason); return; }
  const { frame } = parsed;
  if (parsed.envelopeKind === "notification") {
    const allowedDirection = READ_ONLY_NOTIFICATION_DIRECTIONS.get(frame.method);
    const allowed = routeOwned && allowedDirection === direction;
    const classification = allowed ? "known-read-only-notification"
      : routeOwned ? "unexpected-notification" : "foreign-notification";
    if (phase === "boundary-unknown") rpcState.boundaryUnknownNotificationCount += 1;
    if (allowed) rpcState.allowedNotificationCount += 1;
    else if (routeOwned) rpcState.unexpectedNotificationCount += 1;
    else rpcState.foreignNotificationCount += 1;
    record({ kind: "rpc-notification", routeSocketId, routeOwned, direction, atNodeMs,
      method: frame.method, phase, classification, allowlistedReadOnly: allowed });
    return;
  }
  if (parsed.envelopeKind === "request") {
    const method = frame.method;
    const { target, classification } = classifyObservedRpcRequest({ direction, routeOwned, phase, method });
    if (classification === "mutating-request") rpcState.mutatingRequestCount += 1;
    else if (classification === "unexpected-request") rpcState.unexpectedRequestCount += 1;
    if (phase === "boundary-unknown") {
      rpcState.boundaryUnknownRequestCount += 1;
      if (target) rpcState.boundaryUnknownTargetRequestCount += 1;
    }
    const key = JSON.stringify(frame.id);
    const idFingerprint = createHash("sha256").update(key).digest("hex").slice(0, 16);
    if (pending.has(key)) {
      rpcState.duplicatePendingCount += 1;
      record({ kind: "rpc-duplicate-request", routeSocketId, routeOwned, direction, atNodeMs,
        method, idFingerprint, target, phase, classification });
      return;
    }
    if (rpcState.pendingCount >= MAX_PENDING_RPCS) {
      rpcState.pendingOverflowCount += 1;
      record({ kind: "rpc-pending-overflow", routeSocketId, routeOwned, direction, atNodeMs,
        method, idFingerprint, target, phase, classification });
      return;
    }
    const request = { method, idFingerprint, target, direction, classification,
      phase, requestSequence: ++rpcState.requestOrdinal, requestAtNodeMs: atNodeMs };
    pending.set(key, request);
    rpcState.pendingCount += 1;
    record({ kind: "rpc-request", routeSocketId, routeOwned, direction, envelopeKind: "request",
      atNodeMs, method: request.method, idFingerprint, target: request.target, phase,
      classification, requestSequence: request.requestSequence });
    return;
  }
  const key = JSON.stringify(frame.id);
  const idFingerprint = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const request = pending.get(key);
  if (!request) {
    rpcState.unmatchedResponseCount += 1;
    record({ kind: "rpc-unmatched-response", routeSocketId, routeOwned, direction,
      envelopeKind: parsed.envelopeKind, responseShape: parsed.responseShape,
      atNodeMs, idFingerprint });
    return;
  }
  pending.delete(key);
  rpcState.pendingCount -= 1;
  record({ kind: "rpc-response", routeSocketId, routeOwned, direction,
    envelopeKind: parsed.envelopeKind, responseShape: parsed.responseShape,
    requestDirection: request.direction, atNodeMs, method: request.method,
    idFingerprint: request.idFingerprint, target: request.target, phase: request.phase,
    classification: request.classification, requestSequence: request.requestSequence,
    requestAtNodeMs: request.requestAtNodeMs, elapsedNodeMs: atNodeMs - request.requestAtNodeMs,
    error: parsed.responseShape === "error" });
}

function phaseForRpc(routeOwned, atNodeMs, actionDispatchStartAtNodeMs, actionClickAtNodeMs) {
  if (!routeOwned) return "foreign";
  if (actionDispatchStartAtNodeMs === null || atNodeMs < actionDispatchStartAtNodeMs) return "setup";
  if (actionClickAtNodeMs === null || atNodeMs < actionClickAtNodeMs) return "boundary-unknown";
  return "action";
}

function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}
