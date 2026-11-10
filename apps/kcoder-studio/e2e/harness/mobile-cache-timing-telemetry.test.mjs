import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import vm from "node:vm";

import {
  assessCacheTimingSamplePerformanceValidity,
  installCacheTimingObserverInPage,
  installCacheTimingTelemetry,
  recordCacheTimingRpcRequest,
  recordCacheTimingRpcResponse,
  snapshotCacheTimingTraffic,
} from "./mobile-cache-timing-telemetry.mjs";

const TAIL = "CACHE-TAIL-MARKER";
const ASSISTANT_MESSAGE_ID = "assistant/with space";
const ASSISTANT_DOM_ID = `message-${encodeURIComponent(ASSISTANT_MESSAGE_ID)}`;

class FakePage extends EventEmitter {
  bindings = new Map();
  initScript = null;
  initScripts = [];
  browserWindow = null;
  closed = false;
  failAddInitScript = false;

  async exposeBinding(name, callback) {
    this.bindings.set(name, callback);
    return {
      dispose: async () => {
        if (this.bindings.get(name) === callback) this.bindings.delete(name);
      },
    };
  }

  async addInitScript(callback, argument) {
    if (this.failAddInitScript) throw new Error("simulated addInitScript failure");
    this.initScript = { callback, argument };
    this.initScripts.push(this.initScript);
    const script = this.initScript;
    return {
      dispose: async () => {
        const index = this.initScripts.indexOf(script);
        if (index >= 0) this.initScripts.splice(index, 1);
      },
    };
  }

  async evaluate(callback, argument) {
    if (!this.browserWindow) return;
    return vm.runInNewContext(`(${callback.toString()})(argument)`, {
      argument,
      window: this.browserWindow,
    });
  }

  runInitScript(overrides = {}) {
    assert.ok(this.initScript, "init script was installed");
    const browser = createBrowserContext(this, overrides);
    for (const initScript of this.initScripts) {
      const binding = this.bindings.get(initScript.argument.bindingName);
      if (binding) browser.window[initScript.argument.bindingName] = (...args) => binding({}, ...args);
      vm.runInNewContext(
        `(${initScript.callback.toString()})(argument)`,
        { ...browser.context, argument: initScript.argument },
      );
    }
    this.browserWindow = browser.window;
    return browser;
  }

  async close() {
    this.closed = true;
    this.emit("close");
  }
}

