export function createHomeServersRevisionDiagnosticControl({
  stage,
  actionId,
  epochNow,
  round,
  sha256,
  existingThreadId,
  diagnosticThreadId,
  diagnosticTitle,
}) {
  if (typeof stage !== "string" || !stage || typeof actionId !== "string" || !actionId) {
    throw new TypeError("Home revision diagnostic requires a non-empty stage and action identity");
  }
  for (const [name, value] of Object.entries({ epochNow, round, sha256 })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }
  for (const [name, value] of Object.entries({ existingThreadId, diagnosticThreadId, diagnosticTitle })) {
    if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`);
  }

  let releasePromiseResolve;
  const releasePromise = new Promise(resolveRelease => { releasePromiseResolve = resolveRelease; });
  const statusHold = {
    apiPath: "/api/servers/status",
    state: "DISARMED",
    request: null,
    armedAtEpochMs: null,
    pendingAtEpochMs: null,
    releaseRequestedAtEpochMs: null,
    releasedAtEpochMs: null,
    releaseReason: null,
    arm(atEpochMs) {
      if (this.state !== "DISARMED") throw new Error("manual status hold can be armed only once");
      if (!Number.isFinite(atEpochMs)) throw new TypeError("manual status hold arm time must be finite");
      this.state = "ARMED";
      this.armedAtEpochMs = atEpochMs;
    },
    async hold(request) {
      if (this.state !== "ARMED") return false;
      this.state = "PENDING";
      this.request = request;
      this.pendingAtEpochMs = round(epochNow());
      await releasePromise;
      this.releasedAtEpochMs = round(epochNow());
      this.state = "RELEASED";
      return true;
    },
    release(reason) {
      if (["RELEASE_REQUESTED", "RELEASED"].includes(this.state)) return false;
      if (typeof reason !== "string" || !reason) throw new TypeError("manual status hold release requires a reason");
      this.releaseReason = reason;
      this.releaseRequestedAtEpochMs = round(epochNow());
      this.state = this.state === "DISARMED" ? "RELEASED" : "RELEASE_REQUESTED";
      releasePromiseResolve();
      return true;
    },
  };

  const control = {
    stage,
    actionId,
    pageId: null,
    pagePathFingerprintAtArm: null,
    statusHold,
    targetScope: null,
    armedAtEpochMs: null,
    baselineServerInventory: null,
    serverRefreshResponse: null,
    fixtureInjection: null,
    async observeHttpResponse({ apiPath, request, routeRequest, response }) {
      if (!["/api/servers", "/api/servers/status"].includes(apiPath)) return;
      routeRequest.owner = mobileRequestOwnerFingerprint(request, sha256);
      routeRequest.serverInventory = null;
      routeRequest.manualStatusHoldApplied = false;
      if (apiPath === "/api/servers") {
        routeRequest.serverInventory = await captureServerInventoryDigest(response, sha256);
        if (statusHold.armedAtEpochMs !== null
          && routeRequest.startedAtEpochMs >= statusHold.armedAtEpochMs
          && control.serverRefreshResponse === null) {
          control.serverRefreshResponse = routeRequest;
        }
      } else {
        routeRequest.manualStatusHoldApplied = await statusHold.hold(routeRequest);
      }
    },
    observeRpcResponse({ frame, request, routeInfo, routeSocketId, pageId, receivedAtEpochMs, ledger }) {
      if (request?.method !== "thread/list" || !Array.isArray(frame?.result?.threads)) return frame;
      if (pageId !== control.pageId || request.stage !== stage || request.actionId !== actionId) return frame;
      const existingThread = frame.result.threads.find(thread => thread?.id === existingThreadId && typeof thread?.cwd === "string");
      if (!existingThread) return frame;

      const scope = {
        serverFingerprint: routeInfo.serverFingerprint,
        channelFingerprint: routeInfo.channelFingerprint,
        workspaceFingerprint: routeInfo.workspaceFingerprint,
        rawWorkspaceFingerprint: sha256(existingThread.cwd).slice(0, 16),
      };
      if (!control.targetScope) control.targetScope = { ...scope, initialRouteSocketId: routeSocketId };
      const targetScope = control.targetScope;
      const sameTargetScope = targetScope.serverFingerprint === scope.serverFingerprint
        && targetScope.channelFingerprint === scope.channelFingerprint
        && targetScope.workspaceFingerprint === scope.workspaceFingerprint
        && targetScope.rawWorkspaceFingerprint === scope.rawWorkspaceFingerprint;
      const serverInventoryResponse = control.serverRefreshResponse
        ? ledger.httpResponsePathDelays.find(item => item.routeRequestOrdinal === control.serverRefreshResponse.routeRequestOrdinal)
        : null;
      const serverInventoryForwardedAtEpochMs = serverInventoryResponse?.forwardedAtEpochMs;
      const responseObservation = {
        rpcIdFingerprint: request.rpcIdFingerprint,
        routeSocketId,
        stage: request.stage,
        actionId: request.actionId,
        sentAtEpochMs: round(request.sentAtEpochMs),
        receivedAtEpochMs: round(receivedAtEpochMs),
        ...scope,
        archived: request.threadListArchived === true,
        cursorPresent: request.threadListCursorPresent === true,
        containsExistingThread: true,
        containsDiagnosticThread: frame.result.threads.some(thread => thread?.id === diagnosticThreadId),
        threadIdFingerprints: frame.result.threads.map(thread => typeof thread?.id === "string" ? sha256(thread.id).slice(0, 16) : null).filter(Boolean),
        sameTargetScope,
        fixtureInjected: false,
      };
      if (statusHold.state === "PENDING"
        && sameTargetScope
        && request.threadListArchived !== true
        && request.threadListCursorPresent !== true
        && Number.isFinite(serverInventoryForwardedAtEpochMs)
        && request.sentAtEpochMs >= serverInventoryForwardedAtEpochMs
        && control.fixtureInjection === null) {
        const newThread = {
          ...existingThread,
          id: diagnosticThreadId,
          title: diagnosticTitle,
          status: "idle",
          updatedAt: advanceThreadTimestamp(existingThread.updatedAt, 1_000, epochNow),
        };
        frame = { ...frame, result: { ...frame.result, threads: [...frame.result.threads, newThread] } };
        responseObservation.containsDiagnosticThread = true;
        responseObservation.threadIdFingerprints.push(sha256(diagnosticThreadId).slice(0, 16));
        responseObservation.fixtureInjected = true;
        control.fixtureInjection = {
          source: "single synthetic ThreadSummary appended to this actual upstream mock thread/list response in the Playwright WebSocket route",
          rpcIdFingerprint: request.rpcIdFingerprint,
          routeSocketId,
          requestSentAtEpochMs: round(request.sentAtEpochMs),
          responseReceivedAtEpochMs: round(receivedAtEpochMs),
          serversResponseForwardedAtEpochMs: serverInventoryForwardedAtEpochMs,
          ...scope,
          syntheticThreadIdFingerprint: sha256(diagnosticThreadId).slice(0, 16),
          syntheticTitleFingerprint: sha256(diagnosticTitle).slice(0, 16),
          onlyThisTargetScopeResponse: true,
        };
      }
      request.homeRevisionThreadListResponse = responseObservation;
      return frame;
    },
  };
  return control;
}

function mobileRequestOwnerFingerprint(request, sha256) {
  const headers = request.headers();
  const authorization = headers.authorization ?? headers.Authorization ?? "";
  const cookie = headers.cookie ?? headers.Cookie ?? "";
  return {
    fingerprint: sha256(JSON.stringify({ authorization, cookie })).slice(0, 16),
    bearerPresent: /^Bearer\s+\S+$/i.test(authorization),
    cookiePresent: Boolean(cookie),
  };
}

async function captureServerInventoryDigest(response, sha256) {
  const body = await response.body();
  const parsed = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(parsed?.servers)) throw new Error("mock /api/servers response must contain a server inventory array");
  return {
    serverCount: parsed.servers.length,
    inventoryFingerprint: sha256(JSON.stringify(parsed.servers)).slice(0, 16),
    serverIdFingerprints: parsed.servers.map(server => sha256(String(server?.id ?? "")).slice(0, 16)),
  };
}

function advanceThreadTimestamp(value, deltaMs, epochNow) {
  if (typeof value === "number" && Number.isFinite(value)) return value + deltaMs;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed + deltaMs).toISOString() : new Date(epochNow() + deltaMs).toISOString();
}
