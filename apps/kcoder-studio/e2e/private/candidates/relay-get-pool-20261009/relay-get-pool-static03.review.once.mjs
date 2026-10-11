// Private black-box contract candidate for bounded Relay GET tunnel reuse.
// Uses an owned loopback Relay, reverse clients, and fake HTTP Gateways only.
// It does not use a browser, public listener, Rust app-server, model Provider,
// or developer session. This candidate is intentionally not in suite-registry.
//
// Run only after the frozen Relay source pins in this file are reviewed:
// KCODER_E2E_PRIVATE_RELAY_GET_POOL_STATIC03=1 \
//   /home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node \
//   apps/kcoder-studio/e2e/private/candidates/relay-get-pool-20261009/relay-get-pool-static03.review.once.mjs

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { cp, mkdir, readFile, lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, runE2E } from "../../../harness/run-context.mjs";

const PRIVATE_RUN_FLAG = "KCODER_E2E_PRIVATE_RELAY_GET_POOL_STATIC03";
const PRIVATE_COPY_SMOKE_FLAG = "KCODER_E2E_PRIVATE_RELAY_GET_POOL_STATIC03_COPY_SMOKE";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const RELAY_FREEZE_RELATIVE_ROOT = "target/private-phone-ux-implementation/relay-grant-get-pool-20261009/candidate-static03";
const RELAY_MANIFEST_RELATIVE_PATH = `${RELAY_FREEZE_RELATIVE_ROOT}/manifest.json`;
const RELAY_OVERLAY_RELATIVE_ROOT = `${RELAY_FREEZE_RELATIVE_ROOT}/source`;
const RELAY_BASELINE_RELATIVE_ROOT = `${RELAY_FREEZE_RELATIVE_ROOT}/before`;
const RELAY_TEST_RELATIVE_ROOT = `${RELAY_FREEZE_RELATIVE_ROOT}/tests`;
const RELAY_MANIFEST_SHA256 = "0a4378e704a2f9bd86d4cef268e91041aa68d6765547901581bcf01c25669bfe";
const RELAY_DESIGN_INPUT_SHA256 = "cd8a4db5a2cba20e862b10e6934504b71372885728d87780c03324f2b58477ce";
const RELAY_REVIEW_TEST_SHA256 = "fd8c422f79156b8e4d811287d5b00a466ba0cd5b973b0bbd44d8d2916f637bdb";
const WS_RUNTIME_VERSION = "8.22.0";
const WS_RUNTIME_TREE_SHA256 = "82fda3fce45378d4be16230987eaf1eb07617c437c29e0e9da524209d6f55e6f";
const AUTHORITY = "relay-get-pool.review.test";
const MAX_FIXTURE_REQUESTS = 512;
const REQUEST_TIMEOUT_MS = 8_000;
const CLIENT_CONNECT_TIMEOUT_MS = 5_000;
const SERVER_IDLE_TIMEOUT_MS = 5_000;
const SERVER_ADVERTISED_KEEPALIVE_SECONDS = 60;
const POOL_IDLE_TIMEOUT_MS = 10_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function opaqueCredential() {
  return randomBytes(32).toString("hex");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within(promise, timeoutMs, label) {
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

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assertPinnedHex(actual, expected, label) {
  assert.match(expected, /^[a-f0-9]{64}$/, `${label} source pin is not finalized`);
  assert.equal(actual, expected, `${label} source pin changed`);
}

async function verifyFrozenRelaySource() {
  const freezeRoot = resolve(repoRoot, RELAY_FREEZE_RELATIVE_ROOT);
  const overlayRoot = resolve(repoRoot, RELAY_OVERLAY_RELATIVE_ROOT);
  const baselineRoot = resolve(repoRoot, RELAY_BASELINE_RELATIVE_ROOT);
  const testRoot = resolve(repoRoot, RELAY_TEST_RELATIVE_ROOT);
  const liveRoot = resolve(repoRoot, "apps/kcoder-relay");
  const manifestPath = resolve(repoRoot, RELAY_MANIFEST_RELATIVE_PATH);
  const manifestBytes = await readFile(manifestPath);
  assertPinnedHex(sha256(manifestBytes), RELAY_MANIFEST_SHA256, "Relay source manifest");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.status, "PRIVATE_STATIC_ONLY_NOT_RUN_NOT_APPLIED");
  assert.equal(manifest.revision, "static03");
  assert.equal(manifest.designInputSha256, RELAY_DESIGN_INPUT_SHA256);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === 2, "static03 has exactly two product overlay files");
  assert.ok(Array.isArray(manifest.supportLivePins) && manifest.supportLivePins.length === 14,
    "static03 declares the complete bounded live support source set");
  assert.ok(Array.isArray(manifest.tests) && manifest.tests.length === 1, "static03 pins its one review unit test");
  const overlay = {};
  const baseline = {};
  const support = {};
  const tests = {};
  const checkedPaths = new Set();
  const checkPath = async (root, relativePath, expected, target, targetKey = relativePath) => {
    assert.ok(!relativePath.startsWith("/") && !relativePath.split(/[\\/]/).includes(".."),
      "Relay manifest path must remain beneath its declared candidate root");
    const key = `${root}\0${relativePath}`;
    assert.equal(checkedPaths.has(key), false, `Relay manifest path is unique: ${relativePath}`);
    checkedPaths.add(key);
    const filePath = join(root, relativePath);
    const metadata = await lstat(filePath);
    assert.equal(metadata.isSymbolicLink(), false, `Relay manifest path is not a symlink: ${relativePath}`);
    assert.equal(metadata.isFile(), true, `Relay manifest path is a regular file: ${relativePath}`);
    const bytes = await readFile(filePath);
    const actual = sha256(bytes);
    assert.equal(actual, expected, `frozen Relay input changed: ${relativePath}`);
    target[targetKey] = actual;
  };
  for (const entry of manifest.files) {
    assert.equal(typeof entry.path, "string");
    assertPinnedHex(entry.after, entry.after, `Relay overlay ${entry.path}`);
    await checkPath(overlayRoot, entry.path, entry.after, overlay);
    if (entry.before !== null) await checkPath(baselineRoot, entry.path, entry.before, baseline);
  }
  for (const entry of manifest.supportLivePins) {
    assert.equal(typeof entry.path, "string");
    assertPinnedHex(entry.sha256, entry.sha256, `Relay support pin ${entry.path}`);
    const relativePath = entry.path.replace(/^apps\/kcoder-relay\//, "");
    await checkPath(liveRoot, relativePath, entry.sha256, support, entry.path);
  }
  for (const entry of manifest.tests) {
    assert.equal(typeof entry.path, "string");
    assertPinnedHex(entry.sha256, entry.sha256, `Relay review test ${entry.path}`);
    await checkPath(testRoot, entry.path, entry.sha256, tests);
  }
  for (const required of ["apps/kcoder-relay/src/server.mjs", "apps/kcoder-relay/src/http-get-pool.mjs"])
    assert.ok(manifest.files.some(entry => entry.path === required), `static03 overlay includes ${required}`);
  for (const required of ["apps/kcoder-relay/src/client.mjs", "apps/kcoder-relay/src/transport.mjs", "apps/kcoder-relay/package.json", "apps/kcoder-relay/package-lock.json"])
    assert.ok(manifest.supportLivePins.some(entry => entry.path === required), `static03 pins runtime support ${required}`);
  const lock = JSON.parse((await readFile(join(liveRoot, "package-lock.json"))).toString("utf8"));
  assert.equal(lock.packages?.["node_modules/ws"]?.version, WS_RUNTIME_VERSION,
    "Relay's frozen lockfile and the owned runtime agree on ws version");
  return {
    freezeRoot,
    overlayRoot,
    baselineRoot,
    testRoot,
    liveRoot,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    designInputSha256: manifest.designInputSha256,
    productOverlay: overlay,
    baseline,
    support,
    tests,
  };
}

async function hashPinnedInputs(snapshot) {
  const manifestBytes = await readFile(snapshot.manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const result = { manifestSha256: sha256(manifestBytes), productOverlay: {}, baseline: {}, support: {}, tests: {} };
  for (const entry of manifest.files) {
    const overlayPath = join(snapshot.overlayRoot, entry.path);
    result.productOverlay[entry.path] = sha256(await readFile(overlayPath));
    if (entry.before !== null)
      result.baseline[entry.path] = sha256(await readFile(join(snapshot.baselineRoot, entry.path)));
  }
  for (const entry of manifest.supportLivePins) {
    const relative = entry.path.replace(/^apps\/kcoder-relay\//, "");
    result.support[entry.path] = sha256(await readFile(join(snapshot.liveRoot, relative)));
  }
  for (const entry of manifest.tests) {
    result.tests[entry.path] = sha256(await readFile(join(snapshot.testRoot, entry.path)));
  }
  result.wsRuntime = await verifyWsRuntimePackage();
  return result;
}

async function verifyWsRuntimePackage(root = resolve(repoRoot, "apps/kcoder-relay/node_modules/ws")) {
  const rootStat = await lstat(root);
  assert.equal(rootStat.isDirectory(), true, "installed ws runtime is a real directory");
  assert.equal(rootStat.isSymbolicLink(), false, "installed ws runtime is not a symlink");
  const rows = [];
  let totalBytes = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      assert.equal(metadata.isSymbolicLink(), false, "installed ws dependency contains no symlinks");
      if (metadata.isDirectory()) {
        await walk(absolutePath);
      } else {
        assert.equal(metadata.isFile(), true, "installed ws dependency contains only regular files");
        const bytes = await readFile(absolutePath);
        totalBytes += bytes.length;
        assert.ok(rows.length < 64 && totalBytes <= 1024 * 1024, "installed ws dependency hash walk is bounded");
        rows.push({ path: relative(root, absolutePath).split("\\").join("/"), sha256: sha256(bytes) });
      }
    }
  }
  await walk(root);
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = createHash("sha256");
  for (const row of rows) digest.update(`${row.path}\0${row.sha256}\n`);
  const treeSha256 = digest.digest("hex");
  const packageInfo = JSON.parse((await readFile(join(root, "package.json"))).toString("utf8"));
  assert.equal(packageInfo.version, WS_RUNTIME_VERSION, "installed ws version matches the Relay lockfile pin");
  assert.equal(treeSha256, WS_RUNTIME_TREE_SHA256, "installed ws runtime package bytes match the reviewed dependency pin");
  return { version: packageInfo.version, fileCount: rows.length, bytes: totalBytes, treeSha256 };
}

async function makeOwnedRelayCopy(context, frozen) {
  const runtimeRoot = context.pathInState("relay-runtime");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  for (const relativePath of Object.keys(frozen.support)) {
    const sourcePath = join(frozen.liveRoot, relativePath.replace(/^apps\/kcoder-relay\//, ""));
    const targetPath = join(runtimeRoot, relativePath.replace(/^apps\/kcoder-relay\//, ""));
    await mkdir(join(targetPath, ".."), { recursive: true, mode: 0o700 });
    await cp(sourcePath, targetPath, { errorOnExist: true });
  }
  for (const entry of frozen.productOverlay ? Object.keys(frozen.productOverlay) : []) {
    const sourcePath = join(frozen.overlayRoot, entry);
    const targetPath = join(runtimeRoot, entry.replace(/^apps\/kcoder-relay\//, ""));
    await mkdir(join(targetPath, ".."), { recursive: true, mode: 0o700 });
    await cp(sourcePath, targetPath, { force: true });
  }
  await mkdir(join(runtimeRoot, "node_modules"), { recursive: true, mode: 0o700 });
  await cp(resolve(repoRoot, "apps/kcoder-relay/node_modules/ws"), join(runtimeRoot, "node_modules/ws"),
    { recursive: true, errorOnExist: true });
  return runtimeRoot;
}

async function hashOwnedRuntimeCopy(runtimeRoot, frozen) {
  const copied = {};
  for (const [sourcePath, expected] of Object.entries(frozen.support)) {
    const relativePath = sourcePath.replace(/^apps\/kcoder-relay\//, "");
    if (relativePath === "src/server.mjs") continue;
    copied[sourcePath] = sha256(await readFile(join(runtimeRoot, relativePath)));
    assert.equal(copied[sourcePath], expected, `owned Relay runtime support differs from frozen input: ${sourcePath}`);
  }
  for (const [sourcePath, expected] of Object.entries(frozen.productOverlay)) {
    const relativePath = sourcePath.replace(/^apps\/kcoder-relay\//, "");
    copied[sourcePath] = sha256(await readFile(join(runtimeRoot, relativePath)));
    assert.equal(copied[sourcePath], expected, `owned Relay runtime overlay differs from frozen input: ${sourcePath}`);
  }
  assert.ok(copied["apps/kcoder-relay/package.json"] && Object.keys(copied).some(path => path.endsWith("/src/server.mjs")),
    "owned Relay runtime includes its package metadata and source files");
  const copiedWs = await verifyWsRuntimePackage(join(runtimeRoot, "node_modules/ws"));
  assert.deepEqual(copiedWs, await verifyWsRuntimePackage(), "owned runtime ws dependency matches the pinned installed package");
  return copied;
}

function collectBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let byteLength = 0;
    request.on("data", chunk => {
      byteLength += chunk.length;
      if (byteLength > 8 * 1024) {
        rejectBody(new Error("fixture request body exceeded its bound"));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once("end", () => resolveBody(Buffer.concat(chunks, byteLength)));
    request.once("error", rejectBody);
  });
}

function createGatewayFixture(id) {
  const state = {
    id,
    pairingToken: opaqueCredential(),
    accessTokens: new Map(),
    nextGrantLabel: null,
    requestRows: [],
    connectionIds: new WeakMap(),
    connections: new Map(),
    liveSockets: new Set(),
    nextConnectionId: 1,
    nextRequestId: 1,
    mutationAttempts: 0,
    mutationResponseClosed: deferred(),
    mutationSeen: deferred(),
    mutationGate: deferred(),
    heldGets: new Map(),
    abortConnectionId: null,
    server: null,
    url: null,
  };

  const server = createServer((incoming, outgoing) => {
    const connectionId = state.connectionIds.get(incoming.socket) ?? null;
    const requestId = state.nextRequestId++;
    const url = new URL(incoming.url, "http://gateway.fixture.invalid");
    const rawAccess = /^Bearer (.+)$/.exec(incoming.headers.authorization || "")?.[1] ?? null;
    const grantLabel = rawAccess ? state.accessTokens.get(rawAccess) ?? null : null;
    const row = {
      requestId,
      method: incoming.method,
      path: url.pathname,
      slot: url.pathname === "/api/hold" ? url.searchParams.get("slot") : null,
      gateway: id,
      grant: grantLabel,
      connectionId,
      observedAt: Date.now(),
      bodyBytes: 0,
    };
    if (state.requestRows.length < MAX_FIXTURE_REQUESTS) state.requestRows.push(row);

    void (async () => {
      if (incoming.method === "POST" && url.pathname === "/api/mobile/session") {
        const body = await collectBody(incoming);
        row.bodyBytes = body.length;
        let payload = null;
        try { payload = JSON.parse(body.toString("utf8")); } catch { /* fixed fixture rejection below */ }
        body.fill(0);
        if (payload?.token !== state.pairingToken) {
          outgoing.writeHead(401, { "content-type": "text/plain", "content-length": "12" });
          outgoing.end("unauthorized");
          return;
        }
        const accessToken = opaqueCredential();
        const rpcToken = opaqueCredential();
        const label = state.nextGrantLabel ?? `${id}-grant-${state.nextRequestId}`;
        state.nextGrantLabel = null;
        state.accessTokens.set(accessToken, label);
        const result = { accessToken, rpcToken, expiresAt: Date.now() + 120_000 };
        const bytes = Buffer.from(JSON.stringify(result));
        outgoing.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(bytes.length),
        });
        outgoing.end(bytes);
        outgoing.once("finish", () => bytes.fill(0));
        return;
      }

      if (!grantLabel) {
        outgoing.writeHead(401, { "content-type": "text/plain", "content-length": "12" });
        outgoing.end("unauthorized");
        return;
      }

      if (incoming.method === "GET" && url.pathname === "/api/servers") {
        const ordinal = state.requestRows.filter(value => value.path === "/api/servers").length;
        const bytes = Buffer.from(JSON.stringify({ gateway: id, grant: grantLabel, ordinal, connectionId }));
        outgoing.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(bytes.length),
          "keep-alive": `timeout=${SERVER_ADVERTISED_KEEPALIVE_SECONDS}`,
        });
        outgoing.end(bytes);
        return;
      }

      if (incoming.method === "GET" && url.pathname === "/api/chunk") {
        const ordinal = state.requestRows.filter(value => value.path === "/api/chunk").length;
        const bytes = Buffer.from(`complete:${id}:${grantLabel}:${ordinal}:` + "x".repeat(24 * 1024));
        outgoing.writeHead(200, { "content-type": "application/octet-stream", "transfer-encoding": "chunked" });
        const first = Math.floor(bytes.length / 3);
        const second = Math.floor((bytes.length * 2) / 3);
        outgoing.write(bytes.subarray(0, first));
        setTimeout(() => {
          if (outgoing.destroyed) return;
          outgoing.write(bytes.subarray(first, second));
          setTimeout(() => {
            if (!outgoing.destroyed) {
              outgoing.end(bytes.subarray(second));
              outgoing.once("finish", () => bytes.fill(0));
            } else {
              bytes.fill(0);
            }
          }, 5);
        }, 5);
        return;
      }

      if (incoming.method === "GET" && url.pathname === "/api/abort") {
        state.abortConnectionId = connectionId;
        outgoing.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": "32768",
        });
        outgoing.flushHeaders();
        outgoing.write(Buffer.from("partial-response"));
        setTimeout(() => incoming.socket.destroy(), 20);
        return;
      }

      if (incoming.method === "GET" && url.pathname === "/api/hold") {
        const label = url.searchParams.get("slot");
        if (!label || state.heldGets.has(label)) {
          outgoing.writeHead(400, { "content-length": "0" });
          outgoing.end();
          return;
        }
        const hold = deferred();
        state.heldGets.set(label, { hold, row, outgoing });
        await hold.promise;
        if (outgoing.destroyed) return;
        const bytes = Buffer.from(`held:${id}:${grantLabel}:${label}:${connectionId}`);
        outgoing.writeHead(200, { "content-type": "text/plain", "content-length": String(bytes.length) });
        outgoing.end(bytes);
        return;
      }

      if (incoming.method === "POST" && url.pathname === "/api/mutate") {
        const body = await collectBody(incoming);
        row.bodyBytes = body.length;
        body.fill(0);
        state.mutationAttempts += 1;
        state.mutationSeen.resolve({ connectionId, requestId });
        outgoing.once("close", () => state.mutationResponseClosed.resolve());
        await state.mutationGate.promise;
        if (!outgoing.destroyed) {
          const bytes = Buffer.from("mutation-result");
          outgoing.writeHead(200, { "content-type": "text/plain", "content-length": String(bytes.length) });
          outgoing.end(bytes);
        }
        return;
      }

      outgoing.writeHead(404, { "content-type": "text/plain", "content-length": "0" });
      outgoing.end();
    })().catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(500, { "content-length": "0" });
      outgoing.end();
    });
  });

  server.keepAliveTimeout = SERVER_IDLE_TIMEOUT_MS;
  server.on("connection", socket => {
    const connectionId = state.nextConnectionId++;
    state.connectionIds.set(socket, connectionId);
    state.liveSockets.add(socket);
    state.connections.set(connectionId, { openedAt: Date.now(), closedAt: null, requests: 0 });
    socket.once("close", () => {
      state.liveSockets.delete(socket);
      const record = state.connections.get(connectionId);
      if (record) record.closedAt = Date.now();
    });
  });
  state.server = server;
  return state;
}

async function listenGateway(gateway) {
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  gateway.port = gateway.server.address().port;
  gateway.url = `http://127.0.0.1:${gateway.port}`;
}

function beginRequest(fixture, { gatewayId, path, method = "GET", accessToken, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const bodyBytes = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const headers = { host: AUTHORITY, connection: "close" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (bodyBytes) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(bodyBytes.length);
  }
  let response = null;
  const chunks = [];
  let settled = false;
  let resolveResult;
  const result = new Promise(resolvePromise => { resolveResult = resolvePromise; });
  const finish = outcome => {
    if (settled) return;
    settled = true;
    resolveResult({
      ...outcome,
      status: response?.statusCode ?? 0,
      headers: response?.headers ?? {},
      body: Buffer.concat(chunks),
      complete: response?.complete ?? false,
    });
  };
  const outgoing = httpRequest({
    host: "127.0.0.1",
    port: fixture.relay.proxyPort,
    method,
    path: `/g/${gatewayId}${path}`,
    headers,
  }, incoming => {
    response = incoming;
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.once("end", () => finish({ outcome: "complete" }));
    incoming.once("aborted", () => finish({ outcome: "aborted" }));
    incoming.once("error", () => finish({ outcome: "response-error" }));
  });
  outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error("owned Relay HTTP request timed out")));
  outgoing.once("error", error => finish({ outcome: error.code === "ECONNRESET" ? "reset" : "request-error" }));
  outgoing.once("finish", () => bodyBytes?.fill(0));
  outgoing.once("close", () => bodyBytes?.fill(0));
  outgoing.end(bodyBytes ?? undefined);
  return { result, abort: () => outgoing.destroy(), outgoing };
}

