// Private loopback probe for one corked Relay data WebSocket. This exercises
// the real Relay server/bridge with a fake local Gateway; it is not a public
// network or mobile-client measurement.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const MAIN_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX";
const RELAY_ROOT = resolve(MAIN_ROOT, "apps/kcoder-relay");
const relayRequire = createRequire(resolve(RELAY_ROOT, "package.json"));
const AUTHORITY = "relay-cork-probe.test:8451";
const GATEWAY_ID = "cork-probe";
const RESPONSE_FLUSH_BOUND_MS = 100;
const MAX_SESSION_RESPONSE_BYTES = 4 * 1024;
const EXPECTED_SOURCE_PINS = Object.freeze({
  "apps/kcoder-relay/src/server.mjs": "941172ab1e4415d5fdc9d02f2efb787fe144c7032f3853013bbdb13ac2826a5e",
  "apps/kcoder-relay/src/transport.mjs": "8b94ae9f08cf088e4afdc59bba6594554cc3cd488f151a2229b9340eac8bf012",
  "apps/kcoder-relay/src/server-routing.mjs": "b0f4c2519d75c464227d4b2d7bbc5b9d8cdc19e26690daf0fb1644d13893c4bb",
  "apps/kcoder-relay/src/config.mjs": "b24e5c93198e0b5e0d9478785d5be8ecb826bb69479ac3a4a04a09acdd762335",
  "apps/kcoder-relay/src/registration-store.mjs": "ea310dd7a31a4e1d4f8a62ecedff84dba219cefa08ab64b89fd38c4fb186cf78",
  "apps/kcoder-relay/package.json": "9c9899c86c106b0ccbce4c635f6a8df0128559ab5bcedff5ed72cca84db095cb",
  "apps/kcoder-relay/package-lock.json": "f4491ba93c4c858c4d17edacdffa49f2da84f48b4284441cb38d101f1ee591b0",
  "apps/kcoder-relay/node_modules/ws/package.json": "c1ef91ca04eb4754c011c5f0e7638b5078ff71104fada400c44ac761cf93e0b1",
});
const INTEGRATION_CORE_FILES = Object.freeze([
  "apps/kcoder-relay/src/server.mjs",
  "apps/kcoder-relay/src/transport.mjs",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function token() {
  return randomBytes(32).toString("hex");
}

async function captureSourceInputs() {
  const files = {};
  for (const [path, expectedSha256] of Object.entries(EXPECTED_SOURCE_PINS)) {
    const bytes = await readFile(resolve(MAIN_ROOT, path));
    files[path] = { bytes: bytes.length, sha256: sha256(bytes), expectedSha256 };
  }
  const wsEntry = relayRequire.resolve("ws");
  const wsPackageBytes = await readFile(resolve(dirname(wsEntry), "package.json"));
  const wsPackage = JSON.parse(wsPackageBytes.toString("utf8"));
  return {
    files,
    integrationCore: Object.fromEntries(await Promise.all(INTEGRATION_CORE_FILES.map(async path => {
      const bytes = await readFile(resolve(repoRoot, path));
      return [path, { bytes: bytes.length, sha256: sha256(bytes) }];
    }))),
    ws: {
      version: wsPackage.version,
      packageBytes: wsPackageBytes.length,
      packageSha256: sha256(wsPackageBytes),
      expectedVersion: "8.22.0",
    },
  };
}

function assertExpectedSourcePins(snapshot) {
  for (const [path, expectedSha256] of Object.entries(EXPECTED_SOURCE_PINS)) {
    assert.equal(snapshot.files[path]?.sha256, expectedSha256, `Relay source pin changed: ${path}`);
  }
  for (const path of INTEGRATION_CORE_FILES) {
    assert.equal(snapshot.integrationCore[path]?.sha256, EXPECTED_SOURCE_PINS[path],
      `integration Relay core must match the pinned main source: ${path}`);
  }
  assert.equal(snapshot.ws.version, "8.22.0", "Relay's resolved ws dependency must match package-lock.json");
  assert.equal(snapshot.ws.packageSha256, EXPECTED_SOURCE_PINS["apps/kcoder-relay/node_modules/ws/package.json"],
    "resolved ws package bytes must match the pinned MAIN Relay dependency");
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function postSessionThroughRelay({ port, sessionRequestBody, expectedSessionBody }) {
  return new Promise(resolveResponse => {
    let settled = false;
    let response;
    let timeout;
    const chunks = [];
    let bytes = 0;
    const finish = termination => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const body = Buffer.concat(chunks, bytes);
      const result = {
        status: response?.statusCode ?? 0,
        contentLength: response?.headers["content-length"] ?? null,
        responseBytes: body.length,
        exactSessionBody: response?.statusCode === 200 && body.equals(expectedSessionBody),
        termination,
      };
      body.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      resolveResponse(result);
    };

    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path: `/g/${GATEWAY_ID}/api/mobile/session`,
      headers: {
        host: AUTHORITY,
        "content-type": "application/json",
        "content-length": String(sessionRequestBody.length),
        connection: "close",
      },
    }, incoming => {
      response = incoming;
      incoming.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_SESSION_RESPONSE_BYTES) {
          incoming.destroy();
          finish("response-too-large");
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      incoming.once("end", () => finish("complete"));
      incoming.once("aborted", () => finish("aborted"));
      incoming.once("error", () => finish("response-error"));
    });
    outgoing.once("error", () => finish("request-error"));
    outgoing.once("timeout", () => {
      outgoing.destroy();
      finish("timeout");
    });
    timeout = setTimeout(() => {
      outgoing.destroy();
      finish("deadline");
    }, 5_000);
    outgoing.end(sessionRequestBody);
  });
}

