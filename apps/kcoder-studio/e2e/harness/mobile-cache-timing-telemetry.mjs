import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";

const HTTP_RECORD_LIMIT = 256;
const RPC_RECORD_LIMIT = 256;
const PHASE_BINDING_PREFIX = "__kcoderCacheTimingReportPhaseV1_";
const PHASE_NAMES = new Set([
  "navigation-start",
  "cache-view-visible",
  "cache-readable",
  "cache-status-visible",
  "tail-marker-visible",
  "authority-history-visible",
  "composer-ready",
]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const RPC_OUTCOMES = new Set(["success", "error", "failed", "cancelled", "unknown"]);
const COLLECTOR_STATE = new WeakMap();
const PAGE_COLLECTORS = new WeakMap();
let nextBindingId = 0;

/**
 * Install one owned cache-timing observer and passive page-traffic collector.
 * The caller owns the Page and its navigation, routes, RPC bridge, and cleanup.
 */
export async function installCacheTimingTelemetry(page, { tailMarker, expectedAssistantMessageId } = {}) {
  if (!page || typeof page.on !== "function" || typeof page.exposeBinding !== "function" ||
      typeof page.addInitScript !== "function" || typeof page.evaluate !== "function") {
    throw new TypeError("Cache timing telemetry requires a Playwright-like Page");
  }
  if (typeof tailMarker !== "string" || tailMarker.length === 0) {
    throw new TypeError("Cache timing telemetry requires a non-empty tail marker");
  }
  if (typeof expectedAssistantMessageId !== "string" || expectedAssistantMessageId.length === 0) {
    throw new TypeError("Cache timing telemetry requires an expected assistant message ID");
  }
  if (PAGE_COLLECTORS.has(page)) throw new Error("Cache timing telemetry is already installed on this Page");

  const traffic = createTrafficHandle(page);
  const state = COLLECTOR_STATE.get(traffic);
  state.bindingName = `${PHASE_BINDING_PREFIX}${++nextBindingId}`;
  const listeners = createPageListeners(traffic, state);
  state.listeners = listeners;
  PAGE_COLLECTORS.set(page, traffic);

  try {
    for (const [event, listener] of listeners.page) page.on(event, listener);
    state.bindingDisposable = await page.exposeBinding(state.bindingName, (_source, phase, pageAtMs) => {
      if (state.disposed) return false;
      recordPhase(traffic, phase, pageAtMs, performance.now());
      return true;
    });
    if (!state.bindingDisposable || typeof state.bindingDisposable.dispose !== "function") {
      throw new TypeError("Playwright exposeBinding did not return a Disposable");
    }
    state.initScriptDisposable = await page.addInitScript(installCacheTimingObserverInPage,
      { tailMarker, expectedAssistantMessageId, bindingName: state.bindingName });
    if (!state.initScriptDisposable || typeof state.initScriptDisposable.dispose !== "function") {
      throw new TypeError("Playwright addInitScript did not return a Disposable");
    }
    page.__cacheTimingTraffic = traffic;
  } catch (error) {
    try { await disposeCacheTimingTelemetry(traffic); } catch (cleanupError) {
      if (error && typeof error === "object") error.cleanupError = cleanupError;
    }
    throw error;
  }
  return traffic;
}

/**
 * Browser-serializable initializer. Keep all browser work in this function so
 * Playwright can serialize it without copying page lifecycle or suite logic.
 */
export function installCacheTimingObserverInPage({ tailMarker, expectedAssistantMessageId, bindingName }) {
  if (typeof window[bindingName] !== "function") return;
  const navigation = performance.getEntriesByType("navigation")[0];
  const state = {
    navigationStartAtMs: navigation?.startTime ?? 0,
    cacheViewVisibleAtMs: null,
    cacheReadableAtMs: null,
    cacheStatusVisibleAtMs: null,
    tailMarkerVisibleAtMs: null,
    cacheReadOnlyAtMs: null,
    cacheReadOnlyObserved: null,
    authorityHistoryVisibleAtMs: null,
    composerReadyAtMs: null,
    observationFrames: 0,
    observationStopReason: null,
    rafGapSampleCount: 0,
    rafMaxGapMs: null,
    longTaskCount: 0,
    longTaskMaxMs: null,
    longTaskSumMs: 0,
    longTaskSupported: false,
    eventTimingSupported: false,
    inputSampleCount: 0,
    inputMaxProcessingDelayMs: null,
    inputSampleStatus: "not_sampled",
  };
  Object.defineProperty(window, "__sessionCacheTiming", { value: state });
  Object.defineProperty(state, "__telemetryBindingName", { value: bindingName });
  const intersections = (rect, bounds) => rect.bottom > bounds.top && rect.top < bounds.bottom &&
    rect.right > bounds.left && rect.left < bounds.right;
  const windowBounds = () => ({ top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight });
  const visible = element => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) > 0 && intersections(rect, windowBounds());
  };
  const tailMarkerIntersectsView = () => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!list || !visible(list)) return false;
    const expectedDomId = `message-${encodeURIComponent(expectedAssistantMessageId)}`;
    const matchingMessages = [];
    for (const element of document.querySelectorAll("[id]")) {
      if (element.id === expectedDomId) matchingMessages.push(element);
    }
    if (matchingMessages.length !== 1 || !list.contains(matchingMessages[0])) return false;
    const assistantRows = matchingMessages[0].querySelectorAll('[data-testid="message-assistant"]');
    if (assistantRows.length !== 1) return false;
    const listRect = list.getBoundingClientRect();
    let occurrenceCount = 0;
    let intersectsView = false;
    const segments = [];
    let fullText = "";
    const walker = document.createTreeWalker(assistantRows[0], NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue ?? "";
      segments.push({ node, start: fullText.length, end: fullText.length + text.length });
      fullText += text;
      node = walker.nextNode();
    }
    for (let offset = fullText.indexOf(tailMarker); offset >= 0; offset = fullText.indexOf(tailMarker, offset + 1)) {
      occurrenceCount += 1;
      if (occurrenceCount > 1) return false;
      const locate = position => segments.find(segment => position >= segment.start && position < segment.end);
      const start = locate(offset);
      const end = locate(offset + tailMarker.length - 1);
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, offset - start.start);
      range.setEnd(end.node, offset + tailMarker.length - end.start);
      const style = start.node.parentElement ? getComputedStyle(start.node.parentElement) : null;
      if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) continue;
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0 && intersections(rect, windowBounds()) && intersections(rect, listRect)) {
          intersectsView = true;
        }
      }
    }
    return occurrenceCount === 1 && intersectsView;
  };
  const editable = element => Boolean(element && visible(element) && !element.disabled && !element.readOnly &&
    (element.isContentEditable || "value" in element));
  const reportPhase = (phase, pageAtMs) => {
    try { Promise.resolve(window[bindingName](phase, pageAtMs)).catch(() => {}); } catch {}
  };
  const phase = (name, pageAtMs) => {
    reportPhase(name, pageAtMs);
  };
  phase("navigation-start", state.navigationStartAtMs);

  const deadlineAtMs = performance.now() + 30_000;
  const maximumObservationFrames = 5000;
  let mutationObserver;
  let longTaskObserver;
  let eventTimingObserver;
  let animationFrame = 0;
  let previousFrameAtMs = null;
  let stopped = false;
  const stopSampling = reason => {
    if (stopped) return;
    stopped = true;
    state.observationStopReason = reason;
    mutationObserver?.disconnect();
    longTaskObserver?.disconnect();
    eventTimingObserver?.disconnect();
    if (animationFrame) cancelAnimationFrame(animationFrame);
  };
  Object.defineProperty(state, "stop", { value: stopSampling, enumerable: false });

  if (typeof PerformanceObserver === "function") {
    try {
      longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!Number.isFinite(entry.duration) || entry.duration < 0) continue;
          state.longTaskCount += 1;
          state.longTaskMaxMs = state.longTaskMaxMs === null ? entry.duration : Math.max(state.longTaskMaxMs, entry.duration);
          state.longTaskSumMs += entry.duration;
        }
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
      state.longTaskSupported = true;
    } catch { longTaskObserver = null; }
    const supported = Array.isArray(PerformanceObserver.supportedEntryTypes)
      ? PerformanceObserver.supportedEntryTypes.includes("event")
      : true;
    if (supported) {
      try {
        eventTimingObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (!Number.isSafeInteger(entry.interactionId) || entry.interactionId <= 0 ||
                !Number.isFinite(entry.startTime) || !Number.isFinite(entry.processingStart)) continue;
            const delay = Math.max(0, entry.processingStart - entry.startTime);
            state.inputSampleCount += 1;
            state.inputMaxProcessingDelayMs = state.inputMaxProcessingDelayMs === null
              ? delay : Math.max(state.inputMaxProcessingDelayMs, delay);
            state.inputSampleStatus = "sampled";
          }
        });
        eventTimingObserver.observe({ type: "event", buffered: true, durationThreshold: 16 });
        state.eventTimingSupported = true;
      } catch { eventTimingObserver = null; }
    }
  }

  const inspect = () => {
    if (stopped) return;
    const cacheView = document.querySelector('[data-testid="session-cache-view"]');
    const cacheStatus = document.querySelector('[data-testid="session-cache-status"]');
    const composer = document.querySelector('[data-testid="message-input"]');
    const tailMarkerVisible = tailMarkerIntersectsView();
    const now = performance.now();
    if (state.cacheViewVisibleAtMs === null && visible(cacheView)) {
      state.cacheViewVisibleAtMs = now;
      phase("cache-view-visible", now);
    }
    if (state.cacheStatusVisibleAtMs === null && visible(cacheStatus)) {
      state.cacheStatusVisibleAtMs = now;
      phase("cache-status-visible", now);
    }
    if (state.tailMarkerVisibleAtMs === null && tailMarkerVisible) {
      state.tailMarkerVisibleAtMs = now;
      phase("tail-marker-visible", now);
    }
    if (state.cacheReadableAtMs === null && visible(cacheView) && tailMarkerVisible) {
      state.cacheReadableAtMs = now;
      state.cacheReadOnlyAtMs = now;
      state.cacheReadOnlyObserved = !editable(composer);
      phase("cache-readable", now);
    }
    if (!cacheView && tailMarkerVisible && state.authorityHistoryVisibleAtMs === null) {
      state.authorityHistoryVisibleAtMs = now;
      phase("authority-history-visible", now);
    }
    if (state.authorityHistoryVisibleAtMs !== null && editable(composer) && state.composerReadyAtMs === null) {
      state.composerReadyAtMs = now;
      phase("composer-ready", now);
    }
    if (state.authorityHistoryVisibleAtMs !== null && state.composerReadyAtMs !== null) stopSampling("complete");
  };
  mutationObserver = new MutationObserver(inspect);
  mutationObserver.observe(document, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["disabled", "readonly", "aria-disabled", "contenteditable", "class", "style", "data-testid", "id"] });
  const sampleFrame = () => {
    if (stopped) return;
    const now = performance.now();
    if (previousFrameAtMs !== null) {
      const gap = Math.max(0, now - previousFrameAtMs);
      state.rafGapSampleCount += 1;
      state.rafMaxGapMs = state.rafMaxGapMs === null ? gap : Math.max(state.rafMaxGapMs, gap);
    }
    previousFrameAtMs = now;
    state.observationFrames += 1;
    if (now >= deadlineAtMs || state.observationFrames >= maximumObservationFrames) {
      stopSampling(now >= deadlineAtMs ? "deadline" : "frame-cap");
      return;
    }
    inspect();
    if (!stopped) animationFrame = requestAnimationFrame(sampleFrame);
  };
  inspect();
  if (!stopped) animationFrame = requestAnimationFrame(sampleFrame);
}

