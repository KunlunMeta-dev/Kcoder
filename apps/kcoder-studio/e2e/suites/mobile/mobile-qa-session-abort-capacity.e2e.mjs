import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startGateway } from "../../harness/gateway.mjs";
import { gatewayRpcUrl, openRpc } from "../../harness/rpc.mjs";
import { appRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const AUTH_SESSION_TTL_MS = 7_000;
const SOURCE_AUTH_SESSION_CAPACITY = 32;

await runE2E(import.meta.url, {
  testId: "mobile-session-response-lost-ttl-capacity",
  tier: "full-integration",
  modelPolicy: "model-independent Gateway HTTP authentication and WebSocket session lifecycle; mock Gateway, no app-server or model request",
  cleanupTimeoutMs: 15_000,
  streamCloseTimeoutMs: 5_000,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "mobile-session-abort-capacity",
  });
  const configDir = context.pathInState("gateway-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("gateway-config/settings.jsonc", {});
  const serversFile = await context.writeStateJson("backend4a-servers.jsonc", [{
    id: "backend4a",
    label: "Isolated backend4a transport fixture",
    runtime: "kcoder",
    transport: "local",
    workspace,
  }]);
  const gateway = await startGateway(context, {
    label: "mobile-session-capacity-gateway",
    auth: true,
    workspace,
    serversFile,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_AUTH_SESSION_TTL_MS: String(AUTH_SESSION_TTL_MS),
    },
  });
  assert.ok(gateway.authToken, "the isolated Gateway must require its RunContext-owned login token");

  const proxy = await createHeldSessionResponseProxy(context, gateway);
  const gatewaySourceSha256 = createHash("sha256")
    .update(await readFile(resolve(appRoot, "dev-server.mjs")))
    .digest("hex");

  // The oldest valid session owns a live Gateway WebSocket before the one-time
  // capacity boundary is crossed. No initialize or turn request is sent.
  const sessionA = await createSession(context, gateway, "session-a");
  const rpcA = await openRpc(
    gatewayRpcUrl(gateway, "backend4a", sessionA.rpcToken),
    {
      headers: {
        Origin: gateway.baseUrl,
        Authorization: `Bearer ${sessionA.accessToken}`,
      },
      timeoutMs: 5_000,
    },
  );
  context.addCleanup("close capacity victim session A WebSocket", () => rpcA.close());
  const sessionAClosed = socketClosed(rpcA.socket);
  assert.equal(await sessionStatus(gateway, sessionA.accessToken), 200);

  const fillerSessions = [];
  for (let index = 0; index < SOURCE_AUTH_SESSION_CAPACITY - 1; index += 1) {
    fillerSessions.push(await createSession(context, gateway, `filler-${index + 1}`));
  }
  assert.equal(fillerSessions.length, SOURCE_AUTH_SESSION_CAPACITY - 1);
  const sessionACapacityRemainingMs = sessionA.expiresAt - Date.now();
  assert.ok(
    sessionACapacityRemainingMs > 1_500,
    "session A must still be unexpired before the capacity boundary is crossed",
  );
  assert.equal(await sessionStatus(gateway, sessionA.accessToken), 200);

  const capacityBoundaryStartedAt = Date.now();
  const lossController = new AbortController();
  const mobileClientRequest = fetch(proxy.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: gateway.authToken }),
    signal: lossController.signal,
  });
  await proxy.responseCaptured;
  assert.equal(proxy.probe.gatewayStatus, 200, "the Gateway must complete the session exchange upstream");
  assert.ok(proxy.oracleAccessToken, "the test-only transport oracle must observe the withheld session token");
  assert.equal(proxy.probe.downstreamBytesWrittenAtCapture, 0, "the proxy must not send response bytes to the client");

  lossController.abort();
  let clientAbortName = null;
  await assert.rejects(mobileClientRequest, error => {
    clientAbortName = error?.name ?? null;
    return clientAbortName === "AbortError";
  });
  await waitFor(
    () => proxy.probe.downstreamClosed,
    2_000,
    "the owned proxy observes the Mobile client's aborted response socket",
    20,
    context.abortSignal,
  );
  assert.equal(proxy.probe.downstreamBytesWritten, 0, "the client must receive no response bytes before abort");

  const sessionB = {
    accessToken: proxy.oracleAccessToken,
    expiresAt: proxy.oracleExpiresAt,
    rpcToken: proxy.oracleRpcToken,
  };
  context.addCleanup("revoke hidden response-loss session B if still live", () =>
    revokeIfLive(gateway, sessionB.accessToken));
  const sessionBStatusAfterLostResponse = await sessionStatus(gateway, sessionB.accessToken);
  assert.equal(sessionBStatusAfterLostResponse, 200, "a valid session survives after its JWT response is lost");

  const sessionAStatusAfterCapacity = await sessionStatus(gateway, sessionA.accessToken);
  await waitFor(
    () => rpcA.socket.readyState === 3,
    2_000,
    "capacity eviction closes the oldest session's live WebSocket",
    20,
    context.abortSignal,
  );
  assert.equal(sessionAStatusAfterCapacity, 401, "the previously connected oldest session must be evicted");
  const sessionBStatusAfterCapacity = await sessionStatus(gateway, sessionB.accessToken);
  assert.equal(sessionBStatusAfterCapacity, 200, "the response-loss session remains live after eviction");
  await sessionAClosed;
  const capacityBoundaryElapsedMs = Date.now() - capacityBoundaryStartedAt;

  // A normal known-token cleanup is a separate control: DELETE succeeds and
  // the same Bearer session immediately stops authorizing Gateway HTTP.
  const sessionC = await createSession(context, gateway, "known-token-control-c");
  const knownTokenStatusBeforeDelete = await sessionStatus(gateway, sessionC.accessToken);
  assert.equal(knownTokenStatusBeforeDelete, 200);
  const knownTokenDeleteStatus = await deleteSession(gateway, sessionC.accessToken);
  assert.equal(knownTokenDeleteStatus, 204);
  const knownTokenStatusAfterDelete = await sessionStatus(gateway, sessionC.accessToken);
  assert.equal(knownTokenStatusAfterDelete, 401);

  const sessionBRemainingTtlMs = sessionB.expiresAt - Date.now();
  assert.ok(sessionBRemainingTtlMs > 500, "the TTL observation must begin before B expires");
  await sleep(sessionBRemainingTtlMs + 100, undefined, { signal: context.abortSignal });
  const sessionBStatusAfterTtl = await sessionStatus(gateway, sessionB.accessToken);
  assert.equal(sessionBStatusAfterTtl, 401, "the response-loss session expires at the configured TTL");

  const safeEvidence = {
    gatewaySourceSha256,
    gatewayMode: "KCODER_STUDIO_MOCK=1",
    realAppServerSpawned: false,
    modelRequests: 0,
    logicalServerRole: "backend4a",
    responseLost: {
      gatewayStatus: proxy.probe.gatewayStatus,
      responseBodyBytesHeldByTestOracle: proxy.probe.responseBodyBytes,
      clientResponseBytes: proxy.probe.downstreamBytesWritten,
      clientAbortName,
      requestOrdinal: SOURCE_AUTH_SESSION_CAPACITY + 1,
      sessionAuthorizedAfterAbort: sessionBStatusAfterLostResponse === 200,
    },
    capacity: {
      maxAuthSessionsFromSource: SOURCE_AUTH_SESSION_CAPACITY,
      successfulExchangesBeforeResponseLoss: SOURCE_AUTH_SESSION_CAPACITY,
      totalExchangeOrdinalAtBoundary: SOURCE_AUTH_SESSION_CAPACITY + 1,
      sequentialRequestsOnly: true,
      sessionCountEndpoint: "UNAVAILABLE; count inferred from source-backed exchange sequence and per-session authorization",
      oldestSessionHttpStatusAfterBoundary: sessionAStatusAfterCapacity,
      oldestSessionWebSocketClosed: rpcA.socket.readyState === 3,
      responseLossSessionHttpStatusAfterBoundary: sessionBStatusAfterCapacity,
      boundaryElapsedMs: capacityBoundaryElapsedMs,
    },
    knownSessionDeleteControl: {
      statusBeforeDelete: knownTokenStatusBeforeDelete,
      deleteHttpStatus: knownTokenDeleteStatus,
      statusAfterDelete: knownTokenStatusAfterDelete,
    },
    ttl: {
      configuredMs: AUTH_SESSION_TTL_MS,
      responseLossSessionStatusBeforeExpiry: sessionBStatusAfterCapacity,
      responseLossSessionStatusAfterExpiry: sessionBStatusAfterTtl,
      elapsedFromSessionCreationMs: Date.now() - proxy.oracleCapturedAt,
    },
    browserOrExpo: "not-started",
    backend4a: "logical isolated target only; no real app-server process",
  };
  await context.writeArtifactJson("mobile-session-abort-capacity.json", safeEvidence);

  return safeEvidence;
});