await runE2E(import.meta.url, {
  testId: "relay-single-data-socket-cork-session-probe",
  tier: "manual-live",
  modelPolicy: "Loopback Relay plus fake Gateway HTTP only; no public route, Rust RPC, Provider, browser, or phone claim",
  cleanupTimeoutMs: 10_000,
}, async context => {
  const evidence = {
    classification: "single run-owned data WebSocket corked for at most 100ms before a complete fake Gateway session response",
    nodeVersion: process.version,
    sourceBefore: null,
    sourceAfter: null,
    sourceUnchanged: null,
    gateway: {
      requestSeen: false,
      requestValid: false,
      requestBytes: 0,
      responseFinished: false,
    },
    stimulus: {
      dataChannelCount: 0,
      corked: false,
      writableBytesAtLocalClose: null,
      websocketDestroyedAtLocalClose: null,
      uncorkOutcome: "not-started",
      bridgeClosed: false,
    },
    relay: null,
    cleanup: "registered",
  };

  // The cleanups run LIFO: close owned sockets/servers, then verify pinned
  // source inputs, then save only redacted booleans, byte counts, and status.
  context.addCleanup("write cork probe evidence", () =>
    context.writeArtifactJsonInternal("relay-cork-probe.json", evidence));
  context.addCleanup("verify Relay sources after run", async () => {
    const after = await captureSourceInputs();
    evidence.sourceAfter = after;
    evidence.sourceUnchanged = JSON.stringify(after) === JSON.stringify(evidence.sourceBefore);
    assert.equal(evidence.sourceUnchanged, true, "Relay source/dependency inputs changed during the probe");
  });

  const sourceBefore = await captureSourceInputs();
  evidence.sourceBefore = sourceBefore;
  assertExpectedSourcePins(sourceBefore);

  const WebSocket = relayRequire("ws");
  const { startRelay } = await import(pathToFileURL(resolve(RELAY_ROOT, "src/server.mjs")));
  const { bridge, heartbeat } = await import(pathToFileURL(resolve(RELAY_ROOT, "src/transport.mjs")));

  const gatewaySecret = token();
  const pairingToken = token();
  const session = {
    accessToken: token(),
    rpcToken: token(),
    expiresAt: Date.now() + 120_000,
  };
  const expectedSessionBody = Buffer.from(JSON.stringify(session));
  const sessionRequestBody = Buffer.from(JSON.stringify({ token: pairingToken }));
  for (const secret of [gatewaySecret, pairingToken, session.accessToken, session.rpcToken]) {
    context.registerSecret(secret);
  }

  let releaseGatewayResponse;
  const responseGate = new Promise(resolveGate => { releaseGatewayResponse = resolveGate; });
  let resolveGatewayRequest;
  const gatewayRequestSeen = new Promise(resolveSeen => { resolveGatewayRequest = resolveSeen; });
  let resolveGatewayResponseFinished;
  const gatewayResponseFinished = new Promise(resolveFinished => { resolveGatewayResponseFinished = resolveFinished; });

  const fakeGateway = createServer((incoming, outgoing) => {
    void (async () => {
      const requestChunks = [];
      let requestBytes = 0;
      for await (const chunk of incoming) {
        requestBytes += chunk.length;
        if (requestBytes <= 2 * 1024) requestChunks.push(Buffer.from(chunk));
      }
      const requestBody = Buffer.concat(requestChunks, Math.min(requestBytes, 2 * 1024));
      let payload;
      try { payload = JSON.parse(requestBody.toString("utf8")); } catch { payload = null; }
      const requestValid = incoming.method === "POST" && incoming.url === "/api/mobile/session" &&
        incoming.headers["content-type"] === "application/json" && payload?.token === pairingToken && requestBytes <= 2 * 1024;
      requestBody.fill(0);
      for (const chunk of requestChunks) chunk.fill(0);
      evidence.gateway.requestSeen = true;
      evidence.gateway.requestValid = requestValid;
      evidence.gateway.requestBytes = requestBytes;
      resolveGatewayRequest(requestValid);

      if (!requestValid) {
        outgoing.writeHead(400, { "content-length": "0", connection: "close" });
        outgoing.end();
        resolveGatewayResponseFinished(false);
        return;
      }

      await responseGate;
      if (outgoing.destroyed) {
        resolveGatewayResponseFinished(false);
        return;
      }
      outgoing.once("finish", () => {
        evidence.gateway.responseFinished = true;
        resolveGatewayResponseFinished(true);
      });
      outgoing.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(expectedSessionBody.length),
        connection: "close",
      });
      outgoing.end(expectedSessionBody);
    })().catch(() => {
      resolveGatewayRequest(false);
      resolveGatewayResponseFinished(false);
      if (!outgoing.destroyed) outgoing.destroy();
    });
  });
  fakeGateway.listen(0, "127.0.0.1");
  await once(fakeGateway, "listening");
  context.registerPort("fake-gateway-http", fakeGateway.address().port);
  context.addCleanup("close fake Gateway", async () => {
    fakeGateway.closeAllConnections();
    await new Promise((resolveClose, rejectClose) => {
      fakeGateway.close(error => error ? rejectClose(error) : resolveClose());
    });
  });

  const relay = await startRelay({
    gateways: [{
      id: GATEWAY_ID,
      secret: gatewaySecret,
      pairingToken,
      maxConnections: 2,
      maxBytesPerWindow: 1024 * 1024,
      trafficWindowMs: 60_000,
    }],
    sharedHosts: [AUTHORITY],
    controlPort: 0,
    proxyPort: 0,
    connectTimeout: 2_000,
    pairingBodyTimeoutMs: 2_000,
  });
  context.registerPort("relay-control", relay.controlPort);
  context.registerPort("relay-proxy", relay.proxyPort);
  context.addCleanup("close loopback Relay", () => relay.close());
  context.addCleanup("release fake Gateway response gate", () => releaseGatewayResponse());

  const authHeaders = {
    authorization: `Bearer ${gatewaySecret}`,
    "x-kcoder-device": GATEWAY_ID,
  };
  const control = new WebSocket(`ws://127.0.0.1:${relay.controlPort}/_relay/control`, {
    headers: authHeaders,
    handshakeTimeout: 4_000,
    perMessageDeflate: false,
  });
  control.on("error", () => {});
  context.addCleanup("terminate owned control WebSocket", () => control.terminate());
  await once(control, "open", { signal: AbortSignal.timeout(4_000) });
  heartbeat(control);

  const openFramePromise = once(control, "message", { signal: AbortSignal.timeout(5_000) });
  const relayResponsePromise = postSessionThroughRelay({
    port: relay.proxyPort,
    sessionRequestBody,
    expectedSessionBody,
  });
  const [openFrame] = await openFramePromise;
  let openMessage;
  try { openMessage = JSON.parse(openFrame.toString("utf8")); } catch { openMessage = null; }
  const openValid = openMessage?.type === "open" && /^[a-f0-9]{48}$/.test(openMessage.id) && openMessage.gatewayId === GATEWAY_ID;
  assert.equal(openValid, true, "Relay did not issue the expected data-channel open frame");
  evidence.stimulus.dataChannelCount = 1;

  const data = new WebSocket(`ws://127.0.0.1:${relay.controlPort}/_relay/data?id=${encodeURIComponent(openMessage.id)}`, {
    headers: authHeaders,
    handshakeTimeout: 4_000,
    perMessageDeflate: false,
  });
  data.on("error", () => {});
  context.addCleanup("terminate owned data WebSocket", () => data.terminate());
  let dataSocket;
  let localGatewaySocket;
  let resolveDataBridgeReady;
  let rejectDataBridgeReady;
  const dataBridgeReady = new Promise((resolveReady, rejectReady) => {
    resolveDataBridgeReady = resolveReady;
    rejectDataBridgeReady = rejectReady;
  });
  let localCloseResolve;
  const localClosed = new Promise(resolveClosed => { localCloseResolve = resolveClosed; });
  data.once("error", rejectDataBridgeReady);
  data.once("open", () => {
    try {
      // Match the real mobile client: attach the bridge synchronously in the
      // WebSocket open handler so the first tunneled HTTP frame cannot arrive
      // before the data socket has a message listener.
      heartbeat(data);
      dataSocket = data._socket;
      assert.ok(dataSocket && typeof dataSocket.cork === "function" && typeof dataSocket.uncork === "function",
        "the one run-owned data WebSocket must expose its Node TCP socket");
      dataSocket.cork();
      evidence.stimulus.corked = true;

      localGatewaySocket = connect({ host: "127.0.0.1", port: fakeGateway.address().port });
      localGatewaySocket.on("error", error => {
        evidence.gateway.localSocketError = true;
        rejectDataBridgeReady(error);
      });
      localGatewaySocket.once("connect", resolveDataBridgeReady);
      context.addCleanup("close fake Gateway bridge socket", () => {
        if (!localGatewaySocket.destroyed) localGatewaySocket.destroy();
      });
      localGatewaySocket.once("close", hadError => {
        evidence.stimulus.writableBytesAtLocalClose = dataSocket.writableLength;
        evidence.stimulus.websocketDestroyedAtLocalClose = dataSocket.destroyed;
        evidence.gateway.localCloseHadError = hadError;
        localCloseResolve();
      });
      bridge(localGatewaySocket, data, () => { evidence.stimulus.bridgeClosed = true; });
    } catch (error) {
      rejectDataBridgeReady(error);
    }
  });
  await withTimeout(dataBridgeReady, 4_000, "data WebSocket bridge ready");

  const requestValid = await withTimeout(gatewayRequestSeen, 5_000, "fake Gateway session request");
  assert.equal(requestValid, true, "Relay did not deliver the complete session POST to the fake Gateway");

  let uncorkTimer;
  let uncorkResolve;
  const boundedUncork = new Promise(resolveUncork => { uncorkResolve = resolveUncork; });
  uncorkTimer = setTimeout(() => {
    if (dataSocket.destroyed) {
      evidence.stimulus.uncorkOutcome = "socket-destroyed-before-100ms";
    } else {
      dataSocket.uncork();
      evidence.stimulus.uncorkOutcome = "released-at-100ms";
    }
    uncorkResolve();
  }, RESPONSE_FLUSH_BOUND_MS);

  try {
    // Release a short, valid HTTP session response with Connection: close while
    // exactly this data socket is corked; the only artificial delay is bounded.
    releaseGatewayResponse();
    evidence.gateway.responseFinished = await withTimeout(gatewayResponseFinished, 2_000, "fake Gateway response finish");
    const relayResponse = await withTimeout(relayResponsePromise, 5_000, "Relay session response");
    evidence.relay = relayResponse;
    await withTimeout(localClosed, 2_000, "Gateway TCP close");
    await withTimeout(boundedUncork, RESPONSE_FLUSH_BOUND_MS + 500, "bounded data-socket uncork");

    const queuedBeforeCleanup = Number.isInteger(evidence.stimulus.writableBytesAtLocalClose) &&
      evidence.stimulus.writableBytesAtLocalClose > 0;
    const exactSessionReachedRelay = relayResponse.status === 200 &&
      relayResponse.contentLength === String(expectedSessionBody.length) &&
      relayResponse.responseBytes === expectedSessionBody.length && relayResponse.exactSessionBody;
    evidence.relay.exactSessionReachedRelay = exactSessionReachedRelay;
    evidence.stimulus.queuedBeforeLocalClose = queuedBeforeCleanup;
    evidence.cleanup = "bounded uncork completed; owned sockets and servers registered with RunContext";

    assert.equal(queuedBeforeCleanup, true, "the test did not observe queued bytes before local-close cleanup");
    assert.equal(exactSessionReachedRelay, true, "Relay must return the exact complete registered session JSON");
    return evidence;
  } finally {
    if (uncorkTimer) clearTimeout(uncorkTimer);
    if (!dataSocket.destroyed && evidence.stimulus.uncorkOutcome === "not-started") {
      dataSocket.uncork();
      evidence.stimulus.uncorkOutcome = "released-during-finally";
    }
    expectedSessionBody.fill(0);
    sessionRequestBody.fill(0);
  }
});
