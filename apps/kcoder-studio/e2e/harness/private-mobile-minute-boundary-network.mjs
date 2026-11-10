// Private historical minute-boundary mechanisms; construction starts no resources.
export function createPrivateMinuteBoundaryNetwork({
  APPLICATION_DELAY_TIMER_TOLERANCE_MS,
  DEFAULT_SAMPLES,
  REFRESH_HOME_MINUTE_BOUNDARY_ELAPSED_MS,
  REFRESH_HOME_MINUTE_BOUNDARY_TARGET_OFFSET_MS,
  SERVER_ID,
  THREAD_ID,
  createTurnStartErrorFixtureFrame,
  delay,
  distribution,
  drawerCloseDiagnosticsEnabled,
  epochNow,
  mobileApiPath,
  parseFrame,
  percentile,
  performance,
  refreshCoverageMode,
  refreshHomeMinuteBoundaryDiagnosticMode,
  refreshSingleSampleMode,
  round,
  rpcIdFingerprint,
  safePath,
  safeWebSocketRouteInfo,
  sampleCount,
  sanitizeGatewayPath,
  sha256,
  sumResponseDelayMs,
  waitUntilPerformanceDeadline,
}) {
function sanitizeRpcEventForCheckpoint(event) {
  return {
    direction: event.direction,
    method: event.method,
    rpcIdFingerprint: event.rpcIdFingerprint ?? null,
    atMs: event.atMs,
    atEpochMs: event.atEpochMs,
    stage: event.stage,
    actionId: event.actionId,
    routeSocketId: event.routeSocketId,
    path: typeof event.path === "string" ? sanitizeGatewayPath(event.path) : null,
    serverFingerprint: event.serverFingerprint ?? null,
    channelFingerprint: event.channelFingerprint ?? null,
    workspaceFingerprint: event.workspaceFingerprint ?? null,
  };
}

function pendingRouteRequestsAt(network, atEpochMs) {
  const events = [
    ...network.rpcEvents.map(event => ({ kind: "rpc", event })),
    ...network.routedWebSocketCloseEvents.map(event => ({ kind: "close", event })),
  ].filter(row => row.event.atEpochMs <= atEpochMs).sort((a, b) => a.event.atEpochMs - b.event.atEpochMs);
  const pending = new Map();
  for (const row of events) {
    const event = row.event;
    if (row.kind === "close") {
      for (const [key, request] of pending) if (request.routeSocketId === event.routeSocketId) pending.delete(key);
      continue;
    }
    if (event.direction === "request" && event.hasId && event.rpcIdFingerprint) {
      const key = `${event.routeSocketId}|${event.method}|${event.rpcIdFingerprint}`;
      pending.set(key, event);
    } else if (event.direction === "response-forwarded" || event.direction === "response-dropped") {
      pending.delete(`${event.routeSocketId}|${event.method}|${event.rpcIdFingerprint}`);
    }
  }
  return [...pending.values()].map(sanitizeRpcEventForCheckpoint);
}

function recordRoutedWebSocketCloseInvocation(network, routeSocketId, { code, reason, stage, actionId }) {
  network.routedWebSocketCloseInvocations.push({
    routeSocketId,
    code,
    reason,
    atMs: round(performance.now()),
    atEpochMs: round(epochNow()),
    stage,
    actionId,
    owner: "test-fixture",
  });
}

function beginNavigationSampleCapture(network, observations, browserErrors, delayMs, cacheClass, sampleIndex) {
  const ordinal = ++network.navigationSampleSequence;
  return {
    ordinal,
    delayMs,
    cacheClass,
    sampleIndex,
    startedAtEpochMs: round(epochNow()),
    observationStartIndex: observations.length,
    browserErrorStartIndex: browserErrors.length,
    httpRouteRequestStartIndex: network.httpRouteRequests.length,
    httpResponseDelayStartIndex: network.httpResponsePathDelays.length,
    rpcEventStartIndex: network.rpcEvents.length,
    websocketDelayStartIndex: network.websocketResponsePathDelays.length,
    routedSocketStartIndex: network.routedWebSocketConnections.length,
    routedSocketCloseStartIndex: network.routedWebSocketCloseEvents.length,
    routedSocketCloseInvocationStartIndex: network.routedWebSocketCloseInvocations.length,
    drawerCheckStartIndex: network.drawerCloseListChecks.length,
    websocketFrameCountAtStart: network.websocketFrames,
  };
}

async function writeNavigationSampleCheckpoint(context, network, capture, observations, browserErrors) {
  const finishedAtEpochMs = round(epochNow());
  const safeHttpRequest = row => ({
    routeRequestOrdinal: row.routeRequestOrdinal ?? null,
    path: sanitizeGatewayPath(row.apiPath ?? row.path),
    method: row.method,
    stage: row.stage,
    scenario: row.scenario ?? null,
    startedAtEpochMs: row.startedAtEpochMs ?? null,
  });
  const safeHttpResponse = row => ({
    routeRequestOrdinal: row.routeRequestOrdinal ?? null,
    path: sanitizeGatewayPath(row.apiPath ?? row.path),
    method: row.method,
    status: row.status,
    configuredDelayMs: row.configuredDelayMs,
    appliedDelayMs: row.appliedDelayMs,
    startedAtEpochMs: row.requestStartedAtEpochMs ?? null,
    forwardedAtEpochMs: row.forwardedAtEpochMs ?? null,
    stage: row.stage,
    scenario: row.scenario ?? null,
  });
  const safeWsDelay = row => ({
    method: row.method,
    rpcIdFingerprint: row.rpcIdFingerprint ?? null,
    routeSocketId: row.routeSocketId,
    configuredDelayMs: row.configuredDelayMs,
    appliedDelayMs: row.appliedDelayMs,
    receivedAtEpochMs: row.receivedAtEpochMs ?? null,
    forwardedAtEpochMs: row.forwardedAtEpochMs ?? null,
    stage: row.stage,
    scenario: row.scenario ?? null,
  });
  const httpRequests = network.httpRouteRequests.slice(capture.httpRouteRequestStartIndex).map(safeHttpRequest);
  const httpResponses = network.httpResponsePathDelays.slice(capture.httpResponseDelayStartIndex).map(safeHttpResponse);
  const rpcEvents = network.rpcEvents.slice(capture.rpcEventStartIndex).map(sanitizeRpcEventForCheckpoint);
  const websocketDelays = network.websocketResponsePathDelays.slice(capture.websocketDelayStartIndex).map(safeWsDelay);
  const routeSockets = network.routedWebSocketConnections.slice(capture.routedSocketStartIndex).map(row => ({
    id: row.id,
    path: typeof row.path === "string" ? sanitizeGatewayPath(row.path) : null,
    serverFingerprint: row.serverFingerprint ?? null,
    channelFingerprint: row.channelFingerprint ?? null,
    workspaceFingerprint: row.workspaceFingerprint ?? null,
    atEpochMs: row.atEpochMs,
    stage: row.stage,
  }));
  const sample = context.redactValue({
    schemaVersion: 1,
    evidenceKind: "completed Mobile Web navigation sample checkpoint",
    sample: {
      ordinal: capture.ordinal,
      delayMs: capture.delayMs,
      cacheClass: capture.cacheClass,
      sampleIndex: capture.sampleIndex,
      requiredSamplesPerClass: capture.cacheClass === "profile-setup" ? 1 : sampleCount,
      percentileEligible: capture.cacheClass !== "profile-setup" && sampleCount >= DEFAULT_SAMPLES,
      drawerCloseDiagnosticsEnabled,
      drawerCloseLatencyInterpretation: drawerCloseDiagnosticsEnabled ? "instrumented diagnostic timing; not an unbiased latency measurement" : "standard browser timing",
      startedAtEpochMs: capture.startedAtEpochMs,
      finishedAtEpochMs,
      wallElapsedMs: round(finishedAtEpochMs - capture.startedAtEpochMs),
      browserActionTimingExcludesCheckpointIo: true,
    },
    captureStatus: "COMPLETED",
    sampleOutcome: browserErrors.length > capture.browserErrorStartIndex ? "ERROR" : "NO_PAGEERROR_OBSERVED",
    observations: observations.slice(capture.observationStartIndex),
    browserErrorCount: browserErrors.length - capture.browserErrorStartIndex,
    network: {
      associationSemantics: "request-path observations are bounded by this sample window; method/id/socket/stage/action/time fields support correlation, while background fixture traffic in a live context is not automatically attributed to the measured click",
      pendingAtCheckpoint: pendingGatewayActivity(network),
      outstandingRpcRequestsAtCheckpoint: pendingRouteRequestsAt(network, finishedAtEpochMs),
      httpRouteRequestCount: httpRequests.length,
      httpResponsePathCount: httpResponses.length,
      websocketFrameCount: network.websocketFrames - capture.websocketFrameCountAtStart,
      websocketResponsePathCount: websocketDelays.length,
      rpcEventCount: rpcEvents.length,
      routeSocketCount: routeSockets.length,
      routedSocketCloseEvents: network.routedWebSocketCloseEvents.slice(capture.routedSocketCloseStartIndex),
      routedSocketCloseInvocations: network.routedWebSocketCloseInvocations.slice(capture.routedSocketCloseInvocationStartIndex),
      httpRequests,
      httpResponses,
      rpcEvents,
      websocketResponsePaths: websocketDelays,
      routeSockets,
      drawerCloseChecks: network.drawerCloseListChecks.slice(capture.drawerCheckStartIndex),
    },
    storageStatePersisted: false,
    credentialsOrResponseBodiesIncluded: false,
  });
  const cacheKey = capture.cacheClass.replace(/[^a-z0-9-]/gi, "-");
  const sampleKey = capture.sampleIndex === 0 ? "setup" : String(capture.sampleIndex).padStart(2, "0");
  await context.writeArtifactJson(`phone-ux-navigation-${capture.delayMs}ms-${cacheKey}-${sampleKey}-s${String(capture.ordinal).padStart(4, "0")}.json`, sample);
}

async function installPageInstrumentation(page, pageId) {
  await page.addInitScript(({ pageId }) => {
    const activeKey = "__phoneUxActiveMeasurementsV1";
    const completedKey = "__phoneUxCompletedMeasurementsV1";
    const debugKey = "__phoneUxEventDebugV1";
    const readStored = key => {
      try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch { return []; }
    };
    const active = new Map(readStored(activeKey).map(measurement => [measurement.id, measurement]));
    const completed = new Map(readStored(completedKey));
    const longTasks = [];
    const events = readStored(debugKey);
    const appSocketKey = "__phoneUxApplicationWebSocketConnectionsV1";
    const appFrameKey = "__phoneUxApplicationWebSocketFramesV1";
    const appSockets = readStored(appSocketKey);
    const appFrames = readStored(appFrameKey);
    const pendingAppFrameWrites = new Set();
    const maxAppSockets = 512;
    const maxAppFrames = 8192;
    let socketOverflowCount = 0;
    let frameOverflowCount = 0;
    let storageWriteFailureCount = 0;
    let appSocketSequence = Math.max(0, ...appSockets.map(row => Number(row.socketId) || 0));
    const storeAppEvidence = () => {
      try {
        sessionStorage.setItem(appSocketKey, JSON.stringify(appSockets));
        sessionStorage.setItem(appFrameKey, JSON.stringify(appFrames));
      } catch { storageWriteFailureCount += 1; }
    };
    const digestFingerprint = async value => {
      const bytes = new TextEncoder().encode(String(value));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    };
    const applicationRouteInfo = async rawUrl => {
      try {
        const parsed = new URL(rawUrl, location.href);
        const fingerprint = async names => {
          for (const name of names) {
            const value = parsed.searchParams.get(name);
            if (value) return (await digestFingerprint(`${name}:${value}`)).slice(0, 12);
          }
          return null;
        };
        return {
          path: parsed.pathname,
          serverFingerprint: await fingerprint(["serverId", "server"]),
          channelFingerprint: await fingerprint(["channelId", "channel"]),
          workspaceFingerprint: await fingerprint(["workspaceId", "workspace"]),
        };
      } catch {
        return { path: "<invalid-url>", serverFingerprint: null, channelFingerprint: null, workspaceFingerprint: null };
      }
    };
    const recordApplicationFrame = (socket, direction, raw, atEpochMs, eventTimestampEpochMs = null) => {
      const pending = (async () => {
        if (typeof raw !== "string") return;
        let frame;
        try { frame = JSON.parse(raw); } catch { return; }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
        const hasId = Object.hasOwn(frame, "id");
        const hasResult = Object.hasOwn(frame, "result");
        const hasError = Object.hasOwn(frame, "error");
        const method = typeof frame.method === "string" ? frame.method : null;
        if (!hasId && !hasResult && !hasError && method === null) return;
        const idFingerprint = hasId ? (await digestFingerprint(frame.id)).slice(0, 16) : null;
        const routeInfo = await socket.routeInfo;
        if (appFrames.length >= maxAppFrames) {
          frameOverflowCount += 1;
          return;
        }
        appFrames.push({
          pageId,
          direction,
          socketId: socket.socketId,
          ...routeInfo,
          method,
          rpcIdFingerprint: idFingerprint,
          hasId,
          hasResult,
          hasError,
          atEpochMs: Number(atEpochMs.toFixed(3)),
          eventTimestampEpochMs: Number.isFinite(eventTimestampEpochMs) ? Number(eventTimestampEpochMs.toFixed(3)) : null,
        });
        storeAppEvidence();
      })();
      pendingAppFrameWrites.add(pending);
      void pending.finally(() => pendingAppFrameWrites.delete(pending));
    };
    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;
    const socketMetadata = new WeakMap();
    NativeWebSocket.prototype.send = function phoneUxInstrumentedSend(raw) {
      const socket = socketMetadata.get(this);
      if (socket) recordApplicationFrame(socket, "sent", raw, performance.timeOrigin + performance.now());
      return nativeSend.call(this, raw);
    };
    const InstrumentedWebSocket = function PhoneUxInstrumentedWebSocket(...args) {
      if (!new.target) throw new TypeError("WebSocket constructor requires 'new'");
      const socket = Reflect.construct(NativeWebSocket, args, NativeWebSocket);
      const metadata = {
        pageId,
        socketId: ++appSocketSequence,
        routeInfo: applicationRouteInfo(args[0]),
      };
      socketMetadata.set(socket, metadata);
      const pendingSocketCapture = metadata.routeInfo.then(routeInfo => {
        if (appSockets.length >= maxAppSockets) {
          socketOverflowCount += 1;
          return;
        }
        appSockets.push({
          pageId,
          socketId: metadata.socketId,
          ...routeInfo,
          atEpochMs: Number((performance.timeOrigin + performance.now()).toFixed(3)),
        });
        storeAppEvidence();
      });
      pendingAppFrameWrites.add(pendingSocketCapture);
      void pendingSocketCapture.finally(() => pendingAppFrameWrites.delete(pendingSocketCapture));
      socket.addEventListener("message", event => {
        const callbackEpochMs = performance.timeOrigin + performance.now();
        const eventTimestampEpochMs = performance.timeOrigin + event.timeStamp;
        recordApplicationFrame(metadata, "received", event.data, callbackEpochMs, eventTimestampEpochMs);
      });
      return socket;
    };
    Object.setPrototypeOf(InstrumentedWebSocket, NativeWebSocket);
    InstrumentedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = InstrumentedWebSocket;
    window.__phoneUxDrainApplicationWebSocketEvidence = async () => {
      while (pendingAppFrameWrites.size > 0) await Promise.all([...pendingAppFrameWrites]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      while (pendingAppFrameWrites.size > 0) await Promise.all([...pendingAppFrameWrites]);
      const evidence = {
        pageId,
        sockets: appSockets.slice(),
        frames: appFrames.slice(),
        socketOverflowCount,
        frameOverflowCount,
        storageWriteFailureCount,
        maxSocketsPerPage: maxAppSockets,
        maxFramesPerPage: maxAppFrames,
      };
      appSockets.length = 0;
      appFrames.length = 0;
      storeAppEvidence();
      return evidence;
    };
    storeAppEvidence();
    const absoluteNow = () => performance.timeOrigin + performance.now();
    const persist = () => {
      try {
        sessionStorage.setItem(activeKey, JSON.stringify([...active.values()]));
        sessionStorage.setItem(completedKey, JSON.stringify([...completed.entries()].slice(-64)));
        sessionStorage.setItem(debugKey, JSON.stringify(events.slice(-64)));
      } catch {}
    };
    const noteEvent = (measurement, eventType, target) => {
      events.push({ id: measurement.id, eventType, targetTag: target?.tagName ?? null, targetTestId: target?.getAttribute?.("data-testid") ?? null, at: Number(absoluteNow().toFixed(3)) });
      if (events.length > 64) events.splice(0, events.length - 64);
    };
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const matches = (target, selector) => {
      if (!(target instanceof Element)) return false;
      try { return Boolean(target.closest(selector)); } catch { return false; }
    };
    const stillReady = measurement => {
      const element = document.querySelector(measurement.targetSelector);
      const textMatches = measurement.targetText === undefined || (element?.textContent ?? "").includes(measurement.targetText);
      if (measurement.requireTargetTransition) {
        const isVisible = visible(element) && textMatches;
        if (isVisible) measurement.targetWasVisible = true;
        return measurement.targetWasVisible === true && !isVisible;
      }
      let ready = visible(element) === measurement.targetVisible && (measurement.targetVisible ? textMatches : true);
      if (measurement.targetValue !== undefined) ready = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value === measurement.targetValue
        : false;
      return ready;
    };
    const finish = measurement => {
      if (measurement.startedAt === null || measurement.domReadyAt !== null || !stillReady(measurement)) return;
      measurement.domReadyAt = absoluteNow();
      measurement.domReadyMs = Number((measurement.domReadyAt - measurement.startedAt).toFixed(3));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!stillReady(measurement)) {
          measurement.domReadyAt = null;
          measurement.domReadyMs = null;
          persist();
          return;
        }
        measurement.finishedAt = absoluteNow();
        measurement.paintFeedbackMs = Number((measurement.finishedAt - measurement.startedAt).toFixed(3));
        completed.set(measurement.id, {
          action: measurement.action ?? null,
          startedAtEpochMs: measurement.startedAt,
          domReadyAtEpochMs: measurement.domReadyAt,
          paintFeedbackAtEpochMs: measurement.finishedAt,
          domReadyMs: measurement.domReadyMs,
          paintFeedbackMs: measurement.paintFeedbackMs,
        });
        active.delete(measurement.id);
        persist();
      }));
    };
    window.__phoneUxArm = spec => {
      active.set(spec.id, { ...spec, startedAt: null, domReadyAt: null, finishedAt: null, domReadyMs: null, paintFeedbackMs: null });
      persist();
    };
    window.__phoneUxMeasure = id => completed.get(id) || null;
    window.__phoneUxDebug = ids => {
      const values = Array.isArray(ids) ? ids : [ids];
      return Object.fromEntries(values.map(id => [id, {
        active: active.get(id) ?? null,
        completed: completed.get(id) ?? null,
        events: events.filter(event => event.id === id),
        url: location.href,
      }]));
    };
    const begin = (event, eventType) => {
      for (const measurement of active.values()) {
        if (measurement.targetValue !== undefined && eventType !== "input") continue;
        if (measurement.targetValue === undefined && eventType !== "pointerdown") continue;
        if (measurement.startedAt !== null || !matches(event.target, measurement.sourceSelector)) continue;
        measurement.startedAt = absoluteNow();
        measurement.eventType = eventType;
        noteEvent(measurement, eventType, event.target);
        persist();
        if (eventType === "input") finish(measurement);
      }
    };
    document.addEventListener("pointerdown", event => begin(event, "pointerdown"), true);
    document.addEventListener("click", event => begin(event, "click"), true);
    document.addEventListener("input", event => begin(event, "input"), true);
    new MutationObserver(() => {
      for (const measurement of active.values()) finish(measurement);
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    for (const measurement of active.values()) finish(measurement);
    if (typeof PerformanceObserver === "function") {
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) longTasks.push({ startTimeMs: Number(entry.startTime.toFixed(3)), durationMs: Number(entry.duration.toFixed(3)) });
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    }
    window.__phoneUxLongTasks = () => longTasks.slice();
  }, { pageId });
}