/** Record sanitized HTTP request totals plus bounded terminal records. */
export function snapshotCacheTimingTraffic(traffic) {
  const state = requireCollectorState(traffic);
  const phaseMarks = state.phaseMarks.map(mark => ({ ...mark })).sort((a, b) => a.atNodeMs - b.atNodeMs);
  const requestRecords = state.httpTerminalRecords.map(record => ({
    ...record,
    phaseAtStart: phaseAt(phaseMarks, record.startedAtNodeMs),
    durationMs: Math.max(0, record.endedAtNodeMs - record.startedAtNodeMs),
  }));
  const rpcRequestRecords = state.rpcRecords.map(record => ({
    ...record,
    phaseAtStart: phaseAt(phaseMarks, record.requestAtNodeMs),
    durationMs: record.responseAtNodeMs === null ? null : Math.max(0, record.responseAtNodeMs - record.requestAtNodeMs),
  }));
  const httpComplete = state.httpRequestRecordsDroppedCount === 0 && state.httpTrackedPendingCount === 0 && state.httpActiveCount === 0;
  const rpcComplete = state.rpcRequestRecordsDroppedCount === 0 && state.rpcPendingBySequence.size === 0 &&
    state.rpcUnpairedResponseCount === 0;
  return {
    httpRequestCount: traffic.httpRequestCount,
    httpRequestBodyBytes: traffic.httpRequestBodyBytes,
    httpRequestCountsByMethod: sortCountRecord(traffic.httpRequestCountsByMethod),
    httpResponseCount: traffic.httpResponseCount,
    httpResponseCountsByMethodStatus: sortCountRecord(traffic.httpResponseCountsByMethodStatus),
    httpResponseContentLengthBytes: traffic.httpResponseContentLengthBytes,
    httpResponseContentLengthKnownCount: traffic.httpResponseContentLengthKnownCount,
    websocketConnectionCount: traffic.websocketConnectionCount,
    websocketSentFrameCount: traffic.websocketSentFrameCount,
    websocketSentFrameBytes: traffic.websocketSentFrameBytes,
    websocketReceivedFrameCount: traffic.websocketReceivedFrameCount,
    websocketReceivedFrameBytes: traffic.websocketReceivedFrameBytes,
    httpRequestRecords: requestRecords,
    httpRequestRecordsDroppedCount: state.httpRequestRecordsDroppedCount,
    httpRequestRecordsPendingCount: state.httpTrackedPendingCount,
    httpRequestRecordsComplete: httpComplete,
    httpMaxInFlight: state.httpMaxInFlight,
    httpMaxInFlightByPhaseAtStart: concurrencyByStartPhase(requestRecords, "startedAtNodeMs", "endedAtNodeMs", httpComplete),
    rpcRequestRecords: rpcRequestRecords.map(record => ({ ...record })),
    rpcRequestRecordsDroppedCount: state.rpcRequestRecordsDroppedCount,
    rpcRequestRecordsComplete: rpcComplete,
    rpcUnpairedResponseCount: state.rpcUnpairedResponseCount,
    rpcMaxInFlightByPhaseAtStart: concurrencyByStartPhase(rpcRequestRecords.filter(row => row.responseAtNodeMs !== null),
      "requestAtNodeMs", "responseAtNodeMs", rpcComplete),
    phaseMarks,
    httpResponseContentLengthBoundary: "sum of known Content-Length header bytes only; unknown response lengths are excluded; not wire bytes",
    httpRequestBodyBytesBoundary: "request body payload byte lengths only; request body content is never recorded",
    websocketFrameBytesBoundary: "Playwright-observed WebSocket payload byte lengths; frame content is never recorded",
    rpcFrameBytesBoundary: "caller-supplied RPC frame payload byte lengths; frame content and raw RPC ids are never recorded",
    requestRecordBoundary: "bounded route class, method, sequence, phase, Node timestamps, outcome/status, and byte counts; no raw URL, query, headers, Cookie, body, or response content",
    phaseConcurrencyBoundary: "interval overlap grouped by phaseAtStart; descriptive concurrency only, not a causal critical path",
  };
}

