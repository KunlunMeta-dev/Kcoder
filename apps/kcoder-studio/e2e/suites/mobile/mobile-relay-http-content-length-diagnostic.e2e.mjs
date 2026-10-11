import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as connectTcp, createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startClient } from "../../../../kcoder-relay/src/client.mjs";
import { startRelay } from "../../../../kcoder-relay/src/server.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { findOwnedExecutableProcesses, hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";
import { processTreeAlive } from "../../harness/owned-process.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

process.umask(0o077);

const testId = "mobile-relay-http-content-length-diagnostic";
const gatewayId = "wire-diagnostic";
const pinnedBinarySha256 = "d1c98e33084e6dc8692d0e710d22affb01ebfd79a8d60a4b37965a6d841cbcf6";
const pinnedBinaryPath = resolve(repoRoot, "target/packages/kcoder-studio-gateway/20261007T110812Z-641626d-dirty/kcoder");
const relayEvents = new Set([
  "control_connecting", "control_error", "control_close", "control_open",
  "open_rejected", "open_received", "data_connecting", "data_error", "data_close",
  "data_open", "local_connecting", "local_error", "local_close", "local_timeout",
  "local_connect", "bridge_closed", "reconnect_scheduled", "client_stopped",
]);

await runE2E(
  import.meta.url,
  {
    testId,
    tier: "full-integration",
    modelPolicy: "loopback-only HTTP body-framing diagnostic with real Gateway and Relay; no app-server, Provider, model request, Browser, or user session",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 15_000,
  },
  async context => {
    assert.equal(process.platform, "linux", "this diagnostic's process-group cleanup evidence is Linux-specific");
    assert.equal(process.version, "v22.17.0", "use the approved Node 22.17 runtime");
    assert.equal(process.env.KCODER_E2E_KCODER_BIN, pinnedBinaryPath, "use the explicitly approved KCoder binary path");
    assert.equal(process.env.KCODER_E2E_EXPECTED_KCODER_SHA256, pinnedBinarySha256, "use the explicitly approved KCoder binary digest");
    const binary = await hashExecutableFile(pinnedBinaryPath);
    assert.equal(binary.sha256, pinnedBinarySha256, "approved KCoder binary bytes must match the fixed SHA-256 pin");

    const evidence = {
      schemaVersion: 1,
      testId,
      scope: "Four same-body HTTP probes: Gateway node:http/fetch and Relay node:http/fetch; no app-server requests are made.",
      runner: { pid: process.pid, parentPid: process.ppid, nodeVersion: process.version },
      binary: { path: binary.path, sha256: binary.sha256, size: binary.size },
      body: { utf8ByteLength: null, bufferByteLength: null, stringBufferBytesEqual: null },
      relay: { ownerPid: process.pid, controlPort: null, proxyPort: null, gatewayId },
      probes: [],
      relayClientDiagnostics: [],
      appServerProcessCount: null,
      result: "running",
    };
    let gateway;
    let relay;
    let relayClient;
    let relayOnline = false;
    const ownedPorts = [];

    // Registered first so it runs after the Gateway, Relay, and Relay client cleanups.
    context.addCleanup("verify diagnostic Gateway and Relay process/port cleanup", async () => {
      const processRecords = [...context.processes.values()];
      const processChecks = await Promise.all(processRecords.map(async record => ({
        label: record.label,
        pid: record.pid,
        pgid: record.pgid,
        stopped: record.stopped,
        groupAlive: await processTreeAlive(record.child, record.identity),
      })));
      const portChecks = await Promise.all(ownedPorts.map(async ({ label, port }) => ({
        label,
        port,
        ...(await isLoopbackPortClosed(port)),
      })));
      const cleanup = {
        processChecks,
        portChecks,
        relayClientDiagnostics: evidence.relayClientDiagnostics,
      };
      evidence.cleanup = cleanup;
      await context.writeArtifactJsonInternal("cleanup-verification.json", cleanup);
      if (processChecks.some(item => item.groupAlive) || portChecks.some(item => !item.closed)) {
        throw new Error("an owned Gateway/Relay process group or loopback port survived cleanup");
      }
    });

    try {
      const workspace = context.pathInState("workspace");
      const configDir = context.pathInState("config");
      const webRoot = context.pathInState("web-root");
      await Promise.all([
        mkdir(workspace, { recursive: true, mode: 0o700 }),
        mkdir(configDir, { recursive: true, mode: 0o700 }),
        mkdir(webRoot, { recursive: true, mode: 0o700 }),
      ]);
      const serversFile = await context.writeStateJson("servers.json", [{
        id: "local",
        label: "Isolated HTTP diagnostic target",
        transport: "local",
        command: pinnedBinaryPath,
        workspace,
      }]);
      const relayProxyPort = await reserveLoopbackPort();
      const relayAuthority = `127.0.0.1:${relayProxyPort}`;

      gateway = await startGateway(context, {
        auth: true,
        label: "http-content-length-diagnostic-gateway",
        workspace,
        serversFile,
        serversStore: context.pathInState("servers-store.json"),
        kcoderBin: pinnedBinaryPath,
        env: {
          KCODER_CONFIG_DIR: configDir,
          KCODER_STUDIO_MOCK: "0",
          KCODER_STUDIO_WEB_ROOT: webRoot,
          KCODER_STUDIO_PUBLIC_ORIGINS: `http://127.0.0.1:${relayProxyPort}`,
        },
      });
      ownedPorts.push({ label: "Gateway", port: gateway.port });

      const relaySecret = randomBytes(32).toString("base64url");
      context.registerSecret(relaySecret);
      const relayGatewaySecret = randomBytes(32).toString("base64url");
      context.registerSecret(relayGatewaySecret);
      const relayPairingToken = gateway.authToken;
      relay = await startRelay({
        gateways: [{ id: gatewayId, secret: relayGatewaySecret, pairingToken: relayPairingToken }],
        sharedHosts: [relayAuthority],
        controlPort: 0,
        proxyPort: relayProxyPort,
        connectTimeout: 5_000,
        pairingBodyTimeoutMs: 5_000,
      });
      evidence.relay.controlPort = relay.controlPort;
      evidence.relay.proxyPort = relay.proxyPort;
      ownedPorts.push({ label: "Relay control", port: relay.controlPort }, { label: "Relay proxy", port: relay.proxyPort });
      context.registerPort("http-content-length-diagnostic-relay-control", relay.controlPort);
      context.registerPort("http-content-length-diagnostic-relay-proxy", relay.proxyPort);
      context.addCleanup("close isolated HTTP diagnostic Relay", () => relay.close());

      const relayClientDiagnostics = evidence.relayClientDiagnostics;
      relayClient = startClient({
        url: `http://127.0.0.1:${relay.controlPort}`,
        secret: relayGatewaySecret,
        gatewayId,
        gateway: gateway.baseUrl,
        allowInsecure: true,
        retryMs: 100,
        onOnline: () => { relayOnline = true; },
        onDiagnostic: record => captureRelayDiagnostic(relayClientDiagnostics, record),
      });
      context.addCleanup("stop isolated HTTP diagnostic Relay client", () => relayClient.close());
      await waitFor(
        () => relayOnline ? true : null,
        10_000,
        "loopback Relay control connection",
        50,
        context.abortSignal,
      );

      // Match the original pair request shape and serialize it once. Every cell
      // receives these exact string/Buffer bytes; each successful pair creates
      // a fresh disposable device grant under this RunContext.
      const bodyText = JSON.stringify({
        token: relayPairingToken,
        durableDeviceAuthorization: true,
        deviceLabel: "device A",
      });
      const bodyBuffer = Buffer.from(bodyText, "utf8");
      evidence.body = {
        utf8ByteLength: Buffer.byteLength(bodyText, "utf8"),
        bufferByteLength: bodyBuffer.byteLength,
        stringBufferBytesEqual: Buffer.byteLength(bodyText, "utf8") === bodyBuffer.byteLength,
      };
      assert.equal(evidence.body.stringBufferBytesEqual, true, "string and Buffer representations must have identical UTF-8 bytes");

      const activeUndiciRequests = new WeakMap();
      let activeFetchProbe = null;
      const createSubscriber = ({ request }) => {
        if (!activeFetchProbe || !isPairRequest(request)) return;
        activeFetchProbe.undiciRequestCreated = true;
        activeFetchProbe.declaredContentLength = safeLength(request.contentLength);
        activeUndiciRequests.set(request, activeFetchProbe);
      };
      const bodySentSubscriber = ({ request }) => {
        const probe = activeUndiciRequests.get(request);
        if (probe) probe.requestBodySent = true;
      };
      const headersSubscriber = ({ request, response }) => {
        const probe = activeUndiciRequests.get(request);
        const status = response?.statusCode;
        if (probe && Number.isInteger(status) && status >= 100 && status <= 599) probe.undiciResponseStatus = status;
      };
      const errorSubscriber = ({ request, error }) => {
        const probe = activeUndiciRequests.get(request);
        if (probe) probe.undiciRequestError = safeError(error);
      };
      const undiciChannels = [
        channel("undici:request:create"),
        channel("undici:request:bodySent"),
        channel("undici:request:headers"),
        channel("undici:request:error"),
      ];
      undiciChannels[0].subscribe(createSubscriber);
      undiciChannels[1].subscribe(bodySentSubscriber);
      undiciChannels[2].subscribe(headersSubscriber);
      undiciChannels[3].subscribe(errorSubscriber);

      try {
        const probes = [
          {
            label: "gateway-node-http-fixed-length",
            target: "gateway",
            transport: "node:http",
            url: `${gateway.baseUrl}/api/mobile/session`,
          },
          {
            label: "gateway-fetch-auto-length",
            target: "gateway",
            transport: "fetch",
            url: `${gateway.baseUrl}/api/mobile/session`,
          },
          {
            label: "relay-node-http-fixed-length",
            target: "relay",
            transport: "node:http",
            url: `http://127.0.0.1:${relay.proxyPort}/g/${gatewayId}/api/mobile/session`,
          },
          {
            label: "relay-fetch-auto-length",
            target: "relay",
            transport: "fetch",
            url: `http://127.0.0.1:${relay.proxyPort}/g/${gatewayId}/api/mobile/session`,
          },
        ];

        for (const item of probes) {
          const probe = {
            label: item.label,
            target: item.target,
            transport: item.transport,
            method: "POST",
            bodyByteLength: bodyBuffer.byteLength,
            declaredContentLength: null,
            status: null,
            isJson: null,
            requestBodySent: null,
            undiciRequestCreated: null,
            undiciResponseStatus: null,
            error: null,
            cause: null,
            undiciRequestError: null,
          };
          evidence.probes.push(probe);
          if (item.transport === "node:http") {
            await runNodeHttpProbe(item.url, bodyBuffer, probe);
          } else {
            activeFetchProbe = probe;
            probe.requestBodySent = false;
            probe.undiciRequestCreated = false;
            try {
              const response = await fetch(item.url, {
                method: "POST",
                headers: { accept: "application/json", "content-type": "application/json" },
                body: bodyText,
                cache: "no-store",
                credentials: "omit",
                redirect: "error",
                signal: AbortSignal.timeout(10_000),
              });
              probe.status = response.status;
              probe.isJson = isJsonContentType(response.headers.get("content-type"));
              // Drain without parsing or retaining response credentials.
              await response.arrayBuffer();
            } catch (error) {
              probe.error = safeError(error);
              probe.cause = safeError(error?.cause);
            } finally {
              activeFetchProbe = null;
            }
          }
        }
      } finally {
        activeFetchProbe = null;
        undiciChannels[0].unsubscribe(createSubscriber);
        undiciChannels[1].unsubscribe(bodySentSubscriber);
        undiciChannels[2].unsubscribe(headersSubscriber);
        undiciChannels[3].unsubscribe(errorSubscriber);
      }

      const appServerProcesses = await findOwnedExecutableProcesses({
        pgid: context.processes.get("http-content-length-diagnostic-gateway")?.pgid,
        executablePath: pinnedBinaryPath,
      });
      evidence.appServerProcessCount = appServerProcesses.length;
      assert.equal(evidence.appServerProcessCount, 0, "the HTTP framing diagnostic must not start an app-server process");

      const failed = evidence.probes.filter(probe => probe.status !== 200 || probe.isJson !== true || probe.error !== null);
      for (const probe of evidence.probes.filter(item => item.transport === "fetch")) {
        assert.equal(probe.declaredContentLength, evidence.body.bufferByteLength,
          `${probe.label} must declare the exact UTF-8 body length according to Undici diagnostics`);
      }
      evidence.result = failed.length === 0 ? "passed" : "failed";
      await context.writeArtifactJson("http-content-length-matrix.json", evidence);
      console.log(`DIAGNOSTIC_RUN_ROOT=${context.runRoot}`);
      if (failed.length) {
        throw new Error(`HTTP framing matrix had ${failed.length} non-200 or non-JSON cell(s)`);
      }
      return { result: evidence.result, probes: evidence.probes.length, bodyByteLength: bodyBuffer.byteLength };
    } catch (error) {
      evidence.result = "failed";
      evidence.failure = safeError(error);
      if (!context.finishing) {
        try { await context.writeArtifactJson("http-content-length-matrix.json", evidence); } catch {}
      }
      throw error;
    }
  },
);