async function createSession(context, gateway, role) {
  const response = await fetchWithTimeout(`${gateway.baseUrl}/api/mobile/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: gateway.baseUrl,
    },
    body: JSON.stringify({ token: gateway.authToken }),
  });
  assert.equal(response.status, 200, `isolated ${role} session exchange must succeed`);
  const payload = await response.json();
  assert.equal(typeof payload.accessToken, "string");
  assert.equal(typeof payload.expiresAt, "number");
  assert.equal(typeof payload.rpcToken, "string");
  context.registerSecret(payload.accessToken);
  context.registerSecret(payload.rpcToken);
  return { accessToken: payload.accessToken, expiresAt: payload.expiresAt, rpcToken: payload.rpcToken };
}

async function sessionStatus(gateway, accessToken) {
  const response = await fetchWithTimeout(`${gateway.baseUrl}/api/servers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await response.arrayBuffer();
  return response.status;
}

async function deleteSession(gateway, accessToken) {
  const response = await fetchWithTimeout(`${gateway.baseUrl}/api/mobile/session`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await response.arrayBuffer();
  return response.status;
}

async function revokeIfLive(gateway, accessToken) {
  const status = await deleteSession(gateway, accessToken);
  assert.ok(status === 204 || status === 401, "cleanup must delete a live token or observe prior expiry/eviction");
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function socketClosed(socket) {
  if (socket.readyState === 3) return Promise.resolve();
  return new Promise(resolveClosed => socket.addEventListener("close", resolveClosed, { once: true }));
}

async function createHeldSessionResponseProxy(context, gateway) {
  let resolveResponseCaptured;
  const responseCaptured = new Promise(resolve => { resolveResponseCaptured = resolve; });
  let resolveDownstreamClosed;
  const downstreamClosed = new Promise(resolve => { resolveDownstreamClosed = resolve; });
  const upstreamRequests = new Set();
  const probe = {
    gatewayStatus: null,
    responseBodyBytes: 0,
    downstreamBytesWrittenAtCapture: null,
    downstreamBytesWritten: null,
    downstreamClosed: false,
  };
  const oracle = { accessToken: null, rpcToken: null, expiresAt: null, capturedAt: null };
  const server = createServer((incoming, outgoing) => {
    const downstreamSocket = outgoing.socket;
    outgoing.on("close", () => {
      if (outgoing.writableEnded) return;
      probe.downstreamClosed = true;
      probe.downstreamBytesWritten = downstreamSocket?.bytesWritten ?? null;
      resolveDownstreamClosed();
    });
    const requestChunks = [];
    incoming.on("data", chunk => requestChunks.push(chunk));
    incoming.on("error", error => resolveResponseCaptured(Promise.reject(error)));
    incoming.on("end", () => {
      const upstream = httpRequest(new URL("/api/mobile/session", gateway.baseUrl), {
        method: incoming.method,
        headers: {
          "content-type": incoming.headers["content-type"] || "application/json",
          "content-length": String(Buffer.concat(requestChunks).byteLength),
          Origin: gateway.baseUrl,
        },
      });
      upstreamRequests.add(upstream);
      upstream.on("close", () => upstreamRequests.delete(upstream));
      upstream.on("error", error => {
        upstreamRequests.delete(upstream);
        resolveResponseCaptured(Promise.reject(error));
      });
      upstream.on("response", upstreamResponse => {
        const responseChunks = [];
        upstreamResponse.on("data", chunk => responseChunks.push(chunk));
        upstreamResponse.on("error", error => resolveResponseCaptured(Promise.reject(error)));
        upstreamResponse.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);
          probe.gatewayStatus = upstreamResponse.statusCode;
          probe.responseBodyBytes = responseBody.byteLength;
          probe.downstreamBytesWrittenAtCapture = downstreamSocket?.bytesWritten ?? null;
          try {
            const payload = JSON.parse(responseBody.toString("utf8"));
            if (typeof payload.accessToken === "string") context.registerSecret(payload.accessToken);
            if (typeof payload.rpcToken === "string") context.registerSecret(payload.rpcToken);
            oracle.accessToken = payload.accessToken ?? null;
            oracle.rpcToken = payload.rpcToken ?? null;
            oracle.expiresAt = payload.expiresAt ?? null;
            oracle.capturedAt = Date.now();
          } catch {
            oracle.accessToken = null;
          }
          resolveResponseCaptured();
        });
      });
      upstream.end(Buffer.concat(requestChunks));
    });
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  context.registerPort("mobile-session-held-response-proxy", address.port);
  context.addCleanup("close session response proxy and owned sockets", async () => {
    for (const upstream of upstreamRequests) upstream.destroy();
    await new Promise(resolveClose => {
      server.close(resolveClose);
      server.closeAllConnections?.();
    });
  });
  return {
    url: `http://127.0.0.1:${address.port}/api/mobile/session`,
    responseCaptured,
    downstreamClosed,
    probe,
    get oracleAccessToken() { return oracle.accessToken; },
    get oracleRpcToken() { return oracle.rpcToken; },
    get oracleExpiresAt() { return oracle.expiresAt; },
    get oracleCapturedAt() { return oracle.capturedAt; },
  };
}