/** Decide whether a functionally successful sample has complete traffic evidence for performance statistics. */
export function assessCacheTimingSamplePerformanceValidity({ functionalStatus, traffic } = {}) {
  const invalidReasons = [];
  if (functionalStatus !== "PASS") invalidReasons.push("functionalStatus");
  if (traffic?.httpRequestRecordsComplete !== true) invalidReasons.push("httpRequestRecordsComplete");
  if (traffic?.rpcRequestRecordsComplete !== true) invalidReasons.push("rpcRequestRecordsComplete");
  return { validForPerformance: invalidReasons.length === 0, invalidReasons };
}

/**
 * Begin one bridge-owned RPC timing row. The caller pairs the returned sequence
 * with its private RPC id map; raw ids never enter this collector or snapshots.
 */
export function recordCacheTimingRpcRequest(traffic, { routeClass, method, nodeAtMs, payloadBytes } = {}) {
  const state = requireCollectorState(traffic);
  const sequence = ++state.rpcNextSequence;
  const requestAtNodeMs = finiteTimestamp(nodeAtMs) ?? performance.now();
  if (state.rpcRecords.length >= RPC_RECORD_LIMIT) {
    state.rpcRequestRecordsDroppedCount += 1;
    return null;
  }
  const record = {
    sequence,
    routeClass: safeRouteClass(routeClass),
    method: safeRpcMethod(method),
    requestAtNodeMs,
    responseAtNodeMs: null,
    outcome: "pending",
    requestPayloadBytes: byteCountOrNull(payloadBytes),
    responsePayloadBytes: null,
  };
  state.rpcRecords.push(record);
  state.rpcPendingBySequence.set(sequence, record);
  return sequence;
}