async function runNodeHttpProbe(urlText, body, probe) {
  const url = new URL(urlText);
  await new Promise(resolveProbe => {
    const request = httpRequest(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        connection: "close",
      },
    });
    probe.declaredContentLength = Number(request.getHeader("content-length"));
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe();
    };
    const timer = setTimeout(() => {
      request.destroy(Object.assign(new Error("probe timeout"), { code: "PROBE_TIMEOUT" }));
    }, 10_000);
    timer.unref?.();
    request.once("response", response => {
      probe.status = Number.isInteger(response.statusCode) ? response.statusCode : null;
      probe.isJson = isJsonContentType(response.headers["content-type"]);
      response.once("end", finish);
      response.once("error", error => { probe.error = safeError(error); finish(); });
      response.resume();
    });
    request.once("error", error => { probe.error = safeError(error); finish(); });
    request.end(body);
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function isLoopbackPortClosed(port) {
  return new Promise(resolveResult => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveResult(result);
    };
    socket.once("connect", () => finish({ closed: false, observed: "connected" }));
    socket.once("error", error => finish({
      closed: error?.code === "ECONNREFUSED",
      observed: typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "unknown",
    }));
    socket.setTimeout(500, () => finish({ closed: false, observed: "timeout" }));
  });
}

function isPairRequest(request) {
  return request?.method === "POST" && typeof request.path === "string" && request.path.endsWith("/api/mobile/session");
}