function createBrowserContext(page, overrides = {}) {
  let now = 5;
  let nextFrameId = 0;
  const frames = new Map();
  const performanceObservers = [];
  const mutationObservers = [];
  const rect = { top: 5, left: 5, right: 105, bottom: 25, width: 100, height: 20 };
  const visibleElement = () => ({
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    getBoundingClientRect: () => ({ ...rect }),
  });
  const cacheView = overrides.cacheView === undefined ? visibleElement() : overrides.cacheView;
  const cacheStatus = overrides.cacheStatus === undefined ? visibleElement() : overrides.cacheStatus;
  const composer = overrides.composer === undefined
    ? { ...visibleElement(), getBoundingClientRect: () => ({ ...rect, width: 0, height: 0 }) }
    : overrides.composer;
  const list = visibleElement();
  const wrapperIds = overrides.wrapperIds ?? [ASSISTANT_DOM_ID];
  const assistantRows = wrapperIds.map(() => ({}));
  const textNodes = wrapperIds.map((_, index) => ({
    nodeValue: overrides.tailTexts?.[index] ?? TAIL,
    parentElement: visibleElement(),
  }));
  const wrappers = wrapperIds.map((id, index) => ({
    id,
    querySelectorAll(selector) {
      return selector === '[data-testid="message-assistant"]' ? [assistantRows[index]] : [];
    },
  }));
  list.contains = node => wrappers.includes(node);
  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="message-list"]') return list;
      if (selector === '[data-testid="session-cache-view"]') return cacheView;
      if (selector === '[data-testid="session-cache-status"]') return cacheStatus;
      if (selector === '[data-testid="message-input"]') return composer;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[id]') return wrappers;
      return selector === '[data-testid="message-assistant"]' ? assistantRows : [];
    },
    createTreeWalker(root) {
      let visited = false;
      const textNode = textNodes[assistantRows.indexOf(root)];
      return {
        nextNode() {
          if (visited || !textNode) return null;
          visited = true;
          return textNode;
        },
      };
    },
    createRange() {
      return {
        setStart() {},
        setEnd() {},
        getClientRects: () => [{ ...rect }],
      };
    },
  };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; mutationObservers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  class FakePerformanceObserver {
    static supportedEntryTypes = ["longtask", "event"];
    constructor(callback) { this.callback = callback; performanceObservers.push(this); }
    observe(options) { this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const window = { innerWidth: 400, innerHeight: 800 };
  const context = {
    window,
    document,
    performance: {
      now: () => now,
      getEntriesByType: () => [{ startTime: 0 }],
    },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    MutationObserver: FakeMutationObserver,
    PerformanceObserver: FakePerformanceObserver,
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  return {
    context,
    window,
    frames,
    performanceObservers,
    mutationObservers,
    setNow(value) { now = value; },
    runNextFrame() {
      const next = frames.entries().next().value;
      assert.ok(next, "a RAF callback is queued");
      frames.delete(next[0]);
      next[1]();
    },
  };
}

function makeRequest({ method = "GET", url = "http://127.0.0.1/rpc?token=secret", body = "" } = {}) {
  return {
    method: () => method,
    url: () => url,
    resourceType: () => "fetch",
    postDataBuffer: () => Buffer.from(body),
  };
}

test("in-page observer preserves cache/tail metrics and samples RAF, LongTask, and real input separately", async () => {
  const page = new FakePage();
  const traffic = await installCacheTimingTelemetry(page, {
    tailMarker: TAIL,
    expectedAssistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  const browser = page.runInitScript();
  const state = browser.window.__sessionCacheTiming;

  assert.equal(state.navigationStartAtMs, 0);
  assert.equal(state.cacheViewVisibleAtMs, 5);
  assert.equal(state.cacheStatusVisibleAtMs, 5);
  assert.equal(state.tailMarkerVisibleAtMs, 5);
  assert.equal(state.cacheReadableAtMs, 5);
  assert.equal(state.cacheReadOnlyObserved, true);
  assert.equal(state.authorityHistoryVisibleAtMs, null);
  assert.equal(state.composerReadyAtMs, null);
  assert.equal(state.inputSampleStatus, "not_sampled");
  assert.equal(state.inputSampleCount, 0);
  assert.equal(state.inputMaxProcessingDelayMs, null);

  const longTaskObserver = browser.performanceObservers.find(observer => observer.options?.type === "longtask");
  const eventObserver = browser.performanceObservers.find(observer => observer.options?.type === "event");
  assert.ok(longTaskObserver);
  assert.ok(eventObserver);
  longTaskObserver.callback({ getEntries: () => [{ duration: 33.3 }, { duration: 40.2 }] });
  eventObserver.callback({ getEntries: () => [{ interactionId: 9, startTime: 100, processingStart: 104 }] });
  assert.equal(state.longTaskCount, 2);
  assert.equal(state.longTaskMaxMs, 40.2);
  assert.equal(state.longTaskSumMs, 73.5);
  assert.equal(state.longTaskSupported, true);
  assert.equal(state.eventTimingSupported, true);
  assert.equal(state.inputSampleCount, 1);
  assert.equal(state.inputMaxProcessingDelayMs, 4);
  assert.equal(state.inputSampleStatus, "sampled");

  browser.setNow(25);
  browser.runNextFrame();
  browser.setNow(61);
  browser.runNextFrame();
  assert.equal(state.rafGapSampleCount, 1);
  assert.equal(state.rafMaxGapMs, 36);

  state.stop("test-end");
  assert.equal(state.observationStopReason, "test-end");
  await traffic.dispose();
});

test("tail/cache readiness ignores a matching marker on the wrong message ID", async () => {
  const wrongIdPage = new FakePage();
  const wrongIdTraffic = await installCacheTimingTelemetry(wrongIdPage, {
    tailMarker: TAIL,
    expectedAssistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  const wrongIdBrowser = wrongIdPage.runInitScript({ wrapperIds: ["message-some-other-turn"] });
  assert.equal(wrongIdBrowser.window.__sessionCacheTiming.tailMarkerVisibleAtMs, null);
  assert.equal(wrongIdBrowser.window.__sessionCacheTiming.cacheReadableAtMs, null);
  await wrongIdTraffic.dispose();
});

test("tail/cache readiness fails when the canonical assistant message ID is duplicated", async () => {
  const duplicateIdPage = new FakePage();
  const duplicateIdTraffic = await installCacheTimingTelemetry(duplicateIdPage, {
    tailMarker: TAIL,
    expectedAssistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  const duplicateIdBrowser = duplicateIdPage.runInitScript({
    wrapperIds: [ASSISTANT_DOM_ID, ASSISTANT_DOM_ID],
    tailTexts: [TAIL, "different assistant content"],
  });
  assert.equal(duplicateIdBrowser.window.__sessionCacheTiming.tailMarkerVisibleAtMs, null);
  assert.equal(duplicateIdBrowser.window.__sessionCacheTiming.cacheReadableAtMs, null);
  await duplicateIdTraffic.dispose();
});

test("traffic snapshot pairs bounded HTTP terminals and RPC sequence records without sensitive request data", async () => {
  const page = new FakePage();
  const traffic = await installCacheTimingTelemetry(page, { tailMarker: TAIL, expectedAssistantMessageId: ASSISTANT_MESSAGE_ID });
  traffic.markPhase("navigation-start");

  const first = makeRequest({ method: "POST", body: "private request body" });
  const second = makeRequest({ method: "GET", url: "http://127.0.0.1/api/servers?private=query" });
  page.emit("request", first);
  page.emit("request", second);
  page.emit("response", {
    request: () => first,
    status: () => 200,
    headers: () => ({ "content-length": "17", cookie: "private-cookie" }),
  });
  page.emit("requestfinished", first);
  page.emit("requestfailed", second);

  const sequence = recordCacheTimingRpcRequest(traffic, {
    routeClass: "mobile-session-refresh",
    method: "mobile.session.refresh",
    nodeAtMs: 1000,
    payloadBytes: 28,
  });
  assert.equal(sequence, 1);
  assert.equal(recordCacheTimingRpcResponse(traffic, {
    sequence,
    nodeAtMs: 1012,
    outcome: "success",
    payloadBytes: 42,
  }), true);

  const snapshot = snapshotCacheTimingTraffic(traffic);
  assert.equal(snapshot.httpRequestCount, 2);
  assert.equal(snapshot.httpRequestBodyBytes, Buffer.byteLength("private request body"));
  assert.equal(snapshot.httpResponseCount, 1);
  assert.equal(snapshot.httpResponseContentLengthBytes, 17);
  assert.equal(snapshot.httpResponseContentLengthKnownCount, 1);
  assert.equal(snapshot.httpRequestRecordsComplete, true);
  assert.equal(snapshot.httpMaxInFlight, 2);
  assert.equal(snapshot.httpMaxInFlightByPhaseAtStart.values["navigation-start"], 2);
  assert.equal(snapshot.httpMaxInFlightByPhaseAtStart.complete, true);
  assert.deepEqual(snapshot.httpRequestRecords.map(row => row.outcome), ["finished", "failed"]);
  assert.equal(snapshot.rpcRequestRecordsComplete, true);
  assert.deepEqual(snapshot.rpcRequestRecords.map(row => ({
    routeClass: row.routeClass,
    sequence: row.sequence,
    method: row.method,
    outcome: row.outcome,
    requestPayloadBytes: row.requestPayloadBytes,
    responsePayloadBytes: row.responsePayloadBytes,
  })), [{
    routeClass: "mobile-session-refresh",
    sequence: 1,
    method: "mobile.session.refresh",
    outcome: "success",
    requestPayloadBytes: 28,
    responsePayloadBytes: 42,
  }]);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ["token=secret", "private=query", "private request body", "private-cookie"]) {
    assert.equal(serialized.includes(secret), false, `snapshot must omit ${secret}`);
  }
  assert.match(snapshot.httpResponseContentLengthBoundary, /not wire bytes/);
  assert.match(snapshot.phaseConcurrencyBoundary, /not a causal critical path/);
  await traffic.dispose();
});

test("HTTP and RPC record overflow is explicit and invalidates completeness", async () => {
  const page = new FakePage();
  const traffic = await installCacheTimingTelemetry(page, { tailMarker: TAIL, expectedAssistantMessageId: ASSISTANT_MESSAGE_ID });
  for (let index = 0; index < 257; index += 1) {
    const request = makeRequest({ url: `http://127.0.0.1/api/servers?sequence=${index}` });
    page.emit("request", request);
    page.emit("requestfinished", request);
  }
  const rpcSequences = [];
  for (let index = 0; index < 257; index += 1) {
    rpcSequences.push(recordCacheTimingRpcRequest(traffic, {
      routeClass: "rpc",
      method: "POST",
      nodeAtMs: 2000 + index,
      payloadBytes: 1,
    }));
  }
  const snapshot = snapshotCacheTimingTraffic(traffic);
  assert.equal(snapshot.httpRequestRecords.length, 256);
  assert.equal(snapshot.httpRequestRecordsDroppedCount, 1);
  assert.equal(snapshot.httpRequestRecordsComplete, false);
  assert.equal(snapshot.rpcRequestRecords.length, 256);
  assert.equal(snapshot.rpcRequestRecordsDroppedCount, 1);
  assert.equal(snapshot.rpcRequestRecordsComplete, false);
  assert.equal(rpcSequences.at(-1), null);
  await traffic.dispose();
});

test("performance validity ignores optional input metrics that the browser did not sample", () => {
  assert.deepEqual(assessCacheTimingSamplePerformanceValidity({
    functionalStatus: "PASS",
    traffic: {
      httpRequestRecordsComplete: true,
      rpcRequestRecordsComplete: true,
      inputSampleStatus: "not_sampled",
      inputMaxProcessingDelayMs: null,
    },
  }), { validForPerformance: true, invalidReasons: [] });
});

test("an unfinished HTTP request makes a functional sample invalid for performance statistics", async () => {
  const page = new FakePage();
  const traffic = await installCacheTimingTelemetry(page, { tailMarker: TAIL, expectedAssistantMessageId: ASSISTANT_MESSAGE_ID });
  page.emit("request", makeRequest({ url: "http://127.0.0.1/api/session" }));

  const snapshot = snapshotCacheTimingTraffic(traffic);
  assert.equal(snapshot.httpRequestRecordsComplete, false);
  assert.equal(snapshot.rpcRequestRecordsComplete, true);
  assert.deepEqual(assessCacheTimingSamplePerformanceValidity({ functionalStatus: "PASS", traffic: snapshot }), {
    validForPerformance: false,
    invalidReasons: ["httpRequestRecordsComplete"],
  });
  await traffic.dispose();
});

test("an unpaired RPC request makes a functional sample invalid for performance statistics", async () => {
  const page = new FakePage();
  const traffic = await installCacheTimingTelemetry(page, { tailMarker: TAIL, expectedAssistantMessageId: ASSISTANT_MESSAGE_ID });
  recordCacheTimingRpcRequest(traffic, {
    routeClass: "rpc",
    method: "thread.resume",
    nodeAtMs: 1000,
    payloadBytes: 18,
  });

  const snapshot = snapshotCacheTimingTraffic(traffic);
  assert.equal(snapshot.httpRequestRecordsComplete, true);
  assert.equal(snapshot.rpcRequestRecordsComplete, false);
  assert.deepEqual(assessCacheTimingSamplePerformanceValidity({ functionalStatus: "PASS", traffic: snapshot }), {
    validForPerformance: false,
    invalidReasons: ["rpcRequestRecordsComplete"],
  });
  await traffic.dispose();
});

test("duplicate and unpaired RPC responses invalidate completeness independently of overflow", async () => {
  const page = new FakePage();
  const traffic = await installCacheTimingTelemetry(page, { tailMarker: TAIL, expectedAssistantMessageId: ASSISTANT_MESSAGE_ID });
  const sequence = recordCacheTimingRpcRequest(traffic, {
    routeClass: "rpc",
    method: "thread.resume",
    nodeAtMs: 1000,
    payloadBytes: 18,
  });
  assert.equal(recordCacheTimingRpcResponse(traffic, {
    sequence,
    nodeAtMs: 1010,
    outcome: "success",
    payloadBytes: 24,
  }), true);
  assert.equal(recordCacheTimingRpcResponse(traffic, {
    sequence,
    nodeAtMs: 1011,
    outcome: "success",
    payloadBytes: 24,
  }), false);
  assert.equal(recordCacheTimingRpcResponse(traffic, {
    sequence: Number.MAX_SAFE_INTEGER,
    nodeAtMs: 1012,
    outcome: "error",
    payloadBytes: 12,
  }), false);

  const snapshot = snapshotCacheTimingTraffic(traffic);
  assert.equal(snapshot.rpcUnpairedResponseCount, 2);
  assert.equal(snapshot.rpcRequestRecordsDroppedCount, 0);
  assert.equal(snapshot.rpcRequestRecordsComplete, false);
  assert.equal(snapshot.rpcRequestRecords[0].outcome, "success");
  await traffic.dispose();
});

test("dispose removes only owned Page and WebSocket listeners and leaves Page open", async () => {
  const page = new FakePage();
  const unrelatedPageListener = () => {};
  page.on("request", unrelatedPageListener);
  const traffic = await installCacheTimingTelemetry(page, { tailMarker: TAIL, expectedAssistantMessageId: ASSISTANT_MESSAGE_ID });
  page.runInitScript();
  const socket = new EventEmitter();
  let socketOffCalls = 0;
  const originalSocketOff = socket.off.bind(socket);
  socket.off = (...args) => {
    socketOffCalls += 1;
    return originalSocketOff(...args);
  };
  const unrelatedSocketListener = () => {};
  socket.on("framesent", unrelatedSocketListener);
  page.emit("websocket", socket);
  assert.equal(socket.listenerCount("framesent"), 2);
  socket.emit("close");
  assert.equal(socket.listenerCount("framesent"), 1);
  assert.equal(socketOffCalls, 3);

  await traffic.dispose();
  assert.equal(page.listenerCount("request"), 1);
  assert.equal(page.listeners("request")[0], unrelatedPageListener);
  assert.equal(socket.listenerCount("framesent"), 1);
  assert.equal(socket.listeners("framesent")[0], unrelatedSocketListener);
  assert.equal(socketOffCalls, 3);
  assert.equal(page.closed, false);
  assert.equal(page.bindings.size, 0);
  assert.equal(page.initScripts.length, 0);
  assert.equal(page.__cacheTimingTraffic, undefined);
  assert.equal(page.browserWindow.__sessionCacheTiming.observationStopReason, "disposed");
  assert.equal(Object.keys(page.browserWindow).some(name => name.startsWith("__kcoderCacheTimingReportPhaseV1_")), false);
});

test("a disposed init script stays inert when the same Page is reused", async () => {
  const page = new FakePage();
  const first = await installCacheTimingTelemetry(page, { tailMarker: "OLD-TAIL", expectedAssistantMessageId: ASSISTANT_MESSAGE_ID });
  await first.dispose();
  assert.equal(page.initScripts.length, 0);
  assert.equal(page.bindings.size, 0);
  const second = await installCacheTimingTelemetry(page, { tailMarker: TAIL, expectedAssistantMessageId: ASSISTANT_MESSAGE_ID });

  const browser = page.runInitScript();
  assert.equal(page.initScripts.length, 1);
  assert.equal(browser.performanceObservers.length, 2);
  assert.equal(browser.frames.size, 1);
  assert.equal(browser.window.__sessionCacheTiming.tailMarkerVisibleAtMs, 5);
  await second.dispose();
});

test("partial installation failure disposes its binding and Page listeners, then permits reuse", async () => {
  const page = new FakePage();
  let unrelatedObserverStops = 0;
  page.browserWindow = { __sessionCacheTiming: { stop: () => { unrelatedObserverStops += 1; } } };
  page.failAddInitScript = true;
  await assert.rejects(installCacheTimingTelemetry(page, { tailMarker: TAIL, expectedAssistantMessageId: ASSISTANT_MESSAGE_ID }), /simulated addInitScript failure/);
  assert.equal(page.bindings.size, 0);
  assert.equal(page.initScripts.length, 0);
  assert.equal(page.listenerCount("request"), 0);
  assert.equal(page.__cacheTimingTraffic, undefined);
  assert.equal(unrelatedObserverStops, 0);

  page.failAddInitScript = false;
  const traffic = await installCacheTimingTelemetry(page, { tailMarker: TAIL, expectedAssistantMessageId: ASSISTANT_MESSAGE_ID });
  assert.equal(page.bindings.size, 1);
  assert.equal(page.initScripts.length, 1);
  await traffic.dispose();
});