/** Complete a previously recorded RPC row by its telemetry sequence. */
export function recordCacheTimingRpcResponse(traffic, { sequence, nodeAtMs, outcome, payloadBytes } = {}) {
  const state = requireCollectorState(traffic);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
  const record = state.rpcPendingBySequence.get(sequence);
  if (!record) {
    state.rpcUnpairedResponseCount += 1;
    return false;
  }
  record.responseAtNodeMs = finiteTimestamp(nodeAtMs) ?? performance.now();
  record.outcome = RPC_OUTCOMES.has(outcome) && outcome !== "unknown" ? outcome : "unknown";
  record.responsePayloadBytes = byteCountOrNull(payloadBytes);
  state.rpcPendingBySequence.delete(sequence);
  return true;
}

async function disposeCacheTimingTelemetry(traffic) {
  const state = requireCollectorState(traffic);
  if (state.disposalComplete) return;
  state.disposed = true;
  const cleanupErrors = [];
  const { page, listeners } = state;
  const off = typeof page.off === "function" ? page.off.bind(page)
    : typeof page.removeListener === "function" ? page.removeListener.bind(page) : null;
  if (off) {
    for (const [event, listener] of listeners.page) off(event, listener);
    for (const subscription of state.socketListeners) {
      removeSocketListeners(subscription);
    }
  }
  try {
    if (state.initScriptDisposable) {
      await state.initScriptDisposable.dispose();
      state.initScriptDisposable = null;
    }
  } catch (error) { cleanupErrors.push(error); }
  try {
    await page.evaluate(bindingName => {
      const state = window.__sessionCacheTiming;
      if (state?.__telemetryBindingName === bindingName) state.stop?.("disposed");
      try { delete window[bindingName]; } catch {}
    }, state.bindingName);
  } catch (error) {
    if (typeof page.isClosed !== "function" || !page.isClosed()) cleanupErrors.push(error);
  }
  try {
    if (state.bindingDisposable) {
      await state.bindingDisposable.dispose();
      state.bindingDisposable = null;
    }
  } catch (error) { cleanupErrors.push(error); }
  if (page.__cacheTimingTraffic === traffic) {
    try { delete page.__cacheTimingTraffic; } catch {}
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Failed to dispose cache timing Playwright resources");
  }
  state.disposalComplete = true;
  PAGE_COLLECTORS.delete(page);
}