async function installNetworkInstrumentation(page, pageId, ledger, delayControl, gatewayCalls) {
  const controlledHomeMinuteBoundaryByStage = new Map();
  page.on("websocket", socket => {
    const routeInfo = safeWebSocketRouteInfo(socket.url());
    const path = routeInfo.path;
    const socketId = ++ledger.browserSocketSequence;
    const atMs = round(performance.now());
    ledger.browserWebSocketPaths.push(path);
    ledger.browserWebSocketConnections.push({ id: socketId, ...routeInfo, atMs, atEpochMs: round(epochNow()), stage: ledger.currentStage, actionId: ledger.currentActionId });
    const recordFrame = (direction, event) => {
      const frame = parseFrame(event?.payload);
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      const method = typeof frame.method === "string" ? frame.method : null;
      const hasId = Object.hasOwn(frame, "id");
      const hasResult = Object.hasOwn(frame, "result");
      const hasError = Object.hasOwn(frame, "error");
      if (method === null && !hasId && !hasResult && !hasError) return;
      if (direction === "sent" && method !== null) ledger.browserFrameMethodCounts[method] = (ledger.browserFrameMethodCounts[method] ?? 0) + 1;
      ledger.browserFrames.push({
        direction,
        socketId,
        ...routeInfo,
        method,
        rpcIdFingerprint: hasId ? rpcIdFingerprint(frame.id) : null,
        hasId,
        hasResult,
        hasError,
        atMs: round(performance.now()),
        atEpochMs: round(epochNow()),
        stage: ledger.currentStage,
        actionId: ledger.currentActionId,
      });
    };
    socket.on("framesent", event => recordFrame("sent", event));
    socket.on("framereceived", event => recordFrame("received", event));
  });
  page.on("request", request => {
    const path = safePath(request.url());
    if (mobileApiPath(path).startsWith("/api/")) ledger.requestStarts.set(request, { path, method: request.method(), at: performance.now() });
  });
  page.on("response", response => {
    const request = response.request();
    const start = ledger.requestStarts.get(request);
    if (!start) return;
    ledger.http.push({ path: start.path, method: start.method, status: response.status(), durationMs: round(performance.now() - start.at), configuredDelayMs: delayControl.delayMs ?? 0 });
  });
  await page.route("**/api/**", async route => {
    ledger.pendingHttpResponses += 1;
    try {
      const path = safePath(route.request().url());
      const apiPath = mobileApiPath(path);
      const method = route.request().method();
      const routeRequestOrdinal = ++ledger.httpRouteRequestSequence;
      const requestStartedAtMs = round(performance.now());
      const requestStartedAtEpochMs = round(epochNow());
      ledger.httpRouteRequests.push({
        routeRequestOrdinal,
        path,
        apiPath,
        method,
        stage: ledger.currentStage,
        scenario: delayControl.scenarioId ?? null,
        startedAtMs: requestStartedAtMs,
        startedAtEpochMs: requestStartedAtEpochMs,
      });
      const response = await route.fetch();
      const jitter = delayControl.responseJitter?.next("http", apiPath) ?? { sampleIndex: null, delayMs: 0 };
      const configuredDelayMs = sumResponseDelayMs(
        delayControl.delayMs ?? 0,
        apiPath === "/api/servers/status" ? (delayControl.statusProbeDelayMs ?? 0) : 0,
        delayControl.httpPathDelayMs?.[apiPath] ?? 0,
        jitter.delayMs,
      );
      const responsePathHoldStartedAt = performance.now();
      const responsePathHoldDeadline = responsePathHoldStartedAt + configuredDelayMs;
      if (configuredDelayMs > 0) await waitUntilPerformanceDeadline(responsePathHoldDeadline);
      const appliedDelayMs = round(performance.now() - responsePathHoldStartedAt);
      const injectedStatus = delayControl.httpStatusOverrides?.[apiPath];
      if (Number.isInteger(injectedStatus)) {
        await route.fulfill({ response, status: injectedStatus });
        ledger.injectedHttpStatuses.push({ path, apiPath, status: injectedStatus, stage: ledger.currentStage, scenario: delayControl.scenarioId ?? null });
      } else {
        await route.fulfill({ response });
      }
      ledger.httpResponsePathDelays.push({
        routeRequestOrdinal,
        path,
        apiPath,
        method,
        requestStartedAtMs,
        requestStartedAtEpochMs,
        forwardedAtEpochMs: round(epochNow()),
        configuredDelayMs,
        jitterSampleIndex: jitter.sampleIndex,
        jitterDelayMs: jitter.delayMs,
        appliedDelayMs,
        status: injectedStatus ?? response.status(),
        stage: ledger.currentStage,
        scenario: delayControl.scenarioId ?? null,
      });
    } finally {
      ledger.pendingHttpResponses = Math.max(0, ledger.pendingHttpResponses - 1);
    }
  });
  const methodResponseHoldTimers = new Set();
  page.on("close", () => {
    const cancelledHoldCount = methodResponseHoldTimers.size;
    for (const timer of methodResponseHoldTimers) clearTimeout(timer);
    methodResponseHoldTimers.clear();
    ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - cancelledHoldCount);
  });
  await page.routeWebSocket(url => url.pathname.endsWith("/rpc"), socket => {
    const routeSocketId = ++ledger.routedSocketSequence;
    const socketUrl = typeof socket.url === "function" ? socket.url() : socket.url;
    const routeInfo = typeof socketUrl === "string" ? safeWebSocketRouteInfo(socketUrl) : { path: null };
    ledger.routedWebSocketConnections.push({
      id: routeSocketId,
      owningPageId: pageId,
      ...routeInfo,
      atMs: round(performance.now()),
      atEpochMs: round(epochNow()),
      stage: ledger.currentStage,
      actionId: ledger.currentActionId,
    });
    const upstream = socket.connectToServer();
    const pendingRpc = new Map();
    let deliverQueue = Promise.resolve();
    socket.onMessage(raw => {
      const frame = parseFrame(raw);
      if (typeof frame?.method === "string") {
        const idFingerprint = frame.id !== undefined ? rpcIdFingerprint(frame.id) : null;
        ledger.rpcMethodCounts[frame.method] = (ledger.rpcMethodCounts[frame.method] ?? 0) + 1;
        ledger.rpcEvents.push({
          direction: "request",
          method: frame.method,
          rpcIdFingerprint: idFingerprint,
          hasId: frame.id !== undefined,
          atMs: round(performance.now()),
          atEpochMs: round(epochNow()),
          stage: ledger.currentStage,
          actionId: ledger.currentActionId,
          routeSocketId,
          ...routeInfo,
        });
        if (frame.method === "turn/start" && delayControl.scenarioId) {
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId,
            kind: "turn-start-request",
            rpcIdFingerprint: idFingerprint,
            threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
            clientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
            routeSocketId,
            atMs: round(performance.now()),
            stage: ledger.currentStage,
          });
        }
        if (frame.method === "turn/interrupt" && delayControl.scenarioId) {
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId,
            kind: "turn-interrupt-request",
            rpcIdFingerprint: idFingerprint,
            threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
            turnIdFingerprint: typeof frame.params?.turnId === "string" ? sha256(frame.params.turnId).slice(0, 16) : null,
            routeSocketId,
            atMs: round(performance.now()),
            stage: ledger.currentStage,
          });
        }
        if (frame.method === "turn/start") gatewayCalls.turnStart += 1;
        if (frame.method === "runtime.models.list") gatewayCalls.modelCatalogRpcRequests += 1;
        if (frame.id !== undefined) {
          const receiptRequestIdentity = frame.method === "turn/start"
            ? delayControl.receiptFixture?.observeTurnStartRequest(frame.params, delayControl.receiptScope, routeSocketId)
            : null;
          pendingRpc.set(String(frame.id), {
            method: frame.method,
            stage: ledger.currentStage,
            sentAt: performance.now(),
            sentAtEpochMs: epochNow(),
            rpcIdFingerprint: idFingerprint,
            actionId: ledger.currentActionId,
            routeSocketId,
            threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
            turnIdFingerprint: typeof frame.params?.turnId === "string" ? sha256(frame.params.turnId).slice(0, 16) : null,
            receiptRequestIdentity,
            ...routeInfo,
          });
          ledger.pendingRpcMethodCounts[frame.method] = (ledger.pendingRpcMethodCounts[frame.method] ?? 0) + 1;
          if (frame.method === "turn/start" && delayControl.turnStartErrorFixture === true) {
            const request = pendingRpc.get(String(frame.id));
            const errorFrame = createTurnStartErrorFixtureFrame(frame);
            const receivedAt = performance.now();
            const receivedAtEpochMs = epochNow();
            const configuredDelayMs = sumResponseDelayMs(
              delayControl.methodResponseHoldMs?.["turn/start"] ?? 0,
            );
            const eligibleAt = receivedAt + configuredDelayMs;
            ledger.pendingWebSocketDeliveries += 1;
            deliverQueue = deliverQueue
              .then(async () => {
                if (configuredDelayMs > 0) await waitUntilPerformanceDeadline(eligibleAt);
                socket.send(JSON.stringify(errorFrame));
                const deliveredAt = performance.now();
                const appliedDelayMs = round(deliveredAt - receivedAt);
                const fixtureEvent = {
                  scenario: delayControl.scenarioId ?? "unspecified",
                  kind: "turn-start-error-fixture",
                  responseSource: "test-generated request-id-correlated JSON-RPC error at Playwright WebSocket route",
                  requestIdFingerprint: request.rpcIdFingerprint,
                  clientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
                  threadIdFingerprint: request.threadIdFingerprint,
                  routeSocketId,
                  requestIdPreserved: errorFrame.id === frame.id,
                  errorCode: errorFrame.error.code,
                  configuredDelayMs,
                  appliedDelayMs,
                  stage: request.stage,
                  atMs: round(deliveredAt),
                };
                ledger.websocketFrames += 1;
                ledger.faultFixtureEvents.push(fixtureEvent);
                ledger.websocketResponsePathDelays.push({
                  method: "turn/start",
                  configuredDelayMs,
                  appliedDelayMs,
                  isRpcResponse: true,
                  rpcIdFingerprint: request.rpcIdFingerprint,
                  actionId: request.actionId,
                  routeSocketId,
                  ...routeInfo,
                  receivedAtEpochMs: round(receivedAtEpochMs),
                  forwardedAtEpochMs: round(epochNow()),
                  stage: request.stage,
                  scenario: delayControl.scenarioId ?? null,
                  responseSource: "test-generated request-id-correlated JSON-RPC error; bypasses KCODER_STUDIO_MOCK runMock",
                });
                ledger.rpc.push({
                  method: "turn/start",
                  rpcIdFingerprint: request.rpcIdFingerprint,
                  actionId: request.actionId,
                  routeSocketId,
                  ...routeInfo,
                  durationMs: round(deliveredAt - request.sentAt),
                  configuredDelayMs,
                  methodResponseHoldMs: configuredDelayMs,
                  appliedMethodResponseHoldMs: appliedDelayMs,
                  responsePathAppliedDelayMs: appliedDelayMs,
                  requestSentAtEpochMs: round(request.sentAtEpochMs),
                  responseReceivedAtEpochMs: round(receivedAtEpochMs),
                  responseForwardedAtEpochMs: round(epochNow()),
                  ok: false,
                  errorCode: errorFrame.error.code,
                  responseSource: fixtureEvent.responseSource,
                });
                ledger.methodResponseHolds.push({
                  method: "turn/start",
                  configuredHoldMs: configuredDelayMs,
                  measuredHoldMs: appliedDelayMs,
                  ok: false,
                  responseSource: "test-generated JSON-RPC error fixture",
                  scenario: delayControl.scenarioId ?? null,
                  stage: request.stage,
                });
                ledger.rpcEvents.push({
                  direction: "response-forwarded",
                  method: "turn/start",
                  rpcIdFingerprint: request.rpcIdFingerprint,
                  atMs: round(deliveredAt),
                  atEpochMs: round(epochNow()),
                  stage: request.stage,
                  actionId: request.actionId,
                  routeSocketId,
                  ...routeInfo,
                  ok: false,
                  errorCode: errorFrame.error.code,
                  responseSource: "test-generated JSON-RPC error fixture",
                });
                pendingRpc.delete(String(frame.id));
                ledger.pendingRpcMethodCounts["turn/start"] = Math.max(0, (ledger.pendingRpcMethodCounts["turn/start"] ?? 1) - 1);
              })
              .catch(() => {
                ledger.websocketForwardErrors += 1;
                pendingRpc.delete(String(frame.id));
                ledger.pendingRpcMethodCounts["turn/start"] = Math.max(0, (ledger.pendingRpcMethodCounts["turn/start"] ?? 1) - 1);
              })
              .finally(() => { ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - 1); });
            return;
          }
          if (frame.method === "turn/receipt/read" && delayControl.receiptFixture) {
            const request = pendingRpc.get(String(frame.id));
            const receipt = delayControl.receiptFixture.read(frame.params, delayControl.receiptScope, routeSocketId);
            const response = { jsonrpc: frame.jsonrpc || "2.0", id: frame.id, result: { receipt } };
            socket.send(JSON.stringify(response));
            ledger.rpc.push({
              method: frame.method,
              rpcIdFingerprint: idFingerprint,
              actionId: ledger.currentActionId,
              routeSocketId,
              ...routeInfo,
              durationMs: round(performance.now() - request.sentAt),
              configuredDelayMs: 0,
              methodResponseHoldMs: 0,
              responsePathAppliedDelayMs: 0,
              responseSource: "in-memory fixture populated from observed isolated mock turn/start response",
              ok: Boolean(receipt),
            });
            ledger.rpcEvents.push({
              direction: "response-forwarded",
              method: frame.method,
              rpcIdFingerprint: idFingerprint,
              atMs: round(performance.now()),
              atEpochMs: round(epochNow()),
              stage: ledger.currentStage,
              actionId: ledger.currentActionId,
              routeSocketId,
              ...routeInfo,
              responseSource: "in-memory-test-fixture",
            });
            ledger.faultFixtureEvents.push({
              scenario: delayControl.scenarioId ?? "unspecified",
              kind: "turn-receipt-readback",
              exactObservedAcceptanceMatched: Boolean(receipt),
              receiptScopeFingerprint: receipt ? delayControl.receiptFixture.summary().acceptedIdentityFingerprints.find(row => row.threadIdFingerprint === sha256(frame.params?.threadId).slice(0, 16) && row.clientMessageIdFingerprint === sha256(frame.params?.clientMessageId).slice(0, 16))?.scopeFingerprint ?? null : null,
              threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
              receiptClientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
              routeSocketId,
              receiptFixtureKind: "in-memory isolated mock only; not durable Rust app-server evidence",
            });
            pendingRpc.delete(String(frame.id));
            ledger.pendingRpcMethodCounts[frame.method] = Math.max(0, (ledger.pendingRpcMethodCounts[frame.method] ?? 1) - 1);
            return;
          }
        }
      }
      upstream.send(raw);
    });
    upstream.onMessage(async raw => {
      const receivedAt = performance.now();
      const receivedAtEpochMs = epochNow();
      let frame = parseFrame(raw);
      const request = frame?.id !== undefined ? pendingRpc.get(String(frame.id)) : null;
      let controlledMinuteBoundary = null;
      if (refreshHomeMinuteBoundaryDiagnosticMode
        && request?.method === "thread/list"
        && request.stage?.includes(":home-resume-list-retention:")) {
        const targetThread = frame?.result?.threads?.find(thread => thread?.id === THREAD_ID);
        if (targetThread) {
          let boundary = controlledHomeMinuteBoundaryByStage.get(request.stage);
          if (!boundary) {
            const transitionEpochMs = round(receivedAtEpochMs + REFRESH_HOME_MINUTE_BOUNDARY_TARGET_OFFSET_MS);
            boundary = {
              transitionEpochMs,
              targetOffsetFromThreadListResponseMs: REFRESH_HOME_MINUTE_BOUNDARY_TARGET_OFFSET_MS,
              relativeTimeTransitionElapsedMs: REFRESH_HOME_MINUTE_BOUNDARY_ELAPSED_MS,
              fixtureUpdatedAtEpochMs: transitionEpochMs - REFRESH_HOME_MINUTE_BOUNDARY_ELAPSED_MS,
              injectedByTestRoute: true,
            };
            controlledHomeMinuteBoundaryByStage.set(request.stage, boundary);
          }
          targetThread.updatedAt = boundary.fixtureUpdatedAtEpochMs;
          controlledMinuteBoundary = { ...boundary };
        }
      }
      if (request?.method === "thread/list" && Array.isArray(frame?.result?.threads)) {
        const fixture = frame.result.threads.find(thread => thread?.id === THREAD_ID);
        if (fixture) ledger.homeThreadSnapshots.push({
          stage: request.stage,
          actionId: request.actionId,
          routeSocketId,
          serverId: SERVER_ID,
          threadId: fixture.id,
          title: typeof fixture.title === "string" ? fixture.title : null,
          status: typeof fixture.status === "string" ? fixture.status : null,
          cwd: typeof fixture.cwd === "string" ? fixture.cwd : null,
          updatedAt: typeof fixture.updatedAt === "number" ? fixture.updatedAt : null,
          controlledMinuteBoundary,
          responseAtEpochMs: round(receivedAtEpochMs),
        });
      }
      const method = request?.method ?? (typeof frame?.method === "string" ? frame.method : "notification");
      if (delayControl.scenarioId && ["turn/started", "turn/completed"].includes(frame?.method)) {
        const params = frame.params ?? {};
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId,
          kind: "turn-lifecycle-upstream-frame",
          method: frame.method,
          threadIdFingerprint: typeof params.threadId === "string" ? sha256(params.threadId).slice(0, 16) : null,
          turnIdFingerprint: typeof params.turnId === "string" ? sha256(params.turnId).slice(0, 16) : null,
          turnStatus: typeof params.turn?.status === "string" ? params.turn.status : null,
          routeSocketId,
          atMs: round(receivedAt),
          stage: ledger.currentStage,
          source: "upstream-mock-gateway-frame",
        });
      }
      if (delayControl.scenarioId && request?.method === "turn/interrupt") {
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId,
          kind: "turn-interrupt-upstream-response",
          interrupted: frame?.result?.interrupted === true,
          rpcIdFingerprint: request.rpcIdFingerprint,
          threadIdFingerprint: request.threadIdFingerprint,
          turnIdFingerprint: request.turnIdFingerprint,
          routeSocketId,
          atMs: round(receivedAt),
          stage: ledger.currentStage,
          source: "upstream-mock-gateway-response",
        });
      }
      if (delayControl.threadModelFixture && request && ["thread/read", "thread/resume"].includes(request.method) && frame?.result?.thread) {
        frame = {
          ...frame,
          result: {
            ...frame.result,
            thread: { ...frame.result.thread, model: "MiniMax-M3", modelProvider: "kunlunmeta" },
          },
        };
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId ?? "unspecified",
          kind: "typed-thread-model-fixture",
          method: request.method,
          modelFixture: "mock-minimax from KCODER_STUDIO_MOCK catalog",
          routeSocketId,
        });
      }
      if (request?.method === "initialize" && delayControl.testCapabilities && frame?.result?.capabilities) {
        frame = {
          ...frame,
          result: {
            ...frame.result,
            capabilities: {
              ...frame.result.capabilities,
              experimental: {
                ...frame.result.capabilities.experimental,
                ...delayControl.testCapabilities,
              },
            },
          },
        };
      }
      if (request?.method === "turn/start" && delayControl.receiptFixture) {
        request.receiptAcceptedAtMockResponse = delayControl.receiptFixture.observeTurnStartResponse(request.receiptRequestIdentity, frame, routeSocketId);
      }
      const responseJitter = delayControl.responseJitter?.next("rpc", method) ?? { sampleIndex: null, delayMs: 0 };
      const configuredDelayMs = sumResponseDelayMs(
        delayControl.delayMs ?? 0,
        delayControl.methodDelayMs?.[method] ?? 0,
        responseJitter.delayMs,
      );
      const dropResponse = Boolean(request)
        && delayControl.dropFirstResponseForMethod === method
        && !ledger.injectedWebSocketResponseDrops.some(row => row.scenario === delayControl.scenarioId && row.method === method);
      if (dropResponse) {
        ledger.injectedWebSocketResponseDrops.push({
          scenario: delayControl.scenarioId ?? "unspecified",
          method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          responseReceivedAtEpochMs: round(receivedAtEpochMs),
          acceptedObservedFromMockGateway: method === "turn/start" && request.receiptAcceptedAtMockResponse === true,
          threadIdFingerprint: request.receiptRequestIdentity ? sha256(request.receiptRequestIdentity.threadId).slice(0, 16) : null,
          clientMessageIdFingerprint: request.receiptRequestIdentity ? sha256(request.receiptRequestIdentity.clientMessageId).slice(0, 16) : null,
          receiptScopeFingerprint: request.receiptRequestIdentity?.scopeFingerprint ?? null,
          routeSocketId,
          responseForwarded: false,
          transportLayer: "single JSON-RPC response dropped in Playwright WebSocket route; not IP/TCP packet loss",
        });
        ledger.rpc.push({
          method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          actionId: request.actionId,
          routeSocketId,
          ...routeInfo,
          durationMs: round(performance.now() - request.sentAt),
          configuredDelayMs,
          responsePathAppliedDelayMs: null,
          responseReceivedAtEpochMs: round(receivedAtEpochMs),
          responseForwardedAtEpochMs: null,
          responseDroppedByFixture: true,
          ok: !frame?.error,
        });
        ledger.rpcEvents.push({
          direction: "response-dropped",
          method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          atMs: round(performance.now()),
          atEpochMs: round(epochNow()),
          stage: ledger.currentStage,
          actionId: request.actionId,
          routeSocketId,
          ...routeInfo,
        });
        pendingRpc.delete(String(frame.id));
        ledger.pendingRpcMethodCounts[method] = Math.max(0, (ledger.pendingRpcMethodCounts[method] ?? 1) - 1);
        if (delayControl.closeAfterDroppedResponse) {
          ledger.faultFixtureEvents.push({ scenario: delayControl.scenarioId ?? "unspecified", kind: "socket-closed-after-dropped-response", method });
          recordRoutedWebSocketCloseInvocation(ledger, routeSocketId, { code: 1012, reason: "isolated test reconnect", stage: ledger.currentStage, actionId: ledger.currentActionId });
          await socket.close({ code: 1012, reason: "isolated test reconnect" });
        }
        return;
      }
      // The WSS application delay starts when the upstream response frame arrives.
      const eligibleAt = receivedAt + configuredDelayMs;
      ledger.pendingWebSocketDeliveries += 1;
      const deliver = async appliedMethodResponseHoldMs => {
        ledger.websocketFrames += 1;
        if (configuredDelayMs > 0) await waitUntilPerformanceDeadline(eligibleAt);
        socket.send(frame && JSON.stringify(frame) !== String(raw) ? JSON.stringify(frame) : raw);
        const deliveredAt = performance.now();
        if (delayControl.scenarioId && ["turn/started", "turn/completed"].includes(frame?.method)) {
          const params = frame.params ?? {};
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId,
            kind: "turn-lifecycle-frame",
            method: frame.method,
            threadIdFingerprint: typeof params.threadId === "string" ? sha256(params.threadId).slice(0, 16) : null,
            turnIdFingerprint: typeof params.turnId === "string" ? sha256(params.turnId).slice(0, 16) : null,
            turnStatus: typeof params.turn?.status === "string" ? params.turn.status : null,
            routeSocketId,
            atMs: round(deliveredAt),
            stage: ledger.currentStage,
            source: "route-forwarded-to-browser",
          });
        }
        const appliedDelayMs = round(deliveredAt - receivedAt);
        ledger.websocketResponsePathDelays.push({
          method,
          configuredDelayMs,
          jitterSampleIndex: responseJitter.sampleIndex,
          jitterDelayMs: responseJitter.delayMs,
          appliedDelayMs,
          isRpcResponse: Boolean(request),
          rpcIdFingerprint: request?.rpcIdFingerprint ?? (frame?.id !== undefined ? rpcIdFingerprint(frame.id) : null),
          actionId: request?.actionId ?? ledger.currentActionId,
          routeSocketId,
          ...routeInfo,
          receivedAtEpochMs: round(receivedAtEpochMs),
          forwardedAtEpochMs: round(epochNow()),
          stage: ledger.currentStage,
          scenario: delayControl.scenarioId ?? null,
        });
        if (request) {
          ledger.rpc.push({
            method,
            rpcIdFingerprint: request.rpcIdFingerprint,
            actionId: request.actionId,
            routeSocketId,
            ...routeInfo,
            durationMs: round(performance.now() - request.sentAt),
            configuredDelayMs,
            methodResponseHoldMs: delayControl.methodResponseHoldMs?.[method] ?? 0,
            appliedMethodResponseHoldMs,
            responsePathAppliedDelayMs: appliedDelayMs,
            requestSentAtEpochMs: round(request.sentAtEpochMs),
            responseReceivedAtEpochMs: round(receivedAtEpochMs),
            responseForwardedAtEpochMs: round(epochNow()),
            ok: !frame?.error,
            timingBoundary: "browser RPC request to delayed response frame delivery through loopback Gateway; not physical RTT",
          });
          if ((delayControl.methodResponseHoldMs?.[method] ?? 0) > 0) ledger.methodResponseHolds.push({
            method,
            configuredHoldMs: delayControl.methodResponseHoldMs[method],
            measuredHoldMs: appliedMethodResponseHoldMs,
            ok: !frame?.error,
            scenario: delayControl.scenarioId ?? null,
            stage: request.stage,
          });
          pendingRpc.delete(String(frame.id));
          ledger.pendingRpcMethodCounts[method] = Math.max(0, (ledger.pendingRpcMethodCounts[method] ?? 1) - 1);
          ledger.rpcEvents.push({
            direction: "response-forwarded",
            method,
            rpcIdFingerprint: request.rpcIdFingerprint,
            atMs: round(performance.now()),
            atEpochMs: round(epochNow()),
            stage: ledger.currentStage,
            actionId: request.actionId,
            routeSocketId,
            ...routeInfo,
          });
        }
        if (request && delayControl.disconnectAfterMethodResponse === method) {
          const alreadyClosed = ledger.faultFixtureEvents.some(row => row.scenario === delayControl.scenarioId && row.kind === "socket-closed-after-response");
          if (!alreadyClosed) {
            ledger.faultFixtureEvents.push({ scenario: delayControl.scenarioId ?? "unspecified", kind: "socket-closed-after-response", method });
            recordRoutedWebSocketCloseInvocation(ledger, routeSocketId, { code: 1012, reason: "isolated test reconnect", stage: ledger.currentStage, actionId: ledger.currentActionId });
            await socket.close({ code: 1012, reason: "isolated test reconnect" });
          }
        }
      };
      const methodResponseHoldMs = sumResponseDelayMs(delayControl.methodResponseHoldMs?.[method] ?? 0);
      if (methodResponseHoldMs > 0 && request) {
        // Keep the original hold duration boundary at upstream-frame receipt.
        const methodResponseHoldDeadline = receivedAt + methodResponseHoldMs;
        const timer = setTimeout(() => {
          methodResponseHoldTimers.delete(timer);
          void (async () => {
            await waitUntilPerformanceDeadline(methodResponseHoldDeadline);
            const measuredHoldMs = round(performance.now() - receivedAt);
            await deliver(measuredHoldMs);
          })()
            .catch(() => { ledger.websocketForwardErrors += 1; })
            .finally(() => { ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - 1); });
        }, Math.max(0, methodResponseHoldDeadline - performance.now()));
        methodResponseHoldTimers.add(timer);
        return;
      }
      deliverQueue = deliverQueue
        .then(() => deliver(0))
        .catch(() => { ledger.websocketForwardErrors += 1; })
        .finally(() => { ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - 1); });
    });
    socket.onClose(() => {
      ledger.routedWebSocketCloseEvents.push({
        routeSocketId,
        atMs: round(performance.now()),
        atEpochMs: round(epochNow()),
        stage: ledger.currentStage,
        actionId: ledger.currentActionId,
        pendingRequests: [...pendingRpc.values()].map(request => ({
          method: request.method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          routeSocketId,
          startedAtEpochMs: round(request.sentAtEpochMs),
          stage: request.stage,
          actionId: request.actionId,
        })),
      });
      for (const request of pendingRpc.values()) {
        ledger.pendingRpcMethodCounts[request.method] = Math.max(0, (ledger.pendingRpcMethodCounts[request.method] ?? 1) - 1);
      }
      pendingRpc.clear();
    });
  });
}