function safeLength(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeError(error) {
  if (!error || typeof error !== "object") return null;
  const safe = {};
  if (typeof error.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)) safe.name = error.name;
  if (typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code)) safe.code = error.code;
  if (Number.isInteger(error.errno)) safe.errno = error.errno;
  if (typeof error.syscall === "string" && /^[A-Za-z0-9_-]+$/.test(error.syscall)) safe.syscall = error.syscall;
  return Object.keys(safe).length ? safe : null;
}

function isJsonContentType(value) {
  return typeof value === "string" && /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(value.trim());
}

function captureRelayDiagnostic(target, record) {
  if (!record || !relayEvents.has(record.event) || target.length >= 128) return;
  if (!Number.isSafeInteger(record.generation) || record.generation < 0) return;
  const safe = { event: record.event, generation: record.generation };
  if (typeof record.monotonicMs === "number" && Number.isFinite(record.monotonicMs)) safe.monotonicMs = record.monotonicMs;
  if (typeof record.correlation === "string" && /^[a-f0-9]{64}$/.test(record.correlation)) safe.correlationIdHash = record.correlation;
  if (["handshake_status", "timeout", "refused", "reset", "unreachable", "protocol", "transport"].includes(record.errorKind)) safe.errorKind = record.errorKind;
  if (Number.isInteger(record.handshakeStatus) && record.handshakeStatus >= 100 && record.handshakeStatus <= 599) safe.handshakeStatus = record.handshakeStatus;
  if (Number.isInteger(record.closeCode) && record.closeCode >= 1000 && record.closeCode <= 4999) safe.closeCode = record.closeCode;
  if (typeof record.hadError === "boolean") safe.hadError = record.hadError;
  target.push(safe);
}