async function requestRelay(fixture, requestOptions) {
  return (await beginRequest(fixture, requestOptions).result);
}

function jsonBody(response) {
  return JSON.parse(response.body.toString("utf8"));
}

async function pair(fixture, gatewayId, label) {
  const gateway = fixture.gateways.get(gatewayId);
  gateway.nextGrantLabel = label;
  const response = await requestRelay(fixture, {
    gatewayId,
    path: "/api/mobile/session",
    method: "POST",
    body: { token: gateway.pairingToken },
  });
  assert.equal(response.outcome, "complete");
  assert.equal(response.status, 200, `owned pair for ${gatewayId}/${label} succeeds`);
  const result = jsonBody(response);
  assert.ok(result.accessToken && result.rpcToken, "fixture returned opaque pair credentials");
  fixture.registerSecret(result.accessToken);
  fixture.registerSecret(result.rpcToken);
  return result;
}

function dataEvents(fixture, gatewayId, startIndex = 0) {
  return fixture.diagnostics.get(gatewayId).slice(startIndex);
}

function eventCount(records, name) {
  return records.filter(record => record.event === name).length;
}

async function startFixture(context, relayModule, clientModule) {
  const fixture = {
    gateways: new Map(),
    clients: new Map(),
    diagnostics: new Map(),
    relay: null,
    registerSecret: value => context.registerSecret(value),
  };
  const gatewayA = createGatewayFixture("a");
  const gatewayB = createGatewayFixture("b");
  fixture.gateways.set("a", gatewayA);
  fixture.gateways.set("b", gatewayB);
  const relaySecrets = { a: opaqueCredential(), b: opaqueCredential() };
  context.registerSecret(gatewayA.pairingToken);
  context.registerSecret(gatewayB.pairingToken);
  context.registerSecret(relaySecrets.a);
  context.registerSecret(relaySecrets.b);
  await Promise.all([listenGateway(gatewayA), listenGateway(gatewayB)]);
  context.registerPort("relay-get-pool-fake-gateway-a", gatewayA.port);
  context.registerPort("relay-get-pool-fake-gateway-b", gatewayB.port);
  for (const gateway of [gatewayA, gatewayB]) {
    context.addCleanup(`close fake Gateway ${gateway.id}`, async () => {
      for (const held of gateway.heldGets.values()) held.hold.resolve();
      gateway.mutationGate.resolve();
      for (const socket of gateway.liveSockets) socket.destroy();
      gateway.server.closeAllConnections();
      if (gateway.server.listening)
        await new Promise(resolveClose => gateway.server.close(resolveClose));
      await waitUntil(() => gateway.liveSockets.size === 0, 2_000, `fake Gateway ${gateway.id} sockets close`);
      assert.equal(gateway.liveSockets.size, 0, `fake Gateway ${gateway.id} has no owned TCP sockets after cleanup`);
    });
  }

  fixture.relay = await relayModule.startRelay({
    gateways: [
      { id: "a", secret: relaySecrets.a, pairingToken: gatewayA.pairingToken, baseUrl: gatewayA.url, maxConnections: 2, maxBytesPerWindow: 16 * 1024 * 1024, trafficWindowMs: 60_000 },
      { id: "b", secret: relaySecrets.b, pairingToken: gatewayB.pairingToken, baseUrl: gatewayB.url, maxConnections: 8, maxBytesPerWindow: 16 * 1024 * 1024, trafficWindowMs: 60_000 },
    ],
    sharedHosts: [AUTHORITY],
    controlPort: 0,
    proxyPort: 0,
    connectTimeout: 2_000,
  });
  context.addCleanup("close owned Relay", async () => {
    await fixture.relay.close();
    fixture.relay = null;
  });
  context.registerPort("relay-get-pool-control", fixture.relay.controlPort);
  context.registerPort("relay-get-pool-proxy", fixture.relay.proxyPort);

  for (const gateway of [gatewayA, gatewayB]) {
    const events = [];
    fixture.diagnostics.set(gateway.id, events);
    let onlineResolve;
    const online = new Promise(resolveOnline => { onlineResolve = resolveOnline; });
    const client = clientModule.startClient({
      url: `http://127.0.0.1:${fixture.relay.controlPort}`,
      secret: relaySecrets[gateway.id],
      gatewayId: gateway.id,
      gateway: gateway.url,
      allowInsecure: true,
      retryMs: 25,
      onOnline: onlineResolve,
      onDiagnostic(record) {
        if (events.length < MAX_FIXTURE_REQUESTS)
          events.push({ event: record.event, generation: record.generation, correlation: record.correlation });
      },
    });
    fixture.clients.set(gateway.id, client);
    context.addCleanup(`close reverse client ${gateway.id}`, async () => {
      client.close();
      await waitUntil(() => gateway.liveSockets.size === 0, 2_000, `Gateway ${gateway.id} reverse data sockets closed`);
    });
    await within(online, CLIENT_CONNECT_TIMEOUT_MS, `Relay reverse client ${gateway.id} online`);
  }
  return fixture;
}