async function waitForGatewayRpcQuiescence(network, timeoutMs = 30_000, quietMs = 200) {
  const startedAt = performance.now();
  let lastActivity = gatewayActivityFingerprint(network);
  let quietStartedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const currentActivity = gatewayActivityFingerprint(network);
    const pending = pendingGatewayActivity(network);
    if (currentActivity !== lastActivity) {
      lastActivity = currentActivity;
      quietStartedAt = performance.now();
    }
    if (pending.total === 0 && performance.now() - quietStartedAt >= quietMs) {
      const report = {
        status: "DRAINED",
        elapsedMs: round(performance.now() - startedAt),
        quietWindowMs: quietMs,
        pendingAtReturn: pending,
        activityFingerprint: currentActivity,
        atEpochMs: round(epochNow()),
      };
      network.quiescenceWaits.push(report);
      return report;
    }
    await delay(25);
  }
  const pendingAtTimeout = pendingGatewayActivity(network);
  const report = {
    status: "TIMEOUT",
    elapsedMs: round(performance.now() - startedAt),
    quietWindowMs: quietMs,
    pendingAtReturn: pendingAtTimeout,
    activityFingerprint: gatewayActivityFingerprint(network),
    atEpochMs: round(epochNow()),
  };
  network.quiescenceWaits.push(report);
  throw new Error(`Gateway response paths did not drain within ${timeoutMs}ms: ${JSON.stringify(pendingAtTimeout)}`);
}