function createTrafficHandle(page) {
  const traffic = {
    httpRequestCount: 0,
    httpRequestBodyBytes: 0,
    httpRequestCountsByMethod: {},
    httpResponseCount: 0,
    httpResponseCountsByMethodStatus: {},
    httpResponseContentLengthBytes: 0,
    httpResponseContentLengthKnownCount: 0,
    websocketConnectionCount: 0,
    websocketSentFrameCount: 0,
    websocketSentFrameBytes: 0,
    websocketReceivedFrameCount: 0,
    websocketReceivedFrameBytes: 0,
  };
  const state = {
    page,
    disposed: false,
    disposalComplete: false,
    bindingDisposable: null,
    initScriptDisposable: null,
    listeners: null,
    socketListeners: new Set(),
    phaseMarks: [],
    phaseNames: new Set(),
    httpSequence: 0,
    httpByRequest: new WeakMap(),
    httpTerminalRecords: [],
    httpRequestRecordsDroppedCount: 0,
    httpTrackedPendingCount: 0,
    httpActiveCount: 0,
    httpMaxInFlight: 0,
    rpcNextSequence: 0,
    rpcRecords: [],
    rpcPendingBySequence: new Map(),
    rpcRequestRecordsDroppedCount: 0,
    rpcUnpairedResponseCount: 0,
  };
  COLLECTOR_STATE.set(traffic, state);
  Object.defineProperties(traffic, {
    markPhase: { enumerable: false, value: name => recordPhase(traffic, name, null, performance.now()) },
    snapshot: { enumerable: false, value: () => snapshotCacheTimingTraffic(traffic) },
    dispose: { enumerable: false, value: () => disposeCacheTimingTelemetry(traffic) },
  });
  return traffic;
}