function fixtureRows(gateway, path) {
  return gateway.requestRows.filter(row => row.path === path);
}

async function captureRuntimeCopy(context) {
  const frozen = await verifyFrozenRelaySource();
  const before = await hashPinnedInputs(frozen);
  const runtimeRoot = await makeOwnedRelayCopy(context, frozen);
  const ownedRuntime = await hashOwnedRuntimeCopy(runtimeRoot, frozen);
  const after = await hashPinnedInputs(frozen);
  assert.deepEqual(after, before, "frozen Relay inputs changed while creating the owned runtime copy");
  return { frozen, runtimeRoot, before, ownedRuntime, after };
}

export { captureRuntimeCopy };

const runBlackbox = process.env[PRIVATE_RUN_FLAG] === "1";
const runCopySmoke = process.env[PRIVATE_COPY_SMOKE_FLAG] === "1";
if (runBlackbox === runCopySmoke)
  throw new Error(`Set exactly one of ${PRIVATE_RUN_FLAG}=1 or ${PRIVATE_COPY_SMOKE_FLAG}=1`);
if (process.execPath !== EXPECTED_NODE || process.version !== "v22.17.0")
  throw new Error("This candidate requires the pinned Node 22.17.0 executable");

if (runBlackbox) await runE2E(import.meta.url, {
  testId: "relay-get-pool-static03-loopback-blackbox-review",
  tier: "manual-live",
  modelPolicy: "model-independent loopback Relay HTTP/TCP/WebSocket pooling; fake Gateways only; no public route, Rust app-server, Provider, browser, or phone claim",
  cleanupTimeoutMs: 20_000,
  retainSuccessLogs: true,
}, async context => {
  const runtime = await captureRuntimeCopy(context);
  const relayModule = await import(pathToFileURL(join(runtime.runtimeRoot, "src/server.mjs")).href);
  const clientModule = await import(pathToFileURL(join(runtime.runtimeRoot, "src/client.mjs")).href);
  let fixture;
  const evidence = {
    schemaVersion: 1,
    boundary: "owned loopback Relay, two owned fake HTTP Gateways, actual reverse-client control/data WebSockets; no browser/public/provider/model",
    node: { executable: process.execPath, version: process.version },
    source: {
      candidateRoot: RELAY_FREEZE_RELATIVE_ROOT,
      manifestSha256: runtime.frozen.manifestSha256,
      designInputSha256: runtime.frozen.designInputSha256,
      productOverlay: runtime.frozen.productOverlay,
      baseline: runtime.frozen.baseline,
      supportLivePins: runtime.frozen.support,
      reviewTests: runtime.frozen.tests,
      before: runtime.before,
      ownedRuntime: runtime.ownedRuntime,
      after: runtime.after,
    },
    cases: [],
  };
  context.addCleanup("write redacted Relay GET pool evidence after owned resources stop", async () => {
    evidence.cleanup = {
      relayClosed: fixture ? fixture.relay === null : null,
      gateways: fixture ? [...fixture.gateways.values()].map(gateway => ({
        id: gateway.id,
        listening: gateway.server.listening,
        liveSockets: gateway.liveSockets.size,
        requestCount: gateway.requestRows.length,
      })) : [],
      reverseClientsStopped: fixture ? [...fixture.diagnostics.values()].every(records =>
        records.some(record => record.event === "client_stopped")) : null,
    };
    await context.writeArtifactJsonInternal("relay-get-pool-static03-blackbox.json", evidence);
  });
  fixture = await startFixture(context, relayModule, clientModule);

  // Case 1: a same-grant serial read burst should reuse one actual data WSS and
  // one local Gateway TCP socket, with each HTTP response still parser-complete.
  {
    const gateway = fixture.gateways.get("a");
    const session = await pair(fixture, "a", "a-primary");
    const diagnosticStart = fixture.diagnostics.get("a").length;
    const firstRequestIndex = gateway.requestRows.length;
    const responses = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await requestRelay(fixture, {
        gatewayId: "a",
        path: `/api/servers?sample=${index + 1}`,
        accessToken: session.accessToken,
      });
      assert.equal(response.outcome, "complete");
      assert.equal(response.status, 200);
      assert.equal(response.complete, true);
      const payload = jsonBody(response);
      assert.equal(payload.gateway, "a");
      assert.equal(payload.grant, "a-primary");
      responses.push(payload);
    }
    const events = dataEvents(fixture, "a", diagnosticStart);
    const requests = gateway.requestRows.slice(firstRequestIndex).filter(row => row.path === "/api/servers");
    assert.equal(requests.length, 10);
    assert.equal(new Set(responses.map(value => value.ordinal)).size, 10, "each GET reached the Gateway once");
    assert.equal(new Set(requests.map(value => value.connectionId)).size, 1,
      "the same individual grant reused one actual local Gateway HTTP socket");
    assert.equal(eventCount(events, "open_received"), 1, "ten serial reads cause one actual Relay control open");
    assert.equal(eventCount(events, "data_open"), 1, "ten serial reads establish one actual Relay data WSS");
    assert.equal(eventCount(events, "local_connect"), 1, "the reused data WSS owns one local Gateway TCP connection");
    assert.equal(new Set(events.filter(value => value.event === "data_open").map(value => value.correlation)).size, 1);
    evidence.cases.push({
      id: "same-grant-ten-serial-gets",
      status: "passed",
      httpRequests: requests.length,
      completeResponses: responses.length,
      distinctGatewayConnections: new Set(requests.map(value => value.connectionId)).size,
      controlOpenCount: eventCount(events, "open_received"),
      dataWssOpenCount: eventCount(events, "data_open"),
      localConnectCount: eventCount(events, "local_connect"),
    });
  }

  // Case 2: two simultaneous active reads for one grant must not serialize
  // behind one connection; the third waits, then reuses a released slot.
  {
    const gateway = fixture.gateways.get("a");
    const session = await pair(fixture, "a", "a-parallel");
    const diagnosticStart = fixture.diagnostics.get("a").length;
    const requestStart = gateway.requestRows.length;
    const heldOne = beginRequest(fixture, {
      gatewayId: "a", path: "/api/hold?slot=one", accessToken: session.accessToken,
    });
    const heldTwo = beginRequest(fixture, {
      gatewayId: "a", path: "/api/hold?slot=two", accessToken: session.accessToken,
    });
    await Promise.all([
      waitUntil(() => gateway.heldGets.get("one") ?? null, 3_000, "first held GET reached fake Gateway"),
      waitUntil(() => gateway.heldGets.get("two") ?? null, 3_000, "second held GET reached fake Gateway"),
    ]);
    const firstTwoRows = gateway.requestRows.slice(requestStart).filter(row => row.path === "/api/hold");
    assert.equal(firstTwoRows.length, 2, "both independent held reads reached the Gateway before either response was released");
    assert.equal(new Set(firstTwoRows.map(row => row.connectionId)).size, 2,
      "two concurrent reads use two parser/socket slots rather than HTTP pipelining");
    const secondRow = firstTwoRows.find(row => row.slot === "two");
    assert.ok(secondRow, "the second active GET has an independently held upstream response");

    const queuedThird = beginRequest(fixture, {
      gatewayId: "a", path: "/api/hold?slot=three", accessToken: session.accessToken,
    });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    assert.equal(fixtureRows(gateway, "/api/hold").filter(row => row.slot === "three").length, 0,
      "a third GET stays bounded while both per-grant parser slots are actively leased");

    gateway.heldGets.get("one").hold.resolve();
    const firstResult = await within(heldOne.result, REQUEST_TIMEOUT_MS, "first held HTTP response");
    assert.equal(firstResult.status, 200);
    await waitUntil(() => gateway.heldGets.get("three") ?? null, 3_000, "queued third GET borrowed a released slot");
    assert.equal(gateway.connections.get(secondRow.connectionId)?.closedAt, null,
      "releasing or reusing one idle slot does not close the other active slot");
    assert.equal(heldTwo.outgoing.destroyed, false,
      "the second public request remains active while the released slot serves the third");
    gateway.heldGets.get("three").hold.resolve();
    const thirdResult = await within(queuedThird.result, REQUEST_TIMEOUT_MS, "third queued HTTP response");
    assert.equal(thirdResult.status, 200);
    gateway.heldGets.get("two").hold.resolve();
    const secondResult = await within(heldTwo.result, REQUEST_TIMEOUT_MS, "second held HTTP response");
    assert.equal(secondResult.status, 200);

    const rows = gateway.requestRows.slice(requestStart).filter(row => row.path === "/api/hold");
    assert.equal(rows.length, 3, "each parallel or queued GET reaches the Gateway exactly once");
    const firstConnection = rows.find(row => row.slot === "one")?.connectionId;
    const thirdConnection = rows.find(row => row.slot === "three")?.connectionId;
    assert.equal(thirdConnection, firstConnection, "released healthy slot is reused only after its HTTP response drains");
    const events = dataEvents(fixture, "a", diagnosticStart);
    assert.equal(eventCount(events, "data_open"), 2, "two active leases establish two data WSS slots");
    evidence.cases.push({
      id: "same-grant-two-held-reads-third-queued",
      status: "passed",
      firstTwoRequestsBeforeRelease: firstTwoRows.length,
      distinctActiveGatewayConnections: new Set(firstTwoRows.map(row => row.connectionId)).size,
      totalRequests: rows.length,
      dataWssOpenCount: eventCount(events, "data_open"),
      thirdReusedReleasedConnection: thirdConnection === firstConnection,
    });
  }

  // Case 3: a capacity-triggered pairing request evicts one unused slot but
  // preserves the same grant's active sibling request.
  {
    const gateway = fixture.gateways.get("a");
    const session = await pair(fixture, "a", "a-idle-eviction");
    const diagnosticStart = fixture.diagnostics.get("a").length;
    const requestStart = gateway.requestRows.length;
    const heldIdle = beginRequest(fixture, {
      gatewayId: "a", path: "/api/hold?slot=evictable", accessToken: session.accessToken,
    });
    const heldActive = beginRequest(fixture, {
      gatewayId: "a", path: "/api/hold?slot=active-during-eviction", accessToken: session.accessToken,
    });
    await Promise.all([
      waitUntil(() => gateway.heldGets.get("evictable") ?? null, 3_000, "evictable held GET reached fake Gateway"),
      waitUntil(() => gateway.heldGets.get("active-during-eviction") ?? null, 3_000, "active sibling reached fake Gateway"),
    ]);
    const rows = gateway.requestRows.slice(requestStart).filter(row => row.path === "/api/hold");
    const idleConnectionId = rows.find(row => row.slot === "evictable")?.connectionId;
    const activeConnectionId = rows.find(row => row.slot === "active-during-eviction")?.connectionId;
    assert.ok(Number.isInteger(idleConnectionId) && Number.isInteger(activeConnectionId));
    assert.notEqual(idleConnectionId, activeConnectionId);

    gateway.heldGets.get("evictable").hold.resolve();
    const idleResponse = await within(heldIdle.result, REQUEST_TIMEOUT_MS, "evictable GET completed");
    assert.equal(idleResponse.status, 200);
    const pairRequestStart = gateway.requestRows.filter(row => row.path === "/api/mobile/session").length;
    const replacement = await pair(fixture, "a", "a-capacity-after-eviction");
    assert.ok(replacement.accessToken, "capacity management admission can pair after evicting an idle slot");
    assert.equal(gateway.requestRows.filter(row => row.path === "/api/mobile/session").length, pairRequestStart + 1,
      "the capacity-triggering pair request reaches the Gateway once");
    await waitUntil(() => gateway.connections.get(idleConnectionId)?.closedAt ?? null,
      2_000, "capacity admission evicted the selected idle slot");
    assert.equal(gateway.connections.get(activeConnectionId)?.closedAt, null,
      "evicting one unused socket does not close the sibling's active socket");
    assert.equal(heldActive.outgoing.destroyed, false,
      "the active response remains owned while the pairing request uses the recovered capacity");

    gateway.heldGets.get("active-during-eviction").hold.resolve();
    const activeResponse = await within(heldActive.result, REQUEST_TIMEOUT_MS, "active sibling completed after idle eviction");
    assert.equal(activeResponse.status, 200);
    assert.equal(eventCount(dataEvents(fixture, "a", diagnosticStart), "data_open"), 3,
      "two active slots plus one independent pairing channel opened without exceeding maxConnections");
    evidence.cases.push({
      id: "capacity-evicts-idle-slot-preserves-active-sibling",
      status: "passed",
      gatewayMaxConnections: 2,
      pairReachedGatewayOnce: true,
      evictedIdleSocketClosed: Boolean(gateway.connections.get(idleConnectionId)?.closedAt),
      activeSiblingSurvived: gateway.connections.get(activeConnectionId)?.closedAt === null,
      dataWssOpenCount: eventCount(dataEvents(fixture, "a", diagnosticStart), "data_open"),
    });
  }

  // Case 4: expiry of one idle pool slot must not close its active sibling.
  // The observed close comes from the fake Gateway TCP socket; this does not
  // infer closure from a timer alone.
  {
    const gateway = fixture.gateways.get("a");
    gateway.server.keepAliveTimeout = POOL_IDLE_TIMEOUT_MS + 5_000;
    const session = await pair(fixture, "a", "a-idle-slot-expiry");
    const diagnosticStart = fixture.diagnostics.get("a").length;
    const requestStart = gateway.requestRows.length;
    const heldOne = beginRequest(fixture, {
      gatewayId: "a", path: "/api/hold?slot=idle", accessToken: session.accessToken,
      timeoutMs: POOL_IDLE_TIMEOUT_MS + 5_000,
    });
    const heldTwo = beginRequest(fixture, {
      gatewayId: "a", path: "/api/hold?slot=active", accessToken: session.accessToken,
      timeoutMs: POOL_IDLE_TIMEOUT_MS + 5_000,
    });
    await Promise.all([
      waitUntil(() => gateway.heldGets.get("idle") ?? null, 3_000, "idle-slot held GET reached fake Gateway"),
      waitUntil(() => gateway.heldGets.get("active") ?? null, 3_000, "active-sibling held GET reached fake Gateway"),
    ]);
    const firstRows = gateway.requestRows.slice(requestStart).filter(row => row.path === "/api/hold");
    assert.equal(firstRows.length, 2);
    const idleConnectionId = firstRows.find(row => row.slot === "idle")?.connectionId;
    const activeConnectionId = firstRows.find(row => row.slot === "active")?.connectionId;
    assert.ok(Number.isInteger(idleConnectionId) && Number.isInteger(activeConnectionId));
    assert.notEqual(idleConnectionId, activeConnectionId, "the two requests occupy separate per-grant slots");

    gateway.heldGets.get("idle").hold.resolve();
    const idleResult = await within(heldOne.result, REQUEST_TIMEOUT_MS, "idle-slot HTTP response completed");
    assert.equal(idleResult.status, 200);
    const idleStartedAt = Date.now();
    await waitUntil(() => gateway.connections.get(idleConnectionId)?.closedAt ?? null,
      POOL_IDLE_TIMEOUT_MS + 2_000, "Relay idle TTL closed only the released Gateway socket");
    const idleClosedAt = gateway.connections.get(idleConnectionId).closedAt;
    assert.ok(idleClosedAt - idleStartedAt >= POOL_IDLE_TIMEOUT_MS - 500,
      "the close follows the pool idle bound rather than an early active-request teardown");
    assert.equal(gateway.connections.get(activeConnectionId)?.closedAt, null,
      "idle expiry for one slot leaves its concurrently active sibling socket open");
    assert.equal(heldTwo.outgoing.destroyed, false, "the active sibling response still awaits its own release");

    gateway.heldGets.get("active").hold.resolve();
    const activeResult = await within(heldTwo.result, REQUEST_TIMEOUT_MS, "active sibling response completed after idle expiry");
    assert.equal(activeResult.status, 200);
    const after = await requestRelay(fixture, {
      gatewayId: "a", path: "/api/servers", accessToken: session.accessToken,
    });
    assert.equal(after.status, 200);
    const afterPayload = jsonBody(after);
    assert.equal(afterPayload.connectionId, activeConnectionId,
      "the surviving slot remains available for the next independent request");
    assert.equal(eventCount(dataEvents(fixture, "a", diagnosticStart), "data_open"), 2,
      "the next request does not disturb the sibling channel or create an extra slot");
    evidence.cases.push({
      id: "idle-slot-ttl-preserves-active-sibling",
      status: "passed",
      configuredIdleTtlMs: POOL_IDLE_TIMEOUT_MS,
      idleSocketClosedAfterMs: idleClosedAt - idleStartedAt,
      activeSiblingSurvived: gateway.connections.get(activeConnectionId)?.closedAt === null,
      nextRequestReusedSurvivingSocket: afterPayload.connectionId === activeConnectionId,
      dataWssOpenCount: eventCount(dataEvents(fixture, "a", diagnosticStart), "data_open"),
    });
  }

  // Case 5: a pool cannot cross either an individual access grant or the
  // canonical Gateway route, even when the upstream origin/socket could match.
  {
    const gatewayA = fixture.gateways.get("a");
    const gatewayB = fixture.gateways.get("b");
    const aPrimary = await pair(fixture, "a", "a-isolation-primary");
    const aSecond = await pair(fixture, "a", "a-isolation-second");
    const bPrimary = await pair(fixture, "b", "b-isolation-primary");
    const aStart = fixture.diagnostics.get("a").length;
    const bStart = fixture.diagnostics.get("b").length;
    const aRowsStart = gatewayA.requestRows.length;
    const bRowsStart = gatewayB.requestRows.length;
    const records = [];
    for (const [gatewayId, session, label] of [
      ["a", aPrimary, "a-isolation-primary"],
      ["a", aSecond, "a-isolation-second"],
      ["b", bPrimary, "b-isolation-primary"],
      ["a", aPrimary, "a-isolation-primary"],
      ["a", aSecond, "a-isolation-second"],
      ["b", bPrimary, "b-isolation-primary"],
    ]) {
      const response = await requestRelay(fixture, { gatewayId, path: "/api/servers", accessToken: session.accessToken });
      assert.equal(response.status, 200);
      const payload = jsonBody(response);
      assert.equal(payload.gateway, gatewayId);
      assert.equal(payload.grant, label);
      records.push(payload);
    }
    const wrongRoute = await requestRelay(fixture, {
      gatewayId: "b", path: "/api/servers", accessToken: aPrimary.accessToken,
    });
    assert.equal(wrongRoute.status, 401, "a grant from Gateway A cannot borrow any Gateway B pool slot");
    assert.equal(wrongRoute.outcome, "complete");
    const aRows = gatewayA.requestRows.slice(aRowsStart).filter(row => row.path === "/api/servers");
    const bRows = gatewayB.requestRows.slice(bRowsStart).filter(row => row.path === "/api/servers");
    assert.equal(aRows.length, 4);
    assert.equal(bRows.length, 2, "the two valid Gateway B GETs reach its upstream exactly once each");
    assert.ok(bRows.every(row => row.grant === "b-isolation-primary"),
      "Gateway B receives only its own current grant's requests");
    const socketByGrant = new Map(aRows.map(row => [row.grant, row.connectionId]));
    assert.equal(new Set(socketByGrant.values()).size, 2, "same Gateway but distinct grants have distinct upstream sockets");
    assert.equal(new Set(bRows.map(row => row.connectionId)).size, 1, "Gateway B reuses only its own grant's upstream socket");
    assert.equal(eventCount(dataEvents(fixture, "a", aStart), "data_open"), 2);
    assert.equal(eventCount(dataEvents(fixture, "b", bStart), "data_open"), 1);
    evidence.cases.push({
      id: "grant-and-gateway-isolation",
      status: "passed",
      successfulResponses: records.length,
      wrongRouteStatus: wrongRoute.status,
      gatewayAGrantSockets: Object.fromEntries(socketByGrant),
      gatewayBGrantSockets: [...new Set(bRows.map(row => row.connectionId))],
      gatewayADataWssOpenCount: eventCount(dataEvents(fixture, "a", aStart), "data_open"),
      gatewayBDataWssOpenCount: eventCount(dataEvents(fixture, "b", bStart), "data_open"),
    });
  }

  // Case 6: complete chunked responses can reuse a slot; a truncated body
  // destroys that channel, and the next read opens a fresh data WSS.
  {
    const gateway = fixture.gateways.get("a");
    const session = await pair(fixture, "a", "a-response-boundary");
    const diagnosticStart = fixture.diagnostics.get("a").length;
    const first = await requestRelay(fixture, { gatewayId: "a", path: "/api/chunk", accessToken: session.accessToken });
    const second = await requestRelay(fixture, { gatewayId: "a", path: "/api/chunk", accessToken: session.accessToken });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.complete, true);
    assert.equal(second.complete, true);
    assert.notDeepEqual(first.body, second.body, "distinct complete response bodies remain distinct on a reused parser");
    assert.match(first.body.toString("utf8"), /^complete:a:a-response-boundary:1:/);
    assert.match(second.body.toString("utf8"), /^complete:a:a-response-boundary:2:/);
    const completeRows = fixtureRows(gateway, "/api/chunk").slice(-2);
    assert.equal(completeRows[0].connectionId, completeRows[1].connectionId,
      "complete chunked responses use one persistent local Gateway socket");

    const abortRequestStart = fixtureRows(gateway, "/api/abort").length;
    const aborted = await requestRelay(fixture, { gatewayId: "a", path: "/api/abort", accessToken: session.accessToken });
    assert.equal(aborted.status, 200, "the upstream sent response headers before its partial body was aborted");
    assert.equal(aborted.complete, false, "the caller observes a truncated body, not a successful pooled response");
    assert.equal(fixtureRows(gateway, "/api/abort").length, abortRequestStart + 1,
      "the truncated GET is not transparently retried behind the caller's response");
    const abortConnectionId = gateway.abortConnectionId;
    assert.equal(typeof abortConnectionId, "number");
    await waitUntil(() => gateway.connections.get(abortConnectionId)?.closedAt ?? null, 2_000,
      "aborted upstream socket was closed and removed");
    const opensBeforeNext = eventCount(dataEvents(fixture, "a", diagnosticStart), "data_open");
    const afterAbort = await requestRelay(fixture, { gatewayId: "a", path: "/api/servers", accessToken: session.accessToken });
    assert.equal(afterAbort.status, 200, "a later independent GET can make progress after truncation");
    const afterAbortPayload = jsonBody(afterAbort);
    assert.notEqual(afterAbortPayload.connectionId, abortConnectionId,
      "the truncated channel is never returned to the pool");
    assert.ok(eventCount(dataEvents(fixture, "a", diagnosticStart), "data_open") > opensBeforeNext,
      "the recovery GET establishes a new data WSS instead of transparently retrying the failed read");
    evidence.cases.push({
      id: "chunked-response-and-truncation-discard",
      status: "passed",
      completeResponses: 2,
      sameSocketForCompleteBodies: completeRows[0].connectionId === completeRows[1].connectionId,
      truncatedBodyObserved: !aborted.complete,
      truncatedConnectionClosed: Boolean(gateway.connections.get(abortConnectionId)?.closedAt),
      recoveryUsedDifferentConnection: afterAbortPayload.connectionId !== abortConnectionId,
    });
  }

  // Case 7: a mutating request whose response becomes unknown is attempted
  // once. The GET pool must not replay a POST after client disconnect.
  {
    const gateway = fixture.gateways.get("b");
    const session = await pair(fixture, "b", "b-no-mutation-replay");
    const requestAttempt = beginRequest(fixture, {
      gatewayId: "b",
      path: "/api/mutate",
      method: "POST",
      accessToken: session.accessToken,
      body: { operation: "single-attempt-fixture" },
    });
    const firstSeen = await within(gateway.mutationSeen.promise, 3_000, "mutating request reached fake Gateway");
    requestAttempt.abort();
    const result = await within(requestAttempt.result, 3_000, "client observed the unknown mutation outcome");
    assert.ok(["reset", "request-error", "response-error", "aborted"].includes(result.outcome));
    assert.notEqual(result.outcome, "complete", "the caller retains an unknown outcome after disconnect");
    await within(gateway.mutationResponseClosed.promise, 3_000, "Gateway observed the dropped mutation response socket");
    gateway.mutationGate.resolve();
    await waitUntil(() => gateway.mutationAttempts === 1, 1_000, "single mutation attempt settled");
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    assert.equal(gateway.mutationAttempts, 1, "unknown POST outcome is not transparently replayed");
    evidence.cases.push({
      id: "unknown-mutation-not-replayed",
      status: "passed",
      gatewayAttempts: gateway.mutationAttempts,
      gatewayConnectionId: firstSeen.connectionId,
      observedClientOutcome: result.outcome,
      boundedNoReplayObservationMs: 250,
    });
  }

  // Case 8: a Gateway can retire a keep-alive socket before the Relay pool's
  // ten-second idle cap. The next independent request must recover once using
  // a fresh channel, with no stale-socket retry hidden inside that request.
  {
    const gateway = fixture.gateways.get("b");
    gateway.server.keepAliveTimeout = SERVER_IDLE_TIMEOUT_MS;
    const session = await pair(fixture, "b", "b-idle-close");
    const diagnosticStart = fixture.diagnostics.get("b").length;
    const before = await requestRelay(fixture, { gatewayId: "b", path: "/api/servers", accessToken: session.accessToken });
    assert.equal(before.status, 200);
    const firstPayload = jsonBody(before);
    const connection = gateway.connections.get(firstPayload.connectionId);
    assert.ok(connection, "the fake Gateway recorded the actual upstream socket");
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    assert.equal(connection.closedAt, null, "the first response left a live keep-alive socket before the server idle timeout");
    await waitUntil(() => connection.closedAt, 7_000, "Gateway's bounded keep-alive timeout closed the idle upstream socket");
    assert.ok(connection.closedAt - connection.openedAt >= 4_500,
      "the socket was closed by the Gateway idle timeout, not an immediate close response");
    const dataOpensBefore = eventCount(dataEvents(fixture, "b", diagnosticStart), "data_open");
    const requestCountBefore = fixtureRows(gateway, "/api/servers").length;
    const after = await requestRelay(fixture, { gatewayId: "b", path: "/api/servers", accessToken: session.accessToken });
    assert.equal(after.status, 200);
    const secondPayload = jsonBody(after);
    assert.notEqual(secondPayload.connectionId, firstPayload.connectionId,
      "the pool does not hand out a Gateway-closed idle socket");
    assert.equal(eventCount(dataEvents(fixture, "b", diagnosticStart), "data_open"), dataOpensBefore + 1,
      "one fresh channel is opened after upstream keep-alive expiry");
    assert.equal(fixtureRows(gateway, "/api/servers").length, requestCountBefore + 1,
      "the independent request reaches the Gateway exactly once after stale-socket retirement");
    evidence.cases.push({
      id: "upstream-idle-close-recovery",
      status: "passed",
      upstreamIdleTimeoutMs: SERVER_IDLE_TIMEOUT_MS,
      advertisedKeepAliveSeconds: SERVER_ADVERTISED_KEEPALIVE_SECONDS,
      oldConnectionClosedAt: connection.closedAt,
      oldSocketNotReused: secondPayload.connectionId !== firstPayload.connectionId,
      newDataWssOpenCount: eventCount(dataEvents(fixture, "b", diagnosticStart), "data_open") - dataOpensBefore,
    });
  }

  evidence.caseCount = evidence.cases.length;
  assert.equal(evidence.caseCount, 8, "all eight independent black-box contracts ran");
  const sourceAfter = await hashPinnedInputs(runtime.frozen);
  assert.deepEqual(sourceAfter, runtime.before, "frozen Relay source changed during the candidate run");
  evidence.source.after = sourceAfter;
});