function pendingGatewayActivity(network) {
  const pendingRpc = Object.values(network.pendingRpcMethodCounts).reduce((sum, count) => sum + count, 0);
  const pendingHttp = network.pendingHttpResponses;
  const pendingWebSocketDeliveries = network.pendingWebSocketDeliveries;
  return {
    httpResponses: pendingHttp,
    websocketDeliveries: pendingWebSocketDeliveries,
    rpcResponses: pendingRpc,
    total: pendingHttp + pendingWebSocketDeliveries + pendingRpc,
  };
}

function gatewayActivityFingerprint(network) {
  return [
    network.rpcEvents.length,
    network.rpc.length,
    network.http.length,
    network.httpResponsePathDelays.length,
    network.websocketFrames,
    network.websocketResponsePathDelays.length,
    network.browserFrames.length,
    network.routedWebSocketCloseEvents.length,
  ].join(":");
}

function snapshotNetworkEvidence(network) {
  const { requestStarts: _requestStarts, ...evidence } = network;
  const snapshot = JSON.parse(JSON.stringify(evidence));
  return deepFreeze(snapshot);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function createNetworkLedger() {
  return {
    pendingHttpResponses: 0,
    pendingWebSocketDeliveries: 0,
    quiescenceWaits: [],
    http: [],
    rpc: [],
    httpRouteRequests: [],
    httpRouteRequestSequence: 0,
    httpResponsePathDelays: [],
    websocketResponsePathDelays: [],
    websocketFrames: 0,
    websocketForwardErrors: 0,
    methodResponseHolds: [],
    injectedHttpStatuses: [],
    injectedWebSocketResponseDrops: [],
    faultFixtureEvents: [],
    rpcMethodCounts: Object.create(null),
    pendingRpcMethodCounts: Object.create(null),
    rpcEvents: [],
    homeThreadSnapshots: [],
    browserFrames: [],
    browserFrameMethodCounts: Object.create(null),
    browserWebSocketPaths: [],
    browserWebSocketConnections: [],
    browserSocketSequence: 0,
    applicationPageSequence: 0,
    applicationWebSocketConnections: [],
    applicationWebSocketFrames: [],
    applicationWebSocketCaptureHealth: [],
    routedWebSocketConnections: [],
    routedWebSocketCloseEvents: [],
    routedWebSocketCloseInvocations: [],
    routedSocketSequence: 0,
    navigationSampleSequence: 0,
    currentStage: "startup",
    currentActionId: null,
    currentAction: null,
    drawerClosedListChecks: [],
    drawerCloseListChecks: [],
    failedRequests: Object.create(null),
    requestStarts: new WeakMap(),
  };
}

function summarizeObservations(observations) {
  const groups = new Map();
  for (const observation of observations) {
    const key = `${observation.action}|${observation.cacheClass}|${observation.delayMs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const [action, cacheClass, delayText] = key.split("|");
    const values = entries.filter(entry => entry.ok && Number.isFinite(entry.durationMs)).map(entry => entry.durationMs).sort((a, b) => a - b);
    return {
      action,
      cacheClass,
      configuredApplicationDelayMs: Number(delayText),
      sampleCount: entries.length,
      successCount: entries.filter(entry => entry.ok).length,
      errorCount: entries.filter(entry => !entry.ok).length,
      errorRate: entries.length ? Number((entries.filter(entry => !entry.ok).length / entries.length).toFixed(4)) : 0,
      percentileEligibility: values.length >= DEFAULT_SAMPLES ? "30+ samples" : "SMOKE_ONLY",
      p50Ms: values.length >= DEFAULT_SAMPLES ? percentile(values, 0.50) : null,
      p95Ms: values.length >= DEFAULT_SAMPLES ? percentile(values, 0.95) : null,
      maxMs: values.length ? values.at(-1) : null,
    };
  }).sort((a, b) => a.configuredApplicationDelayMs - b.configuredApplicationDelayMs || a.action.localeCompare(b.action) || a.cacheClass.localeCompare(b.cacheClass));
}

function scenarioStatus(rows, scenario) {
  return rows.find(row => row.scenario === scenario)?.status ?? "NOT_RUN";
}

function summarizeNetwork(network) {
  const group = rows => {
    const groups = new Map();
    for (const row of rows) {
      const key = row.path || row.method;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.entries()].map(([key, entries]) => {
      const values = entries.map(entry => entry.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
      return {
        key,
        samples: entries.length,
        ...(refreshSingleSampleMode ? { percentileEligibility: refreshCoverageMode, percentilesReported: false } : { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) }),
        maxMs: values.length ? values.at(-1) : null,
      };
    });
  };
  return {
      httpByPath: group(network.http),
      httpRouteRequests: network.httpRouteRequests,
      httpResponsePathResponses: network.httpResponsePathDelays.map(item => ({
        routeRequestOrdinal: item.routeRequestOrdinal,
        apiPath: item.apiPath,
        configuredDelayMs: item.configuredDelayMs,
        jitterDelayMs: item.jitterDelayMs,
        appliedDelayMs: item.appliedDelayMs,
        status: item.status,
        stage: item.stage,
        scenario: item.scenario,
      })),
    rpcByMethod: group(network.rpc.map(row => ({ ...row, path: row.method || row.path }))),
    rpcTransactions: network.rpc,
    httpResponsePathFrames: network.httpResponsePathDelays.length,
    httpAppliedDelayByPath: group(network.httpResponsePathDelays.map(row => ({ path: row.path, durationMs: row.appliedDelayMs, configuredDelayMs: row.configuredDelayMs }))),
    websocketResponseFrames: network.websocketFrames,
    websocketResponsePathFrames: network.websocketResponsePathDelays.length,
    websocketResponseDelayDistributionMs: distribution(network.websocketResponsePathDelays.map(row => row.configuredDelayMs)),
    websocketAppliedDelayByMethod: group(network.websocketResponsePathDelays.map(row => ({ method: row.method, durationMs: row.appliedDelayMs, configuredDelayMs: row.configuredDelayMs }))),
    websocketResponsePathEvents: network.websocketResponsePathDelays,
    injectedHttpStatuses: network.injectedHttpStatuses,
    injectedWebSocketResponseDrops: network.injectedWebSocketResponseDrops,
    faultFixtureEvents: network.faultFixtureEvents,
    rpcMethodCounts: network.rpcMethodCounts,
    browserFrameMethodCounts: network.browserFrameMethodCounts,
    browserWebSocketPaths: network.browserWebSocketPaths,
    browserWebSocketConnections: network.browserWebSocketConnections,
    routedWebSocketConnections: network.routedWebSocketConnections,
    routedWebSocketCloseEvents: network.routedWebSocketCloseEvents,
    routedWebSocketCloseInvocations: network.routedWebSocketCloseInvocations,
    applicationWebSocketConnections: network.applicationWebSocketConnections,
    applicationWebSocketFrames: network.applicationWebSocketFrames,
    applicationWebSocketCaptureHealth: network.applicationWebSocketCaptureHealth,
    browserWebSocketConnectionCount: network.browserWebSocketConnections.length,
    routedWebSocketConnectionCount: network.routedWebSocketConnections.length,
    browserFrames: network.browserFrames,
    pendingRpcMethodCounts: network.pendingRpcMethodCounts,
    pendingHttpResponses: network.pendingHttpResponses,
    pendingWebSocketDeliveries: network.pendingWebSocketDeliveries,
    quiescenceWaits: network.quiescenceWaits,
    rpcEvents: network.rpcEvents,
    drawerClosedListChecks: network.drawerClosedListChecks,
    drawerCloseListChecks: network.drawerCloseListChecks,
    failedRequests: network.failedRequests,
    websocketForwardErrors: network.websocketForwardErrors,
  };
}

function correlateRpcFrames(network) {
  const browserRequests = network.applicationWebSocketFrames.filter(frame => frame.direction === "sent" && frame.hasId && frame.method);
  const routeRequests = network.rpcEvents.filter(event => event.direction === "request" && event.hasId && event.method);
  const socketPairing = pairApplicationAndRouteSockets(
    network.applicationWebSocketConnections,
    network.routedWebSocketConnections,
    network.applicationWebSocketFrames,
    network.rpcEvents,
  );
  const socketPairs = socketPairing.pairs;
  const routeSocketByApplicationSocket = new Map(socketPairs.map(pair => [`${pair.applicationPageId}:${pair.applicationSocketId}`, pair.routeSocketId]));
  const requestKey = (row, routeSocketId) => `${routeSocketId}|${row.method}|${row.rpcIdFingerprint}`;
  const routeRequestCandidates = new Map();
  routeRequests.forEach((event, index) => {
    const key = requestKey(event, event.routeSocketId);
    if (!routeRequestCandidates.has(key)) routeRequestCandidates.set(key, []);
    routeRequestCandidates.get(key).push({ index, event, used: false });
  });
  const matchedRequests = [];
  const unmatchedBrowserRequests = [];
  for (const browserFrame of browserRequests) {
    const routeSocketId = routeSocketByApplicationSocket.get(`${browserFrame.pageId}:${browserFrame.socketId}`);
    const candidates = routeSocketId === undefined ? [] : routeRequestCandidates.get(requestKey(browserFrame, routeSocketId)) ?? [];
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.used) continue;
      const routeEvent = candidate.event;
      const delta = Math.abs(browserFrame.atEpochMs - routeEvent.atEpochMs);
      if (delta < bestDelta) {
        best = candidate;
        bestDelta = delta;
      }
    }
    if (!best || bestDelta > 2_000) {
      unmatchedBrowserRequests.push({
        method: browserFrame.method,
        rpcIdFingerprint: browserFrame.rpcIdFingerprint,
        applicationPageId: browserFrame.pageId,
        applicationSocketId: browserFrame.socketId,
        routeSocketId: routeSocketId ?? null,
        browserAtEpochMs: browserFrame.atEpochMs,
      });
      continue;
    }
    best.used = true;
    matchedRequests.push({
      method: browserFrame.method,
      rpcIdFingerprint: browserFrame.rpcIdFingerprint,
      browserActionId: best.event.actionId,
      routeActionId: best.event.actionId,
      applicationPageId: browserFrame.pageId,
      applicationSocketId: browserFrame.socketId,
      routeSocketId: best.event.routeSocketId,
      browserAtEpochMs: browserFrame.atEpochMs,
      routeAtEpochMs: best.event.atEpochMs,
      routeMinusBrowserMs: round(best.event.atEpochMs - browserFrame.atEpochMs),
    });
  }
  const unmatchedRouteRequests = routeRequests.flatMap((event, index) => routeRequestCandidates.get(requestKey(event, event.routeSocketId))?.find(candidate => candidate.index === index)?.used ? [] : [{
    method: event.method,
    rpcIdFingerprint: event.rpcIdFingerprint,
    actionId: event.actionId,
    routeSocketId: event.routeSocketId,
    routeAtEpochMs: event.atEpochMs,
  }]);
  const routeResponses = network.rpc.filter(row => row.rpcIdFingerprint && Number.isFinite(row.responseForwardedAtEpochMs));
  const delayedRouteResponses = routeResponses.filter(row => row.configuredDelayMs > 0);
  const browserResponses = network.applicationWebSocketFrames.filter(frame => frame.direction === "received" && frame.hasId && (frame.hasResult || frame.hasError));
  const responseCandidates = new Map();
  browserResponses.forEach((frame, index) => {
    const routeSocketId = routeSocketByApplicationSocket.get(`${frame.pageId}:${frame.socketId}`);
    if (routeSocketId === undefined) return;
    const key = `${routeSocketId}|${frame.rpcIdFingerprint}`;
    if (!responseCandidates.has(key)) responseCandidates.set(key, []);
    responseCandidates.get(key).push({ index, frame, routeSocketId, used: false });
  });
  const matchedRouteResponses = [];
  const matchedDelayedResponses = [];
  const unmatchedRouteResponses = [];
  const matchedBrowserResponseIndexes = new Set();
  for (const routeResponse of routeResponses) {
    const responseKey = `${routeResponse.routeSocketId}|${routeResponse.rpcIdFingerprint}`;
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of responseCandidates.get(responseKey) ?? []) {
      if (candidate.used) continue;
      const browserFrame = candidate.frame;
      const delta = Math.abs(browserFrame.atEpochMs - routeResponse.responseForwardedAtEpochMs);
      if (delta < bestDelta) {
        best = candidate;
        bestDelta = delta;
      }
    }
    const maxClockSkewMs = 2_000;
    if (!best || bestDelta > maxClockSkewMs) {
      unmatchedRouteResponses.push({
        method: routeResponse.method,
        rpcIdFingerprint: routeResponse.rpcIdFingerprint,
        actionId: routeResponse.actionId,
        routeSocketId: routeResponse.routeSocketId,
        configuredDelayMs: routeResponse.configuredDelayMs,
        forwardedAtEpochMs: routeResponse.responseForwardedAtEpochMs,
      });
      continue;
    }
    best.used = true;
    matchedBrowserResponseIndexes.add(best.index);
    const match = {
      method: routeResponse.method,
      rpcIdFingerprint: routeResponse.rpcIdFingerprint,
      actionId: routeResponse.actionId,
      routeSocketId: routeResponse.routeSocketId,
      applicationPageId: best.frame.pageId,
      applicationSocketId: best.frame.socketId,
      configuredDelayMs: routeResponse.configuredDelayMs,
      routeForwardedAtEpochMs: routeResponse.responseForwardedAtEpochMs,
      browserReceivedAtEpochMs: best.frame.atEpochMs,
    nativeObserverMinusRouteForwardedMs: round(best.frame.atEpochMs - routeResponse.responseForwardedAtEpochMs),
    };
    matchedRouteResponses.push(match);
    if (routeResponse.configuredDelayMs > 0) matchedDelayedResponses.push(match);
  }
  const unmatchedBrowserResponses = browserResponses.flatMap((frame, index) => matchedBrowserResponseIndexes.has(index) ? [] : [{
    method: frame.method,
    rpcIdFingerprint: frame.rpcIdFingerprint,
    applicationPageId: frame.pageId,
    applicationSocketId: frame.socketId,
    routeSocketId: routeSocketByApplicationSocket.get(`${frame.pageId}:${frame.socketId}`) ?? null,
    receivedAtEpochMs: frame.atEpochMs,
  }]);
  const countByMethod = rows => Object.fromEntries([...new Set(rows.map(row => row.method))].sort().map(method => [method, rows.filter(row => row.method === method).length]));
  const percentage = (matched, total) => total === 0 ? null : Number((matched * 100 / total).toFixed(1));
  const preShimNativeObserverBeforeForward = matchedDelayedResponses.filter(row => row.nativeObserverMinusRouteForwardedMs < -50);
  const preShimNativeObserverOffsetByConfiguredDelayMs = Object.fromEntries([...new Set(matchedDelayedResponses.map(row => row.configuredDelayMs))].sort((a, b) => a - b).map(delayMs => {
    const rows = matchedDelayedResponses.filter(row => row.configuredDelayMs === delayMs);
    return [delayMs, {
      count: rows.length,
      beforeForwardCount: rows.filter(row => row.nativeObserverMinusRouteForwardedMs < -50).length,
      offsetsMs: rows.map(row => row.nativeObserverMinusRouteForwardedMs),
    }];
  }));
  return {
    browserRequestCount: browserRequests.length,
    routeRequestCount: routeRequests.length,
    matchedRequestCount: matchedRequests.length,
    requestCoveragePercent: percentage(matchedRequests.length, browserRequests.length),
    browserRequestsByMethod: countByMethod(browserRequests),
    routeRequestsByMethod: countByMethod(routeRequests),
    unmatchedBrowserRequestsByMethod: countByMethod(unmatchedBrowserRequests),
    unmatchedRouteRequestsByMethod: countByMethod(unmatchedRouteRequests),
    matchedRequests,
    unmatchedBrowserRequests,
    unmatchedRouteRequests,
    browserResponseCount: browserResponses.length,
    routeResponseCount: routeResponses.length,
    matchedRouteResponseCount: matchedRouteResponses.length,
    unmatchedRouteResponses,
    unmatchedBrowserResponses,
    delayedRouteResponseCount: delayedRouteResponses.length,
    matchedDelayedResponseCount: matchedDelayedResponses.length,
    responseCoveragePercent: percentage(matchedRouteResponses.length, routeResponses.length),
    browserResponseCoveragePercent: percentage(matchedRouteResponses.length, browserResponses.length),
    delayedResponseCoveragePercent: percentage(matchedDelayedResponses.length, delayedRouteResponses.length),
    matchedDelayedResponses,
    preShimNativeObserverBeforeForwardCount: preShimNativeObserverBeforeForward.length,
    preShimNativeObserverOffsetByConfiguredDelayMs,
    applicationDispatchReceiptObserved: false,
    responseObservationLayer: "Playwright-captured native WebSocket transport before WebSocketMock dispatch",
    unmatchedDelayedResponses: unmatchedRouteResponses.filter(row => row.configuredDelayMs > 0),
    socketPairCount: socketPairs.length,
    applicationWebSocketCount: network.applicationWebSocketConnections.length,
    routedWebSocketCount: network.routedWebSocketConnections.length,
    socketPairs,
    ambiguousSocketGroups: socketPairing.ambiguousGroups,
    unpairedApplicationSockets: socketPairing.unpairedApplicationSockets,
    unpairedRouteSockets: socketPairing.unpairedRouteSockets,
    playwrightTransportObserverResponseCount: network.browserFrames.filter(frame => frame.direction === "received" && frame.hasId && (frame.hasResult || frame.hasError)).length,
  };
}

function pairApplicationAndRouteSockets(applicationSockets, routeSockets, applicationFrames, routeEvents) {
  const routeMetadataKey = row => JSON.stringify([
    row.path,
    row.serverFingerprint,
    row.channelFingerprint,
    row.workspaceFingerprint,
  ]);
  const appSequence = new Map();
  for (const socket of applicationSockets) {
    const rows = applicationFrames
      .filter(frame => frame.pageId === socket.pageId && frame.socketId === socket.socketId && frame.direction === "sent" && frame.method)
      .sort((a, b) => a.atEpochMs - b.atEpochMs)
      .map(frame => `${frame.method}|${frame.rpcIdFingerprint ?? "-"}`);
    appSequence.set(`${socket.pageId}:${socket.socketId}`, rows);
  }
  const routeSequence = new Map();
  for (const socket of routeSockets) {
    const rows = routeEvents
      .filter(event => event.routeSocketId === socket.id && event.direction === "request" && event.method)
      .sort((a, b) => a.atEpochMs - b.atEpochMs)
      .map(event => `${event.method}|${event.rpcIdFingerprint ?? "-"}`);
    routeSequence.set(String(socket.id), rows);
  }
  const appGroups = new Map();
  const routeGroups = new Map();
  for (const socket of applicationSockets) {
    const key = `${routeMetadataKey(socket)}|${JSON.stringify(appSequence.get(`${socket.pageId}:${socket.socketId}`) ?? [])}`;
    if (!appGroups.has(key)) appGroups.set(key, []);
    appGroups.get(key).push(socket);
  }
  for (const socket of routeSockets) {
    const key = `${routeMetadataKey(socket)}|${JSON.stringify(routeSequence.get(String(socket.id)) ?? [])}`;
    if (!routeGroups.has(key)) routeGroups.set(key, []);
    routeGroups.get(key).push(socket);
  }
  const groupKeys = new Set([...appGroups.keys(), ...routeGroups.keys()]);
  const usedApplication = new Set();
  const usedRoute = new Set();
  const pairs = [];
  const ambiguousGroups = [];
  const makePair = (applicationSocket, routeSocket, mode) => {
    const deltaMs = Math.abs(applicationSocket.atEpochMs - routeSocket.atEpochMs);
    if (deltaMs > 5_000) return false;
    const applicationKey = `${applicationSocket.pageId}:${applicationSocket.socketId}`;
    if (usedApplication.has(applicationKey) || usedRoute.has(routeSocket.id)) return false;
    usedApplication.add(applicationKey);
    usedRoute.add(routeSocket.id);
    pairs.push({
      applicationPageId: applicationSocket.pageId,
      applicationSocketId: applicationSocket.socketId,
      routeSocketId: routeSocket.id,
      path: routeSocket.path,
      serverFingerprint: routeSocket.serverFingerprint,
      channelFingerprint: routeSocket.channelFingerprint,
      workspaceFingerprint: routeSocket.workspaceFingerprint,
      requestSequenceFingerprint: sha256(JSON.stringify(appSequence.get(applicationKey) ?? [])).slice(0, 16),
      socketOpenedAtEpochMs: applicationSocket.atEpochMs,
      routeInstalledAtEpochMs: routeSocket.atEpochMs,
      absoluteOpenSkewMs: round(deltaMs),
      pairingMode: mode,
    });
    return true;
  };
  for (const key of groupKeys) {
    const appGroup = (appGroups.get(key) ?? []).slice().sort((a, b) => a.atEpochMs - b.atEpochMs);
    const routeGroup = (routeGroups.get(key) ?? []).slice().sort((a, b) => a.atEpochMs - b.atEpochMs);
    if (appGroup.length === routeGroup.length) {
      for (let index = 0; index < appGroup.length; index += 1) makePair(appGroup[index], routeGroup[index], appGroup.length === 1 ? "unique-metadata-and-full-request-sequence" : "identical-full-sequence-ordered-by-open-time");
      continue;
    }
    if (appGroup.length === 1 && routeGroup.length === 1) {
      if (makePair(appGroup[0], routeGroup[0], "unique-metadata-and-full-request-sequence")) continue;
    }
    if (appGroup.length || routeGroup.length) {
      const representative = appGroup[0] ?? routeGroup[0];
      const sequence = appGroup[0]
        ? appSequence.get(`${appGroup[0].pageId}:${appGroup[0].socketId}`) ?? []
        : routeSequence.get(String(routeGroup[0].id)) ?? [];
      ambiguousGroups.push({
        path: representative.path,
        serverFingerprint: representative.serverFingerprint,
        channelFingerprint: representative.channelFingerprint,
        workspaceFingerprint: representative.workspaceFingerprint,
        requestSequenceFingerprint: sha256(JSON.stringify(sequence)).slice(0, 16),
        applicationSocketCount: appGroup.length,
        routeSocketCount: routeGroup.length,
        reason: "Full method/ID request sequence and sanitized route metadata did not define a one-to-one timestamp-bounded socket pairing",
      });
    }
  }
  return {
    pairs: pairs.sort((a, b) => a.routeSocketId - b.routeSocketId),
    ambiguousGroups,
    unpairedApplicationSockets: applicationSockets.filter(row => !usedApplication.has(`${row.pageId}:${row.socketId}`)).map(row => ({
      pageId: row.pageId,
      socketId: row.socketId,
      path: row.path,
      serverFingerprint: row.serverFingerprint,
      channelFingerprint: row.channelFingerprint,
      workspaceFingerprint: row.workspaceFingerprint,
    })),
    unpairedRouteSockets: routeSockets.filter(row => !usedRoute.has(row.id)).map(row => ({
      routeSocketId: row.id,
      path: row.path,
      serverFingerprint: row.serverFingerprint,
      channelFingerprint: row.channelFingerprint,
      workspaceFingerprint: row.workspaceFingerprint,
    })),
  };
}

function summarizeActionTimelines(observations, network) {
  const actions = new Set([
    "task-shell-title-visible",
    "history-first-content-visible",
    "composer-ready",
    "return-home",
    "refresh-home",
    "drawer-open",
    "drawer-close",
    "input-feedback",
  ]);
  return observations.filter(row => row.actionId && actions.has(row.action)).map(row => {
    const pointerDownAt = row.pointerDownAtEpochMs;
    const routeTransactions = network.rpc.filter(rpc => rpc.actionId === row.actionId).map(rpc => ({
      method: rpc.method,
      rpcIdFingerprint: rpc.rpcIdFingerprint,
      configuredDelayMs: rpc.configuredDelayMs,
      requestSentAtEpochMs: rpc.requestSentAtEpochMs,
      responseReceivedAtEpochMs: rpc.responseReceivedAtEpochMs,
      responseForwardedAtEpochMs: rpc.responseForwardedAtEpochMs,
      requestAfterPointerDownMs: Number.isFinite(pointerDownAt) ? round(rpc.requestSentAtEpochMs - pointerDownAt) : null,
      responseAfterPointerDownMs: Number.isFinite(pointerDownAt) ? round(rpc.responseForwardedAtEpochMs - pointerDownAt) : null,
      visibleBeforeResponseForwarded: Number.isFinite(row.paintFeedbackAtEpochMs) ? row.paintFeedbackAtEpochMs < rpc.responseForwardedAtEpochMs : null,
      responsePathAppliedDelayMs: rpc.responsePathAppliedDelayMs,
      routeSocketId: rpc.routeSocketId,
    }));
    const browserRequests = network.browserFrames.filter(frame => frame.actionId === row.actionId && frame.direction === "sent" && frame.hasId && frame.method).map(frame => ({
      method: frame.method,
      rpcIdFingerprint: frame.rpcIdFingerprint,
      socketId: frame.socketId,
      atEpochMs: frame.atEpochMs,
      afterPointerDownMs: Number.isFinite(pointerDownAt) ? round(frame.atEpochMs - pointerDownAt) : null,
    }));
    return {
      action: row.action,
      actionId: row.actionId,
      cacheClass: row.cacheClass,
      configuredApplicationDelayMs: row.delayMs,
      ok: row.ok,
      clickStartedAtEpochMs: row.pointerDownAtEpochMs,
      domReadyAtEpochMs: row.domReadyAtEpochMs,
      visibleAtEpochMs: row.paintFeedbackAtEpochMs,
      domReadyMs: row.domReadyMs,
      visibleMs: row.paintFeedbackMs,
      targetSharesClickWith: observations.filter(other => other.actionId === row.actionId && other.action !== row.action).map(other => other.action),
      browserRpcRequests: browserRequests,
      routedRpcTransactions: routeTransactions,
    };
  });
}

function createCoverageLedger(delays, sampleCount, observations, network, gatewayCalls, snapshotMode) {
  const getSamples = (action, cacheClass, delayMs) => observations.filter(entry => entry.action === action && entry.cacheClass === cacheClass && entry.delayMs === delayMs && entry.ok).length;
  const requiredActionsByCache = {
    "hot-runtime": ["task-shell-title-visible", "history-first-content-visible", "composer-ready", "return-home", "drawer-open", "drawer-close", "input-feedback", "send-local-pending", "mock-gateway-turn-start-ack"],
    "cold-runtime-warm-profile": ["task-shell-title-visible", "history-first-content-visible", "composer-ready", "return-home", "refresh-home", "drawer-open", "drawer-close", "input-feedback", "send-local-pending", "mock-gateway-turn-start-ack"],
  };
  const core = delays.flatMap(delayMs => Object.entries(requiredActionsByCache).flatMap(([cacheClass, actions]) => actions.map(action => ({
    action,
    cacheClass,
    delayMs,
    samples: getSamples(action, cacheClass, delayMs),
    samplesPerRun: sampleCount,
    requiredByPlan: DEFAULT_SAMPLES,
    status: getSamples(action, cacheClass, delayMs) >= DEFAULT_SAMPLES ? "PASS" : getSamples(action, cacheClass, delayMs) > 0 ? "SMOKE" : "NOT_RUN",
  }))));
  const bothTransports = network.httpResponsePathDelays.length > 0 && network.websocketFrames > 0 && network.websocketResponsePathDelays.length > 0;
  const rpcFrameCorrelation = correlateRpcFrames(network);
  const applicationCaptureComplete = network.applicationWebSocketCaptureHealth.length > 0
    && network.applicationWebSocketCaptureHealth.every(row => row.socketOverflowCount === 0 && row.frameOverflowCount === 0 && row.storageWriteFailureCount === 0);
  const positiveDelays = delays.filter(delayMs => delayMs > 0);
  const websocketRouteCoverage = rpcFrameCorrelation.requestCoveragePercent === 100
    && rpcFrameCorrelation.responseCoveragePercent === 100
    && rpcFrameCorrelation.browserResponseCoveragePercent === 100
    && (positiveDelays.length === 0 || rpcFrameCorrelation.delayedResponseCoveragePercent === 100);
  const drawerClosedNoScans = network.drawerClosedListChecks.length > 0 && network.drawerClosedListChecks.every(row => row.requestsAfterTaskEntryBeforeDrawerOpen === 0);
  const drawerCloseNoScans = network.drawerCloseListChecks.length > 0 && network.drawerCloseListChecks.every(row => row.requestsAfterClose === 0);
  const baselineDrawerClosedStatus = drawerClosedNoScans ? "BASELINE_ZERO_OBSERVED" : "BASELINE_SCAN_OBSERVED";
  const drawerClosedStatus = snapshotMode === "before" ? baselineDrawerClosedStatus : drawerClosedNoScans ? "PASS" : "FAIL";
  const expectedMockTurnStarts = observations.filter(sample => sample.action === "send-local-pending").length;
  const observedBrowserTurnStarts = network.browserFrameMethodCounts["turn/start"] ?? 0;
  const configuredDelayEffect = positiveDelays.length > 0 && positiveDelays.every(delayMs =>
    network.httpResponsePathDelays.some(row => row.configuredDelayMs === delayMs && Number.isFinite(row.appliedDelayMs) && row.appliedDelayMs >= row.configuredDelayMs - APPLICATION_DELAY_TIMER_TOLERANCE_MS) &&
    network.websocketResponsePathDelays.some(row => row.configuredDelayMs === delayMs && Number.isFinite(row.appliedDelayMs) && row.appliedDelayMs >= row.configuredDelayMs - APPLICATION_DELAY_TIMER_TOLERANCE_MS));
  return {
    overallStatus: "PARTIAL",
    note: "P0 Mobile Web browser measurement only. PASS is scoped to the listed loopback/mock scenarios; unrun plan matrix rows remain explicit.",
    delayDefinition: "extra one-way delay applied after HTTP Gateway responses and before server-to-browser WebSocket frame delivery; not RTT or packet loss",
    coreSamples: core,
    rpcFrameCorrelation,
    matrix: [
      { id: "http-and-wss-response-path-observed", status: bothTransports ? "PATH_OBSERVED" : "PARTIAL", configuredDelaysMs: delays, httpResponseSamples: network.httpResponsePathDelays.length, websocketResponseFrames: network.websocketResponsePathDelays.length, timingBoundary: "delay is injected at HTTP response / server-to-browser frame path; configured zero validates routing only" },
      { id: "websocket-route-coverage", status: websocketRouteCoverage ? "PASS" : "PARTIAL", browserWebSocketCount: network.browserWebSocketConnections.length, routedWebSocketCount: network.routedWebSocketConnections.length, preShimNativeWebSocketCount: rpcFrameCorrelation.applicationWebSocketCount, socketPairCount: rpcFrameCorrelation.socketPairCount, ambiguousSocketGroups: rpcFrameCorrelation.ambiguousSocketGroups, browserObservedOutboundMethodCounts: network.browserFrameMethodCounts, preShimNativeRpcRequestFrames: rpcFrameCorrelation.browserRequestCount, routeRpcRequestFrames: rpcFrameCorrelation.routeRequestCount, matchedRequestFrames: rpcFrameCorrelation.matchedRequestCount, requestCoveragePercent: rpcFrameCorrelation.requestCoveragePercent, preShimNativeRpcResponses: rpcFrameCorrelation.browserResponseCount, routeRpcResponses: rpcFrameCorrelation.routeResponseCount, matchedRpcResponses: rpcFrameCorrelation.matchedRouteResponseCount, responseCoveragePercent: rpcFrameCorrelation.responseCoveragePercent, browserResponseCoveragePercent: rpcFrameCorrelation.browserResponseCoveragePercent, delayedRouteResponses: rpcFrameCorrelation.delayedRouteResponseCount, matchedDelayedResponses: rpcFrameCorrelation.matchedDelayedResponseCount, delayedResponseCoveragePercent: rpcFrameCorrelation.delayedResponseCoveragePercent, unmatchedBrowserRequestsByMethod: rpcFrameCorrelation.unmatchedBrowserRequestsByMethod, unmatchedRouteRequestsByMethod: rpcFrameCorrelation.unmatchedRouteRequestsByMethod, unmatchedDelayedResponses: rpcFrameCorrelation.unmatchedDelayedResponses, evidenceLayer: "native transport observations before Playwright WebSocketMock app dispatch", reason: websocketRouteCoverage ? null : "Native transport observations must correlate with routed request/response frames on a uniquely paired socket" },
      { id: "browser-route-rpc-frame-correlation", status: websocketRouteCoverage ? "PASS" : "PARTIAL", browserRequestsByMethod: rpcFrameCorrelation.browserRequestsByMethod, routeRequestsByMethod: rpcFrameCorrelation.routeRequestsByMethod, unmatchedBrowserRequests: rpcFrameCorrelation.unmatchedBrowserRequests, matchedRequestFrames: rpcFrameCorrelation.matchedRequestCount, unmatchedRouteRequests: rpcFrameCorrelation.unmatchedRouteRequests, unmatchedBrowserResponses: rpcFrameCorrelation.unmatchedBrowserResponses, unmatchedRouteResponses: rpcFrameCorrelation.unmatchedRouteResponses, matchedDelayedResponses: rpcFrameCorrelation.matchedDelayedResponses, ambiguousSocketGroups: rpcFrameCorrelation.ambiguousSocketGroups, preShimNativeObserverBeforeForwardCount: rpcFrameCorrelation.preShimNativeObserverBeforeForwardCount, preShimNativeObserverOffsetByConfiguredDelayMs: rpcFrameCorrelation.preShimNativeObserverOffsetByConfiguredDelayMs, timingBoundary: "Playwright-captured native transport observation correlated to routed RPC frames; it is upstream of WebSocketMock dispatch and is not app receipt" },
      { id: "pre-shim-native-websocket-evidence-capture", status: applicationCaptureComplete ? "DIAGNOSTIC_ONLY" : "FAIL", pageDrainCount: network.applicationWebSocketCaptureHealth.length, maxSocketsPerPage: Math.min(...network.applicationWebSocketCaptureHealth.map(row => row.maxSocketsPerPage)), maxFramesPerPage: Math.min(...network.applicationWebSocketCaptureHealth.map(row => row.maxFramesPerPage)), socketOverflowCount: network.applicationWebSocketCaptureHealth.reduce((sum, row) => sum + row.socketOverflowCount, 0), frameOverflowCount: network.applicationWebSocketCaptureHealth.reduce((sum, row) => sum + row.frameOverflowCount, 0), storageWriteFailureCount: network.applicationWebSocketCaptureHealth.reduce((sum, row) => sum + row.storageWriteFailureCount, 0), captureLayer: "native WebSocket captured before Playwright installs WebSocketMock", evidence: "bounded native transport observations are drained into Node after samples; this is not application-level receipt evidence" },
      { id: "application-websocket-dispatch-receipt", status: "UNVERIFIED", reason: "Playwright routeWebSocket captures the native constructor and replaces the page global with WebSocketMock; this initScript observes upstream native events, not dispatch into the app WebSocketMock/EventTarget. Delayed route forwarding and DOM visibility are measured separately." },
      { id: "positive-response-delay-effect", status: positiveDelays.length === 0 ? "NOT_RUN" : configuredDelayEffect ? "PASS" : "FAIL", configuredDelaysMs: positiveDelays, timingBoundary: "configured application-path hold, explicitly not network RTT" },
      { id: "fixture-sizes-50-500-2000-messages", status: "NOT_RUN", reason: "synthetic history volume sweep is a follow-up matrix; this first run measures navigation and local feedback" },
      { id: "slow-gateway-status-probe-12s", status: "NOT_RUN", reason: "separate 12s status-only injection not included in first core flow" },
      { id: "slow-optional-model-configuration", status: "NOT_RUN", reason: "model configuration RPC hold not included; no model RPC is sent in the core flow" },
      { id: "http-401-and-reauthorization", status: "NOT_RUN", reason: "auth expiry/401 behavior needs a dedicated isolated scenario" },
      { id: "disconnect-and-ack-loss", status: "NOT_RUN", reason: "WebSocket close and response drop require a dedicated recovery scenario" },
      { id: "jitter-and-real-packet-loss", status: "NOT_RUN", reason: "not simulated by fixed application response delays" },
      { id: "public-relay", status: "NOT_RUN_HERE", reason: "separate public validation run owns isolated test relay evidence" },
      { id: "drawer-closed-no-thread-list-scan", status: drawerClosedStatus, snapshotMode, samples: network.drawerClosedListChecks.length, nonzeroSamples: network.drawerClosedListChecks.filter(row => row.requestsAfterTaskEntryBeforeDrawerOpen > 0).length, evidence: "outbound thread/list RPC count after all startup RPCs quiesced, from task entry through interactive task shell until drawer open" },
      { id: "drawer-close-no-new-thread-list", status: snapshotMode === "before" ? (drawerCloseNoScans ? "BASELINE_ZERO_OBSERVED" : "BASELINE_SCAN_OBSERVED") : drawerCloseNoScans ? "PASS" : "FAIL", snapshotMode, samples: network.drawerCloseListChecks.length, nonzeroSamples: network.drawerCloseListChecks.filter(row => row.requestsAfterClose > 0).length, evidence: "outbound thread/list RPC count during 100ms after drawer close" },
      { id: "android-ios-hermes-native-performance", status: "UNVERIFIED", reason: "Chromium web viewport does not measure native JS/UI, keyboard, storage, or frame behavior" },
      { id: "no-real-provider-request", status: observedBrowserTurnStarts === expectedMockTurnStarts ? "PASS" : "FAIL", browserObservedMockTurnStarts: observedBrowserTurnStarts, routeObservedMockTurnStarts: gatewayCalls.turnStart, expectedPendingSamples: expectedMockTurnStarts, realProviderConfigured: false, gatewayMode: "KCODER_STUDIO_MOCK" },
    ],
  };
}

return { sanitizeRpcEventForCheckpoint, pendingRouteRequestsAt, recordRoutedWebSocketCloseInvocation, beginNavigationSampleCapture, writeNavigationSampleCheckpoint, installPageInstrumentation, installNetworkInstrumentation, waitForGatewayRpcQuiescence, pendingGatewayActivity, gatewayActivityFingerprint, snapshotNetworkEvidence, deepFreeze, createNetworkLedger, summarizeObservations, scenarioStatus, summarizeNetwork, correlateRpcFrames, pairApplicationAndRouteSockets, summarizeActionTimelines, createCoverageLedger };
}