function createPageListeners(traffic, state) {
  const requestListener = request => {
    if (state.disposed) return;
    traffic.httpRequestCount += 1;
    const method = safeMethod(request.method?.());
    const payloadBytes = requestPayloadByteLength(request);
    traffic.httpRequestBodyBytes += payloadBytes;
    incrementCount(traffic.httpRequestCountsByMethod, method);
    const sequence = ++state.httpSequence;
    let row = null;
    if (state.httpTerminalRecords.length + state.httpTrackedPendingCount < HTTP_RECORD_LIMIT) {
      row = {
        sequence,
        routeClass: classifyRoute(request),
        method,
        startedAtNodeMs: performance.now(),
        responseAtNodeMs: null,
        endedAtNodeMs: null,
        statusCode: null,
        outcome: "pending",
        requestPayloadBytes: payloadBytes,
        responseContentLengthBytes: null,
      };
      state.httpTrackedPendingCount += 1;
    } else {
      state.httpRequestRecordsDroppedCount += 1;
    }
    state.httpByRequest.set(request, row);
    state.httpActiveCount += 1;
    state.httpMaxInFlight = Math.max(state.httpMaxInFlight, state.httpActiveCount);
  };
  const responseListener = response => {
    if (state.disposed) return;
    const request = response.request?.();
    const method = safeMethod(request?.method?.());
    const status = response.status?.();
    if (Number.isSafeInteger(status)) incrementCount(traffic.httpResponseCountsByMethodStatus, `${method} ${status}`);
    traffic.httpResponseCount += 1;
    let contentLength = null;
    try {
      const headerValue = response.headers?.()["content-length"];
      const parsed = Number(headerValue);
      if (Number.isSafeInteger(parsed) && parsed >= 0) contentLength = parsed;
    } catch {}
    if (contentLength !== null) {
      traffic.httpResponseContentLengthBytes += contentLength;
      traffic.httpResponseContentLengthKnownCount += 1;
    }
    if (request && state.httpByRequest.has(request)) {
      const row = state.httpByRequest.get(request);
      if (row) {
        row.responseAtNodeMs = performance.now();
        row.statusCode = Number.isSafeInteger(status) ? status : null;
        row.responseContentLengthBytes = contentLength;
      }
    }
  };
  const terminal = (request, outcome) => {
    if (state.disposed || !state.httpByRequest.has(request)) return;
    const row = state.httpByRequest.get(request);
    state.httpByRequest.delete(request);
    state.httpActiveCount = Math.max(0, state.httpActiveCount - 1);
    if (!row) return;
    row.endedAtNodeMs = performance.now();
    row.outcome = outcome;
    state.httpTrackedPendingCount = Math.max(0, state.httpTrackedPendingCount - 1);
    state.httpTerminalRecords.push(row);
  };
  const requestFinishedListener = request => terminal(request, "finished");
  const requestFailedListener = request => terminal(request, "failed");
  const websocketListener = socket => {
    if (state.disposed) return;
    traffic.websocketConnectionCount += 1;
    const sent = frame => {
      traffic.websocketSentFrameCount += 1;
      traffic.websocketSentFrameBytes += byteLength(frame?.payload) ?? 0;
    };
    const received = frame => {
      traffic.websocketReceivedFrameCount += 1;
      traffic.websocketReceivedFrameBytes += byteLength(frame?.payload) ?? 0;
    };
    let subscription;
    const closed = () => {
      if (!subscription) return;
      removeSocketListeners(subscription);
      state.socketListeners.delete(subscription);
    };
    subscription = { socket, sent, received, closed };
    socket.on("framesent", sent);
    socket.on("framereceived", received);
    socket.on("close", closed);
    state.socketListeners.add(subscription);
  };
  return {
    page: [
      ["request", requestListener],
      ["response", responseListener],
      ["requestfinished", requestFinishedListener],
      ["requestfailed", requestFailedListener],
      ["websocket", websocketListener],
    ],
  };
}

function removeSocketListeners({ socket, sent, received, closed }) {
  const off = typeof socket.off === "function" ? socket.off.bind(socket)
    : typeof socket.removeListener === "function" ? socket.removeListener.bind(socket) : null;
  if (!off) return;
  off("framesent", sent);
  off("framereceived", received);
  off("close", closed);
}

function recordPhase(traffic, name, pageAtMs, atNodeMs) {
  const state = requireCollectorState(traffic);
  if (state.disposed || !PHASE_NAMES.has(name) || state.phaseNames.has(name)) return false;
  const nodeTime = finiteTimestamp(atNodeMs);
  if (nodeTime === null) return false;
  const pageTime = finiteTimestamp(pageAtMs);
  state.phaseNames.add(name);
  state.phaseMarks.push({ phase: name, atNodeMs: nodeTime, pageAtMs: pageTime });
  return true;
}

function classifyRoute(request) {
  let pathname = "";
  try { pathname = new URL(request.url()).pathname.replace(/\/+$/, "") || "/"; } catch {}
  if (pathname.endsWith("/rpc")) return "rpc";
  if (pathname.endsWith("/api/mobile/session/refresh")) return "api-mobile-session-refresh";
  if (pathname.endsWith("/api/mobile/session")) return "api-mobile-session";
  if (pathname.endsWith("/api/servers/status")) return "api-servers-status";
  if (pathname.endsWith("/api/servers")) return "api-servers";
  let resourceType = "other";
  try { resourceType = request.resourceType?.() ?? "other"; } catch {}
  if (resourceType === "document") return "document";
  if (["script", "stylesheet", "image", "font", "media"].includes(resourceType)) return "static-asset";
  return "other";
}

function phaseAt(marks, nodeAtMs) {
  let selected = "before-first-phase";
  for (const mark of marks) {
    if (mark.atNodeMs > nodeAtMs) break;
    selected = mark.phase;
  }
  return selected;
}

function concurrencyByStartPhase(records, startField, endField, complete) {
  const groups = new Map();
  for (const record of records) {
    const start = record[startField];
    const end = record[endField];
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const phase = record.phaseAtStart ?? "before-first-phase";
    if (!groups.has(phase)) groups.set(phase, []);
    groups.get(phase).push({ start, end });
  }
  const result = {};
  for (const [phase, intervals] of groups) {
    const events = intervals.flatMap(interval => [
      { at: interval.start, delta: 1 },
      { at: interval.end, delta: -1 },
    ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
    let active = 0;
    let maximum = 0;
    for (const event of events) {
      active += event.delta;
      maximum = Math.max(maximum, active);
    }
    result[phase] = maximum;
  }
  return { values: result, complete };
}

function requireCollectorState(traffic) {
  const state = COLLECTOR_STATE.get(traffic);
  if (!state) throw new TypeError("Expected a cache timing telemetry handle");
  return state;
}

function safeMethod(value) {
  return typeof value === "string" && HTTP_METHODS.has(value.toUpperCase()) ? value.toUpperCase() : "OTHER";
}

function safeRpcMethod(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._/-]{0,63}$/.test(value) ? value : "other";
}

function requestPayloadByteLength(request) {
  try { return byteLength(request.postDataBuffer?.()) ?? 0; } catch { return 0; }
}

function safeRouteClass(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,47}$/.test(value) ? value : "other";
}

function byteCountOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function byteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return null;
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortCountRecord(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
